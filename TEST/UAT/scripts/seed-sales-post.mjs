/**
 * 岗位主数据造数脚本（docs/FAQ 教程配套）。
 * 前置：sales_post 域/模型已发布（postName/postSeq/headcount/postDuty），
 *       编码规则 POST+3 位流水已配；「销售总监」已由浏览器提交（可由本脚本审批）。
 * 功能：补齐 4 个岗位（缺哪个建哪个），自适应多轮审批直至全部发布。幂等。
 * 用法：node TEST/UAT/scripts/seed-sales-post.mjs
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

async function recordOf(name, tok) {
  const list = await api('GET', `/api/v1/master-data/sales_post?page=1&size=50&keyword=${encodeURIComponent(name)}`, undefined, tok);
  return (list.list || []).find((x) => x.name === name) || null;
}

async function publishedCodeOf(name, tok) {
  const rec = await recordOf(name, tok);
  return rec?.status === 'PUBLISHED' ? rec.master_code : null;
}

/** DEFAULT_ADD：leader（部门初审）→ steward（数据治理岗复审）→ 自动发布发号 */
async function approveUntilPublished(name, adminTok, approverToks) {
  for (let round = 0; round < 4; round++) {
    let acted = false;
    for (const tk of approverToks) {
      const todo = (await api('GET', '/api/v1/approvals/todo', undefined, tk)) || [];
      const task = todo.find((x) => String(x.title || '').includes(name));
      if (task) {
        await api('POST', `/api/v1/approvals/${task.instance_id}/pass`, { comment: '销售岗位数据初始化' }, tk);
        acted = true;
      }
    }
    const code = await publishedCodeOf(name, adminTok);
    if (code) return code;
    if (!acted) break;
  }
  throw new Error(`岗位「${name}」审批流走完仍未发布`);
}

// (岗位名称, 岗位序列, 编制人数, 岗位职责)
const POSITIONS = [
  ['销售总监', 'DIRECTOR', 1, '制定全国销售战略，统筹各大区业绩目标，直接管理大区经理'],
  ['大区经理', 'REGION_MANAGER', 2, '统筹大区销售运营与目标拆解，管理二线经理，向销售总监汇报'],
  ['二线经理', 'MANAGER', 2, '负责一线销售团队的日常管理、陪访与业绩辅导'],
  ['一线销售', 'SALES', 4, '客户开发与关系维护，达成个人业绩目标'],
];

const admin = await login('admin', 'admin123');
const leader = await login('leader', 'leader123');
const steward = await login('steward', 'steward123');

for (const [name, postSeq, headcount, postDuty] of POSITIONS) {
  const existing = await recordOf(name, admin);
  if (existing?.status === 'PUBLISHED') { console.log(`- ${name} 已存在（${existing.master_code}），跳过`); continue; }
  if (!existing) {
    await api('POST', '/api/v1/master-data/sales_post', {
      data: { postName: name, postSeq, headcount, postDuty },
      submit: true,
    }, admin);
  } else {
    console.log(`~ ${name} 已提交待审批（${existing.status}），直接进入审批`);
  }
  const code = await approveUntilPublished(name, admin, [leader, steward]);
  console.log(`✔ ${name.padEnd(4)} ${postSeq.padEnd(15)} 编制 ${headcount} → ${code}`);
}

const list = await api('GET', '/api/v1/master-data/sales_post?page=1&size=50', undefined, admin);
console.log(`\n完成：sales_post 共 ${list.total} 条已发布记录`);
for (const r of (list.list || []).sort((a, b) => (a.master_code || '').localeCompare(b.master_code || ''))) {
  console.log(`  ${r.master_code}  ${r.name}  v${r.version}  ${r.status}`);
}
