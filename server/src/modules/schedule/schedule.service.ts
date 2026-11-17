import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { NoticeService } from '../../common/notice.service';
import { AuthUser } from '../../common/decorators';
import { BizException, ErrCode } from '../../common/errors';
import { describeCron, nextRunAfter, parseCron } from '../../common/cron';
import { nowStr, paged } from '../../common/util';
import { QualityService } from '../quality/quality.service';
import { WorkflowService } from '../workflow/workflow.service';
import { IntegrationService } from '../integration/integration.service';

/** 支持的任务类型 */
export const JOB_TYPES = [
  { type: 'QUALITY_SCAN', name: '质量巡检' },
  { type: 'QUALITY_TASK', name: '巡检任务' },
  { type: 'WORKFLOW', name: '数据工作流' },
  { type: 'DISPATCH', name: '分发补偿' },
];
const TYPE_LABELS: Record<string, string> = Object.fromEntries(JOB_TYPES.map((t) => [t.type, t.name]));

/** 定时触发使用的系统身份（管理员视角，不依赖具体登录态） */
function systemUser(): AuthUser {
  return { id: 0, username: 'scheduler', displayName: '定时调度', dept: '', roles: ['SYS_ADMIN'], perms: [], domains: [], fieldMasks: {} };
}

@Injectable()
export class ScheduleService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger('Schedule');
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private db: DbService,
    private quality: QualityService,
    private workflow: WorkflowService,
    private integration: IntegrationService,
    private notice: NoticeService,
  ) {}

  onModuleInit() {
    // 兜底：为缺失下次执行时间的任务重算（如手工改库）
    for (const j of this.db.all<any>("SELECT id, cron FROM sch_job WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at = '')")) {
      const next = nextRunAfter(j.cron);
      if (next) this.db.run('UPDATE sch_job SET next_run_at = ? WHERE id = ?', next, j.id);
    }
    const interval = parseInt(process.env.SCHEDULE_INTERVAL || '30000', 10);
    if (interval > 0) {
      this.timer = setInterval(() => { void this.tick(); }, interval);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 后台轮询：到点即执行（串行，避免 SQLite 并发写放大） */
  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = nowStr();
      const due = this.db.all<any>(
        "SELECT * FROM sch_job WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY id",
        now,
      );
      for (const job of due) {
        await this.executeJob(job, 'TIMER', systemUser());
      }
    } catch (e: any) {
      this.logger.warn('调度轮询异常：' + (e?.message || e));
    } finally {
      this.ticking = false;
    }
  }

  /** 执行单个任务并落运行记录（手动 / 定时统一入口） */
  async executeJob(job: any, trigger: 'MANUAL' | 'TIMER', user: AuthUser) {
    const t0 = Date.now();
    let status = 'SUCCESS';
    let message = '';
    let result: any = null;
    try {
      switch (String(job.job_type)) {
        case 'QUALITY_SCAN': {
          const r = this.quality.scan(user, null, job.domain_code || null);
          result = { kind: 'quality', runId: r.id, total: r.total, failed: r.failed, score: r.score };
          message = `巡检 ${r.total} 项，问题 ${r.failed} 条，评分 ${r.score}`;
          break;
        }
        case 'QUALITY_TASK': {
          if (!job.target_id) throw new Error('未配置巡检任务');
          const r = this.quality.runTask(user, Number(job.target_id));
          result = { kind: 'quality', runId: r.id, total: r.total, failed: r.failed, score: r.score };
          message = `巡检 ${r.total} 项，问题 ${r.failed} 条，评分 ${r.score}`;
          break;
        }
        case 'WORKFLOW': {
          if (!job.target_id) throw new Error('未配置工作流');
          const r = await this.workflow.run(user, Number(job.target_id));
          result = { kind: 'workflow', runId: r.id, rows: r.row_count, status: r.status };
          message = `${r.status === 'SUCCESS' ? '运行成功' : '运行失败'}：${r.row_count} 行`;
          break;
        }
        case 'DISPATCH': {
          const r = await this.integration.dispatchDue(50, user);
          result = { kind: 'dispatch', attempted: r.attempted, success: r.success, failed: r.failed };
          message = r.attempted ? `分发 ${r.attempted} 条，成功 ${r.success}，失败 ${r.failed}` : '无待分发事件';
          break;
        }
        default:
          throw new Error(`未知任务类型：${job.job_type}`);
      }
    } catch (e: any) {
      status = 'FAILED';
      message = e?.message || '任务执行失败';
    }
    const ts = nowStr();
    const duration = Date.now() - t0;
    const next = nextRunAfter(job.cron);
    this.db.run(
      'INSERT INTO sch_job_run (job_id, trigger, status, message, result, duration_ms, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      job.id, trigger, status, message, JSON.stringify(result || {}), duration, user.displayName, ts,
    );
    this.db.run(
      'UPDATE sch_job SET last_run_at = ?, last_status = ?, next_run_at = ? WHERE id = ?',
      ts, status, next, job.id,
    );
    // 定时任务失败时向管理员与数据治理岗发送告警
    if (status === 'FAILED' && trigger === 'TIMER') {
      this.notice.sendToRoles(
        ['SYS_ADMIN', 'DATA_STEWARD'], 'SCHEDULE', `定时任务执行失败：${job.name}`,
        `${job.code} · ${message}（${ts.replace('T', ' ')}），请到任务调度中心排查`, '/system',
      );
    }
    return { jobId: job.id, status, message, duration_ms: duration, next_run_at: next };
  }

  // ---------------------------------------------------------------- 查询
  meta() {
    return {
      jobTypes: JOB_TYPES,
      qualityTasks: this.db.all<any>('SELECT id, code, name, domain_code FROM dq_task ORDER BY id'),
      workflows: this.db.all<any>("SELECT id, code, name, domain_code FROM wf_definition WHERE status = 'PUBLISHED' ORDER BY id"),
      domains: this.db.all<any>("SELECT code, name FROM md_domain WHERE status = 'ACTIVE' ORDER BY sort"),
      presets: [
        { label: '每 5 分钟', cron: '*/5 * * * *' },
        { label: '每小时', cron: '0 * * * *' },
        { label: '每天 02:00', cron: '0 2 * * *' },
        { label: '每天 07:30', cron: '30 7 * * *' },
        { label: '每周一 03:00', cron: '0 3 * * 1' },
        { label: '每月 1 日 04:00', cron: '0 4 1 * *' },
      ],
    };
  }

  jobs() {
    const rows = this.db.all<any>(
      `SELECT j.*,
        (SELECT COUNT(*) FROM sch_job_run r WHERE r.job_id = j.id) AS run_count,
        (SELECT status FROM sch_job_run r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_run_status,
        (SELECT message FROM sch_job_run r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM sch_job_run r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS last_run_time
       FROM sch_job j ORDER BY j.id`,
    );
    return rows.map((j) => ({ ...j, enabled: !!j.enabled, type_label: TYPE_LABELS[j.job_type] || j.job_type, target_label: this.targetLabel(j), cron_desc: describeCron(j.cron) }));
  }

  private targetLabel(j: any): string {
    if (j.job_type === 'QUALITY_TASK') {
      const t = j.target_id ? this.db.one<any>('SELECT name, domain_code FROM dq_task WHERE id = ?', j.target_id) : null;
      return t?.name || '—';
    }
    if (j.job_type === 'WORKFLOW') {
      const w = j.target_id ? this.db.one<any>('SELECT name FROM wf_definition WHERE id = ?', j.target_id) : null;
      return w?.name || '—';
    }
    if (j.job_type === 'QUALITY_SCAN' && j.domain_code) {
      const d = this.db.one<any>('SELECT name FROM md_domain WHERE code = ?', j.domain_code);
      return d?.name || j.domain_code;
    }
    return j.job_type === 'QUALITY_SCAN' ? '全部数据域' : '待分发事件';
  }

  runs(user: AuthUser, query: any) {
    const page = Math.max(1, Number(query?.page) || 1);
    const size = Math.min(100, Math.max(1, Number(query?.size) || 10));
    const conds: string[] = ['1 = 1'];
    const params: any[] = [];
    if (query?.jobId) {
      conds.push('r.job_id = ?');
      params.push(Number(query.jobId));
    }
    if (query?.status) {
      conds.push('r.status = ?');
      params.push(query.status);
    }
    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM sch_job_run r WHERE ${conds.join(' AND ')}`, ...params)?.n || 0;
    const list = this.db.all<any>(
      `SELECT r.*, j.code AS job_code, j.name AS job_name, j.job_type
       FROM sch_job_run r LEFT JOIN sch_job j ON j.id = r.job_id
       WHERE ${conds.join(' AND ')} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      ...params, size, (page - 1) * size,
    ).map((r) => ({ ...r, type_label: TYPE_LABELS[r.job_type] || r.job_type }));
    return paged(list, total, page, size);
  }

  // ---------------------------------------------------------------- 维护
  saveJob(user: AuthUser, dto: any) {
    const code = String(dto?.code || '').trim();
    const name = String(dto?.name || '').trim();
    const jobType = String(dto?.jobType || '').trim();
    const cron = String(dto?.cron || '').trim();
    const targetId = Number(dto?.targetId || 0) || null;
    const domainCode = String(dto?.domainCode || '').trim() || null;
    if (!code || !name || !jobType || !cron) throw new BizException('编码、名称、类型与调度表达式不能为空', ErrCode.PARAM);
    if (!JOB_TYPES.some((t) => t.type === jobType)) throw new BizException('任务类型不合法', ErrCode.PARAM);
    if (!parseCron(cron)) throw new BizException('cron 表达式不合法（应为 5 段：分 时 日 月 周）', ErrCode.PARAM);
    if ((jobType === 'QUALITY_TASK' || jobType === 'WORKFLOW') && !targetId) {
      throw new BizException('该类型任务必须选择执行目标', ErrCode.PARAM);
    }
    if (jobType === 'QUALITY_TASK') {
      if (!this.db.one<any>('SELECT id FROM dq_task WHERE id = ?', targetId)) throw new BizException('巡检任务不存在', ErrCode.PARAM);
    }
    if (jobType === 'WORKFLOW') {
      if (!this.db.one<any>('SELECT id FROM wf_definition WHERE id = ?', targetId)) throw new BizException('工作流不存在', ErrCode.PARAM);
    }
    if (domainCode && !this.db.one<any>("SELECT code FROM md_domain WHERE code = ? AND status = 'ACTIVE'", domainCode)) {
      throw new BizException('数据域不存在', ErrCode.PARAM);
    }
    const next = nextRunAfter(cron);
    if (!next) throw new BizException('该 cron 表达式在 3 年内无可执行时间点', ErrCode.PARAM);

    const enabled = dto?.enabled === undefined ? 1 : dto.enabled ? 1 : 0;
    const id = Number(dto?.id || 0);
    const ts = nowStr();
    if (id) {
      const exists = this.db.one<any>('SELECT * FROM sch_job WHERE id = ?', id);
      if (!exists) throw new BizException('调度任务不存在', ErrCode.NOT_FOUND);
      const dup = this.db.one<any>('SELECT id FROM sch_job WHERE code = ? AND id <> ?', code, id);
      if (dup) throw new BizException('任务编码已存在', ErrCode.DUP);
      this.db.run(
        'UPDATE sch_job SET code = ?, name = ?, job_type = ?, target_id = ?, domain_code = ?, cron = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
        code, name, jobType, targetId, domainCode, cron, enabled, enabled ? next : null, ts, id,
      );
      this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        user.id, user.username, 'schedule', 'JOB_UPDATE', name, `${code} cron=${cron}`, ts);
      return { id };
    }
    if (this.db.one<any>('SELECT id FROM sch_job WHERE code = ?', code)) throw new BizException('任务编码已存在', ErrCode.DUP);
    const r = this.db.run(
      'INSERT INTO sch_job (code, name, job_type, target_id, domain_code, cron, enabled, next_run_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      code, name, jobType, targetId, domainCode, cron, enabled, enabled ? next : null, user.displayName, ts, ts,
    );
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'schedule', 'JOB_CREATE', name, `${code} cron=${cron}`, ts);
    return { id: Number(r.lastInsertRowid) };
  }

  toggle(user: AuthUser, id: number, enabled: boolean) {
    const job = this.db.one<any>('SELECT * FROM sch_job WHERE id = ?', id);
    if (!job) throw new BizException('调度任务不存在', ErrCode.NOT_FOUND);
    const next = enabled ? nextRunAfter(job.cron) : null;
    this.db.run('UPDATE sch_job SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, next, nowStr(), id);
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'schedule', enabled ? 'JOB_ENABLE' : 'JOB_DISABLE', job.name, job.code, nowStr());
    return { id, enabled: !!enabled, next_run_at: next };
  }

  async runNow(user: AuthUser, id: number) {
    const job = this.db.one<any>('SELECT * FROM sch_job WHERE id = ?', id);
    if (!job) throw new BizException('调度任务不存在', ErrCode.NOT_FOUND);
    const result = await this.executeJob(job, 'MANUAL', user);
    this.db.run('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      user.id, user.username, 'schedule', 'JOB_RUN', job.name, result.message, nowStr());
    return result;
  }
}
