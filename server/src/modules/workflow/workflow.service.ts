import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { AuthUser } from '../../common/decorators';
import { BizException, ErrCode } from '../../common/errors';
import { nowStr, paged, parseJson } from '../../common/util';
import { MasterService } from '../master/master.service';

/** 工作流算子类型：与前端工具箱保持一致 */
export const NODE_TYPES = [
  { type: 'DB_INPUT', name: '读取主数据', group: '输入' },
  { type: 'SELECT', name: '字段选择', group: '加工' },
  { type: 'FILTER', name: '条件过滤', group: '加工' },
  { type: 'FORMULA', name: '公式计算', group: '加工' },
  { type: 'DEDUP', name: '去重', group: '加工' },
  { type: 'SORT', name: '排序', group: '加工' },
  { type: 'AGG', name: '分组聚合', group: '加工' },
  { type: 'JOIN', name: '数据关联', group: '关联' },
  { type: 'UNION', name: '并集合', group: '关联' },
  { type: 'CODE_MAP', name: '码值映射', group: '清洗' },
  { type: 'NORMALIZE', name: '标准化', group: '清洗' },
  { type: 'FILL_EMPTY', name: '空值填充', group: '清洗' },
  { type: 'OUTPUT', name: '预览输出', group: '输出' },
];
const TYPE_NAMES: Record<string, string> = Object.fromEntries(NODE_TYPES.map((n) => [n.type, n.name]));
const MAX_PREVIEW = 50;

/** 极简安全表达式求值：仅支持 + - * / ( ) 与字段名，不执行任意代码 */
function evalExpression(expr: string, row: Record<string, any>): number {
  const tokens = String(expr || '').match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[-+*/()]/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parsePrimary = (): number => {
    const t = next();
    if (t === undefined) throw new Error('表达式不完整');
    if (t === '(') {
      const v = parseExpr();
      if (next() !== ')') throw new Error('括号不匹配');
      return v;
    }
    if (t === '-') return -parsePrimary();
    if (/^\d/.test(t)) return Number(t);
    if (/^[A-Za-z_$]/.test(t)) {
      const v = row[t];
      const n = Number(v);
      if (v === null || v === undefined || v === '' || Number.isNaN(n)) throw new Error(`字段 ${t} 不是数值`);
      return n;
    }
    throw new Error('非法字符');
  };
  const parseTerm = (): number => {
    let v = parsePrimary();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = parsePrimary();
      if (op === '/' && r === 0) throw new Error('除数不能为 0');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const val = parseExpr();
  if (pos < tokens.length) throw new Error('表达式含无法识别的内容');
  if (!Number.isFinite(val)) throw new Error('计算结果非法');
  return Math.round(val * 100) / 100;
}

function isEmpty(v: any) {
  return v === undefined || v === null || String(v).trim() === '';
}

@Injectable()
export class WorkflowService {
  constructor(
    private db: DbService,
    private master: MasterService,
  ) {}

  private allowedDomains(user: AuthUser): string[] {
    const all = this.db.all<any>("SELECT code FROM md_domain WHERE status = 'ACTIVE' ORDER BY sort").map((d) => d.code);
    if (user?.roles?.includes('SYS_ADMIN')) return all;
    return all.filter((c) => (user?.domains || []).includes(c));
  }

  /** 工具箱元数据：数据域、模型字段与算子目录 */
  meta(user: AuthUser) {
    const allowed = this.allowedDomains(user);
    const domains = this.db
      .all<any>("SELECT code, name FROM md_domain WHERE status = 'ACTIVE' ORDER BY sort")
      .filter((d) => allowed.includes(d.code))
      .map((d) => {
        const fields = this.db.all<any>(
          `SELECT f.field_key, f.label, f.type FROM md_field f JOIN md_model m ON m.id = f.model_id
           WHERE m.domain_code = ? ORDER BY f.sort`,
          d.code,
        );
        return {
          ...d,
          records: this.db.one<any>(
            "SELECT COUNT(*) AS n FROM md_master_data WHERE domain_code = ? AND deleted = 0 AND status = 'PUBLISHED'",
            d.code,
          )?.n || 0,
          fields,
        };
      });
    const dicts = this.db.all<any>('SELECT code, name FROM md_dict ORDER BY code');
    return { nodeTypes: NODE_TYPES, domains, dicts };
  }

  definitions(user: AuthUser, query: any) {
    const allowed = this.allowedDomains(user);
    if (!allowed.length) return [];
    const conds = [`d.domain_code IN (${allowed.map(() => '?').join(',')})`];
    const params: any[] = [...allowed];
    if (query?.domain) {
      conds.push('d.domain_code = ?');
      params.push(query.domain);
    }
    if (query?.keyword) {
      conds.push('(d.name LIKE ? OR d.code LIKE ?)');
      const kw = `%${query.keyword}%`;
      params.push(kw, kw);
    }
    return this.db.all<any>(
      `SELECT d.*, m.name AS domain_name,
        (SELECT COUNT(*) FROM wf_run r WHERE r.definition_id = d.id) AS run_count,
        (SELECT created_at FROM wf_run r WHERE r.definition_id = d.id ORDER BY r.id DESC LIMIT 1) AS last_run_at,
        (SELECT status FROM wf_run r WHERE r.definition_id = d.id ORDER BY r.id DESC LIMIT 1) AS last_status
       FROM wf_definition d LEFT JOIN md_domain m ON m.code = d.domain_code
       WHERE ${conds.join(' AND ')} ORDER BY d.id DESC`,
      ...params,
    ).map((d) => ({ ...d, nodes: parseJson(d.nodes, []) }));
  }

  definition(user: AuthUser, id: number) {
    const def = this.db.one<any>('SELECT * FROM wf_definition WHERE id = ?', id);
    if (!def) throw new BizException('工作流定义不存在', ErrCode.NOT_FOUND);
    if (!this.allowedDomains(user).includes(def.domain_code)) throw new BizException('无权访问该数据域', ErrCode.FORBIDDEN);
    return { ...def, nodes: parseJson(def.nodes, []) };
  }

  saveDefinition(user: AuthUser, dto: any) {
    const code = String(dto?.code || '').trim();
    const name = String(dto?.name || '').trim();
    const domainCode = String(dto?.domainCode || dto?.domain_code || '').trim();
    const description = String(dto?.description || '').trim() || null;
    const status = String(dto?.status || 'DRAFT').toUpperCase();
    const nodes = dto?.nodes;
    if (!code || !name || !domainCode) throw new BizException('编码、名称与数据域不能为空', ErrCode.PARAM);
    if (!Array.isArray(nodes) || !nodes.length) throw new BizException('工作流至少需要一个节点', ErrCode.PARAM);
    if (!['DRAFT', 'PUBLISHED'].includes(status)) throw new BizException('状态仅支持 DRAFT / PUBLISHED', ErrCode.PARAM);
    const allowed = this.allowedDomains(user);
    if (!allowed.includes(domainCode)) throw new BizException('无权访问该数据域', ErrCode.FORBIDDEN);
    for (const n of nodes) {
      if (!n?.id || !n?.type || !NODE_TYPES.some((t) => t.type === n.type) || !n?.name) {
        throw new BizException('节点结构不完整或类型不合法', ErrCode.PARAM);
      }
    }

    const id = Number(dto?.id || 0);
    const ts = nowStr();
    const nodesJson = JSON.stringify(nodes);
    if (id) {
      const exists = this.db.one<any>('SELECT * FROM wf_definition WHERE id = ?', id);
      if (!exists) throw new BizException('工作流定义不存在', ErrCode.NOT_FOUND);
      const dup = this.db.one<any>('SELECT id FROM wf_definition WHERE code = ? AND id <> ?', code, id);
      if (dup) throw new BizException('工作流编码已存在', ErrCode.DUP);
      this.db.run(
        'UPDATE wf_definition SET code = ?, name = ?, domain_code = ?, description = ?, nodes = ?, status = ?, updated_at = ? WHERE id = ?',
        code, name, domainCode, description, nodesJson, status, ts, id,
      );
      return { id };
    }
    if (this.db.one<any>('SELECT id FROM wf_definition WHERE code = ?', code)) throw new BizException('工作流编码已存在', ErrCode.DUP);
    const r = this.db.run(
      'INSERT INTO wf_definition (code, name, domain_code, description, nodes, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      code, name, domainCode, description, nodesJson, status, user.displayName, ts, ts,
    );
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'workflow', 'DEF_CREATE', name, code, ts);
    return { id: Number(r.lastInsertRowid) };
  }

  // ---------------------------------------------------------------- 执行引擎
  run(user: AuthUser, definitionId: number) {
    const def = this.definition(user, definitionId);
    const nodes = Array.isArray(def.nodes) ? def.nodes : parseJson<any[]>(def.nodes, []);
    if (!nodes.length) throw new BizException('工作流没有可执行节点', ErrCode.STATE);

    const startedAt = nowStr();
    const runId = this.db.tx(() => {
      const r = this.db.run(
        'INSERT INTO wf_run (definition_id, status, started_at, row_count, created_by) VALUES (?, ?, ?, 0, ?)',
        def.id, 'RUNNING', startedAt, user.displayName,
      );
      return Number(r.lastInsertRowid);
    });

    let rows: Array<Record<string, any>> = [];
    let failed = false;
    let message = '';
    const outputs: any[] = [];

    for (const node of nodes) {
      const t0 = Date.now();
      const rowsIn = rows.length;
      let nodeMessage = '';
      try {
        const cfg = node.config || {};
        switch (node.type) {
          case 'DB_INPUT':
            rows = this.loadInput(def.domain_code, cfg);
            nodeMessage = `读取 ${rows.length} 行`;
            break;
          case 'SELECT': {
            const fields: string[] = Array.isArray(cfg.fields) ? cfg.fields : [];
            rows = fields.length ? rows.map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]]))) : rows;
            break;
          }
          case 'FILTER': {
            const conditions: any[] = Array.isArray(cfg.conditions) && cfg.conditions.length
              ? cfg.conditions
              : cfg.field ? [{ field: cfg.field, op: cfg.op, value: cfg.value }] : [];
            const logic = String(cfg.logic || 'AND').toUpperCase();
            rows = rows.filter((r) => {
              if (!conditions.length) return true;
              const ok = (c: any) => {
                const v = r[c.field];
                switch (c.op) {
                  case 'eq': return String(v) === String(c.value);
                  case 'ne': return String(v) !== String(c.value);
                  case 'contains': return String(v ?? '').includes(String(c.value ?? ''));
                  case 'notContains': return !String(v ?? '').includes(String(c.value ?? ''));
                  case 'gt': return Number(v) > Number(c.value);
                  case 'gte': return Number(v) >= Number(c.value);
                  case 'lt': return Number(v) < Number(c.value);
                  case 'lte': return Number(v) <= Number(c.value);
                  case 'notEmpty': return !isEmpty(v);
                  case 'empty': return isEmpty(v);
                  case 'regex': {
                    try { return new RegExp(String(c.value)).test(String(v ?? '')); } catch { return true; }
                  }
                  default: return true;
                }
              };
              return logic === 'OR' ? conditions.some(ok) : conditions.every(ok);
            });
            nodeMessage = `保留 ${rows.length} 行`;
            break;
          }
          case 'FORMULA': {
            if (!cfg.target || !cfg.expression) throw new Error('公式节点需配置目标字段与表达式');
            rows = rows.map((r) => ({ ...r, [cfg.target]: evalExpression(cfg.expression, r) }));
            nodeMessage = `计算 ${cfg.target}`;
            break;
          }
          case 'DEDUP': {
            const fields: string[] = Array.isArray(cfg.fields) && cfg.fields.length ? cfg.fields : cfg.field ? [cfg.field] : [];
            if (fields.length) {
              const seen = new Set<string>();
              rows = rows.filter((r) => {
                const key = fields.map((f) => String(r[f] ?? '').trim().toLowerCase()).join('\u0001');
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
            }
            nodeMessage = `去重后 ${rows.length} 行`;
            break;
          }
          case 'SORT': {
            const field = cfg.field;
            const dir = String(cfg.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
            if (field) {
              rows = rows.slice().sort((a, b) => {
                const x = a[field];
                const y = b[field];
                if (x === y) return 0;
                if (x === undefined || x === null) return 1;
                if (y === undefined || y === null) return -1;
                if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
                return String(x).localeCompare(String(y), 'zh-CN') * dir;
              });
            }
            break;
          }
          case 'AGG': {
            const groupBy: string[] = Array.isArray(cfg.groupBy) ? cfg.groupBy : cfg.groupBy ? [cfg.groupBy] : [];
            const metrics: any[] = Array.isArray(cfg.metrics) ? cfg.metrics : [];
            const groups = new Map<string, Record<string, any>>();
            for (const r of rows) {
              const key = groupBy.map((g) => String(r[g] ?? '')).join('\u0001');
              if (!groups.has(key)) {
                const g: Record<string, any> = {};
                for (const f of groupBy) g[f] = r[f];
                for (const m of metrics) g[m.as || `${m.field}_${m.agg}`] = m.agg === 'max' || m.agg === 'min' ? null : 0;
                groups.set(key, g);
              }
              const g = groups.get(key)!;
              for (const m of metrics) {
                const col = m.as || `${m.field}_${m.agg}`;
                const v = Number(r[m.field]);
                switch (m.agg) {
                  case 'count': g[col] += 1; break;
                  case 'sum': g[col] += Number.isNaN(v) ? 0 : v; break;
                  case 'avg': {
                    const cntKey = `__cnt_${col}`;
                    const sumKey = `__sum_${col}`;
                    g[sumKey] = (g[sumKey] || 0) + (Number.isNaN(v) ? 0 : v);
                    g[cntKey] = (g[cntKey] || 0) + (Number.isNaN(v) ? 0 : 1);
                    g[col] = g[cntKey] ? Math.round((g[sumKey] / g[cntKey]) * 100) / 100 : 0;
                    break;
                  }
                  case 'max': {
                    if (!Number.isNaN(v)) g[col] = g[col] === null ? v : Math.max(g[col], v);
                    break;
                  }
                  case 'min': {
                    if (!Number.isNaN(v)) g[col] = g[col] === null ? v : Math.min(g[col], v);
                    break;
                  }
                  default: break;
                }
              }
            }
            const out: any[] = [];
            for (const g of groups.values()) {
              for (const k of Object.keys(g)) if (k.startsWith('__')) delete g[k];
              out.push(g);
            }
            rows = out;
            nodeMessage = `聚合为 ${rows.length} 组`;
            break;
          }
          case 'JOIN': {
            const joinDomain = String(cfg.joinDomain || '').trim();
            const joinType = String(cfg.joinType || 'inner').toLowerCase();
            const leftKey = String(cfg.leftKey || '').trim();
            const rightKey = String(cfg.rightKey || '').trim();
            if (!joinDomain) throw new Error('关联节点需指定右表数据域');
            if (!leftKey || !rightKey) throw new Error('关联节点需配置左表与右表连接键');
            if (!['inner', 'left', 'right', 'full'].includes(joinType)) throw new Error(`不支持的连接类型：${joinType}`);
            if (!this.allowedDomains(user).includes(joinDomain)) throw new Error(`无权访问关联数据域：${joinDomain}`);
            const rightRows = this.loadInput(joinDomain, { status: cfg.joinStatus, limit: cfg.limit });
            // 右表保留字段：未指定则取全部（去掉连接键避免重名）
            const rightFields: string[] = Array.isArray(cfg.rightFields) && cfg.rightFields.length
              ? cfg.rightFields.map((f: any) => String(f))
              : Array.from(new Set(rightRows.flatMap((r) => Object.keys(r)))).filter((k) => k !== rightKey);
            const index = new Map<string, Array<Record<string, any>>>();
            for (const r of rightRows) {
              const k = String(r[rightKey] ?? '').trim();
              if (!k) continue;
              const list = index.get(k);
              if (list) list.push(r);
              else index.set(k, [r]);
            }
            const mergeRight = (left: Record<string, any>, right?: Record<string, any>) => {
              const out = { ...left };
              for (const f of rightFields) {
                const name = f in out ? `r_${f}` : f;
                out[name] = right ? right[f] : null;
              }
              return out;
            };
            const matched = new Set<Record<string, any>>();
            let outRows: Array<Record<string, any>> = [];
            for (const l of rows) {
              const hits = index.get(String(l[leftKey] ?? '').trim()) || [];
              if (hits.length) {
                for (const h of hits) {
                  matched.add(h);
                  outRows.push(mergeRight(l, h));
                }
              } else if (joinType === 'left' || joinType === 'full') {
                outRows.push(mergeRight(l));
              }
            }
            if (joinType === 'right' || joinType === 'full') {
              for (const r of rightRows) if (!matched.has(r)) outRows.push(mergeRight({}, r));
            }
            rows = outRows;
            nodeMessage = `${joinType} 连接后 ${rows.length} 行`;
            break;
          }
          case 'UNION': {
            const unionDomain = String(cfg.unionDomain || '').trim();
            if (!unionDomain) throw new Error('并集节点需指定追加数据域');
            if (!this.allowedDomains(user).includes(unionDomain)) throw new Error(`无权访问追加数据域：${unionDomain}`);
            const extra = this.loadInput(unionDomain, { status: cfg.unionStatus, limit: cfg.limit });
            rows = [...rows, ...extra];
            nodeMessage = `并集后 ${rows.length} 行`;
            break;
          }
          case 'CODE_MAP': {
            const field = String(cfg.field || '').trim();
            if (!field) throw new Error('码值映射节点需配置目标字段');
            const map = new Map<string, string>();
            if (String(cfg.mode || 'manual') === 'dict') {
              const dictCode = String(cfg.dictCode || '').trim();
              if (!dictCode) throw new Error('字典模式需指定码表编码');
              for (const it of this.db.all<any>(
                "SELECT value, label FROM md_dict_item WHERE dict_code = ? AND status = 'ACTIVE' ORDER BY sort",
                dictCode,
              )) map.set(String(it.value), String(it.label));
              if (!map.size) throw new Error(`码表 ${dictCode} 无可用码值`);
            } else {
              for (const m of Array.isArray(cfg.mapping) ? cfg.mapping : []) {
                if (m && String(m.from ?? '') !== '') map.set(String(m.from), String(m.to ?? ''));
              }
            }
            const defaultVal = cfg.defaultVal === undefined || cfg.defaultVal === null || cfg.defaultVal === ''
              ? null
              : String(cfg.defaultVal);
            let hit = 0;
            rows = rows.map((r) => {
              if (isEmpty(r[field])) return r;
              const key = String(r[field]).trim();
              if (map.has(key)) {
                hit++;
                return { ...r, [field]: map.get(key) };
              }
              if (defaultVal !== null) return { ...r, [field]: defaultVal };
              return r; // 未命中且无默认值：保留原值
            });
            nodeMessage = `码值映射命中 ${hit} 行`;
            break;
          }
          case 'NORMALIZE': {
            const fields: string[] = Array.isArray(cfg.fields) && cfg.fields.length
              ? cfg.fields.map((f: any) => String(f))
              : cfg.field ? [String(cfg.field)] : [];
            if (!fields.length) throw new Error('标准化节点需配置字段');
            const toCase = String(cfg.case || '').toLowerCase();
            const replaces: any[] = Array.isArray(cfg.replace) ? cfg.replace : [];
            rows = rows.map((r) => {
              const out = { ...r };
              for (const f of fields) {
                if (isEmpty(out[f])) continue;
                let v = String(out[f]);
                if (cfg.trim) v = v.trim();
                for (const rep of replaces) {
                  if (rep && String(rep.from ?? '') !== '') v = v.split(String(rep.from)).join(String(rep.to ?? ''));
                }
                if (toCase === 'upper') v = v.toUpperCase();
                else if (toCase === 'lower') v = v.toLowerCase();
                out[f] = v;
              }
              return out;
            });
            nodeMessage = `标准化 ${fields.length} 个字段`;
            break;
          }
          case 'FILL_EMPTY': {
            const fills: any[] = Array.isArray(cfg.fills) ? cfg.fills : [];
            if (!fills.length) throw new Error('空值填充节点需配置填充规则');
            let filled = 0;
            rows = rows.map((r) => {
              const out = { ...r };
              for (const f of fills) {
                const key = f && String(f.field || '').trim();
                if (key && isEmpty(out[key])) {
                  out[key] = f.value === undefined || f.value === null ? '' : f.value;
                  filled++;
                }
              }
              return out;
            });
            nodeMessage = `填充 ${filled} 个空值`;
            break;
          }
          case 'OUTPUT': {
            const fields: string[] = Array.isArray(cfg.fields) && cfg.fields.length ? cfg.fields : [];
            const result = fields.length ? rows.map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]]))) : rows;
            outputs.push({ nodeId: node.id, fields: Object.keys(result[0] || {}), rows: result.length });
            rows = result;
            if (cfg.submit) {
              const persist = this.persistOutput(user, def, cfg, rows);
              nodeMessage = `输出 ${rows.length} 行；写回主数据 ${persist.created} 条（跳过 ${persist.skipped}，失败 ${persist.failed}）`;
              if (persist.failed && persist.errors.length) {
                nodeMessage += `。首条失败原因：${persist.errors[0]}`;
              }
            } else {
              nodeMessage = `输出 ${rows.length} 行`;
            }
            break;
          }
          default:
            throw new Error(`不支持的算子：${node.type}`);
        }
      } catch (e: any) {
        nodeMessage = e.message || '节点执行失败';
        failed = true;
        this.db.run(
          'INSERT INTO wf_node_run (run_id, node_id, node_type, node_name, status, rows_in, rows_out, duration_ms, preview, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          runId, node.id, node.type, node.name, 'FAILED', rowsIn, 0, Date.now() - t0, '[]', nodeMessage,
        );
        message = `节点「${node.name}」执行失败：${nodeMessage}`;
        break;
      }
      const previewRows = rows.slice(0, MAX_PREVIEW);
      this.db.run(
        'INSERT INTO wf_node_run (run_id, node_id, node_type, node_name, status, rows_in, rows_out, duration_ms, preview, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        runId, node.id, node.type, node.name, 'SUCCESS', rowsIn, rows.length, Date.now() - t0,
        JSON.stringify(previewRows), nodeMessage || TYPE_NAMES[node.type],
      );
    }

    const finishedAt = nowStr();
    this.db.run(
      'UPDATE wf_run SET status = ?, finished_at = ?, row_count = ?, message = ? WHERE id = ?',
      failed ? 'FAILED' : 'SUCCESS', finishedAt, rows.length, message || null, runId,
    );
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'workflow', 'RUN', def.name, `运行 #${runId}，${rows.length} 行`, finishedAt);

    return this.runDetail(user, runId);
  }

  private loadInput(domainCode: string, cfg: any) {
    const limit = Math.min(2000, Math.max(1, Number(cfg.limit) || 500));
    const status = cfg.status ? String(cfg.status) : 'PUBLISHED';
    const records = this.db.all<any>(
      'SELECT id, master_code, name, data FROM md_master_data WHERE domain_code = ? AND deleted = 0 AND status = ? ORDER BY id LIMIT ?',
      domainCode, status, limit,
    );
    return records.map((r) => ({ recordId: r.id, masterCode: r.master_code, name: r.name, ...parseJson<any>(r.data, {}) }));
  }

  /**
   * OUTPUT 节点 submit 模式：将结果行写回主数据（复用 master 的新增 + 提交审批链路）。
   * 配置 keyField 后，已存在同值记录的行跳过，避免重复落库。
   */
  private persistOutput(user: AuthUser, def: any, cfg: any, rows: Array<Record<string, any>>) {
    const domain = String(cfg.domainCode || def.domain_code);
    const keyField = String(cfg.keyField || '').trim();
    if (keyField && !/^[A-Za-z0-9_$]+$/.test(keyField)) {
      throw new Error('写回键字段名不合法（仅支持字母、数字与下划线）');
    }
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const row of rows) {
      try {
        const keyVal = keyField ? String(row[keyField] ?? '').trim() : '';
        if (keyField && keyVal) {
          // 与唯一性校验口径一致：已归档记录不参与查重（支持重新落库）
          const exists = this.db.one<any>(
            `SELECT id FROM md_master_data WHERE domain_code = ? AND deleted = 0 AND status <> 'ARCHIVED'
             AND (master_code = ? OR json_extract(data, '$.${keyField}') = ?) LIMIT 1`,
            domain, keyVal, keyVal,
          );
          if (exists) {
            skipped++;
            continue;
          }
        }
        this.master.create(user, domain, { data: row, submit: true });
        created++;
      } catch (e: any) {
        failed++;
        if (errors.length < 3) {
          const raw = e?.getResponse?.();
          errors.push((typeof raw === 'object' && raw?.msg) || e?.message || '写入失败');
        }
      }
    }
    return { created, skipped, failed, errors };
  }

  runs(user: AuthUser, query: any) {
    const page = Math.max(1, Number(query?.page) || 1);
    const size = Math.min(100, Math.max(1, Number(query?.size) || 10));
    const allowed = this.allowedDomains(user);
    if (!allowed.length) return paged([], 0, page, size);
    const conds = [`d.domain_code IN (${allowed.map(() => '?').join(',')})`];
    const params: any[] = [...allowed];
    if (query?.definitionId) {
      conds.push('r.definition_id = ?');
      params.push(Number(query.definitionId));
    }
    const total = this.db.one<any>(
      `SELECT COUNT(*) AS n FROM wf_run r JOIN wf_definition d ON d.id = r.definition_id WHERE ${conds.join(' AND ')}`,
      ...params,
    )?.n || 0;
    const list = this.db.all<any>(
      `SELECT r.*, d.name AS definition_name, d.code AS definition_code, d.domain_code
       FROM wf_run r JOIN wf_definition d ON d.id = r.definition_id
       WHERE ${conds.join(' AND ')} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      ...params, size, (page - 1) * size,
    );
    return paged(list, total, page, size);
  }

  runDetail(user: AuthUser, id: number) {
    const run = this.db.one<any>(
      `SELECT r.*, d.name AS definition_name, d.code AS definition_code, d.domain_code, d.nodes AS definition_nodes
       FROM wf_run r JOIN wf_definition d ON d.id = r.definition_id WHERE r.id = ?`,
      id,
    );
    if (!run) throw new BizException('运行记录不存在', ErrCode.NOT_FOUND);
    if (!this.allowedDomains(user).includes(run.domain_code)) throw new BizException('无权访问该数据域', ErrCode.FORBIDDEN);
    const nodeRuns = this.db.all<any>('SELECT * FROM wf_node_run WHERE run_id = ? ORDER BY id', id).map((n) => ({
      ...n,
      preview: parseJson(n.preview, []),
    }));
    return {
      ...run,
      definition_nodes: parseJson(run.definition_nodes, []),
      nodeRuns,
      output: nodeRuns.length ? nodeRuns[nodeRuns.length - 1].preview : [],
    };
  }
}
