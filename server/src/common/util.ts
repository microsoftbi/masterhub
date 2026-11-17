import { createHash } from 'crypto';

/** 本地时间字符串 YYYY-MM-DDTHH:mm:ss（SQLite 存储为 TEXT，按字典序可排序） */
export function nowStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function addHours(hours: number, base: Date = new Date()): string {
  return nowStr(new Date(base.getTime() + hours * 3600 * 1000));
}

export function dateOnly(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 按编码规则中的日期格式渲染，支持 yyyy / MM / dd / HH / mm / ss */
export function formatDate(fmt: string, d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, p(d.getMonth() + 1))
    .replace(/dd/g, p(d.getDate()))
    .replace(/HH/g, p(d.getHours()))
    .replace(/mm/g, p(d.getMinutes()))
    .replace(/ss/g, p(d.getSeconds()));
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashRule(domain: string, segments: any[]): string {
  return sha256(domain + '::' + JSON.stringify(segments)).slice(0, 24);
}

/** 规范化 JSON：对象 key 排序后序列化，用于数据指纹 */
export function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function fingerprintOf(data: any): string {
  return sha256(canonicalJson(data || {}));
}

export function parseJson<T = any>(text: string | null | undefined, fallback?: T): T {
  if (!text) return fallback as T;
  try {
    return JSON.parse(text);
  } catch {
    return fallback as T;
  }
}

/** 字段级差异：{ key: { old, new } } */
export function diffJson(oldData: any, newData: any): Record<string, { old: any; new: any }> {
  const keys = new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})]);
  const out: Record<string, { old: any; new: any }> = {};
  for (const k of keys) {
    const a = oldData?.[k];
    const b = newData?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { old: a ?? null, new: b ?? null };
  }
  return out;
}

export function eventNo(seq: number): string {
  return 'EVT' + formatDate('yyyyMMddHHmmss') + String(seq).padStart(4, '0');
}

export function paged<T>(list: T[], total: number, page: number, size: number) {
  return { list, total, page, size };
}

export function toInt(v: any, fallback = 0): number {
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? fallback : n;
}

export function likeEscape(kw: string): string {
  return (kw || '').replace(/[%_\\]/g, (m) => '\\' + m);
}

/** 名称相似度：字面归一 + 编辑距离 + 二元组 Jaccard，加权 0~1 */
export function similarity(a: string, b: string): number {
  const norm = (s: string) => (s || '').toLowerCase().replace(/[\s\-_·（）()【】\[\],，.。]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const lev = levenshtein(x, y);
  const levScore = 1 - lev / Math.max(x.length, y.length);
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  bx.forEach((g) => {
    if (by.has(g)) inter++;
  });
  const union = bx.size + by.size - inter;
  const jac = union === 0 ? 0 : inter / union;
  return Math.max(0, Math.round((levScore * 0.55 + jac * 0.45) * 1000) / 1000);
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 脱敏：保留首尾，中间掩码 */
export function maskValue(v: any): string {
  const s = String(v ?? '');
  if (!s) return '';
  if (s.length <= 2) return '*'.repeat(s.length);
  if (s.length <= 6) return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
  return s.slice(0, 3) + '*'.repeat(Math.max(2, s.length - 7)) + s.slice(-4);
}
