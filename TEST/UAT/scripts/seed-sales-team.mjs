/**
 * 销售团队层级数据造数脚本（docs/FAQ 教程配套）。
 * 前置：sales_team 域/模型已发布，码表 sales_rank、sales_region 已建，
 *       编码规则 XS+SEQ4 已配，张万峰(XS0001)/李成钢(XS0002)已发布。
 * 用法：node TEST/UAT/scripts/seed-sales-team.mjs
 * 每条记录：admin 提交 → leader/steward 自适应多轮审批 → 发布生成编码。
 */
const BASE = 'http://localhost:3000';

async function api(method, path, body, tok) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) throw new Error(`${method} ${path} 失败: ${json?.msg || res.status}`);
  return json.data;
}

async function login(username, password) {
  return (await api('POST', '/api/v1/auth/login', { username, password })).token;
}

async function codeOf(name, tok) {
  const list = await api('GET', `/api/v1/master-data/sales_team?page=1&size=50&keyword=${encodeURIComponent(name)}`, undefined, tok);
  const rec = (list.list || []).find((x) => x.name === name && x.status === 'PUBLISHED');
  if (!rec?.master_code) throw new Error(`找不到已发布的「${name}」`);
  return rec.master_code;
}

async function approveUntilPublished(name, adminTok, approverToks) {
  for (let round = 0; round < 4; round++) {
    let acted = false;
    for (const tk of approverToks) {
      const todo = (await api('GET', '/api/v1/approvals/todo', undefined, tk)) || [];
      const task = todo.find((x) => String(x.title || '').includes(name));
      if (task) {
        await api('POST', `/api/v1/approvals/${task.instance_id}/pass`, { comment: '销售团队数据初始化' }, tk);
        acted = true;
      }
    }
    const rec = await codeOf(name, adminTok).catch(() => null);
    if (rec) return rec;
    if (!acted) break;
  }
  throw new Error(`「${name}」审批流走完仍未发布`);
}

const admin = await login('admin', 'admin123');
const leader = await login('leader', 'leader123');
const steward = await login('steward', 'steward123');

// (姓名, 职级, 大区, 上级姓名|null, 入职日期)
const members = [
  ['王丽华', 'REGION_MANAGER', 'SOUTH', '张万峰', '2021-08-15'],
  ['陈美琳', 'MANAGER', 'EAST', '李成钢', '2022-04-10'],
  ['刘志强', 'MANAGER', 'SOUTH', '王丽华', '2022-05-20'],
  ['孙晓东', 'SALES', 'EAST', '陈美琳', '2023-07-01'],
  ['钱小雨', 'SALES', 'EAST', '陈美琳', '2023-09-15'],
  ['何大勇', 'SALES', 'SOUTH', '刘志强', '2023-03-01'],
  ['宋佳', 'SALES', 'SOUTH', '刘志强', '2024-02-19'],
];

for (const [name, rank, region, parentName, entryDate] of members) {
  const existing = await codeOf(name, admin).catch(() => null);
  if (existing) { console.log(`- ${name} 已存在（${existing}），跳过`); continue; }
  const parentMember = parentName ? await codeOf(parentName, admin) : '';
  await api('POST', '/api/v1/master-data/sales_team', {
    data: { memberName: name, rank, region, parentMember: parentName ? parentMember : '', entryDate, active: true },
    submit: true,
  }, admin);
  const code = await approveUntilPublished(name, admin, [leader, steward]);
  console.log(`✔ ${name.padEnd(4)} ${parentName ? `上级 ${parentName}(${parentMember})` : '—'} → ${code}`);
}

const list = await api('GET', '/api/v1/master-data/sales_team?page=1&size=50', undefined, admin);
console.log(`\n完成：sales_team 共 ${list.total} 条已发布记录`);
for (const r of (list.list || []).sort((a, b) => (a.master_code || '').localeCompare(b.master_code || ''))) {
  console.log(`  ${r.master_code}  ${r.name}  v${r.version}  ${r.status}`);
}
