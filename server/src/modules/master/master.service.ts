import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { AuditService } from '../../common/audit.service';
import { ProcessHooks } from '../../common/hooks';
import { BizException, ErrCode } from '../../common/errors';
import { diffJson, fingerprintOf, likeEscape, maskValue, nowStr, parseJson, similarity, toInt } from '../../common/util';
import { AuthUser } from '../../common/decorators';
import { ApprovalService } from '../approval/approval.service';
import { CodeEngine } from '../metadata/code-engine.service';
import { OutboxService } from '../integration/integration.service';

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '审批中',
  CHANGING: '变更中',
  PUBLISHED: '已发布',
  FROZEN: '已冻结',
  ARCHIVED: '已归档',
};

@Injectable()
export class MasterService implements OnModuleInit {
  constructor(
    private db: DbService,
    private audit: AuditService,
    private approval: ApprovalService,
    private codes: CodeEngine,
    private outbox: OutboxService,
    private hooks: ProcessHooks,
  ) {}

  onModuleInit() {
    this.hooks.register('publishWithCode', (inst) => this.publishWithCode(inst));
    this.hooks.register('applyChange', (inst) => this.applyChange(inst));
    this.hooks.register('rejectInstance', (inst) => this.rejectInstance(inst));
    this.hooks.register('publishBatch', (inst) => this.publishWithCode(inst));
  }

  // ---------------- 基础查询 ----------------
  private domainOf(code: string) {
    const d = this.db.one<any>("SELECT * FROM md_domain WHERE code = ? AND status = 'ACTIVE'", code);
    if (!d) throw new BizException('主数据域不存在', ErrCode.NOT_FOUND);
    return d;
  }

  private modelOf(domain: string) {
    const m = this.db.one<any>('SELECT * FROM md_model WHERE domain_code = ?', domain);
    if (!m) throw new BizException('该域尚未配置数据模型', ErrCode.NOT_FOUND);
    return m;
  }

  private fieldsOf(modelId: number) {
    return this.db.all<any>('SELECT * FROM md_field WHERE model_id = ? ORDER BY sort, id', modelId);
  }

  private assertDomain(user: AuthUser, domain: string) {
    if (user.roles.includes('SYS_ADMIN')) return;
    if (!user.domains.includes(domain)) throw new BizException(`无「${domain}」数据域的访问权限`, ErrCode.FORBIDDEN);
  }

  private masksOf(user: AuthUser, domain: string) {
    return user.fieldMasks?.[domain] || {};
  }

  private presentRecord(record: any, user: AuthUser, fields?: any[]) {
    const data = parseJson(record.data, {});
    const masks = this.masksOf(user, record.domain_code);
    const maskedFields: string[] = [];
    for (const [key, mode] of Object.entries(masks)) {
      if (mode === 'masked' && data[key] !== undefined && data[key] !== null && data[key] !== '') {
        data[key] = maskValue(data[key]);
        maskedFields.push(key);
      }
    }
    return {
      id: record.id,
      domain_code: record.domain_code,
      master_code: record.master_code,
      name: record.name,
      status: record.status,
      status_label: STATUS_LABELS[record.status] || record.status,
      version: record.version,
      data,
      created_at: record.created_at,
      updated_at: record.updated_at,
      fingerprint: record.fingerprint,
      maskedFields,
      fields: fields || undefined,
    };
  }

  private recordByKey(domain: string, key: string) {
    const isNum = /^\d+$/.test(key);
    const rec = isNum
      ? this.db.one<any>('SELECT * FROM md_master_data WHERE domain_code = ? AND id = ? AND deleted = 0', domain, Number(key))
      : this.db.one<any>('SELECT * FROM md_master_data WHERE domain_code = ? AND master_code = ? AND deleted = 0', domain, key);
    if (!rec) throw new BizException('主数据不存在', ErrCode.NOT_FOUND);
    return rec;
  }

  // ---------------- 列表 ----------------
  list(user: AuthUser, domain: string, query: any) {
    this.assertDomain(user, domain);
    const d = this.domainOf(domain);
    const model = this.modelOf(domain);
    const fields = this.fieldsOf(model.id);
    const fieldMap = new Map(fields.map((f) => [f.field_key, f]));

    const reserved = new Set(['page', 'size', 'keyword', 'status', 'sort', 'order', 'all']);
    const where: string[] = ['m.domain_code = ?', 'm.deleted = 0'];
    const params: any[] = [domain];

    const status = query.status ? String(query.status) : '';
    if (status) {
      where.push('m.status = ?');
      params.push(status);
    } else if (!query.all) {
      where.push("m.status <> 'ARCHIVED'");
    }

    const keyword = String(query.keyword || '').trim();
    if (keyword) {
      where.push("(m.name LIKE ? ESCAPE '\\' OR m.master_code LIKE ? ESCAPE '\\')");
      params.push(`%${likeEscape(keyword)}%`, `%${likeEscape(keyword)}%`);
    }

    for (const [key, value] of Object.entries(query)) {
      if (reserved.has(key) || value === '' || value === undefined || value === null) continue;
      const field = fieldMap.get(key);
      if (!field || !field.query_flag) continue;
      where.push(`m.g_${key} = ?`);
      params.push(String(value));
    }

    const sortField = ['updated_at', 'created_at', 'name', 'master_code', 'version', 'id'].includes(String(query.sort))
      ? String(query.sort)
      : 'updated_at';
    const order = String(query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, toInt(query.page, 1));
    const defaultSize = Number(this.db.cfg('page.size.default', 20)) || 20;
    const size = Math.min(200, Math.max(1, toInt(query.size, defaultSize)));
    // M5：树形模式——模型配置了层级字段时，一次性取全量（上限 2000）由前端组装树
    const treeMode = String(query.tree || '') === '1' && !!model.parent_field;
    const cond = 'WHERE ' + where.join(' AND ');

    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM md_master_data m ${cond}`, ...params)?.n || 0;
    const rows = this.db.all<any>(
      `SELECT m.* FROM md_master_data m ${cond} ORDER BY ${treeMode ? 'm.master_code ASC' : `m.${sortField} ${order}`} LIMIT ? OFFSET ?`,
      ...params, treeMode ? 2000 : size, treeMode ? 0 : (page - 1) * size,
    );
    const dicts: Record<string, any> = {};
    for (const f of fields.filter((x) => x.dict_code)) {
      if (!dicts[f.dict_code]) {
        dicts[f.dict_code] = this.db.all<any>(
          "SELECT value, label FROM md_dict_item WHERE dict_code = ? AND status = 'ACTIVE' ORDER BY sort", f.dict_code,
        );
      }
    }
    return {
      list: rows.map((r) => this.presentRecord(r, user)),
      total,
      page,
      size,
      domain: { code: d.code, name: d.name, description: d.description, owner: d.owner },
      model: { id: model.id, name: model.name, nameKey: model.name_key, parentField: model.parent_field || null },
      parentField: model.parent_field
        ? { key: model.parent_field, label: fieldMap.get(model.parent_field)?.label || model.parent_field }
        : null,
      treeMode,
      fields: fields.map((f) => ({
        key: f.field_key, label: f.label, type: f.type, required: !!f.required,
        unique: !!f.unique_flag, query: !!f.query_flag, dictCode: f.dict_code, placeholder: f.placeholder,
      })),
      dicts,
      statusLabels: STATUS_LABELS,
      statusCounts: this.statusCounts(domain),
    };
  }

  statusCounts(domain: string) {
    const rows = this.db.all<any>(
      "SELECT status, COUNT(*) AS n FROM md_master_data WHERE domain_code = ? AND deleted = 0 GROUP BY status", domain,
    );
    const map: Record<string, number> = {};
    for (const r of rows) map[r.status] = r.n;
    return map;
  }

  // ---------------- 详情 ----------------
  detail(user: AuthUser, domain: string, key: string) {
    this.assertDomain(user, domain);
    const model = this.modelOf(domain);
    const fields = this.fieldsOf(model.id);
    const rec = this.recordByKey(domain, key);
    const result: any = this.presentRecord(rec, user, fields.map((f) => ({
      key: f.field_key, label: f.label, type: f.type, dictCode: f.dict_code, required: !!f.required,
    })));
    const running = this.db.one<any>(
      "SELECT id, action, title, status, current_node, data_snapshot, applicant_name, updated_at FROM ap_instance WHERE domain_code = ? AND biz_id = ? AND status = 'RUNNING' ORDER BY id DESC",
      domain, rec.id,
    );
    if (running) {
      result.approval = {
        ...running,
        data_snapshot: undefined,
        pendingData: parseJson(running.data_snapshot, null),
        diff: running.data_snapshot ? diffJson(parseJson(rec.data, {}), parseJson(running.data_snapshot, {})) : null,
      };
    }
    result.versionCount = this.db.one<any>('SELECT COUNT(*) AS n FROM md_data_version WHERE record_id = ?', rec.id)?.n || 0;
    result.mergeOf = this.db.one<any>(
      "SELECT * FROM md_merge_log WHERE domain_code = ? AND merged_ids LIKE ? ORDER BY id DESC", domain, `%${rec.id}%`,
    ) || null;
    return result;
  }

  versions(user: AuthUser, domain: string, key: string) {
    this.assertDomain(user, domain);
    const rec = this.recordByKey(domain, key);
    const model = this.modelOf(domain);
    const fields = this.fieldsOf(model.id);
    const labelMap = new Map(fields.map((f) => [f.field_key, f.label]));
    const rows = this.db.all<any>('SELECT * FROM md_data_version WHERE record_id = ? ORDER BY version DESC, id DESC', rec.id);
    return {
      record: { id: rec.id, master_code: rec.master_code, name: rec.name, status: rec.status, version: rec.version },
      list: rows.map((r) => ({
        ...r,
        data: parseJson(r.data, {}),
        diff: parseJson(r.diff, null),
        diffLabels: r.diff
          ? Object.fromEntries(Object.keys(parseJson(r.diff, {})).map((k) => [k, labelMap.get(k) || k]))
          : {},
      })),
    };
  }

  // ---------------- 校验 ----------------
  private validateData(fields: any[], raw: any, options: { requireAll?: boolean } = {}) {
    const data: any = {};
    const errors: string[] = [];
    const input = raw && typeof raw === 'object' ? raw : {};
    for (const f of fields) {
      let v = input[f.field_key];
      // 前端空字符串统一视为空
      if (typeof v === 'string') v = v.trim();
      if (v === '' || v === undefined || v === null) {
        if (f.required && options.requireAll !== false) {
          errors.push(`「${f.label}」为必填项`);
        } else {
          data[f.field_key] = null;
        }
        continue;
      }
      switch (f.type) {
        case 'NUMBER': {
          const n = Number(v);
          if (Number.isNaN(n)) errors.push(`「${f.label}」必须为数字`);
          else data[f.field_key] = n;
          break;
        }
        case 'BOOL':
          data[f.field_key] = v === true || v === 'true' || v === 1 || v === '1';
          break;
        case 'DATE':
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errors.push(`「${f.label}」日期格式应为 YYYY-MM-DD`);
          else data[f.field_key] = String(v);
          break;
        case 'ENUM': {
          const item = this.db.one<any>(
            "SELECT * FROM md_dict_item WHERE dict_code = ? AND value = ? AND status = 'ACTIVE'", f.dict_code, String(v),
          );
          if (!item) errors.push(`「${f.label}」取值不在码表范围内`);
          else data[f.field_key] = String(v);
          break;
        }
        case 'REF': {
          const ref = this.db.one<any>(
            "SELECT id FROM md_master_data WHERE domain_code = ? AND master_code = ? AND deleted = 0", f.ref_domain, String(v),
          );
          if (!ref) errors.push(`「${f.label}」引用的 ${f.ref_domain} 数据不存在`);
          else data[f.field_key] = String(v);
          break;
        }
        default: {
          const s = String(v);
          if (f.max_length && s.length > f.max_length) errors.push(`「${f.label}」长度不能超过 ${f.max_length}`);
          if (f.regex) {
            try {
              if (!new RegExp(f.regex).test(s)) errors.push(`「${f.label}」格式不符合要求`);
            } catch { /* 忽略非法正则 */ }
          }
          data[f.field_key] = s;
        }
      }
    }
    if (errors.length) throw new BizException(errors.join('；'), ErrCode.PARAM);
    return data;
  }

  private assertUnique(domain: string, fields: any[], data: any, excludeId?: number) {
    for (const f of fields.filter((x) => x.unique_flag)) {
      const value = data[f.field_key];
      if (!value) continue;
      const other = this.db.one<any>(
        `SELECT id, master_code, name, status FROM md_master_data WHERE domain_code = ? AND deleted = 0 AND status <> 'ARCHIVED' AND json_extract(data, '$.${f.field_key}') = ? AND id <> ?`,
        domain, value, excludeId || 0,
      );
      if (other) {
        throw new BizException(
          `「${f.label}」已存在相同值（${other.master_code || other.name} · ${STATUS_LABELS[other.status] || other.status}）`,
          ErrCode.DUP,
        );
      }
    }
  }

  /** M5：层级防环校验——上级必须存在，且上级链上不允许出现自己（含间接环） */
  private assertHierarchy(domain: string, model: any, data: any, excludeId?: number) {
    const pf = model.parent_field;
    if (!pf) return;
    const parentCode = data[pf] ? String(data[pf]) : '';
    if (!parentCode) return;
    let curCode: string | null = parentCode;
    const seen = new Set<string>();
    while (curCode) {
      const cur = this.db.one<any>(
        'SELECT id, data FROM md_master_data WHERE domain_code = ? AND master_code = ? AND deleted = 0', domain, curCode,
      );
      if (!cur) throw new BizException(`层级校验失败：上级「${curCode}」不存在`, ErrCode.PARAM);
      if (excludeId && cur.id === excludeId) {
        throw new BizException('上级不能是自身或自己的下级（会形成循环）', ErrCode.PARAM);
      }
      if (seen.has(curCode)) break; // 存量脏数据成环时避免死循环
      seen.add(curCode);
      const curData = parseJson(cur.data, {});
      curCode = curData[pf] ? String(curData[pf]) : null;
    }
  }

  // ---------------- 查重 ----------------
  checkDup(user: AuthUser, domain: string, payload: { data: any; excludeId?: number }) {
    this.assertDomain(user, domain);
    const model = this.modelOf(domain);
    const fields = this.fieldsOf(model.id);
    const rule = this.db.one<any>('SELECT * FROM md_dup_rule WHERE domain_code = ?', domain);
    const exactFields: string[] = rule ? parseJson(rule.exact_fields, []) : [];
    const fuzzyFields: string[] = rule ? parseJson(rule.fuzzy_fields, []) : [];
    const threshold = rule?.threshold ?? 0.6;
    const nameKey = model.name_key;
    const keyword = String(payload?.data?.[nameKey] || '');
    const candidates = this.db.all<any>(
      "SELECT * FROM md_master_data WHERE domain_code = ? AND deleted = 0 AND status <> 'ARCHIVED' AND id <> ? ORDER BY updated_at DESC LIMIT 500",
      domain, payload.excludeId || 0,
    );
    const results = [];
    for (const c of candidates) {
      const cdata = parseJson(c.data, {});
      const exactHits: string[] = [];
      for (const f of exactFields) {
        const v = payload?.data?.[f];
        if (v && cdata[f] && String(v).trim().toLowerCase() === String(cdata[f]).trim().toLowerCase()) exactHits.push(f);
      }
      let score = 0;
      if (keyword && fuzzyFields.length) {
        score = Math.max(...fuzzyFields.map((f) => similarity(keyword, String(cdata[f] || ''))));
      }
      const isExact = exactHits.length > 0 && exactFields.length > 0 && exactHits.length === exactFields.filter((f) => payload?.data?.[f]).length;
      if (isExact || score >= threshold) {
        results.push({
          id: c.id,
          master_code: c.master_code,
          name: c.name,
          status: c.status,
          status_label: STATUS_LABELS[c.status] || c.status,
          score: isExact ? 1 : score,
          exact: isExact,
          matchedFields: Array.from(new Set([...exactHits, ...(score >= threshold ? fuzzyFields : [])])),
          data: cdata,
        });
      }
    }
    return {
      threshold,
      exactCount: results.filter((r) => r.exact).length,
      list: results.sort((a, b) => b.score - a.score).slice(0, 20),
    };
  }

  // ---------------- 新增 ----------------
  create(user: AuthUser, domain: string, body: { data: any; submit?: boolean }) {
    this.assertDomain(user, domain);
    const model = this.modelOf(domain);
    const fields = this.fieldsOf(model.id);
    const data = this.validateData(fields, body?.data || {});
    const name = data[model.name_key];
    this.assertUnique(domain, fields, data);
    this.assertHierarchy(domain, model, data);
    const ts = nowStr();
    const rec = this.db.tx(() => {
      const r = this.db.run(
        "INSERT INTO md_master_data (model_id, domain_code, master_code, name, status, version, data, fingerprint, created_by, created_at, updated_by, updated_at, deleted) VALUES (?, ?, NULL, ?, 'DRAFT', 1, ?, ?, ?, ?, ?, ?, 0)",
        model.id, domain, name, JSON.stringify(data), fingerprintOf(data), user.id, ts, user.id, ts,
      );
      return Number(r.lastInsertRowid);
    });
    this.audit.log(user, 'master', 'CREATE', `${domain} 新增草稿：${name}`, data);
    if (body?.submit) return this.submit(user, domain, String(rec), (body as any)?.ccUserIds);
    return this.detail(user, domain, String(rec));
  }

  // ---------------- 修改 ----------------
  update(user: AuthUser, domain: string, key: string, body: { data: any; submit?: boolean; ccUserIds?: number[] }) {
    this.assertDomain(user, domain);
    const model = this.modelOf(domain);
    const fields = this.fieldsOf(model.id);
    const rec = this.recordByKey(domain, key);
    if (['PENDING', 'CHANGING', 'FROZEN', 'ARCHIVED'].includes(rec.status)) {
      throw new BizException(`当前状态为「${STATUS_LABELS[rec.status]}」，不可编辑`, ErrCode.STATE);
    }
    const data = this.validateData(fields, body?.data || {});
    this.assertUnique(domain, fields, data, rec.id);
    this.assertHierarchy(domain, model, data, rec.id);
    if (rec.status === 'DRAFT') {
      this.db.run('UPDATE md_master_data SET name = ?, data = ?, fingerprint = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        data[model.name_key], JSON.stringify(data), fingerprintOf(data), user.id, nowStr(), rec.id);
      this.audit.log(user, 'master', 'UPDATE_DRAFT', `${domain} 修改草稿：${data[model.name_key]}`, diffJson(parseJson(rec.data, {}), data));
      if (body?.submit) return this.submit(user, domain, String(rec.id), body.ccUserIds);
      return this.detail(user, domain, String(rec.id));
    }

    // PUBLISHED → 发起变更
    const oldData = parseJson(rec.data, {});
    const diff = diffJson(oldData, data);
    if (!Object.keys(diff).length) return this.detail(user, domain, String(rec.id));
    const res = this.approval.start({
      domain, action: 'CHANGE', bizId: rec.id,
      title: `${this.domainOf(domain).name}变更：${data[model.name_key] || rec.name}`,
      prevStatus: 'PUBLISHED', applicant: user, dataSnapshot: data,
      ccUserIds: Array.isArray(body?.ccUserIds) ? body.ccUserIds : undefined,
    });
    if (res.auto) {
      this.applyChangeData(rec, data, model, user, null);
      return this.detail(user, domain, String(rec.id));
    }
    this.db.run("UPDATE md_master_data SET status = 'CHANGING', updated_by = ?, updated_at = ? WHERE id = ?", user.id, nowStr(), rec.id);
    this.audit.log(user, 'master', 'CHANGE_SUBMIT', `${domain} 发起变更：${rec.master_code}`, diff);
    return this.detail(user, domain, String(rec.id));
  }

  // ---------------- 提交审批 ----------------
  submit(user: AuthUser, domain: string, key: string, ccUserIds?: number[]) {
    this.assertDomain(user, domain);
    const model = this.modelOf(domain);
    const rec = this.recordByKey(domain, key);
    if (rec.status !== 'DRAFT') throw new BizException('仅草稿可提交审批', ErrCode.STATE);
    const data = parseJson(rec.data, {});
    const res = this.approval.start({
      domain, action: 'CREATE', bizId: rec.id,
      title: `${this.domainOf(domain).name}新增：${rec.name}`,
      prevStatus: 'DRAFT', applicant: user, dataSnapshot: data,
      ccUserIds: Array.isArray(ccUserIds) ? ccUserIds : undefined,
    });
    if (res.auto) {
      this.publishDirect(rec.id, user);
      this.audit.log(user, 'approval', 'SUBMIT', `${domain} 新增提交（未配置流程，直接发布）：${rec.name}`, 'auto');
      return this.detail(user, domain, String(rec.id));
    }
    this.db.run("UPDATE md_master_data SET status = 'PENDING', updated_by = ?, updated_at = ? WHERE id = ?", user.id, nowStr(), rec.id);
    this.audit.log(user, 'approval', 'SUBMIT', `${domain} 新增提交：${rec.name}`, { instanceId: res.instanceId });
    return this.detail(user, domain, String(rec.id));
  }

  // ---------------- 发布与生效 ----------------
  private publishDirect(recordId: number, user: AuthUser | null) {
    const rec = this.db.one<any>('SELECT * FROM md_master_data WHERE id = ?', recordId);
    if (!rec) throw new BizException('主数据不存在', ErrCode.NOT_FOUND);
    if (rec.status === 'PUBLISHED' && rec.master_code) return rec;
    const model = this.modelOf(rec.domain_code);
    const code = rec.master_code || this.codes.generate(rec.domain_code);
    this.db.tx(() => {
      this.db.run("UPDATE md_master_data SET master_code = ?, status = 'PUBLISHED', version = 1, updated_at = ? WHERE id = ?", code, nowStr(), recordId);
      const data = parseJson(rec.data, {});
      this.db.run('INSERT INTO md_data_version (record_id, domain_code, version, data, diff, action, operator, created_at) VALUES (?, ?, 1, ?, NULL, ?, ?, ?)',
        recordId, rec.domain_code, rec.data, 'CREATE', user?.displayName || '系统', nowStr());
      this.outbox.emit(rec.domain_code, code, 'CREATE', data, 1);
    });
    this.audit.log(user, 'master', 'PUBLISH', `${rec.domain_code} 发布 ${code}`, { name: rec.name });
    return this.recordByKey(rec.domain_code, code);
  }

  private publishWithCode(inst: any) {
    const rec = this.db.one<any>('SELECT * FROM md_master_data WHERE id = ?', inst.biz_id);
    if (!rec) throw new BizException('主数据不存在', ErrCode.NOT_FOUND);
    if (rec.status === 'PUBLISHED' && rec.master_code) return;
    const model = this.modelOf(rec.domain_code);
    const code = rec.master_code || this.codes.generate(rec.domain_code);
    const data = parseJson(rec.data, {});
    this.db.tx(() => {
      this.db.run("UPDATE md_master_data SET master_code = ?, name = ?, status = 'PUBLISHED', version = 1, updated_at = ? WHERE id = ?",
        code, data[model.name_key] || rec.name, nowStr(), rec.id);
      this.db.run('INSERT INTO md_data_version (record_id, domain_code, version, data, diff, action, operator, instance_id, created_at) VALUES (?, ?, 1, ?, NULL, ?, ?, ?, ?)',
        rec.id, rec.domain_code, JSON.stringify(data), 'CREATE', inst.applicant_name || '审批生效', inst.id, nowStr());
      this.outbox.emit(rec.domain_code, code, 'CREATE', data, 1);
    });
    this.audit.log({ id: inst.applicant_id, username: inst.applicant_name }, 'master', 'PUBLISH', `${rec.domain_code} 审批通过发布 ${code}`, { name: rec.name });
  }

  private applyChange(inst: any) {
    const rec = this.db.one<any>('SELECT * FROM md_master_data WHERE id = ?', inst.biz_id);
    if (!rec) throw new BizException('主数据不存在', ErrCode.NOT_FOUND);
    const newData = parseJson(inst.data_snapshot, null);
    if (!newData) return;
    const model = this.modelOf(rec.domain_code);
    this.applyChangeData(rec, newData, model, { id: inst.applicant_id, username: inst.applicant_name }, inst.id);
  }

  private applyChangeData(rec: any, newData: any, model: any, user: AuthUser | { id: number; username: string } | null, instanceId?: number | null) {
    const oldData = parseJson(rec.data, {});
    const diff = diffJson(oldData, newData);
    const version = rec.version + 1;
    const name = newData[model.name_key] || rec.name;
    this.db.tx(() => {
      this.db.run("UPDATE md_master_data SET name = ?, data = ?, fingerprint = ?, status = 'PUBLISHED', version = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        name, JSON.stringify(newData), fingerprintOf(newData), version, user?.id ?? rec.updated_by, nowStr(), rec.id);
      this.db.run('INSERT INTO md_data_version (record_id, domain_code, version, data, diff, action, operator, instance_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        rec.id, rec.domain_code, version, JSON.stringify(newData), JSON.stringify(diff), 'UPDATE', user?.username || '系统', instanceId || null, nowStr());
      this.outbox.emit(rec.domain_code, rec.master_code, 'UPDATE', newData, version);
    });
    this.audit.log(user as any, 'master', 'CHANGE_APPLY', `${rec.domain_code} 变更生效 ${rec.master_code} v${version}`, diff);
  }

  private rejectInstance(inst: any) {
    const rec = this.db.one<any>('SELECT * FROM md_master_data WHERE id = ?', inst.biz_id);
    if (!rec) return;
    if (inst.action === 'CREATE' && rec.status === 'PENDING') {
      this.db.run("UPDATE md_master_data SET status = 'DRAFT', updated_at = ? WHERE id = ?", nowStr(), rec.id);
    } else if (inst.action === 'CHANGE' && rec.status === 'CHANGING') {
      this.db.run("UPDATE md_master_data SET status = 'PUBLISHED', updated_at = ? WHERE id = ?", nowStr(), rec.id);
    }
    this.audit.log(null, 'master', 'APPROVAL_REJECT', `${inst.domain_code} 审批驳回：${rec.name}`, inst.title);
  }

  // ---------------- 生命周期 ----------------
  lifecycle(user: AuthUser, domain: string, key: string, action: 'freeze' | 'unfreeze' | 'archive') {
    this.assertDomain(user, domain);
    const rec = this.recordByKey(domain, key);
    if (action === 'freeze') {
      if (rec.status !== 'PUBLISHED') throw new BizException('仅已发布数据可冻结', ErrCode.STATE);
      this.db.run("UPDATE md_master_data SET status = 'FROZEN', updated_at = ? WHERE id = ?", nowStr(), rec.id);
      this.emitLifecycle(rec, 'FREEZE');
    } else if (action === 'unfreeze') {
      if (rec.status !== 'FROZEN') throw new BizException('仅已冻结数据可解冻', ErrCode.STATE);
      this.db.run("UPDATE md_master_data SET status = 'PUBLISHED', updated_at = ? WHERE id = ?", nowStr(), rec.id);
      this.emitLifecycle(rec, 'UNFREEZE');
    } else {
      if (!['PUBLISHED', 'FROZEN'].includes(rec.status)) throw new BizException('仅已发布/已冻结数据可归档', ErrCode.STATE);
      this.db.run("UPDATE md_master_data SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", nowStr(), rec.id);
      this.emitLifecycle(rec, 'ARCHIVE');
    }
    this.audit.log(user, 'master', action.toUpperCase(), `${domain} ${rec.master_code} ${action}`, { name: rec.name });
    return this.detail(user, domain, String(rec.id));
  }

  /** M4：批量生命周期操作（逐条校验执行，失败不中断并汇总原因） */
  batchLifecycle(user: AuthUser, domain: string, dto: { ids?: any[]; action?: string }) {
    this.assertDomain(user, domain);
    const ids = (dto?.ids || []).map(Number).filter(Boolean);
    const action = String(dto?.action || '');
    if (!ids.length) throw new BizException('请选择要操作的数据', ErrCode.PARAM);
    if (!['freeze', 'unfreeze', 'archive'].includes(action)) throw new BizException('操作类型不合法', ErrCode.PARAM);
    let success = 0;
    let failed = 0;
    const results: Array<{ id: number; ok: boolean; message?: string }> = [];
    for (const id of ids) {
      try {
        this.lifecycle(user, domain, String(id), action as any);
        success++;
        results.push({ id, ok: true });
      } catch (e: any) {
        failed++;
        const raw = e?.getResponse?.();
        results.push({ id, ok: false, message: (typeof raw === 'object' && raw?.msg) || e?.message || '操作失败' });
      }
    }
    const labels: Record<string, string> = { freeze: '冻结', unfreeze: '解冻', archive: '归档' };
    this.audit.log(user, 'master', `BATCH_${String(action).toUpperCase()}`, `${domain} 批量${labels[action]}：成功 ${success}/${ids.length} 条`, { ids });
    return { success, failed, results, action };
  }

  /** M4：回滚到历史版本（草稿直接覆盖；已发布数据走变更审批链路） */
  rollback(user: AuthUser, domain: string, key: string, dto: { version?: number }) {
    this.assertDomain(user, domain);
    const rec = this.recordByKey(domain, key);
    const version = Number(dto?.version || 0);
    const v = this.db.one<any>('SELECT * FROM md_data_version WHERE record_id = ? AND version = ?', rec.id, version);
    if (!v) throw new BizException('目标版本不存在', ErrCode.NOT_FOUND);
    if (version >= rec.version) throw new BizException('目标版本不早于当前版本，无需回滚', ErrCode.PARAM);
    const data = parseJson(v.data, null);
    if (!data || typeof data !== 'object') throw new BizException('历史版本数据为空', ErrCode.STATE);
    this.audit.log(user, 'master', 'ROLLBACK', `${domain} ${rec.master_code || rec.name} 回滚至 v${version}`, { from: rec.version, to: version });
    return this.update(user, domain, key, { data, submit: false });
  }

  private emitLifecycle(rec: any, eventType: string) {
    this.outbox.emit(rec.domain_code, rec.master_code, eventType, parseJson(rec.data, {}), rec.version);
  }

  // ---------------- 合并 ----------------
  merge(user: AuthUser, domain: string, dto: { goldId: number; mergeIds: number[]; fieldChoices?: any }) {
    this.assertDomain(user, domain);
    const gold = this.db.one<any>('SELECT * FROM md_master_data WHERE id = ? AND domain_code = ?', dto.goldId, domain);
    if (!gold) throw new BizException('金数据不存在', ErrCode.NOT_FOUND);
    if (gold.status !== 'PUBLISHED') throw new BizException('金数据必须为已发布状态', ErrCode.STATE);
    const mergeIds = (dto.mergeIds || []).map(Number).filter((x) => x && x !== gold.id);
    if (!mergeIds.length) throw new BizException('请选择需合并的数据', ErrCode.PARAM);
    const merged = this.db.all<any>(
      'SELECT * FROM md_master_data WHERE domain_code = ? AND id IN (' + mergeIds.map(() => '?').join(',') + ') AND deleted = 0',
      domain, ...mergeIds,
    );
    if (merged.length !== mergeIds.length) throw new BizException('部分待合并数据不存在', ErrCode.NOT_FOUND);
    if (merged.some((m) => m.status === 'ARCHIVED')) throw new BizException('已归档数据不可重复合并', ErrCode.STATE);
    const model = this.modelOf(domain);
    const fields = this.fieldsOf(model.id);
    const goldData = parseJson(gold.data, {});
    const choices = dto.fieldChoices || {};
    const newData: any = { ...goldData };
    for (const [k, v] of Object.entries(choices)) {
      if (fields.some((f) => f.field_key === k)) newData[k] = v;
    }
    const version = gold.version + 1;
    const ts = nowStr();
    this.db.tx(() => {
      this.db.run('UPDATE md_master_data SET data = ?, name = ?, fingerprint = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        JSON.stringify(newData), newData[model.name_key] || gold.name, fingerprintOf(newData), version, ts, user.id, gold.id);
      this.db.run('INSERT INTO md_data_version (record_id, domain_code, version, data, diff, action, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        gold.id, domain, version, JSON.stringify(newData), JSON.stringify(diffJson(goldData, newData)), 'MERGE', user.displayName, ts);
      for (const m of merged) {
        this.db.run("UPDATE md_master_data SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", ts, m.id);
      }
      this.db.run('INSERT INTO md_merge_log (domain_code, gold_id, gold_code, merged_ids, merged_codes, field_choices, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        domain, gold.id, gold.master_code, JSON.stringify(mergeIds), merged.map((m) => m.master_code).join(','), JSON.stringify(choices), user.displayName, ts);
      this.outbox.emit(domain, gold.master_code, 'UPDATE', newData, version);
    });
    this.audit.log(user, 'master', 'MERGE', `${domain} 合并 ${mergeIds.length} 条至 ${gold.master_code}`, { mergeIds });
    return { gold: this.detail(user, domain, String(gold.id)), mergedCount: mergeIds.length };
  }

  // ---------------- 导出 ----------------
  exportCsv(user: AuthUser, domain: string, query: any) {
    const result = this.list(user, domain, { ...query, page: 1, size: 5000 });
    const header = ['主数据编码', '名称', '状态', ...result.fields.map((f) => f.label), '版本', '更新时间'];
    const lines = [header.join(',')];
    for (const row of result.list) {
      const values = [
        row.master_code || '',
        row.name,
        row.status_label,
        ...result.fields.map((f) => {
          const v = row.data?.[f.key];
          if (v === null || v === undefined) return '';
          if (f.dictCode) {
            const opt = result.dicts[f.dictCode]?.find((o: any) => String(o.value) === String(v));
            return opt?.label || v;
          }
          return v;
        }),
        row.version,
        row.updated_at,
      ];
      lines.push(values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    return { filename: `${domain}-${nowStr().replace(/[:T]/g, '')}.csv`, content: lines.join('\r\n') };
  }

  /** 供工作台/审批详情复用 */
  getRecordRaw(id: number) {
    return this.db.one<any>('SELECT * FROM md_master_data WHERE id = ?', id);
  }

  /** 供导入模板/动态表格复用：返回域名、模型与字段定义 */
  fieldsFor(user: AuthUser, domain: string) {
    this.assertDomain(user, domain);
    const d = this.domainOf(domain);
    const model = this.modelOf(domain);
    return { domain: d, model, fields: this.fieldsOf(model.id) };
  }

  /** 导入预校验：返回逐行结果，不落库（含批内唯一性检查） */
  precheck(user: AuthUser, domain: string, rows: any[]) {
    this.assertDomain(user, domain);
    const model = this.modelOf(domain);
    const fields = this.fieldsOf(model.id);
    const uniqueFields = fields.filter((f) => f.unique_flag);
    const seen = new Map<string, number>();
    return rows.map((data, idx) => {
      const rowNo = idx + 1;
      const errors: string[] = [];
      let normalized: any = null;
      try {
        normalized = this.validateData(fields, data);
        this.assertUnique(domain, fields, normalized);
        this.assertHierarchy(domain, model, normalized);
      } catch (e: any) {
        const raw = e?.getResponse?.();
        const msg = (typeof raw === 'object' && raw?.msg) || e?.message || '校验失败';
        errors.push(...String(msg).split('；').filter(Boolean));
      }
      if (normalized) {
        for (const f of uniqueFields) {
          const v = normalized[f.field_key];
          if (!v) continue;
          const fp = `${f.field_key}:${String(v).trim().toLowerCase()}`;
          const first = seen.get(fp);
          if (first) errors.push(`「${f.label}」与第 ${first} 行重复`);
          else seen.set(fp, rowNo);
        }
      }
      return { rowNo, valid: errors.length === 0, errors, data: normalized || data };
    });
  }
}
