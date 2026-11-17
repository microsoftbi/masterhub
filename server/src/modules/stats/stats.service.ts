import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { AuthUser } from '../../common/decorators';
import { parseJson } from '../../common/util';

function dayOffset(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class StatsService {
  constructor(private db: DbService) {}

  private domainFilter(user: AuthUser) {
    if (user.roles.includes('SYS_ADMIN')) return { cond: '', params: [] as any[] };
    const codes = user.domains || [];
    if (!codes.length) return { cond: ' AND 1 = 0', params: [] as any[] };
    return { cond: ' AND d.code IN (' + codes.map(() => '?').join(',') + ')', params: codes as any[] };
  }

  overview(user: AuthUser) {
    const f = this.domainFilter(user);
    const domains = this.db.all<any>(
      `SELECT d.code, d.name, d.description, d.owner,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status <> 'ARCHIVED') AS total,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status = 'PUBLISHED') AS published,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status = 'DRAFT') AS drafts,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status = 'PENDING') AS pending,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status = 'CHANGING') AS changing,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status = 'FROZEN') AS frozen
       FROM md_domain d WHERE d.status = 'ACTIVE'${f.cond} ORDER BY d.sort, d.code`,
      ...f.params,
    );
    const totals = domains.reduce(
      (acc, d) => {
        acc.total += d.total;
        acc.published += d.published;
        acc.drafts += d.drafts;
        acc.pending += d.pending;
        acc.changing += d.changing;
        acc.frozen += d.frozen;
        return acc;
      },
      { total: 0, published: 0, drafts: 0, pending: 0, changing: 0, frozen: 0 },
    );

    const trend: Array<{ date: string; published: number; created: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const day = dayOffset(i);
      const created = this.db.one<any>(
        `SELECT COUNT(*) AS n FROM md_master_data m JOIN md_domain d ON d.code = m.domain_code
         WHERE m.deleted = 0 AND substr(m.created_at, 1, 10) = ?${f.cond}`,
        day, ...f.params,
      )?.n || 0;
      const published = this.db.one<any>(
        `SELECT COUNT(*) AS n FROM md_data_version v JOIN md_domain d ON d.code = v.domain_code
         WHERE substr(v.created_at, 1, 10) = ?${f.cond}`,
        day, ...f.params,
      )?.n || 0;
      trend.push({ date: day, created, published });
    }

    const approval = this.db.one<any>(
      "SELECT COUNT(*) AS n FROM ap_instance WHERE status = 'RUNNING'",
    )?.n || 0;
    const myTodo = this.db.one<any>(
      "SELECT COUNT(*) AS n FROM ap_task WHERE status = 'PENDING' AND assignee_id = ?",
      user.id,
    )?.n || 0;

    const push = this.db.one<any>(
      `SELECT
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'PUSHED' THEN 1 ELSE 0 END) AS pushed,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'DEAD' THEN 1 ELSE 0 END) AS dead
       FROM int_push_event`,
    ) || { pending: 0, pushed: 0, failed: 0, dead: 0 };

    return {
      totals,
      domains,
      trend,
      approval: { running: approval, myTodo },
      push: {
        pending: push.pending || 0,
        pushed: push.pushed || 0,
        failed: push.failed || 0,
        dead: push.dead || 0,
      },
      meta: {
        models: this.db.one<any>('SELECT COUNT(*) AS n FROM md_model')?.n || 0,
        dicts: this.db.one<any>('SELECT COUNT(*) AS n FROM md_dict')?.n || 0,
        users: this.db.one<any>("SELECT COUNT(*) AS n FROM sys_user WHERE status = 'ACTIVE'")?.n || 0,
        subscribers: this.db.one<any>("SELECT COUNT(*) AS n FROM int_subscriber WHERE status = 'ACTIVE'")?.n || 0,
      },
    };
  }

  workbench(user: AuthUser) {
    const f = this.domainFilter(user);
    const todo = this.db.one<any>(
      "SELECT COUNT(*) AS n FROM ap_task WHERE status = 'PENDING' AND assignee_id = ?",
      user.id,
    )?.n || 0;
    const myRunning = this.db.one<any>(
      "SELECT COUNT(*) AS n FROM ap_instance WHERE applicant_id = ? AND status = 'RUNNING'",
      user.id,
    )?.n || 0;
    const recentPublished = this.db.all<any>(
      `SELECT m.id, m.domain_code, m.master_code, m.name, m.status, m.version, m.updated_at, d.name AS domain_name
       FROM md_master_data m JOIN md_domain d ON d.code = m.domain_code
       WHERE m.deleted = 0 AND m.master_code IS NOT NULL${f.cond}
       ORDER BY m.updated_at DESC LIMIT 8`,
      ...f.params,
    );
    const recentAudit = this.db.all<any>(
      'SELECT module, action, target, username, created_at FROM sys_audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 8',
      user.id,
    );
    return {
      todo,
      myRunning,
      recentPublished,
      recentAudit,
      domains: this.db.all<any>(
        `SELECT d.code, d.name,
           (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status <> 'ARCHIVED') AS total
         FROM md_domain d WHERE d.status = 'ACTIVE'${f.cond} ORDER BY d.sort`,
        ...f.params,
      ),
    };
  }

  /** 治理仪表板：数据量 / 质量 / 审批效率 / 分发成功率 / 工作流 */
  dashboard(user: AuthUser) {
    const f = this.domainFilter(user);

    // ---------- 数据量 ----------
    const domains = this.db.all<any>(
      `SELECT d.code, d.name,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status <> 'ARCHIVED') AS total,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status = 'PUBLISHED') AS published,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status = 'DRAFT') AS draft,
         (SELECT COUNT(*) FROM md_master_data m WHERE m.domain_code = d.code AND m.deleted = 0 AND m.status = 'PENDING') AS pending
       FROM md_domain d WHERE d.status = 'ACTIVE'${f.cond} ORDER BY d.sort`,
      ...f.params,
    );
    const volumeTrend: Array<{ date: string; created: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const day = dayOffset(i);
      const created = this.db.one<any>(
        `SELECT COUNT(*) AS n FROM md_master_data m JOIN md_domain d ON d.code = m.domain_code
         WHERE m.deleted = 0 AND substr(m.created_at, 1, 10) = ?${f.cond}`,
        day, ...f.params,
      )?.n || 0;
      volumeTrend.push({ date: day, created });
    }

    // ---------- 质量 ----------
    const latest = this.db.one<any>("SELECT * FROM dq_task_run WHERE status = 'SUCCESS' ORDER BY id DESC LIMIT 1");
    const detail = parseJson<Record<string, any>>(latest?.detail, {});
    const dimIssue = this.db.all<any>("SELECT dimension, COUNT(*) AS n FROM dq_issue WHERE status = 'OPEN' GROUP BY dimension");
    const dims = ['COMPLETENESS', 'UNIQUENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS'].map((dim) => ({
      dimension: dim,
      score: detail?.[dim]?.score ?? (latest?.score ?? 100),
      issues: dimIssue.find((x) => x.dimension === dim)?.n || 0,
    }));
    const issueCounts = this.db.one<any>(
      `SELECT SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status = 'FIXED' THEN 1 ELSE 0 END) AS fixed,
        SUM(CASE WHEN status = 'OPEN' AND level = 'HIGH' THEN 1 ELSE 0 END) AS high,
        COUNT(*) AS total FROM dq_issue`,
    ) || { open: 0, fixed: 0, high: 0, total: 0 };
    const qualityTrend = this.db.all<any>(
      "SELECT score, failed, created_at FROM dq_task_run WHERE status = 'SUCCESS' ORDER BY id DESC LIMIT 7",
    ).reverse();
    const ruleCount = this.db.one<any>('SELECT COUNT(*) AS n FROM dq_rule WHERE enabled = 1')?.n || 0;

    // ---------- 审批 ----------
    const ap = this.db.one<any>(
      `SELECT
        SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected
       FROM ap_instance`,
    ) || { running: 0, completed: 0, rejected: 0 };
    const avgHours = this.db.one<any>(
      "SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) AS h FROM ap_instance WHERE status = 'COMPLETED'",
    )?.h;
    const approvalTrend: Array<{ date: string; submitted: number; completed: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const day = dayOffset(i);
      approvalTrend.push({
        date: day,
        submitted: this.db.one<any>("SELECT COUNT(*) AS n FROM ap_instance WHERE substr(created_at, 1, 10) = ?", day)?.n || 0,
        completed: this.db.one<any>("SELECT COUNT(*) AS n FROM ap_instance WHERE status = 'COMPLETED' AND substr(updated_at, 1, 10) = ?", day)?.n || 0,
      });
    }
    const myTodo = this.db.one<any>(
      "SELECT COUNT(*) AS n FROM ap_task WHERE assignee_id = ? AND status = 'PENDING'",
      user.id,
    )?.n || 0;
    // M4：流程效率增强——待办积压、驳回率、环节平均耗时
    const backlog = this.db.one<any>(
      "SELECT COUNT(*) AS n FROM ap_task WHERE status = 'PENDING'",
    )?.n || 0;
    const settled = (ap.completed || 0) + (ap.rejected || 0);
    const rejectRate = settled ? Math.round(((ap.rejected || 0) / settled) * 1000) / 10 : 0;
    const nodeStats = this.db.all<any>(
      `SELECT node_name,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
         AVG(CASE WHEN handled_at IS NOT NULL THEN (julianday(handled_at) - julianday(created_at)) * 24 END) AS avgHours
       FROM ap_task GROUP BY node_name ORDER BY total DESC LIMIT 6`,
    ).map((n) => ({ ...n, avgHours: n.avgHours ? Math.round(Number(n.avgHours) * 10) / 10 : 0 }));
    const slowest = this.db.all<any>(
      `SELECT i.title, i.process_code,
         ROUND((julianday(i.updated_at) - julianday(i.created_at)) * 24, 1) AS hours
       FROM ap_instance i WHERE i.status = 'COMPLETED' ORDER BY (julianday(i.updated_at) - julianday(i.created_at)) DESC LIMIT 5`,
    );

    // ---------- 分发 ----------
    const push = this.db.one<any>(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'PUSHED' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status IN ('FAILED', 'DEAD') THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending
       FROM int_push_event`,
    ) || { total: 0, success: 0, failed: 0, pending: 0 };
    const pushTrend: Array<{ date: string; success: number; failed: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const day = dayOffset(i);
      const row = this.db.one<any>(
        `SELECT SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
         FROM int_push_log WHERE substr(created_at, 1, 10) = ?`, day,
      ) || {};
      pushTrend.push({ date: day, success: row.success || 0, failed: row.failed || 0 });
    }
    const bySubscriber = this.db.all<any>(
      `SELECT s.name, s.code,
        COUNT(e.id) AS total,
        SUM(CASE WHEN e.status = 'PUSHED' THEN 1 ELSE 0 END) AS success
       FROM int_subscriber s LEFT JOIN int_push_event e ON e.subscriber_id = s.id
       GROUP BY s.id ORDER BY total DESC LIMIT 5`,
    );
    const pushSettled = (push.success || 0) + (push.failed || 0);
    const pushRate = pushSettled ? Math.round(((push.success || 0) / pushSettled) * 1000) / 10 : 100;

    // ---------- 工作流 ----------
    const wfDefs = this.db.one<any>('SELECT COUNT(*) AS n FROM wf_definition')?.n || 0;
    const wfRuns = this.db.one<any>('SELECT COUNT(*) AS n FROM wf_run')?.n || 0;
    const wfSuccess = this.db.one<any>("SELECT COUNT(*) AS n FROM wf_run WHERE status = 'SUCCESS'")?.n || 0;
    const wfRecent = this.db.all<any>(
      `SELECT r.id, r.status, r.row_count, r.started_at, r.finished_at, d.name AS definition_name
       FROM wf_run r JOIN wf_definition d ON d.id = r.definition_id ORDER BY r.id DESC LIMIT 5`,
    );

    return {
      volume: {
        total: domains.reduce((a, d) => a + d.total, 0),
        published: domains.reduce((a, d) => a + d.published, 0),
        draft: domains.reduce((a, d) => a + d.draft, 0),
        pending: domains.reduce((a, d) => a + d.pending, 0),
        domains,
        trend: volumeTrend,
      },
      quality: {
        score: latest?.score ?? 100,
        lastRunAt: latest?.created_at || null,
        rules: ruleCount,
        dims,
        counts: {
          open: issueCounts.open || 0,
          fixed: issueCounts.fixed || 0,
          high: issueCounts.high || 0,
          total: issueCounts.total || 0,
        },
        trend: qualityTrend.map((t) => ({ score: t.score, failed: t.failed, at: t.created_at })),
      },
      approval: {
        running: ap.running || 0,
        completed: ap.completed || 0,
        rejected: ap.rejected || 0,
        avgHours: avgHours ? Math.round(Number(avgHours) * 10) / 10 : 0,
        myTodo,
        backlog,
        rejectRate,
        nodeStats,
        slowest,
        trend: approvalTrend,
      },
      push: {
        total: push.total || 0,
        success: push.success || 0,
        failed: push.failed || 0,
        pending: push.pending || 0,
        successRate: pushRate,
        trend: pushTrend,
        bySubscriber,
      },
      workflow: {
        definitions: wfDefs,
        runs: wfRuns,
        success: wfSuccess,
        successRate: wfRuns ? Math.round((wfSuccess / wfRuns) * 1000) / 10 : 100,
        recent: wfRecent,
      },
    };
  }
}
