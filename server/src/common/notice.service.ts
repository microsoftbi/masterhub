import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { AuthUser } from './decorators';
import { nowStr, paged } from './util';

export const NOTICE_TYPE_LABELS: Record<string, string> = {
  APPROVAL: '审批待办',
  APPROVAL_RESULT: '审批结果',
  ISSUE_ASSIGN: '质量整改',
  SCHEDULE: '调度告警',
  COLLECT: '数据采集',
  SYSTEM: '系统通知',
};

/**
 * 站内通知（M4）：审批待办 / 问题指派 / 调度告警 / 采集结果统一触达。
 * 全局服务（CoreModule），各业务模块直接注入调用。
 */
@Injectable()
export class NoticeService {
  constructor(private db: DbService) {}

  /** 给指定用户发送通知 */
  send(userIds: Array<number | undefined | null>, type: string, title: string, content?: string, link?: string) {
    const ids = Array.from(new Set((userIds || []).map(Number).filter((x) => x > 0)));
    if (!ids.length) return;
    const ts = nowStr();
    for (const uid of ids) {
      this.db.run(
        'INSERT INTO sys_notice (user_id, type, title, content, link, read_flag, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
        uid, type, title.slice(0, 200), content ? String(content).slice(0, 500) : null, link || null, ts,
      );
    }
  }

  /** 给指定角色的全部启用用户发送通知 */
  sendToRoles(roleCodes: string[], type: string, title: string, content?: string, link?: string) {
    if (!roleCodes?.length) return;
    const rows = this.db.all<any>(
      `SELECT DISTINCT u.id FROM sys_user u
       JOIN sys_user_role ur ON ur.user_id = u.id
       JOIN sys_role r ON r.id = ur.role_id
       WHERE u.status = 'ACTIVE' AND r.code IN (${roleCodes.map(() => '?').join(',')})`,
      ...roleCodes,
    );
    this.send(rows.map((r) => r.id), type, title, content, link);
  }

  /** 当前用户的通知列表 */
  mine(user: AuthUser, query: any) {
    const page = Math.max(1, Number(query?.page) || 1);
    const size = Math.min(50, Math.max(1, Number(query?.size) || 10));
    const conds = ['user_id = ?'];
    const params: any[] = [user.id];
    if (query?.unread === '1' || query?.unread === 'true') conds.push('read_flag = 0');
    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM sys_notice WHERE ${conds.join(' AND ')}`, ...params)?.n || 0;
    const list = this.db.all<any>(
      `SELECT * FROM sys_notice WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, size, (page - 1) * size,
    ).map((n) => ({ ...n, read_flag: !!n.read_flag, type_label: NOTICE_TYPE_LABELS[n.type] || n.type }));
    return paged(list, total, page, size);
  }

  /** 未读数 */
  unreadCount(user: AuthUser) {
    return this.db.one<any>('SELECT COUNT(*) AS n FROM sys_notice WHERE user_id = ? AND read_flag = 0', user.id)?.n || 0;
  }

  /** 标记已读：单条或全部 */
  markRead(user: AuthUser, dto: { id?: number; all?: boolean }) {
    if (dto?.all) {
      this.db.run('UPDATE sys_notice SET read_flag = 1 WHERE user_id = ? AND read_flag = 0', user.id);
      return { updated: -1, unread: 0 };
    }
    const id = Number(dto?.id || 0);
    if (id) this.db.run('UPDATE sys_notice SET read_flag = 1 WHERE id = ? AND user_id = ?', id, user.id);
    return { updated: id, unread: this.unreadCount(user) };
  }
}
