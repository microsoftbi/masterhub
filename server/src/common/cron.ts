/**
 * 极简 5 段 cron 解析：分 时 日 月 周。
 * 支持 * 、步长(n) 、区间(a-b) 、逗号列表(a,b,c) 的组合；周字段 0-7（0 与 7 均为周日）。
 * 调度中心与种子数据共用，不引入外部依赖。
 */

interface FieldMatcher {
  /** true 表示 `*`（不限） */
  any: boolean;
  values: Set<number>;
}

const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function parseField(field: string, min: number, max: number): FieldMatcher | null {
  const text = String(field ?? '').trim();
  const m: FieldMatcher = { any: text === '*' || text === '', values: new Set() };
  if (m.any) return m;
  for (const part of text.split(',')) {
    if (!part) return null;
    let range = part;
    let step = 1;
    if (part.includes('/')) {
      const seg = part.split('/');
      if (seg.length !== 2) return null;
      range = seg[0];
      step = Number(seg[1]);
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let lo = min;
    let hi = max;
    if (range !== '*') {
      if (range.includes('-')) {
        const seg = range.split('-');
        if (seg.length !== 2) return null;
        lo = Number(seg[0]);
        hi = Number(seg[1]);
      } else {
        lo = hi = Number(range);
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) m.values.add(max === 6 && v === 7 ? 0 : v);
  }
  return m;
}

export interface CronExpr {
  minute: FieldMatcher;
  hour: FieldMatcher;
  dom: FieldMatcher;
  month: FieldMatcher;
  dow: FieldMatcher;
}

/** 解析并校验 cron 表达式，非法返回 null */
export function parseCron(expr: string): CronExpr | null {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

/** 时间点是否命中（日/周均限定时按标准 cron 取并集） */
export function matchCron(c: CronExpr, d: Date): boolean {
  if (!c.minute.any && !c.minute.values.has(d.getMinutes())) return false;
  if (!c.hour.any && !c.hour.values.has(d.getHours())) return false;
  if (!c.month.any && !c.month.values.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.any || c.dom.values.has(d.getDate());
  const dowOk = c.dow.any || c.dow.values.has(d.getDay());
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return dowOk;
  if (c.dow.any) return domOk;
  return domOk || dowOk;
}

function toLocalStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 计算下一次执行时间（从 from 的下一整分钟起逐分钟扫描，格式与 nowStr 一致） */
export function nextRunAfter(expr: string, from: Date = new Date()): string | null {
  const c = parseCron(expr);
  if (!c) return null;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = 3 * 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchCron(c, d)) return toLocalStr(d);
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** 常见 cron 的中文描述（用于界面展示，未覆盖时原样返回） */
const isNumField = (s: string) => /^\d+$/.test(s);

export function describeCron(expr: string): string {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parseCron(expr) === null || parts.length !== 5) return String(expr ?? '');
  const [mf, hf, domf, monf, dowf] = parts;
  const mm = isNumField(mf) ? mf.padStart(2, '0') : mf;
  const hh = isNumField(hf) ? hf.padStart(2, '0') : hf;
  if (monf !== '*') return `每年 ${monf} 月（${expr}）`;
  if (domf !== '*' && dowf !== '*') return `每月 ${domf} 日 ${hh}:${mm}（${expr}）`;
  if (domf !== '*') return `每月 ${domf} 日 ${hh}:${mm}`;
  if (dowf !== '*') {
    const days = dowf.split(',').map((x) => WEEK_LABELS[Number(x) % 7] || x).join('、');
    return `每${days} ${hh}:${mm}`;
  }
  if (mf.startsWith('*/')) return `每 ${mf.slice(2)} 分钟`;
  if (hf.startsWith('*/')) return `每 ${hf.slice(2)} 小时（第 ${mm} 分）`;
  if (hf === '*') return `每小时第 ${mm} 分`;
  return `每天 ${hh}:${mm}`;
}
