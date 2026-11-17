/**
 * 存量销售人员岗位字段回填脚本（docs/FAQ 教程配套）。
 * 前置：sales_member 模型已改为 post REF（rank 已删）并重新发布 v2；
 *       岗位 POST001-004 已发布。
 * 功能：为 9 名存量成员补齐 post 字段（PUBLISHED → 变更审批 → 发布，版本 +1）。幂等。
 * 用法：node TEST/UAT/scripts/backfill-member-post.mjs
 */
const BASE = 'http://localhost:3000';

async function api(method, path, body, tok) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) throw new Error(`${method} ${path} 失败: ${json?.msg || res.status}`);
  return json.data;
}

async function login(username, password) {
  return (await api('POST', '/api/v1/auth/login', { username, password })).token;
}

// 成员姓名 → 岗位名称（岗位编码运行时按名称反查）
const MEMBER_TO_POST = {
  张万峰: '销售总监',
  李成钢: '大区经理',
  王丽华: '大区经理',
  陈美琳: '二线经理',
  刘志强: '二线经理',
  孙晓东: '一线销售',
  钱小雨: '一线销售',
  何大勇: '一线销售',
  宋佳: '一线销售',
};

/** DEFAULT_CHANGE：仅 steward（数据治理岗审核）→ auto 生效 */
async function approveChange(name, adminTok, stewardTok) {
  for (let round = 0; round < 4; round++) {
    const todo = (await api('GET', '/api/v1/approvals/todo', undefined, stewardTok)) || [];
    const task = todo.find((x) => String(x.title || '').includes(name));
    if (!task) break;
    await api('POST', `/api/v1/approvals/${task.instance_id}/pass`, { comment: '岗位字段回填' }, stewardToken);
  }
  const list = await api('GET', `/api/v1/master-data/sales_team?page=1&size=50&keyword=${encodeURIComponent(name)}`, undefined, adminTok);
  return (list.list || []).find((x) => x.name === name) || null;
}

const admin = await login('admin', 'admin123');
const stewardToken = await login('steward', 'steward123');

// 岗位名称 → 编码
const postList = await api('GET', '/api/v1/master-data/sales_post?page=1&size=50', undefined, admin);
const postCodeOf = Object.fromEntries((postList.list || []).filter((x) => x.status === 'PUBLISHED').map((x) => [x.name, x.master_code]));
console.log('岗位编码映射：', postCodeOf);

const members = await api('GET', '/api/v1/master-data/sales_team?page=1&size=50', undefined, admin);
for (const m of (members.list || [])) {
  const detail = await api('GET', `/api/v1/master-data/sales_team/${m.master_code}`, undefined, admin);
  const d = detail.record?.data || detail.data || detail;
  if (d.post) { console.log(`- ${m.name} 已有岗位（${d.post}），跳过`); continue; }
  const postName = MEMBER_TO_POST[m.name];
  if (!postName) { console.log(`! ${m.name} 无岗位映射，跳过`); continue; }
  const data = {
    memberName: d.memberName,
    region: d.region,
    parentMember: d.parentMember || '',
    post: postCodeOf[postName],
    entryDate: d.entryDate,
    active: d.active,
  };
  await api('PUT', `/api/v1/master-data/sales_team/${m.master_code}`, { data, submit: true }, admin);
  const after = await approveChange(m.name, admin, stewardToken);
  console.log(`✔ ${m.name.padEnd(4)} ${m.master_code} 岗位→${data.post}  v${after?.version} ${after?.status}`);
}

const final = await api('GET', '/api/v1/master-data/sales_team?page=1&size=50', undefined, admin);
console.log(`\n完成：sales_team ${final.total} 条`);
for (const r of (final.list || []).sort((a, b) => (a.master_code || '').localeCompare(b.master_code || ''))) {
  console.log(`  ${r.master_code}  ${r.name}  v${r.version}  ${r.status}`);
}
