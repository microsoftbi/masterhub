import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'crypto';
import { DbService } from '../../db/db.service';
import { AuditService } from '../../common/audit.service';
import { BizException, ErrCode } from '../../common/errors';
import { addHours, eventNo, nowStr, parseJson } from '../../common/util';
import { AuthUser } from '../../common/decorators';

/**
 * 分发（出）：Outbox 模式。主数据发布/变更写 int_push_event，后台按订阅关系推送。
 * 失败按指数退避重试，超过 5 次置 DEAD，可在分发日志中人工重试。
 */
@Injectable()
export class OutboxService {
  constructor(private db: DbService) {}

  emit(domain: string, masterCode: string, eventType: string, data: any, version: number) {
    const subs = this.db.all<any>("SELECT * FROM int_subscriber WHERE status = 'ACTIVE'");
    const targets = subs.filter((s) => String(s.domain_codes || '').split(',').map((x) => x.trim()).includes(domain));
    const ts = nowStr();
    let count = 0;
    for (const sub of targets) {
      const no = eventNo(Math.floor(Math.random() * 9000) + 1000);
      const payload = {
        eventNo: no,
        eventType,
        domain,
        masterCode,
        occurredAt: ts,
        data: { ...data, status: eventType === 'ARCHIVE' ? 'ARCHIVED' : 'PUBLISHED', version },
      };
      this.db.run(
        'INSERT INTO int_push_event (event_no, subscriber_id, domain_code, master_code, event_type, payload, status, retry_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
        no, sub.id, domain, masterCode || '-', eventType, JSON.stringify(payload), 'PENDING', ts,
      );
      count++;
    }
    return count;
  }
}

@Injectable()
export class IntegrationService implements OnModuleInit {
  private logger = new Logger('Integration');

  constructor(private db: DbService, private audit: AuditService, private outbox: OutboxService) {}

  onModuleInit() {
    const interval = parseInt(process.env.DISPATCH_INTERVAL || '20000', 10);
    if (interval > 0) {
      setInterval(async () => {
        try {
          await this.dispatchDue(20, null);
        } catch (e) {
          this.logger.warn('后台分发失败：' + (e as any)?.message);
        }
      }, interval).unref();
    }
  }

  subscribers() {
    return this.db.all<any>(
      `SELECT s.*, (SELECT COUNT(*) FROM int_push_event e WHERE e.subscriber_id = s.id) AS event_count,
        (SELECT COUNT(*) FROM int_push_event e WHERE e.subscriber_id = s.id AND e.status = 'PENDING') AS pending_count
       FROM int_subscriber s ORDER BY s.id`,
    ).map((s) => ({ ...s, domain_codes: String(s.domain_codes || '').split(',').filter(Boolean) }));
  }

  /** 分发概览：待推送 / 已推送 / 失败 / 死信 / 成功率 */
  summary() {
    const rows = this.db.all<any>('SELECT status, COUNT(*) AS n FROM int_push_event GROUP BY status');
    const map: Record<string, number> = {};
    for (const r of rows) map[r.status] = r.n;
    const total = Object.values(map).reduce((a, b) => a + b, 0);
    const pushed = map['PUSHED'] || 0;
    return {
      total,
      pending: map['PENDING'] || 0,
      pushed,
      failed: map['FAILED'] || 0,
      dead: map['DEAD'] || 0,
      successRate: total ? Math.round((pushed / total) * 1000) / 10 : 0,
      subscribers: this.db.one<any>("SELECT COUNT(*) AS n FROM int_subscriber WHERE status = 'ACTIVE'")?.n || 0,
    };
  }

  /** 开放 API：按 id 游标增量拉取已发布数据 */
  openPull(domain: string, cursor?: string) {
    const after = parseInt(cursor || '0', 10) || 0;
    const rows = this.db.all<any>(
      `SELECT id, master_code, name, version, data, updated_at FROM md_master_data
       WHERE domain_code = ? AND status = 'PUBLISHED' AND deleted = 0 AND id > ? ORDER BY id LIMIT 50`,
      domain, after,
    );
    const list = rows.map((r) => ({
      id: r.id,
      masterCode: r.master_code,
      name: r.name,
      version: r.version,
      updatedAt: r.updated_at,
      data: parseJson(r.data, {}),
    }));
    return { domain, list, nextCursor: rows.length ? String(rows[rows.length - 1].id) : String(after) };
  }

  saveSubscriber(dto: any, user: AuthUser) {
    if (!dto.code || !dto.name || !dto.url) throw new BizException('订阅编码、名称、回调地址不能为空', ErrCode.PARAM);
    if (!/^https?:\/\//.test(dto.url)) throw new BizException('回调地址需以 http(s):// 开头', ErrCode.PARAM);
    const domains = Array.isArray(dto.domainCodes) ? dto.domainCodes.join(',') : String(dto.domainCodes || '');
    if (!domains) throw new BizException('至少选择一个订阅主数据域', ErrCode.PARAM);
    const existing = dto.id ? this.db.one<any>('SELECT * FROM int_subscriber WHERE id = ?', dto.id) : this.db.one<any>('SELECT * FROM int_subscriber WHERE code = ?', dto.code);
    if (existing) {
      this.db.run('UPDATE int_subscriber SET code = ?, name = ?, domain_codes = ?, url = ?, secret = ?, status = ? WHERE id = ?',
        dto.code, dto.name, domains, dto.url, dto.secret ?? existing.secret, dto.status ?? existing.status, existing.id);
      this.audit.log(user, 'integration', 'SUBSCRIBER_UPDATE', `修改订阅 ${dto.name}`, dto.code);
      return Number(existing.id);
    }
    const r = this.db.run('INSERT INTO int_subscriber (code, name, domain_codes, url, secret, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      dto.code, dto.name, domains, dto.url, dto.secret || null, dto.status || 'ACTIVE', nowStr());
    this.audit.log(user, 'integration', 'SUBSCRIBER_CREATE', `新建订阅 ${dto.name}`, dto.code);
    return Number(r.lastInsertRowid);
  }

  events(query: any) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const size = Math.min(100, Math.max(1, parseInt(query.size || '20', 10)));
    const where: string[] = [];
    const params: any[] = [];
    if (query.status) { where.push('e.status = ?'); params.push(query.status); }
    if (query.domain) { where.push('e.domain_code = ?'); params.push(query.domain); }
    if (query.subscriberId) { where.push('e.subscriber_id = ?'); params.push(query.subscriberId); }
    if (query.keyword) { where.push('(e.master_code LIKE ? OR e.event_no LIKE ?)'); params.push(`%${query.keyword}%`, `%${query.keyword}%`); }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM int_push_event e ${cond}`, ...params)?.n || 0;
    const list = this.db.all<any>(
      `SELECT e.*, s.name AS subscriber_name, s.code AS subscriber_code
       FROM int_push_event e LEFT JOIN int_subscriber s ON s.id = e.subscriber_id
       ${cond} ORDER BY e.id DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size,
    );
    return {
      list: list.map((e) => ({
        ...e,
        payload: undefined,
        payloadPreview: (() => {
          const p: any = parseJson(e.payload, {});
          return { name: p?.data?.materialName || p?.data?.customerName || p?.data?.supplierName || '', version: p?.version };
        })(),
      })),
      total, page, size,
    };
  }

  eventDetail(id: number) {
    const event = this.db.one<any>(
      'SELECT e.*, s.name AS subscriber_name FROM int_push_event e LEFT JOIN int_subscriber s ON s.id = e.subscriber_id WHERE e.id = ?', id);
    if (!event) throw new BizException('分发事件不存在', ErrCode.NOT_FOUND);
    return {
      ...event,
      payload: parseJson(event.payload, {}),
      logs: this.db.all<any>('SELECT * FROM int_push_log WHERE event_id = ? ORDER BY id DESC', id),
    };
  }

  logs(query: any) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const size = Math.min(100, Math.max(1, parseInt(query.size || '20', 10)));
    const where: string[] = [];
    const params: any[] = [];
    if (query.eventId) { where.push('l.event_id = ?'); params.push(query.eventId); }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM int_push_log l ${cond}`, ...params)?.n || 0;
    const list = this.db.all<any>(
      `SELECT l.*, e.event_no, e.master_code, s.name AS subscriber_name
       FROM int_push_log l LEFT JOIN int_push_event e ON e.id = l.event_id LEFT JOIN int_subscriber s ON s.id = e.subscriber_id
       ${cond} ORDER BY l.id DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size);
    return { list, total, page, size };
  }

  async retry(id: number, user: AuthUser | null) {
    const event = this.db.one<any>('SELECT * FROM int_push_event WHERE id = ?', id);
    if (!event) throw new BizException('分发事件不存在', ErrCode.NOT_FOUND);
    if (event.status === 'PUSHED') throw new BizException('该事件已推送成功，无需重试', ErrCode.STATE);
    this.db.run("UPDATE int_push_event SET status = 'PENDING', next_retry_at = NULL WHERE id = ?", id);
    const result = await this.dispatchOne(id);
    if (user) this.audit.log(user, 'integration', 'PUSH_RETRY', `重试分发 ${event.event_no}`, result.message);
    return result;
  }

  async dispatchDue(limit = 20, user: AuthUser | null) {
    const now = nowStr();
    const rows = this.db.all<any>(
      `SELECT * FROM int_push_event
       WHERE status IN ('PENDING', 'FAILED') AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY id LIMIT ?`, now, limit);
    const result = { attempted: 0, success: 0, failed: 0, items: [] as any[] };
    for (const row of rows) {
      const r = await this.dispatchOne(row.id);
      result.attempted++;
      if (r.success) result.success++;
      else result.failed++;
      result.items.push(r);
    }
    if (user) this.audit.log(user, 'integration', 'DISPATCH', `手动触发分发达 ${rows.length} 条`, result);
    return result;
  }

  async dispatchOne(id: number) {
    const event = this.db.one<any>(
      'SELECT e.*, s.url, s.secret, s.name AS subscriber_name FROM int_push_event e LEFT JOIN int_subscriber s ON s.id = e.subscriber_id WHERE e.id = ?', id);
    if (!event) return { success: false, message: '事件不存在' };
    if (event.status === 'PUSHED') return { success: true, message: '已推送' };
    const attempt = event.retry_count + 1;
    const started = Date.now();
    const body = event.payload;
    const signature = event.secret ? createHmac('sha256', event.secret).update(body).digest('hex') : '';
    return this.sendWithFetch(id, event, attempt, body, signature, started);
  }

  private async sendWithFetch(eventId: number, event: any, attempt: number, body: string, signature: string, started: number) {
    try {
      const res = await fetch(event.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MH-Signature': signature, 'X-MH-Event': event.event_no },
        body,
        signal: AbortSignal.timeout(5000),
      });
      const text = (await res.text()).slice(0, 2000);
      const ok = res.ok;
      this.finishEvent(eventId, attempt, ok, body, text, Date.now() - started, ok ? null : `HTTP ${res.status}`);
      return { success: ok, message: ok ? `推送成功（HTTP ${res.status}）` : `推送失败（HTTP ${res.status}）` };
    } catch (e: any) {
      const msg = e?.name === 'TimeoutError' ? '请求超时（5s）' : String(e?.message || e);
      this.finishEvent(eventId, attempt, false, body, msg, Date.now() - started, msg);
      return { success: false, message: '推送失败：' + msg };
    }
  }

  private finishEvent(eventId: number, attempt: number, success: boolean, request: string, response: string, duration: number, error: string | null) {
    const event = this.db.one<any>('SELECT * FROM int_push_event WHERE id = ?', eventId);
    if (!event) return;
    this.db.run('INSERT INTO int_push_log (event_id, attempt, success, request, response, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      eventId, attempt, success ? 1 : 0, request.slice(0, 2000), response.slice(0, 2000), duration, nowStr());
    if (success) {
      this.db.run("UPDATE int_push_event SET status = 'PUSHED', retry_count = ?, last_error = NULL, next_retry_at = NULL WHERE id = ?", attempt, eventId);
    } else {
      // 全局参数：最大重试次数（超过进入死信）
      const maxRetry = Number(this.db.cfg('dispatch.maxRetry', 5)) || 5;
      const dead = attempt >= maxRetry;
      const next = dead ? null : addHours(Math.pow(2, attempt) / 60);
      this.db.run('UPDATE int_push_event SET status = ?, retry_count = ?, last_error = ?, next_retry_at = ? WHERE id = ?',
        dead ? 'DEAD' : 'FAILED', attempt, error, next, eventId);
    }
  }
}
