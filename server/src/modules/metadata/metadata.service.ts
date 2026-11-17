import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { AuditService } from '../../common/audit.service';
import { BizException, ErrCode } from '../../common/errors';
import { nowStr, parseJson } from '../../common/util';
import { IndexManager } from './index-manager';
import { CodeEngine } from './code-engine.service';
import { AuthUser } from '../../common/decorators';

const FIELD_TYPES = ['TEXT', 'ENUM', 'NUMBER', 'DATE', 'BOOL', 'REF'];

@Injectable()
export class MetadataService {
  constructor(private db: DbService, private audit: AuditService, private index: IndexManager, private codes: CodeEngine) {}

  domains(user: AuthUser) {
    const allowed = user.roles.includes('SYS_ADMIN') ? null : user.domains;
    const rows = this.db.all<any>(
      `SELECT d.*,
        (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0) AS total,
        (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.status = 'PUBLISHED' AND m.deleted = 0) AS published,
        (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.status = 'DRAFT' AND m.deleted = 0) AS drafts,
        md.id AS model_id, md.name AS model_name, md.version AS model_version, md.status AS model_status, md.name_key
       FROM md_domain d LEFT JOIN md_model md ON md.domain_code = d.code
       WHERE d.status = 'ACTIVE' ORDER BY d.sort`,
    );
    const list = allowed ? rows.filter((r) => allowed.includes(r.code)) : rows;
    return list.map((r) => ({
      code: r.code,
      name: r.name,
      description: r.description,
      owner: r.owner,
      total: r.total,
      published: r.published,
      drafts: r.drafts,
      model: r.model_id
        ? { id: r.model_id, name: r.model_name, version: r.model_version, status: r.model_status, nameKey: r.name_key }
        : null,
    }));
  }

  /** 新建数据域（M10 教程配套）：建域即对 SYS_ADMIN / DATA_STEWARD 默认授权可见范围 */
  saveDomain(dto: any, user: AuthUser) {
    const code = String(dto?.code || '').trim();
    const name = String(dto?.name || '').trim();
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(code)) throw new BizException('数据域编码须为小写字母开头，仅含小写字母/数字/下划线（2-31 位）', ErrCode.PARAM);
    if (!name) throw new BizException('数据域名称不能为空', ErrCode.PARAM);
    if (this.db.one<any>('SELECT code FROM md_domain WHERE code = ?', code)) throw new BizException('数据域编码已存在', ErrCode.DUP);
    const sort = ((this.db.one<any>('SELECT MAX(sort) AS s FROM md_domain') || {}).s || 0) + 1;
    this.db.run(
      'INSERT INTO md_domain (code, name, description, owner, status, sort) VALUES (?, ?, ?, ?, ?, ?)',
      code, name, String(dto?.description || '').trim() || null, String(dto?.owner || '').trim() || null, 'ACTIVE', sort,
    );
    // 建域即授权：管理员与数据管理员默认可见新域（幂等：已授权则跳过）
    for (const rc of ['SYS_ADMIN', 'DATA_STEWARD']) {
      const role = this.db.one<any>('SELECT id FROM sys_role WHERE code = ?', rc);
      if (role && !this.db.one<any>('SELECT id FROM sys_data_perm WHERE role_id = ? AND domain_code = ?', role.id, code)) {
        this.db.run('INSERT INTO sys_data_perm (role_id, domain_code) VALUES (?, ?)', role.id, code);
      }
    }
    this.audit.log(user, 'metadata', 'DOMAIN_CREATE', `新建数据域 ${name}`, code);
    return this.domains(user);
  }

  models() {
    return this.db.all<any>(
      `SELECT m.*, d.name AS domain_name,
        (SELECT COUNT(*) FROM md_field f WHERE f.model_id = m.id) AS field_count,
        (SELECT COUNT(*) FROM md_field f WHERE f.model_id = m.id AND f.query_flag = 1) AS query_count,
        (SELECT COUNT(*) FROM md_master_data x WHERE x.domain_code = m.domain_code AND x.deleted = 0) AS record_count
       FROM md_model m LEFT JOIN md_domain d ON d.code = m.domain_code ORDER BY m.id`,
    );
  }

  model(id: number) {
    const model = this.db.one<any>(
      'SELECT m.*, d.name AS domain_name FROM md_model m LEFT JOIN md_domain d ON d.code = m.domain_code WHERE m.id = ?',
      id,
    );
    if (!model) throw new BizException('模型不存在', ErrCode.NOT_FOUND);
    const fields = this.db.all<any>('SELECT * FROM md_field WHERE model_id = ? ORDER BY sort, id', id);
    const recordCount = this.db.one<any>('SELECT COUNT(*) AS n FROM md_master_data WHERE domain_code = ? AND deleted = 0', model.domain_code)
      ?.n;
    return {
      ...model,
      fields: fields.map((f) => ({
        ...f,
        required: !!f.required,
        unique_flag: !!f.unique_flag,
        query_flag: !!f.query_flag,
        indexed: f.query_flag ? this.index.hasColumn(f.field_key) : false,
      })),
      record_count: recordCount || 0,
    };
  }

  createModel(dto: any, user: AuthUser) {
    if (!dto.code || !dto.name || !dto.domainCode) throw new BizException('模型编码、名称、所属域不能为空', ErrCode.PARAM);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(dto.code)) throw new BizException('模型编码需以字母开头，仅含字母/数字/下划线', ErrCode.PARAM);
    const dup = this.db.one<any>('SELECT id FROM md_model WHERE code = ?', dto.code);
    if (dup) throw new BizException('模型编码已存在', ErrCode.BUSINESS);
    const domain = this.db.one<any>('SELECT code FROM md_domain WHERE code = ?', dto.domainCode);
    if (!domain) throw new BizException('所属主数据域不存在', ErrCode.NOT_FOUND);
    const ts = nowStr();
    const r = this.db.run(
      "INSERT INTO md_model (domain_code, code, name, name_key, version, status, description, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'DRAFT', ?, ?, ?)",
      dto.domainCode, dto.code, dto.name, dto.nameKey || 'name', dto.description || null, ts, ts,
    );
    this.audit.log(user, 'metadata', 'MODEL_CREATE', `新建模型 ${dto.name}`, dto.code);
    return this.model(Number(r.lastInsertRowid));
  }

  updateModel(id: number, dto: any, user: AuthUser) {
    const model = this.db.one<any>('SELECT * FROM md_model WHERE id = ?', id);
    if (!model) throw new BizException('模型不存在', ErrCode.NOT_FOUND);
    const nameKey = dto.nameKey || model.name_key;
    if (nameKey) {
      const f = this.db.one<any>('SELECT id FROM md_field WHERE model_id = ? AND field_key = ?', id, nameKey);
      if (!f && model.status === 'PUBLISHED') throw new BizException('名称字段必须存在于模型中', ErrCode.PARAM);
    }
    // M5：层级字段配置——字段必须已存在于模型，且不能与名称字段相同
    const parentField = dto.parentField === undefined ? model.parent_field : (dto.parentField || null);
    if (parentField) {
      if (parentField === nameKey) throw new BizException('层级字段不能与名称字段相同', ErrCode.PARAM);
      const pf = this.db.one<any>('SELECT id FROM md_field WHERE model_id = ? AND field_key = ?', id, parentField);
      if (!pf) throw new BizException('层级字段必须存在于模型字段中', ErrCode.PARAM);
    }
    this.db.run(
      'UPDATE md_model SET name = ?, name_key = ?, description = ?, parent_field = ?, updated_at = ? WHERE id = ?',
      dto.name ?? model.name, nameKey, dto.description ?? model.description, parentField, nowStr(), id,
    );
    this.audit.log(user, 'metadata', 'MODEL_UPDATE', `修改模型 ${dto.name || model.name}`, { ...dto, parentField });
    return this.model(id);
  }

  saveField(modelId: number, dto: any, user: AuthUser) {
    const model = this.db.one<any>('SELECT * FROM md_model WHERE id = ?', modelId);
    if (!model) throw new BizException('模型不存在', ErrCode.NOT_FOUND);
    const key = String(dto.fieldKey || '').trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) throw new BizException('字段标识需以字母开头，仅含字母/数字/下划线', ErrCode.PARAM);
    if (!dto.label) throw new BizException('字段名称不能为空', ErrCode.PARAM);
    const type = String(dto.type || 'TEXT').toUpperCase();
    if (!FIELD_TYPES.includes(type)) throw new BizException('不支持的字段类型', ErrCode.PARAM);
    if (type === 'ENUM') {
      if (!dto.dictCode) throw new BizException('枚举字段必须绑定码表', ErrCode.PARAM);
      const dict = this.db.one<any>('SELECT code FROM md_dict WHERE code = ?', dto.dictCode);
      if (!dict) throw new BizException('码表不存在', ErrCode.NOT_FOUND);
    }
    if (type === 'REF' && !dto.refDomain) throw new BizException('引用字段必须指定引用主数据域', ErrCode.PARAM);
    let existing = this.db.one<any>('SELECT * FROM md_field WHERE model_id = ? AND field_key = ?', modelId, key);
    if (!existing && dto.id) existing = this.db.one<any>('SELECT * FROM md_field WHERE id = ? AND model_id = ?', dto.id, modelId);
    const sort = dto.sort ?? (existing?.sort ?? (this.db.one<any>('SELECT MAX(sort) AS m FROM md_field WHERE model_id = ?', modelId)?.m || 0) + 1);
    if (existing) {
      this.db.run(
        'UPDATE md_field SET field_key = ?, label = ?, type = ?, required = ?, unique_flag = ?, query_flag = ?, dict_code = ?, ref_domain = ?, max_length = ?, regex = ?, placeholder = ?, sort = ? WHERE id = ?',
        key, dto.label, type, dto.required ? 1 : 0, dto.uniqueFlag ? 1 : 0, dto.queryFlag ? 1 : 0,
        type === 'ENUM' ? dto.dictCode : null, type === 'REF' ? dto.refDomain : null,
        dto.maxLength ?? null, dto.regex ?? null, dto.placeholder ?? null, sort, existing.id,
      );
    } else {
      this.db.run(
        'INSERT INTO md_field (model_id, field_key, label, type, required, unique_flag, query_flag, dict_code, ref_domain, max_length, regex, placeholder, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        modelId, key, dto.label, type, dto.required ? 1 : 0, dto.uniqueFlag ? 1 : 0, dto.queryFlag ? 1 : 0,
        type === 'ENUM' ? dto.dictCode : null, type === 'REF' ? dto.refDomain : null,
        dto.maxLength ?? null, dto.regex ?? null, dto.placeholder ?? null, sort,
      );
    }
    if (model.status === 'PUBLISHED' && dto.queryFlag) this.index.ensureColumn(key);
    this.db.run('UPDATE md_model SET updated_at = ? WHERE id = ?', nowStr(), modelId);
    this.audit.log(user, 'metadata', existing ? 'FIELD_UPDATE' : 'FIELD_CREATE', `${model.name} 字段 ${dto.label}`, dto);
    return this.model(modelId);
  }

  deleteField(modelId: number, fieldId: number, user: AuthUser) {
    const field = this.db.one<any>('SELECT * FROM md_field WHERE id = ? AND model_id = ?', fieldId, modelId);
    if (!field) throw new BizException('字段不存在', ErrCode.NOT_FOUND);
    const model = this.db.one<any>('SELECT * FROM md_model WHERE id = ?', modelId);
    if (model.name_key === field.field_key) throw new BizException('名称字段不可删除', ErrCode.BUSINESS);
    this.db.run('DELETE FROM md_field WHERE id = ?', fieldId);
    this.audit.log(user, 'metadata', 'FIELD_DELETE', `${model.name} 删除字段 ${field.label}`, field.field_key);
    return this.model(modelId);
  }

  compat(id: number) {
    const model = this.model(id);
    const records = this.db.all<any>('SELECT data FROM md_master_data WHERE domain_code = ? AND deleted = 0 LIMIT 5000', model.domain_code);
    const samples: Record<string, number> = {};
    for (const r of records) {
      const d = parseJson(r.data, {});
      for (const f of model.fields) if (d[f.field_key] !== undefined && d[f.field_key] !== null && d[f.field_key] !== '') samples[f.field_key] = (samples[f.field_key] || 0) + 1;
    }
    const newFields = model.fields.filter((f) => !samples[f.field_key]);
    return {
      recordCount: model.record_count,
      sampled: records.length,
      emptyFields: model.fields.filter((f) => !samples[f.field_key]).map((f) => f.label),
      indexed: model.fields.filter((f) => f.query_flag).map((f) => ({ key: f.field_key, label: f.label, created: this.index.hasColumn(f.field_key) })),
      strategyOptions: [
        { value: 'KEEP', label: '保留存量数据（新字段为空）' },
        { value: 'DEFAULT', label: '新字段填充默认值', enabled: false },
        { value: 'BLOCK', label: '阻断发布（存量数据必填缺失）', enabled: false },
      ],
      newFieldCount: newFields.length,
    };
  }

  publish(id: number, dto: any, user: AuthUser) {
    const model = this.model(id);
    if (!model.fields.length) throw new BizException('模型至少需要一个字段', ErrCode.BUSINESS);
    if (!model.fields.some((f) => f.field_key === model.name_key)) throw new BizException('名称字段未定义，无法发布', ErrCode.BUSINESS);
    if (model.fields.some((f) => f.unique_flag && f.query_flag === false)) {
      // 唯一字段建议建索引，但不阻断
    }
    const indexes = this.index.sync(id);
    const version = (model.version || 0) + 1;
    this.db.run("UPDATE md_model SET version = ?, status = 'PUBLISHED', published_at = ?, updated_at = ? WHERE id = ?", version, nowStr(), nowStr(), id);
    this.audit.log(user, 'metadata', 'MODEL_PUBLISH', `${model.name} 发布 v${version}`, {
      strategy: dto?.strategy || 'KEEP',
      indexed: indexes.indexed,
      created: indexes.created,
    });
    return { model: this.model(id), indexes, version };
  }

  // ---------- 码表 ----------
  dicts() {
    return this.db.all<any>(
      `SELECT d.*, (SELECT COUNT(*) FROM md_dict_item i WHERE i.dict_code = d.code AND i.status = 'ACTIVE') AS item_count
       FROM md_dict d ORDER BY d.id`,
    );
  }

  createDict(dto: any, user: AuthUser) {
    if (!dto.code || !dto.name) throw new BizException('码表编码与名称不能为空', ErrCode.PARAM);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(dto.code)) throw new BizException('码表编码需以字母开头', ErrCode.PARAM);
    if (this.db.one('SELECT id FROM md_dict WHERE code = ?', dto.code)) throw new BizException('码表编码已存在', ErrCode.BUSINESS);
    this.db.run('INSERT INTO md_dict (code, name, remark, is_tree) VALUES (?, ?, ?, ?)', dto.code, dto.name, dto.remark || null, dto.isTree ? 1 : 0);
    this.audit.log(user, 'metadata', 'DICT_CREATE', `新建码表 ${dto.name}`, dto.code);
    return this.dicts();
  }

  /** M5：编辑码表基础信息与树形开关 */
  updateDict(code: string, dto: any, user: AuthUser) {
    const dict = this.db.one<any>('SELECT * FROM md_dict WHERE code = ?', code);
    if (!dict) throw new BizException('码表不存在', ErrCode.NOT_FOUND);
    const isTree = dto.isTree === undefined ? dict.is_tree : (dto.isTree ? 1 : 0);
    this.db.run('UPDATE md_dict SET name = ?, remark = ?, is_tree = ? WHERE code = ?',
      dto.name || dict.name, dto.remark ?? dict.remark, isTree, code);
    this.audit.log(user, 'metadata', 'DICT_UPDATE', `修改码表 ${dto.name || dict.name}`, { code, isTree });
    return this.dictItems(code);
  }

  dictItems(code: string) {
    const dict = this.db.one<any>('SELECT * FROM md_dict WHERE code = ?', code);
    if (!dict) throw new BizException('码表不存在', ErrCode.NOT_FOUND);
    return {
      ...dict,
      items: this.db.all<any>('SELECT * FROM md_dict_item WHERE dict_code = ? ORDER BY sort, id', code),
    };
  }

  /** M5：树形码表防环校验——上级必须存在且不能形成循环（自己不能成为自己祖先） */
  private assertDictParent(code: string, value: string, parentValue: string | null) {
    if (!parentValue) return;
    if (parentValue === value) throw new BizException('上级码值不能是自身', ErrCode.PARAM);
    const parent = this.db.one<any>('SELECT * FROM md_dict_item WHERE dict_code = ? AND value = ?', code, parentValue);
    if (!parent) throw new BizException(`上级码值「${parentValue}」不存在`, ErrCode.PARAM);
    let cur: any = parent;
    const seen = new Set<string>();
    while (cur) {
      if (cur.value === value) throw new BizException('不能将自己的下级码值设为上级（会形成循环）', ErrCode.PARAM);
      if (seen.has(cur.value)) break; // 存量数据本身成环时避免死循环
      seen.add(cur.value);
      cur = cur.parent_value
        ? this.db.one<any>('SELECT * FROM md_dict_item WHERE dict_code = ? AND value = ?', code, cur.parent_value)
        : null;
    }
  }

  saveDictItem(code: string, dto: any, user: AuthUser) {
    const dict = this.db.one<any>('SELECT * FROM md_dict WHERE code = ?', code);
    if (!dict) throw new BizException('码表不存在', ErrCode.NOT_FOUND);
    if (!dto.value || !dto.label) throw new BizException('码值与显示名不能为空', ErrCode.PARAM);
    const existing = dto.id
      ? this.db.one<any>('SELECT * FROM md_dict_item WHERE id = ? AND dict_code = ?', dto.id, code)
      : this.db.one<any>('SELECT * FROM md_dict_item WHERE dict_code = ? AND value = ?', code, dto.value);
    // 上级码值：未传时保留原值，传空则清除
    const parentValue = dto.parentValue === undefined ? (existing?.parent_value ?? null) : (dto.parentValue || null);
    this.assertDictParent(code, String(dto.value), parentValue);
    if (existing) {
      this.db.run('UPDATE md_dict_item SET value = ?, label = ?, parent_value = ?, sort = ?, status = ? WHERE id = ?',
        dto.value, dto.label, parentValue, dto.sort ?? existing.sort, dto.status ?? existing.status, existing.id);
    } else {
      this.db.run('INSERT INTO md_dict_item (dict_code, value, label, parent_value, sort, status) VALUES (?, ?, ?, ?, ?, ?)',
        code, dto.value, dto.label, parentValue, dto.sort ?? 99, dto.status ?? 'ACTIVE');
    }
    this.audit.log(user, 'metadata', 'DICT_ITEM_SAVE', `${dict.name} 码值 ${dto.label}`, `${code}.${dto.value}`);
    return this.dictItems(code);
  }

  deleteDictItem(code: string, id: number, user: AuthUser) {
    const item = this.db.one<any>('SELECT * FROM md_dict_item WHERE id = ? AND dict_code = ?', id, code);
    if (!item) throw new BizException('码值不存在', ErrCode.NOT_FOUND);
    // M5：存在下级码值时禁止删除，避免悬空引用
    const children = this.db.one<any>(
      'SELECT COUNT(*) AS n FROM md_dict_item WHERE dict_code = ? AND parent_value = ?', code, item.value,
    )?.n;
    if (children) throw new BizException(`该码值存在 ${children} 个下级码值，请先删除或调整下级的上级指向`, ErrCode.STATE);
    const used = this.db.one<any>("SELECT COUNT(*) AS n FROM md_field WHERE dict_code = ? AND type = 'ENUM'", code)?.n;
    this.db.run('DELETE FROM md_dict_item WHERE id = ?', id);
    this.audit.log(user, 'metadata', 'DICT_ITEM_DELETE', `删除码值 ${item.label}`, `${code}.${item.value}`);
    return { ...this.dictItems(code), usedByFields: used };
  }

  // ---------- 编码规则 ----------
  codeRules() {
    const rules = this.db.all<any>(
      `SELECT r.*, d.name AS domain_name FROM md_code_rule r LEFT JOIN md_domain d ON d.code = r.domain_code ORDER BY r.id`,
    );
    return rules.map((r) => ({ ...r, segments: parseJson(r.segments, []), preview: this.tryPreview(r.domain_code) }));
  }

  private tryPreview(domain: string) {
    try {
      return this.codes.preview(domain);
    } catch (e: any) {
      return { code: '', error: e?.message };
    }
  }

  updateCodeRule(domain: string, dto: any, user: AuthUser) {
    const domainRow = this.db.one<any>('SELECT * FROM md_domain WHERE code = ?', domain);
    if (!domainRow) throw new BizException('主数据域不存在', ErrCode.NOT_FOUND);
    const segments = dto.segments;
    if (!Array.isArray(segments) || segments.length === 0) throw new BizException('编码规则至少需要一个段', ErrCode.PARAM);
    for (const seg of segments) {
      if (!['FIX', 'DATE', 'JOIN', 'SEQ'].includes(seg.type)) throw new BizException('不支持的规则段类型：' + seg.type, ErrCode.PARAM);
      if (seg.type === 'SEQ' && (!seg.len || seg.len < 1 || seg.len > 12)) throw new BizException('流水号长度需在 1~12 位', ErrCode.PARAM);
    }
    const existing = this.db.one<any>('SELECT * FROM md_code_rule WHERE domain_code = ?', domain);
    if (existing) {
      this.db.run('UPDATE md_code_rule SET name = ?, segments = ?, updated_at = ? WHERE domain_code = ?',
        dto.name || existing.name, JSON.stringify(segments), nowStr(), domain);
    } else {
      this.db.run('INSERT INTO md_code_rule (domain_code, name, segments, status, updated_at) VALUES (?, ?, ?, ?, ?)',
        domain, dto.name || `${domainRow.name}编码规则`, JSON.stringify(segments), 'ACTIVE', nowStr());
    }
    this.audit.log(user, 'metadata', 'CODE_RULE_UPDATE', `${domainRow.name} 编码规则`, dto);
    return this.codeRules().find((r) => r.domain_code === domain);
  }

  previewCode(domain: string) {
    return this.codes.preview(domain);
  }
}
