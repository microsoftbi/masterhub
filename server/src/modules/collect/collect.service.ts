import { Injectable } from '@nestjs/common';
import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import Database from 'better-sqlite3';
import { DbService } from '../../db/db.service';
import { AuditService } from '../../common/audit.service';
import { NoticeService } from '../../common/notice.service';
import { AuthUser } from '../../common/decorators';
import { BizException, ErrCode } from '../../common/errors';
import { nowStr, parseJson, toInt } from '../../common/util';
import { ImportService } from '../import/import.service';

/** 演示用 Mock 源数据：模拟 ERP 返回的"脏"数据（含空格、非标码值、缺失字段） */
const MOCK_SOURCES: Record<string, Array<Record<string, any>>> = {
  'SRC-ERP': [
    { erp_name: ' 内六角螺栓 M8x30 ', erp_spec: 'GB/T 70.1', erp_unit: '个', erp_category: '紧固件', erp_price: '1.25' },
    { erp_name: '工业轴承 6204', erp_spec: 'GB/T 276', erp_unit: '只', erp_category: '耗材', erp_price: '6.8' },
    { erp_name: '尼龙扎带 3x100', erp_spec: 'ZD-100', erp_unit: '个', erp_category: '耗材', erp_price: '0.35' },
    { erp_name: '外六角螺栓 M10x40', erp_spec: 'GB/T 5782', erp_unit: '件', erp_category: '紧固件', erp_price: '2.1' },
    { erp_name: '生锈垫片 8', erp_spec: 'GB/T 97.1', erp_unit: '个', erp_category: '原材料', erp_price: '0.1' },
  ],
};

/** 合法标识符（直连表名 / 增量时间戳字段名）：仅字母、数字与下划线 */
const IDENT_RE = /^[A-Za-z0-9_]{1,64}$/;

/** 时间戳比较：双方均为数字字面量时按数值比较，否则按字符串比较（ISO 时间字符串字典序即时间序） */
function tsGt(a: any, b: any): boolean {
  const na = Number(a);
  const nb = Number(b);
  const bothNum = a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb);
  return bothNum ? na > nb : String(a) > String(b);
}

/** 推进增量水位：仅当本次最大时间戳更大时才前进，绝不回退 */
function advanceTs(lastTs: string, maxTs: string | null): string | null {
  if (!maxTs) return lastTs || null;
  if (!lastTs || tsGt(maxTs, lastTs)) return maxTs;
  return lastTs;
}

/**
 * 采集接入（M4）：源系统注册、字段映射（含清洗规则与码值转换）、执行采集。
 * 采集结果复用导入校验链路（ImportService.validate）生成批次，走"预校验 → 提交入库"同一闭环。
 * M7 扩展：数据库直连通道（SQLite 只读）+ 基于时间戳的增量采集 + 执行留痕（src_collect_log）。
 */
@Injectable()
export class CollectService {
  constructor(
    private db: DbService,
    private audit: AuditService,
    private notice: NoticeService,
    private imports: ImportService,
  ) {}

  private assertDomain(user: AuthUser, domain: string) {
    if (user.roles.includes('SYS_ADMIN')) return;
    if (!user.domains.includes(domain)) throw new BizException(`无「${domain}」数据域的访问权限`, ErrCode.FORBIDDEN);
  }

  /** 源系统列表（含映射配置展开） */
  systems(user: AuthUser) {
    const rows = this.db.all<any>(
      `SELECT s.*, d.name AS domain_name FROM src_system s LEFT JOIN md_domain d ON d.code = s.domain_code ORDER BY s.id`,
    );
    return rows
      .filter((s) => user.roles.includes('SYS_ADMIN') || user.domains.includes(s.domain_code))
      .map((s) => {
        const m = this.db.one<any>('SELECT * FROM src_mapping WHERE system_id = ?', s.id);
        return {
          ...s,
          config: parseJson<any>(s.config, {}),
          fieldMaps: parseJson(m?.field_maps, []),
          valueMaps: parseJson(m?.value_maps, []),
          cleanRules: parseJson(m?.clean_rules, []),
          fields: this.db.all<any>(
            `SELECT f.field_key, f.label FROM md_field f JOIN md_model m ON m.id = f.model_id WHERE m.domain_code = ? ORDER BY f.sort`,
            s.domain_code,
          ),
        };
      });
  }

  /**
   * 校验并归一化通道配置（M7）：
   * - DB 直连：{ dbType, dbPath, tableName }，当前仅支持 SQLite，路径解析为绝对路径且文件必须存在；
   * - 增量：{ incremental, tsField }，lastTs 水位由服务端在执行时维护，不接收外部覆盖。
   */
  private normalizeConfig(channel: string, raw: any) {
    const c: any = {
      dbType: String(raw?.dbType || 'sqlite').toLowerCase(),
      dbPath: String(raw?.dbPath || '').trim(),
      tableName: String(raw?.tableName || '').trim(),
      incremental: !!raw?.incremental,
      tsField: String(raw?.tsField || '').trim(),
    };
    if (channel === 'DB') {
      if (c.dbType !== 'sqlite') throw new BizException('当前版本数据库直连仅支持 SQLite', ErrCode.PARAM);
      if (!c.dbPath) throw new BizException('数据库直连必须配置数据库文件路径', ErrCode.PARAM);
      if (!IDENT_RE.test(c.tableName)) throw new BizException('直连表名仅允许字母、数字与下划线', ErrCode.PARAM);
      const p = isAbsolute(c.dbPath) ? c.dbPath : resolve(process.cwd(), c.dbPath);
      if (!existsSync(p)) throw new BizException(`数据库文件不存在：${c.dbPath}`, ErrCode.PARAM);
      c.dbPath = p;
    } else {
      c.dbType = 'sqlite';
      c.dbPath = '';
      c.tableName = '';
    }
    if (c.incremental) {
      if (!IDENT_RE.test(c.tsField)) throw new BizException('启用增量采集时必须配置有效的时间戳字段名', ErrCode.PARAM);
    } else {
      c.tsField = '';
    }
    return c;
  }

  /** 保存源系统与映射（同一表单一起提交） */
  saveSystem(user: AuthUser, dto: any) {
    const code = String(dto?.code || '').trim();
    const name = String(dto?.name || '').trim();
    const domainCode = String(dto?.domainCode || '').trim();
    const channel = String(dto?.channel || 'API').toUpperCase();
    const endpoint = String(dto?.endpoint || '').trim() || null;
    const apiKey = String(dto?.apiKey || '').trim() || null;
    if (!code || !name || !domainCode) throw new BizException('编码、名称与数据域不能为空', ErrCode.PARAM);
    if (!['API', 'FILE', 'DB'].includes(channel)) throw new BizException('通道类型仅支持 API / FILE / DB', ErrCode.PARAM);
    if (channel === 'API' && !endpoint) throw new BizException('API 通道必须配置拉取地址', ErrCode.PARAM);
    if (!this.db.one<any>("SELECT code FROM md_domain WHERE code = ? AND status = 'ACTIVE'", domainCode)) {
      throw new BizException('数据域不存在', ErrCode.PARAM);
    }
    this.assertDomain(user, domainCode);
    const config = this.normalizeConfig(channel, dto?.config);
    const fieldMaps = Array.isArray(dto?.fieldMaps) ? dto.fieldMaps : [];
    for (const fm of fieldMaps) {
      if (!fm?.source || !fm?.target) throw new BizException('字段映射的源字段与目标字段均不能为空', ErrCode.PARAM);
    }
    if (!fieldMaps.length) throw new BizException('至少配置一条字段映射', ErrCode.PARAM);

    const ts = nowStr();
    const id = Number(dto?.id || 0);
    if (id) {
      const exists = this.db.one<any>('SELECT * FROM src_system WHERE id = ?', id);
      if (!exists) throw new BizException('源系统不存在', ErrCode.NOT_FOUND);
      const dup = this.db.one<any>('SELECT id FROM src_system WHERE code = ? AND id <> ?', code, id);
      if (dup) throw new BizException('源系统编码已存在', ErrCode.DUP);
      // 增量水位 lastTs 由服务端维护：编辑时保留原值
      const prev = parseJson<any>(exists.config, {}) || {};
      const mergedConfig = JSON.stringify({ ...config, lastTs: prev.lastTs || null });
      this.db.run(
        'UPDATE src_system SET code = ?, name = ?, domain_code = ?, channel = ?, endpoint = ?, api_key = ?, status = ?, remark = ?, config = ?, updated_at = ? WHERE id = ?',
        code, name, domainCode, channel, endpoint, apiKey, dto?.status === false || dto?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        String(dto?.remark || '').trim() || null, mergedConfig, ts, id,
      );
      this.db.run(
        `UPDATE src_mapping SET domain_code = ?, field_maps = ?, value_maps = ?, clean_rules = ?, updated_at = ? WHERE system_id = ?`,
        domainCode, JSON.stringify(fieldMaps), JSON.stringify(dto?.valueMaps || []), JSON.stringify(dto?.cleanRules || []), ts, id,
      );
      this.audit.log(user, 'collect', 'SYSTEM_UPDATE', `更新采集源：${name}`, code);
      return { id };
    }
    if (this.db.one<any>('SELECT id FROM src_system WHERE code = ?', code)) throw new BizException('源系统编码已存在', ErrCode.DUP);
    const sysId = this.db.tx(() => {
      const r = this.db.run(
        'INSERT INTO src_system (code, name, domain_code, channel, endpoint, api_key, status, remark, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        code, name, domainCode, channel, endpoint, apiKey,
        dto?.status === false || dto?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        String(dto?.remark || '').trim() || null, JSON.stringify({ ...config, lastTs: null }), ts, ts,
      );
      const sid = Number(r.lastInsertRowid);
      this.db.run(
        "INSERT INTO src_mapping (system_id, domain_code, field_maps, value_maps, clean_rules, status, updated_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)",
        sid, domainCode, JSON.stringify(fieldMaps), JSON.stringify(dto?.valueMaps || []), JSON.stringify(dto?.cleanRules || []), ts,
      );
      return sid;
    });
    this.audit.log(user, 'collect', 'SYSTEM_CREATE', `新增采集源：${name}`, code);
    return { id: sysId };
  }

  /** 执行采集：拉取 → 清洗 / 映射 / 码值转换 → CSV → 导入校验链路（批次） */
  async run(user: AuthUser, systemId: number) {
    const sys = this.db.one<any>('SELECT * FROM src_system WHERE id = ?', systemId);
    if (!sys) throw new BizException('源系统不存在', ErrCode.NOT_FOUND);
    if (sys.status !== 'ACTIVE') throw new BizException('源系统已停用', ErrCode.STATE);
    this.assertDomain(user, sys.domain_code);
    const mapping = this.db.one<any>('SELECT * FROM src_mapping WHERE system_id = ?', systemId);
    const fieldMaps = parseJson<any[]>(mapping?.field_maps, []);
    const valueMaps = parseJson<any[]>(mapping?.value_maps, []);
    const cleanRules = parseJson<string[]>(mapping?.clean_rules, []);

    const config = parseJson<any>(sys.config, {}) || {};
    const incremental = !!config.incremental && !!config.tsField;
    const lastTs = config.lastTs ? String(config.lastTs) : '';
    let maxTs: string | null = null; // 本次拉取全量数据中的最大时间戳（新的增量水位）

    const maxRows = Number(this.db.cfg('import.maxRows', 5000)) || 5000;
    let rows: any[];
    if (sys.channel === 'FILE') {
      throw new BizException('文件通道请使用「主数据维护 → 批量导入」上传', ErrCode.PARAM);
    } else if (sys.channel === 'DB') {
      // 数据库直连（SQLite 只读）：按配置读取外部表，支持时间戳增量过滤
      let db: Database.Database;
      try {
        db = new Database(config.dbPath, { readonly: true });
      } catch (e: any) {
        throw new BizException(`直连数据库打开失败：${e?.message || e}`, ErrCode.BUSINESS);
      }
      try {
        const where = incremental && lastTs ? ` WHERE "${config.tsField}" > ?` : '';
        const sql = `SELECT * FROM "${config.tableName}"${where} LIMIT ?`;
        rows = (where ? db.prepare(sql).all(lastTs, maxRows + 1) : db.prepare(sql).all(maxRows + 1)) as any[];
        if (incremental) {
          const mx = db.prepare(`SELECT MAX("${config.tsField}") AS v FROM "${config.tableName}"`).get() as any;
          maxTs = mx?.v === null || mx?.v === undefined ? null : String(mx.v);
        }
      } catch (e: any) {
        throw new BizException(`直连查询失败：${e?.message || e}`, ErrCode.BUSINESS);
      } finally {
        db.close();
      }
    } else {
      try {
        const res = await fetch(sys.endpoint, {
          headers: { 'X-Api-Key': sys.api_key || '' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: any = await res.json();
        // 兼容数组直返、{rows}、{data}、以及平台统一响应包裹 {code,msg,data:{rows}} 四种形态
        rows = Array.isArray(body)
          ? body
          : Array.isArray(body?.rows)
            ? body.rows
            : Array.isArray(body?.data)
              ? body.data
              : Array.isArray(body?.data?.rows)
                ? body.data.rows
                : [];
      } catch (e: any) {
        throw new BizException(`源系统拉取失败：${e?.message || e}`, ErrCode.BUSINESS);
      }
      if (incremental) {
        for (const raw of rows) {
          const v = raw?.[config.tsField];
          if (v === null || v === undefined) continue;
          const s = String(v);
          if (!maxTs || tsGt(s, maxTs)) maxTs = s;
        }
        if (lastTs) {
          rows = rows.filter((raw) => {
            const v = raw?.[config.tsField];
            return v !== null && v !== undefined && tsGt(String(v), lastTs);
          });
        }
      }
    }
    if (!Array.isArray(rows) || !rows.length) {
      if (incremental) {
        // 增量采集无新数据属正常情况：推进水位、留痕并返回空结果，不生成批次
        const skipTs = nowStr();
        const newLastTs = advanceTs(lastTs, maxTs);
        this.db.run('UPDATE src_system SET config = ?, last_run_at = ? WHERE id = ?',
          JSON.stringify({ ...config, lastTs: newLastTs }), skipTs, sys.id);
        this.db.run(
          'INSERT INTO src_collect_log (system_id, system_code, mode, pulled, valid, invalid, batch_id, last_ts, skipped, message, created_by, created_at) VALUES (?, ?, ?, 0, 0, 0, NULL, ?, 1, ?, ?, ?)',
          sys.id, sys.code, 'INCR', newLastTs, '本次无增量数据', user.username, skipTs,
        );
        this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          user.id, user.username, 'collect', 'RUN', `采集「${sys.name}」（增量）`, '无增量数据', skipTs);
        return { skipped: true, message: '本次无增量数据', id: 0, total: 0, valid: 0, invalid: 0, rows: [], lastTs: newLastTs };
      }
      throw new BizException('源系统返回数据为空', ErrCode.BUSINESS);
    }
    if (rows.length > maxRows) throw new BizException(`采集行数 ${rows.length} 超过上限 ${maxRows}`, ErrCode.BUSINESS);

    // 清洗 + 字段映射 + 码值转换
    const mapped = rows.map((raw) => {
      const out: Record<string, any> = {};
      for (const fm of fieldMaps) {
        let v = raw?.[fm.source];
        if (typeof v === 'string') {
          if (cleanRules.includes('trim')) v = v.trim();
          if (cleanRules.includes('upper')) v = v.toUpperCase();
        }
        const vm = valueMaps.find((m: any) => m.field === fm.target);
        if (vm?.map && v !== undefined && v !== null && vm.map[String(v)] !== undefined) v = vm.map[String(v)];
        out[fm.target] = v ?? '';
      }
      return out;
    });

    // 生成 CSV（表头用目标字段 key，导入校验支持按 key 匹配）并走统一校验链路
    const targets = fieldMaps.map((f: any) => f.target);
    const q = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [targets.map(q).join(',')];
    for (const row of mapped) lines.push(targets.map((t: string) => q(row[t])).join(','));

    const batch = this.imports.validate(user, sys.domain_code, {
      filename: `采集-${sys.code}-${nowStr().replace(/[:T]/g, '')}.csv`,
      content: lines.join('\r\n'),
    });
    const ts = nowStr();
    const newLastTs = incremental ? advanceTs(lastTs, maxTs) : null;
    this.db.run('UPDATE src_system SET last_run_at = ?, config = ? WHERE id = ?',
      ts, JSON.stringify({ ...config, lastTs: newLastTs }), sys.id);
    const modeLabel = incremental ? '增量' : '全量';
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'collect', 'RUN', `采集「${sys.name}」（${modeLabel}）`,
      `拉取 ${rows.length} 行，通过 ${batch.valid}，失败 ${batch.invalid}`, ts);
    this.db.run(
      'INSERT INTO src_collect_log (system_id, system_code, mode, pulled, valid, invalid, batch_id, last_ts, skipped, message, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)',
      sys.id, sys.code, incremental ? 'INCR' : 'FULL', rows.length, batch.valid, batch.invalid, batch.id, newLastTs, user.username, ts,
    );
    this.notice.send(
      [user.id], 'COLLECT', `「${sys.name}」采集完成`,
      `${modeLabel}拉取 ${rows.length} 行：校验通过 ${batch.valid} 行，失败 ${batch.invalid} 行（批次 #${batch.id}）`, '/integration',
    );
    return { ...batch, mode: incremental ? 'INCR' : 'FULL', lastTs: newLastTs };
  }

  /** 采集执行历史（M7 留痕）：分页返回，附源系统名称 */
  logs(query: any) {
    const page = Math.max(1, toInt(query?.page, 1));
    const size = Math.min(100, Math.max(1, toInt(query?.size, 20)));
    const total = (this.db.one<any>('SELECT COUNT(*) AS n FROM src_collect_log') || {}).n || 0;
    const list = this.db.all<any>(
      `SELECT l.*, s.name AS system_name FROM src_collect_log l LEFT JOIN src_system s ON s.id = l.system_id ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      size, (page - 1) * size,
    );
    return { list, total, page, size };
  }

  /** Mock 源接口：按注册的 API Key 提供演示数据 */
  mock(code: string, apiKey: string | undefined) {
    const sys = this.db.one<any>('SELECT * FROM src_system WHERE code = ?', code);
    if (!sys) throw new BizException('源系统未注册', ErrCode.PARAM);
    if (!sys.api_key || sys.api_key !== apiKey) throw new BizException('API Key 校验失败', ErrCode.FORBIDDEN);
    const rows = MOCK_SOURCES[code] || [];
    return { code, total: rows.length, rows };
  }
}
