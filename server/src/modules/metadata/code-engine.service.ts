import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { BizException, ErrCode } from '../../common/errors';
import { dateOnly, formatDate, hashRule, nowStr, parseJson } from '../../common/util';

/**
 * 编码引擎：规则段 FIX / DATE / JOIN / SEQ 有序组合。
 * M1 使用 md_sequence 表事务原子发号（单实例 SQLite），迁移 PG 多实例后切换 Redis INCR。
 */
@Injectable()
export class CodeEngine {
  constructor(private db: DbService) {}

  getRule(domain: string) {
    const rule = this.db.one<any>('SELECT * FROM md_code_rule WHERE domain_code = ? AND status = ?', domain, 'ACTIVE');
    if (!rule) throw new BizException(`主数据域 ${domain} 未配置编码规则`, ErrCode.BUSINESS);
    return { ...rule, segments: parseJson<any[]>(rule.segments, []) };
  }

  private periodOf(segments: any[]): string {
    const seq = segments.find((s) => s.type === 'SEQ');
    if (!seq) return 'ALL';
    if (seq.reset === 'MONTH') return formatDate('yyyyMM');
    if (seq.reset === 'FOREVER') return 'ALL';
    return dateOnly();
  }

  private render(segments: any[], seqValue: number): string {
    const parts: string[] = [];
    for (const seg of segments) {
      if (seg.type === 'FIX') parts.push(String(seg.value ?? ''));
      else if (seg.type === 'DATE') parts.push(formatDate(seg.fmt || 'yyyyMMdd'));
      else if (seg.type === 'JOIN') parts.push(String(seg.value ?? '-'));
      else if (seg.type === 'SEQ') {
        const len = Number(seg.len || 4);
        const s = String(seqValue);
        if (s.length > len) throw new BizException(`编码流水号已超出 ${len} 位长度，请调整规则或扩容`, ErrCode.BUSINESS);
        parts.push(s.padStart(len, '0'));
      }
    }
    return parts.join('');
  }

  /** 预览：取当前流水 + 1，不落库 */
  preview(domain: string) {
    const rule = this.getRule(domain);
    const period = this.periodOf(rule.segments);
    const hash = hashRule(domain, rule.segments);
    const row = this.db.one<any>('SELECT cur FROM md_sequence WHERE rule_hash = ? AND period = ?', hash, period);
    const next = (row?.cur || 0) + 1;
    return { code: this.render(rule.segments, next), next, period, segments: rule.segments };
  }

  /** 正式发号：事务内原子自增，返回编码 */
  generate(domain: string): string {
    const rule = this.getRule(domain);
    const period = this.periodOf(rule.segments);
    const hash = hashRule(domain, rule.segments);
    return this.db.tx(() => {
      const row = this.db.one<any>('SELECT cur FROM md_sequence WHERE rule_hash = ? AND period = ?', hash, period);
      let next: number;
      if (!row) {
        this.db.run('INSERT INTO md_sequence (rule_hash, period, cur, updated_at) VALUES (?, ?, 1, ?)', hash, period, nowStr());
        next = 1;
      } else {
        next = row.cur + 1;
        this.db.run('UPDATE md_sequence SET cur = ?, updated_at = ? WHERE rule_hash = ? AND period = ?', next, nowStr(), hash, period);
      }
      return this.render(rule.segments, next);
    });
  }
}
