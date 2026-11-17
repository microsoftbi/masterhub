import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { NoticeService } from '../../common/notice.service';
import { AuthUser } from '../../common/decorators';
import { BizException, ErrCode } from '../../common/errors';
import { dateOnly, nowStr, parseJson, paged } from '../../common/util';

/** 五维质量：完整 / 唯一 / 合法 / 一致 / 及时 */
export const DIMENSIONS = ['COMPLETENESS', 'UNIQUENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS'];
export const DIMENSION_LABELS: Record<string, string> = {
  COMPLETENESS: '完整性',
  UNIQUENESS: '唯一性',
  VALIDITY: '合法性',
  CONSISTENCY: '一致性',
  TIMELINESS: '及时性',
};
export const RULE_TYPES = ['NOT_EMPTY', 'UNIQUE', 'REGEX', 'RANGE', 'REF_EXISTS'];
const LEVELS = ['HIGH', 'MEDIUM', 'LOW'];

interface CheckResult {
  failed: boolean;
  message?: string;
}

@Injectable()
export class QualityService {
  constructor(
    private db: DbService,
    private notice: NoticeService,
  ) {}

  /** 数据域可见范围：管理员不受限，其余按数据权限 */
  private allowedDomains(user: AuthUser): string[] {
    const all = this.db.all<any>("SELECT code FROM md_domain WHERE status = 'ACTIVE' ORDER BY sort").map((d) => d.code);
    if (user?.roles?.includes('SYS_ADMIN')) return all;
    const own = user?.domains || [];
    return all.filter((c) => own.includes(c));
  }

  private domainCondition(user: AuthUser, column: string) {
    const codes = this.allowedDomains(user);
    if (!codes.length) return { sql: ' AND 1 = 0', params: [] as any[] };
    return { sql: ` AND ${column} IN (${codes.map(() => '?').join(',')})`, params: codes as any[] };
  }

  // ---------------------------------------------------------------- 概览
  /** 规则配置所需元数据：可见数据域及其模型字段 */
  meta(user: AuthUser) {
    const allowed = this.allowedDomains(user);
    const domains = this.db
      .all<any>("SELECT code, name FROM md_domain WHERE status = 'ACTIVE' ORDER BY sort")
      .filter((d) => allowed.includes(d.code))
      .map((d) => ({
        ...d,
        fields: this.db.all<any>(
          `SELECT f.field_key, f.label, f.type FROM md_field f JOIN md_model m ON m.id = f.model_id
           WHERE m.domain_code = ? ORDER BY f.sort`,
          d.code,
        ),
      }));
    return { domains, dimensions: DIMENSIONS, dimensionLabels: DIMENSION_LABELS, ruleTypes: RULE_TYPES };
  }

  overview(user: AuthUser) {
    const latest = this.db.one<any>("SELECT * FROM dq_task_run WHERE status = 'SUCCESS' ORDER BY id DESC LIMIT 1");
    const detail = parseJson<Record<string, any>>(latest?.detail, {});
    const dimIssues = this.db.all<any>(
      `SELECT dimension, COUNT(*) AS n FROM dq_issue WHERE status = 'OPEN' GROUP BY dimension`,
    );

    const dims = DIMENSIONS.map((dim) => ({
      dimension: dim,
      label: DIMENSION_LABELS[dim],
      score: detail?.[dim]?.score ?? (latest?.score ? Number(latest.score) : 100),
      issues: dimIssues.find((x) => x.dimension === dim)?.n || 0,
    }));

    const counts = this.db.one<any>(
      `SELECT
        SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status = 'FIXED' THEN 1 ELSE 0 END) AS fixed,
        SUM(CASE WHEN status = 'IGNORED' THEN 1 ELSE 0 END) AS ignored,
        COUNT(*) AS total
       FROM dq_issue`,
    ) || { open: 0, fixed: 0, ignored: 0, total: 0 };
    const high = this.db.one<any>("SELECT COUNT(*) AS n FROM dq_issue WHERE status = 'OPEN' AND level = 'HIGH'")?.n || 0;

    const trend = this.db.all<any>(
      `SELECT id, score, failed, created_at FROM dq_task_run WHERE status = 'SUCCESS' ORDER BY id DESC LIMIT 7`,
    ).reverse();

    const f = this.domainCondition(user, 'i.domain_code');
    const recentIssues = this.db.all<any>(
      `SELECT i.*, d.name AS domain_name, r.name AS rule_name
       FROM dq_issue i
       LEFT JOIN md_domain d ON d.code = i.domain_code
       LEFT JOIN dq_rule r ON r.id = i.rule_id
       WHERE 1 = 1${f.sql} ORDER BY i.id DESC LIMIT 8`,
      ...f.params,
    );

    return {
      score: latest?.score ?? 100,
      lastRunAt: latest?.created_at || null,
      dims,
      trend: trend.map((t) => ({ runId: t.id, score: t.score, failed: t.failed, at: t.created_at })),
      counts: {
        open: counts.open || 0,
        fixed: counts.fixed || 0,
        ignored: counts.ignored || 0,
        total: counts.total || 0,
        highOpen: high,
      },
      rules: this.db.one<any>('SELECT COUNT(*) AS n FROM dq_rule WHERE enabled = 1')?.n || 0,
      tasks: this.db.one<any>('SELECT COUNT(*) AS n FROM dq_task')?.n || 0,
      recentIssues,
    };
  }

  // ---------------------------------------------------------------- 规则
  rules(user: AuthUser, query: any) {
    const f = this.domainCondition(user, 'r.domain_code');
    const conds: string[] = [`1 = 1${f.sql}`];
    const params: any[] = [...f.params];
    if (query?.domain) {
      conds.push('r.domain_code = ?');
      params.push(query.domain);
    }
    if (query?.keyword) {
      conds.push('(r.name LIKE ? OR r.code LIKE ? OR r.field_key LIKE ?)');
      const kw = `%${query.keyword}%`;
      params.push(kw, kw, kw);
    }
    const rows = this.db.all<any>(
      `SELECT r.*, d.name AS domain_name,
        (SELECT COUNT(*) FROM dq_issue i WHERE i.rule_id = r.id AND i.status = 'OPEN') AS open_issues,
        (SELECT COUNT(*) FROM dq_issue i WHERE i.rule_id = r.id) AS total_issues
       FROM dq_rule r LEFT JOIN md_domain d ON d.code = r.domain_code
       WHERE ${conds.join(' AND ')} ORDER BY r.domain_code, r.id`,
      ...params,
    );
    return rows.map((r) => ({ ...r, enabled: !!r.enabled, params: parseJson(r.params, {}) }));
  }

  saveRule(user: AuthUser, dto: any) {
    const code = String(dto?.code || '').trim();
    const name = String(dto?.name || '').trim();
    const domainCode = String(dto?.domainCode || dto?.domain_code || '').trim();
    const dimension = String(dto?.dimension || '').trim();
    const ruleType = String(dto?.ruleType || dto?.rule_type || '').trim();
    const fieldKey = String(dto?.fieldKey || dto?.field_key || '').trim() || null;
    const level = String(dto?.level || 'MEDIUM').toUpperCase();
    if (!code || !name || !domainCode) throw new BizException('规则编码、名称与数据域不能为空', ErrCode.PARAM);
    if (!DIMENSIONS.includes(dimension)) throw new BizException('质量维度不合法', ErrCode.PARAM);
    if (!RULE_TYPES.includes(ruleType)) throw new BizException('规则类型不合法', ErrCode.PARAM);
    if (!LEVELS.includes(level)) throw new BizException('严重级别不合法', ErrCode.PARAM);
    if (!this.db.one<any>("SELECT code FROM md_domain WHERE code = ? AND status = 'ACTIVE'", domainCode)) {
      throw new BizException('数据域不存在', ErrCode.PARAM);
    }
    const params = dto?.params && typeof dto.params === 'object' ? JSON.stringify(dto.params) : '{}';
    const enabled = dto?.enabled === undefined ? 1 : dto.enabled ? 1 : 0;
    const ts = nowStr();
    const id = Number(dto?.id || 0);

    if (id) {
      const exists = this.db.one<any>('SELECT * FROM dq_rule WHERE id = ?', id);
      if (!exists) throw new BizException('规则不存在', ErrCode.NOT_FOUND);
      const dup = this.db.one<any>('SELECT id FROM dq_rule WHERE code = ? AND id <> ?', code, id);
      if (dup) throw new BizException('规则编码已存在', ErrCode.DUP);
      this.db.run(
        'UPDATE dq_rule SET code = ?, name = ?, domain_code = ?, dimension = ?, field_key = ?, rule_type = ?, params = ?, level = ?, enabled = ?, updated_at = ? WHERE id = ?',
        code, name, domainCode, dimension, fieldKey, ruleType, params, level, enabled, ts, id,
      );
      return { id };
    }

    if (this.db.one<any>('SELECT id FROM dq_rule WHERE code = ?', code)) throw new BizException('规则编码已存在', ErrCode.DUP);
    const r = this.db.run(
      'INSERT INTO dq_rule (code, name, domain_code, dimension, field_key, rule_type, params, level, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      code, name, domainCode, dimension, fieldKey, ruleType, params, level, enabled, ts, ts,
    );
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'quality', 'RULE_CREATE', name, code, ts);
    return { id: Number(r.lastInsertRowid) };
  }

  // ---------------------------------------------------------------- 任务
  tasks(user: AuthUser) {
    const allowed = this.allowedDomains(user);
    if (!allowed.length) return [];
    const rows = this.db.all<any>(
      `SELECT t.*, d.name AS domain_name,
        (SELECT score FROM dq_task_run r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_score,
        (SELECT failed FROM dq_task_run r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_failed,
        (SELECT id FROM dq_task_run r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_run_id
       FROM dq_task t LEFT JOIN md_domain d ON d.code = t.domain_code
       WHERE (t.domain_code IS NULL OR t.domain_code = '' OR t.domain_code IN (${allowed.map(() => '?').join(',')}))
       ORDER BY t.id`,
      ...allowed,
    );
    return rows;
  }

  saveTask(user: AuthUser, dto: any) {
    const code = String(dto?.code || '').trim();
    const name = String(dto?.name || '').trim();
    const domainCode = String(dto?.domainCode || dto?.domain_code || '').trim() || null;
    const schedule = String(dto?.schedule || '').trim() || null;
    if (!code || !name) throw new BizException('任务编码与名称不能为空', ErrCode.PARAM);
    const id = Number(dto?.id || 0);
    const ts = nowStr();
    if (id) {
      if (!this.db.one<any>('SELECT id FROM dq_task WHERE id = ?', id)) throw new BizException('任务不存在', ErrCode.NOT_FOUND);
      const dup = this.db.one<any>('SELECT id FROM dq_task WHERE code = ? AND id <> ?', code, id);
      if (dup) throw new BizException('任务编码已存在', ErrCode.DUP);
      this.db.run('UPDATE dq_task SET code = ?, name = ?, domain_code = ?, schedule = ? WHERE id = ?', code, name, domainCode, schedule, id);
      return { id };
    }
    if (this.db.one<any>('SELECT id FROM dq_task WHERE code = ?', code)) throw new BizException('任务编码已存在', ErrCode.DUP);
    const r = this.db.run('INSERT INTO dq_task (code, name, domain_code, schedule, created_at) VALUES (?, ?, ?, ?, ?)', code, name, domainCode, schedule, ts);
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'quality', 'TASK_CREATE', name, code, ts);
    return { id: Number(r.lastInsertRowid) };
  }

  // ---------------------------------------------------------------- 巡检执行
  runTask(user: AuthUser, taskId: number) {
    const task = this.db.one<any>('SELECT * FROM dq_task WHERE id = ?', taskId);
    if (!task) throw new BizException('质量任务不存在', ErrCode.NOT_FOUND);
    return this.scan(user, taskId, task.domain_code || null);
  }

  scan(user: AuthUser, taskId: number | null = null, domainCode: string | null = null) {
    const allowed = this.allowedDomains(user);
    if (!allowed.length) throw new BizException('无可巡检的数据域权限', ErrCode.FORBIDDEN);
    const domains = domainCode
      ? allowed.filter((c) => c === domainCode)
      : allowed.slice();
    if (!domains.length) throw new BizException('无权访问该数据域', ErrCode.FORBIDDEN);

    const started = Date.now();
    const ts = nowStr();
    const recordsByDomain: Record<string, any[]> = {};
    for (const d of domains) {
      recordsByDomain[d] = this.db.all<any>(
        "SELECT id, master_code, name, data FROM md_master_data WHERE domain_code = ? AND deleted = 0 AND status = 'PUBLISHED' ORDER BY id",
        d,
      );
    }

    const dimStats: Record<string, { total: number; passed: number; failed: number }> = {};
    for (const dim of DIMENSIONS) dimStats[dim] = { total: 0, passed: 0, failed: 0 };
    let total = 0;
    let passed = 0;
    const failures: Array<{ rule: any; record: any; check: CheckResult; dimension: string }> = [];

    const labelsByDomain: Record<string, Record<string, string>> = {};
    for (const d of domains) {
      const fields = this.db.all<any>(
        'SELECT f.field_key, f.label FROM md_field f JOIN md_model m ON m.id = f.model_id WHERE m.domain_code = ?',
        d,
      );
      labelsByDomain[d] = {};
      for (const f of fields) labelsByDomain[d][f.field_key] = f.label;
    }

    const rulesByDomain: Record<string, any[]> = {};
    for (const d of domains) {
      rulesByDomain[d] = this.db
        .all<any>("SELECT * FROM dq_rule WHERE domain_code = ? AND enabled = 1 ORDER BY id", d)
        .map((r) => ({ ...r, params: parseJson(r.params, {}) }));
    }

    /** 唯一性预计算：同域同值出现次数 */
    const dupIndex: Record<string, Map<string, number>> = {};
    for (const d of domains) {
      for (const rule of rulesByDomain[d]) {
        if (rule.rule_type !== 'UNIQUE') continue;
        const map = new Map<string, number>();
        for (const rec of recordsByDomain[d]) {
          const v = parseJson<any>(rec.data, {})[rule.field_key];
          if (v === undefined || v === null || String(v).trim() === '') continue;
          const key = String(v).trim().toLowerCase();
          map.set(key, (map.get(key) || 0) + 1);
        }
        dupIndex[rule.id] = map;
      }
    }

    for (const d of domains) {
      const labels = labelsByDomain[d] || {};
      for (const rule of rulesByDomain[d]) {
        const dim = DIMENSIONS.includes(rule.dimension) ? rule.dimension : 'VALIDITY';
        const stat = dimStats[dim];
        for (const rec of recordsByDomain[d]) {
          const data = parseJson<any>(rec.data, {});
          const result = this.checkRule(rule, rec, data, dupIndex[rule.id], labels);
          total++;
          // 不适用（字段为空且规则非必填）视为通过
          if (!result.failed) {
            passed++;
            stat.total++;
            stat.passed++;
          } else {
            stat.total++;
            stat.failed++;
            failures.push({ rule, record: rec, check: result, dimension: dim });
          }
        }
      }
    }

    const failed = failures.length;
    const score = total ? Math.round((passed / total) * 1000) / 10 : 100;
    for (const dim of DIMENSIONS) {
      const s = dimStats[dim];
      (s as any).score = s.total ? Math.round((s.passed / s.total) * 1000) / 10 : 100;
    }
    const duration = Date.now() - started;

    const runId = this.db.tx(() => {
      const r = this.db.run(
        'INSERT INTO dq_task_run (task_id, domain_code, status, total, passed, failed, score, duration_ms, operator, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        taskId, domainCode, 'SUCCESS', total, passed, failed, score, duration, user.displayName, JSON.stringify(dimStats), ts,
      );
      const id = Number(r.lastInsertRowid);
      for (const f of failures) {
        this.db.run(
          'INSERT INTO dq_issue (run_id, rule_id, domain_code, record_id, master_code, field_key, value, message, level, dimension, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, f.rule.id, f.rule.domain_code, f.record.id, f.record.master_code,
          f.rule.field_key, f.rule.field_key ? String(parseJson<any>(f.record.data, {})[f.rule.field_key] ?? '') : null,
          f.check.message || '规则校验未通过', f.rule.level, f.dimension, 'OPEN', ts,
        );
      }
      if (taskId) this.db.run('UPDATE dq_task SET last_run_at = ? WHERE id = ?', ts, taskId);
      return id;
    });

    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'quality', 'SCAN', `质量巡检 #${runId}`, `检查 ${total} 项，问题 ${failed} 条`, ts);

    return {
      id: runId,
      total,
      passed,
      failed,
      score,
      duration_ms: duration,
      domains,
      dims: DIMENSIONS.map((dim) => ({ dimension: dim, ...dimStats[dim] })),
    };
  }

  private checkRule(rule: any, record: any, data: any, dupMap: Map<string, number> | undefined, labels: Record<string, string>): CheckResult {
    const value = rule.field_key ? data[rule.field_key] : undefined;
    const label = labels[rule.field_key] || rule.field_key || '字段';
    const isEmpty = value === undefined || value === null || String(value).trim() === '';
    const params = rule.params || {};

    switch (rule.rule_type) {
      case 'NOT_EMPTY':
        return isEmpty ? { failed: true, message: `「${label}」缺失（非空校验）` } : { failed: false };
      case 'UNIQUE': {
        if (isEmpty) return { failed: false };
        const key = String(value).trim().toLowerCase();
        const n = dupMap?.get(key) || 0;
        return n > 1 ? { failed: true, message: `「${label}」重复：${value}（共 ${n} 条）` } : { failed: false };
      }
      case 'REGEX': {
        if (isEmpty || !params.pattern) return { failed: false };
        try {
          const re = new RegExp(String(params.pattern));
          return re.test(String(value)) ? { failed: false } : { failed: true, message: `「${label}」格式不符合规则：${value}` };
        } catch {
          return { failed: false };
        }
      }
      case 'RANGE': {
        if (isEmpty) return { failed: false };
        if (params.dateAfter === 'TODAY' || params.dateBefore) {
          const val = String(value).slice(0, 10);
          const today = dateOnly();
          const isoToday = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
          if (params.dateAfter === 'TODAY' && val < isoToday) {
            return { failed: true, message: `「${label}」已过期：${val}（须不早于今天）` };
          }
          if (params.dateBefore && val > String(params.dateBefore)) {
            return { failed: true, message: `「${label}」晚于允许日期：${val}` };
          }
          return { failed: false };
        }
        const num = Number(value);
        if (Number.isNaN(num)) return { failed: true, message: `「${label}」不是合法数值：${value}` };
        if (params.min !== undefined && num < Number(params.min)) return { failed: true, message: `「${label}」低于下限 ${params.min}：${value}` };
        if (params.max !== undefined && num > Number(params.max)) return { failed: true, message: `「${label}」超过上限 ${params.max}：${value}` };
        return { failed: false };
      }
      case 'REF_EXISTS': {
        if (isEmpty || !params.dict) return { failed: false };
        const hit = this.db.one<any>(
          "SELECT id FROM md_dict_item WHERE dict_code = ? AND value = ? AND status = 'ACTIVE'",
          params.dict,
          String(value),
        );
        return hit ? { failed: false } : { failed: true, message: `「${label}」取值不在码表 ${params.dict} 中：${value}` };
      }
      default:
        return { failed: false };
    }
  }

  // ---------------------------------------------------------------- 运行记录
  runs(user: AuthUser, query: any) {
    const page = Math.max(1, Number(query?.page) || 1);
    const size = Math.min(100, Math.max(1, Number(query?.size) || 10));
    // 全域巡检（domain_code 为 NULL）对拥有任一数据域权限的用户可见
    const codes = this.allowedDomains(user);
    if (!codes.length) return paged([], 0, page, size);
    const conds = [`(r.domain_code IS NULL OR r.domain_code IN (${codes.map(() => '?').join(',')}))`];
    const params: any[] = [...codes];
    if (query?.domain) {
      conds.push('r.domain_code = ?');
      params.push(query.domain);
    }
    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM dq_task_run r WHERE ${conds.join(' AND ')}`, ...params)?.n || 0;
    const list = this.db.all<any>(
      `SELECT r.*, t.name AS task_name, d.name AS domain_name
       FROM dq_task_run r LEFT JOIN dq_task t ON t.id = r.task_id LEFT JOIN md_domain d ON d.code = r.domain_code
       WHERE ${conds.join(' AND ')} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      ...params,
      size,
      (page - 1) * size,
    );
    return paged(list.map((r) => ({ ...r, detail: parseJson(r.detail, {}) })), total, page, size);
  }

  // ---------------------------------------------------------------- 问题闭环
  issues(user: AuthUser, query: any) {
    const page = Math.max(1, Number(query?.page) || 1);
    const size = Math.min(100, Math.max(1, Number(query?.size) || 10));
    const f = this.domainCondition(user, 'i.domain_code');
    const conds = [`1 = 1${f.sql}`];
    const params: any[] = [...f.params];
    const add = (sql: string, v: any) => {
      conds.push(sql);
      params.push(v);
    };
    if (query?.status) add('i.status = ?', query.status);
    if (query?.domain) add('i.domain_code = ?', query.domain);
    if (query?.dimension) add('i.dimension = ?', query.dimension);
    if (query?.level) add('i.level = ?', query.level);
    if (query?.runId) add('i.run_id = ?', Number(query.runId));
    if (query?.ruleId) add('i.rule_id = ?', Number(query.ruleId));
    if (query?.mine) add('i.assignee_id = ?', user.id);
    else if (query?.assigneeId) add('i.assignee_id = ?', Number(query.assigneeId));
    if (query?.assignee === 'NONE') conds.push('i.assignee_id IS NULL');
    if (query?.keyword) {
      conds.push('(i.master_code LIKE ? OR i.message LIKE ? OR i.field_key LIKE ?)');
      const kw = `%${query.keyword}%`;
      params.push(kw, kw, kw);
    }
    const total = this.db.one<any>(
      `SELECT COUNT(*) AS n FROM dq_issue i WHERE ${conds.join(' AND ')}`,
      ...params,
    )?.n || 0;
    const list = this.db.all<any>(
      `SELECT i.*, d.name AS domain_name, r.name AS rule_name, r.code AS rule_code, r.rule_type
       FROM dq_issue i LEFT JOIN md_domain d ON d.code = i.domain_code LEFT JOIN dq_rule r ON r.id = i.rule_id
       WHERE ${conds.join(' AND ')} ORDER BY i.id DESC LIMIT ? OFFSET ?`,
      ...params,
      size,
      (page - 1) * size,
    );
    return paged(list, total, page, size);
  }

  handleIssue(user: AuthUser, id: number, dto: any) {
    const issue = this.db.one<any>('SELECT * FROM dq_issue WHERE id = ?', id);
    if (!issue) throw new BizException('质量问题不存在', ErrCode.NOT_FOUND);
    const action = String(dto?.action || '').toUpperCase();
    if (!['FIX', 'IGNORE'].includes(action)) throw new BizException('处置动作仅支持 FIX / IGNORE', ErrCode.PARAM);
    if (issue.status !== 'OPEN') throw new BizException('该问题已处置，不能重复操作', ErrCode.STATE);
    const ts = nowStr();
    this.db.run(
      'UPDATE dq_issue SET status = ?, handled_by = ?, handled_at = ?, remark = ? WHERE id = ?',
      action === 'FIX' ? 'FIXED' : 'IGNORED',
      user.displayName,
      ts,
      String(dto?.remark || '').trim() || null,
      id,
    );
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'quality', action === 'FIX' ? 'ISSUE_FIX' : 'ISSUE_IGNORE', issue.master_code || `#${id}`, issue.message, ts);
    return { id, status: action === 'FIX' ? 'FIXED' : 'IGNORED' };
  }

  // ---------------------------------------------------------------- 指派
  /** 可指派的候选人：启用状态且具备质量治理相关角色 */
  assignees() {
    return this.db.all<any>(
      `SELECT DISTINCT u.id, u.username, u.display_name, u.dept FROM sys_user u
       JOIN sys_user_role ur ON ur.user_id = u.id
       JOIN sys_role r ON r.id = ur.role_id
       WHERE u.status = 'ACTIVE' AND r.code IN ('SYS_ADMIN', 'DATA_STEWARD', 'DATA_EDITOR')
       ORDER BY u.id`,
    );
  }

  assignIssue(user: AuthUser, id: number, dto: any) {
    const issue = this.db.one<any>('SELECT * FROM dq_issue WHERE id = ?', id);
    if (!issue) throw new BizException('质量问题不存在', ErrCode.NOT_FOUND);
    if (issue.status !== 'OPEN') throw new BizException('该问题已处置，不能指派', ErrCode.STATE);
    const assigneeId = Number(dto?.userId || 0);
    const target = assigneeId
      ? this.db.one<any>("SELECT id, display_name, status FROM sys_user WHERE id = ?", assigneeId)
      : null;
    if (!target || target.status !== 'ACTIVE') throw new BizException('指派对象不存在或已停用', ErrCode.PARAM);
    this.db.run('UPDATE dq_issue SET assignee_id = ?, assignee_name = ? WHERE id = ?', target.id, target.display_name, id);
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'quality', 'ISSUE_ASSIGN', issue.master_code || `#${id}`, `指派给 ${target.display_name}`, nowStr());
    this.notice.send(
      [target.id], 'ISSUE_ASSIGN', `您有一条质量整改任务：${issue.master_code || issue.field_key || ''}`,
      `${issue.message}（${issue.domain_code} 域 · ${issue.level === 'HIGH' ? '高' : issue.level === 'MEDIUM' ? '中' : '低'}级别），由 ${user.displayName} 指派`, '/quality',
    );
    return { id, assignee_id: target.id, assignee_name: target.display_name };
  }

  // ---------------------------------------------------------------- 报告导出
  /** 巡检批次报告：概要 + 五维评分 + 逐条问题明细（CSV） */
  exportRunReport(user: AuthUser, runId: number) {
    const run = this.db.one<any>(
      `SELECT r.*, t.name AS task_name, d.name AS domain_name
       FROM dq_task_run r LEFT JOIN dq_task t ON t.id = r.task_id LEFT JOIN md_domain d ON d.code = r.domain_code
       WHERE r.id = ?`,
      runId,
    );
    if (!run) throw new BizException('巡检记录不存在', ErrCode.NOT_FOUND);
    const detail = parseJson<Record<string, any>>(run.detail, {});
    const f = this.domainCondition(user, 'i.domain_code');
    const issues = this.db.all<any>(
      `SELECT i.*, d.name AS domain_name, r.name AS rule_name FROM dq_issue i
       LEFT JOIN md_domain d ON d.code = i.domain_code LEFT JOIN dq_rule r ON r.id = i.rule_id
       WHERE i.run_id = ?${f.sql} ORDER BY i.id`,
      runId, ...f.params,
    );
    const q = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines: string[] = [];
    lines.push('主数据质量管理平台 · 质量巡检报告');
    lines.push(`巡检批次,#${run.id}`);
    lines.push(`任务,${q(run.task_name || '手动巡检')}`);
    lines.push(`数据域,${q(run.domain_name || run.domain_code || '全部')}`);
    lines.push(`执行人,${q(run.operator)}`);
    lines.push(`执行时间,${q(run.created_at)}`);
    lines.push(`检查项,${run.total}`);
    lines.push(`通过,${run.passed}`);
    lines.push(`问题,${run.failed}`);
    lines.push(`综合评分,${run.score}`);
    lines.push(`五维评分,${q(DIMENSIONS.map((d) => `${DIMENSION_LABELS[d]}=${detail?.[d]?.score ?? 100}`).join('，'))}`);
    lines.push('');
    lines.push(['序号', '数据域', '主数据编码', '字段', '当前值', '问题描述', '维度', '级别', '状态', '指派给', '处置人', '处置时间'].map(q).join(','));
    issues.forEach((it, idx) => {
      lines.push([
        idx + 1,
        it.domain_name || it.domain_code,
        it.master_code,
        it.field_key,
        it.value,
        it.message,
        DIMENSION_LABELS[it.dimension] || it.dimension,
        it.level,
        it.status === 'OPEN' ? '待整改' : it.status === 'FIXED' ? '已修复' : '已忽略',
        it.assignee_name,
        it.handled_by,
        it.handled_at,
      ].map(q).join(','));
    });
    return { filename: `质量巡检报告-${run.id}.csv`, content: lines.join('\r\n') };
  }

  /** 质量问题关联的记录明细（下钻） */
  issueDetail(user: AuthUser, id: number) {
    const issue = this.db.one<any>('SELECT * FROM dq_issue WHERE id = ?', id);
    if (!issue) throw new BizException('质量问题不存在', ErrCode.NOT_FOUND);
    const allowed = this.allowedDomains(user);
    if (!allowed.includes(issue.domain_code)) throw new BizException('无权访问该数据域', ErrCode.FORBIDDEN);
    const record = issue.record_id
      ? this.db.one<any>('SELECT id, master_code, name, status, version, data FROM md_master_data WHERE id = ? AND deleted = 0', issue.record_id)
      : null;
    const rule = issue.rule_id ? this.db.one<any>('SELECT * FROM dq_rule WHERE id = ?', issue.rule_id) : null;
    return {
      issue,
      record: record ? { ...record, data: parseJson(record.data, {}) } : null,
      rule: rule ? { ...rule, params: parseJson(rule.params, {}) } : null,
    };
  }
}
