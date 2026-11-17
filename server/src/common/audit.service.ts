import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { nowStr } from './util';

/** 审计日志：登录、增删改、审批、导入、分发等关键动作统一落库 */
@Injectable()
export class AuditService {
  constructor(private db: DbService) {}

  log(user: { id?: number; username?: string } | null, module: string, action: string, target: string, detail?: any, ip?: string) {
    try {
      this.db.run(
        'INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        user?.id ?? null,
        user?.username ?? 'system',
        module,
        action,
        target,
        typeof detail === 'string' ? detail : JSON.stringify(detail ?? null),
        ip || '127.0.0.1',
        nowStr(),
      );
    } catch {
      // 审计失败不阻断主流程
    }
  }
}
