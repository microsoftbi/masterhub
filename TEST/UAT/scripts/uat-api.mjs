/**
 * MasterHub UAT API 自动化测试脚本
 * 覆盖 uat-testcases.md 中的 40 个 API 用例，结果写入 ../results/uat-api-results.json
 *
 * 用法（工作区根目录执行）：
 *   node TEST/UAT/scripts/uat-api.mjs [baseUrl]
 * 前置：后端服务已启动（默认 http://localhost:3000）
 */
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://localhost:3000';
// better-sqlite3 依赖位于 server/node_modules，通过 server/test 目录解析
const require2 = createRequire(pathToFileURL(join(__dirname, '..', '..', '..', 'server', 'test', 'x.mjs')));
const Database = require2('better-sqlite3');

const stamp = Date.now().toString().slice(-6);
const results = [];

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let b = null;
  try { b = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, body: b };
}

const data = (r) => r.body?.data;

/** 执行单个用例并记录结果 */
async function runCase(id, name, moduleName, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ id, name, module: moduleName, status: 'PASS', note: note || '', ms: Date.now() - t0 });
    console.log(`  PASS ${id} ${name}${note ? `（${note}）` : ''}`);
  } catch (e) {
    results.push({ id, name, module: moduleName, status: 'FAIL', note: e?.message || String(e), ms: Date.now() - t0 });
    console.error(`  FAIL ${id} ${name}：${e?.message || e}`);
  }
}

function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

// ---------------- 运行期共享状态 ----------------
let adminToken = '';
let stewardToken = '';
let leaderToken = '';
let draftId = 0;
let masterCode = '';
let leaders = [];

async function main() {
  console.log(`MasterHub UAT API 测试\n目标：${BASE}\n`);

  // ============ 1. 认证与权限 ============
  console.log('[1] 认证与权限 AUTH');
  await runCase('UAT-AUTH-01', '管理员有效登录', 'AUTH', async () => {
    const r = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'admin123' });
    ok(r.body?.code === 0 && data(r)?.token, '登录失败');
    adminToken = data(r).token;
    return `token=${adminToken.slice(0, 12)}...`;
  });
  await runCase('UAT-AUTH-02', '错误密码拒绝', 'AUTH', async () => {
    const r = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'wrong-pass' });
    ok(r.body?.code !== 0, '错误密码不应登录成功');
    return `msg=${r.body?.msg || '—'}`;
  });
  await runCase('UAT-AUTH-03', '获取当前用户信息', 'AUTH', async () => {
    const r = await api('GET', '/api/v1/auth/me', undefined, adminToken);
    ok(r.body?.code === 0 && data(r)?.username === 'admin', 'me 接口返回异常');
    return `roles=${(data(r)?.roles || []).join('/')}`;
  });
  await runCase('UAT-AUTH-04', '未认证访问拦截', 'AUTH', async () => {
    const r = await api('GET', '/api/v1/domains');
    ok(r.body?.code !== 0, '无 token 应被拦截');
    return `http=${r.status}`;
  });
  await runCase('UAT-AUTH-05', '业务角色登录（steward）', 'AUTH', async () => {
    const r = await api('POST', '/api/v1/auth/login', { username: 'steward', password: 'steward123' });
    ok(r.body?.code === 0 && data(r)?.token, 'steward 登录失败');
    stewardToken = data(r).token;
    const l = await api('POST', '/api/v1/auth/login', { username: 'leader', password: 'leader123' });
    ok(l.body?.code === 0 && data(l)?.token, 'leader 登录失败');
    leaderToken = data(l).token;
    return 'steward/leader 均登录成功';
  });

  // ============ 2. 元数据 ============
  console.log('[2] 元数据管理 META');
  await runCase('UAT-META-01', '数据域列表查询', 'META', async () => {
    const r = await api('GET', '/api/v1/domains', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r) || []).length >= 3, '数据域不足');
    return `域=${(data(r) || []).map((d) => d.code).join('/')}`;
  });
  await runCase('UAT-META-02', '模型与字段查询', 'META', async () => {
    const r = await api('GET', '/api/v1/models', undefined, adminToken);
    const list = data(r) || [];
    ok(r.body?.code === 0 && list.length >= 1, '模型列表为空');
    const m = list.find((x) => x.code === 'material' || x.domain_code === 'material') || list[0];
    return `模型=${m?.code || m?.name || '—'}，名称键=${m?.nameKey || m?.name_key || '—'}`;
  });
  await runCase('UAT-META-03', '码表列表查询', 'META', async () => {
    const r = await api('GET', '/api/v1/dicts', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r) || []).length >= 1, '码表为空');
    return `码表数=${(data(r) || []).length}`;
  });

  // ============ 3. 主数据维护 ============
  console.log('[3] 主数据维护 MD');
  await runCase('UAT-MD-01', '列表分页查询', 'MD', async () => {
    const r = await api('GET', '/api/v1/master-data/material?page=1&size=5', undefined, adminToken);
    ok(r.body?.code === 0 && data(r)?.total >= 1 && (data(r)?.list || []).length <= 5, '列表返回异常');
    return `total=${data(r)?.total}`;
  });
  const mdName = `UAT物料-${stamp}`;
  await runCase('UAT-MD-02', '新增草稿', 'MD', async () => {
    const r = await api('POST', '/api/v1/master-data/material', {
      data: { materialName: mdName, spec: 'UAT-SPEC', unit: 'EA', category: 'CONSUME', price: 12.5 },
    }, adminToken);
    ok(r.body?.code === 0 && data(r)?.id, '新增失败');
    draftId = data(r)?.id;
    return `id=${draftId}`;
  });
  await runCase('UAT-MD-03', '提交审批', 'MD', async () => {
    const r = await api('POST', `/api/v1/master-data/material/${draftId}/submit`, undefined, adminToken);
    ok(r.body?.code === 0, `提交失败：${r.body?.msg}`);
    return '进入审批中';
  });
  await runCase('UAT-MD-04', '两级审批通过并发布', 'MD', async () => {
    // 审批顺序由流程定义决定（物料新增：leader 初审 → steward 复审），此处自适应多轮直至发布
    for (let round = 0; round < 4; round++) {
      let acted = false;
      for (const [who, tk] of [['leader', leaderToken], ['steward', stewardToken]]) {
        const todo = data(await api('GET', '/api/v1/approvals/todo', undefined, tk)) || [];
        const task = todo.find((x) => String(x.title || '').includes(mdName));
        if (task) {
          const p = await api('POST', `/api/v1/approvals/${task.instance_id}/pass`, { comment: 'UAT 审批通过' }, tk);
          ok(p.body?.code === 0, `${who} 审批失败：${p.body?.msg}`);
          acted = true;
        }
      }
      const list = data(await api('GET', `/api/v1/master-data/material?page=1&size=20&keyword=${encodeURIComponent(mdName)}`, undefined, adminToken)) || {};
      const rec = (list.list || []).find((x) => x.status === 'PUBLISHED');
      if (rec) { masterCode = rec?.master_code || ''; return `发布成功，主数据编码=${masterCode}`; }
      if (!acted) break;
    }
    throw new Error('审批流走完仍未发布（PUBLISHED）');
  });
  await runCase('UAT-MD-05', '版本历史查询', 'MD', async () => {
    const r = await api('GET', `/api/v1/master-data/material/${masterCode || draftId}/versions`, undefined, adminToken);
    const list = data(r)?.list || [];
    ok(r.body?.code === 0 && list.length >= 1, `版本历史为空：${r.body?.msg}`);
    return `当前 v${data(r)?.record?.version}，历史 ${list.length} 个版本`;
  });
  await runCase('UAT-MD-06', '批量冻结/解冻', 'MD', async () => {
    const f = await api('POST', '/api/v1/master-data/material/batch-lifecycle', { ids: [draftId], action: 'freeze' }, adminToken);
    ok(f.body?.code === 0 && data(f)?.success === 1, `冻结失败：${f.body?.msg}`);
    const u = await api('POST', '/api/v1/master-data/material/batch-lifecycle', { ids: [draftId], action: 'unfreeze' }, adminToken);
    ok(u.body?.code === 0 && data(u)?.success === 1, `解冻失败：${u.body?.msg}`);
    return '冻结→解冻状态流转正确';
  });
  await runCase('UAT-MD-07', '导出 CSV', 'MD', async () => {
    const r = await api('GET', '/api/v1/master-data/material/export', undefined, adminToken);
    ok(r.body?.code === 0 && data(r)?.filename && data(r)?.content?.includes('物料名称'), '导出内容为空');
    return `${data(r)?.filename}（${String(data(r)?.content || '').split('\n').length} 行）`;
  });

  // ============ 4. 导入导出 ============
  console.log('[4] 导入导出 IMP');
  let csvHeader = '';
  await runCase('UAT-IMP-01', '下载导入模板', 'IMP', async () => {
    const r = await api('GET', '/api/v1/imports/material/template', undefined, adminToken);
    ok(r.body?.code === 0 && data(r)?.content?.includes('物料名称'), '模板表头异常');
    csvHeader = String(data(r).content).split(/\r?\n/)[0];
    return `${data(r)?.filename}，表头=${csvHeader.slice(0, 40)}...`;
  });
  let uatBatchId = 0;
  await runCase('UAT-IMP-02', '导入预校验（含错误行）', 'IMP', async () => {
    // 按模板表头列位置构造合法行 + 非法行（缺物料名称）
    const headers = csvHeader.split(',');
    const buildRow = (name) => headers.map((h) => {
      if (h.includes('物料名称')) return name;
      if (h.includes('规格')) return 'UAT-IMP-SPEC';
      if (h.includes('计量')) return 'PCS';
      if (h.includes('分类')) return 'CONSUME';
      if (h.includes('单价')) return '6.6';
      if (h.includes('品牌')) return 'UAT';
      if (h.includes('备注')) return 'UAT 导入';
      return '';
    }).join(',');
    const csv = [csvHeader, buildRow(`UAT导入物料-${stamp}`), buildRow('')].join('\n');
    const r = await api('POST', '/api/v1/imports/material/validate', { filename: `uat-${stamp}.csv`, content: csv }, adminToken);
    ok(r.body?.code === 0 && data(r)?.total === 2 && data(r)?.valid === 1 && data(r)?.invalid === 1,
      `预校验统计异常：total=${data(r)?.total} valid=${data(r)?.valid} invalid=${data(r)?.invalid}`);
    uatBatchId = data(r)?.id;
    return `批次 #${uatBatchId}：合法 1 行，非法 1 行`;
  });
  await runCase('UAT-IMP-03', '导入提交', 'IMP', async () => {
    const r = await api('POST', `/api/v1/imports/${uatBatchId}/commit`, undefined, adminToken);
    ok(r.body?.code === 0, `提交失败：${r.body?.msg}`);
    return `code=0，${JSON.stringify(data(r) || {}).slice(0, 60)}`;
  });
  await runCase('UAT-IMP-04', '导入批次列表', 'IMP', async () => {
    const r = await api('GET', '/api/v1/imports?page=1&size=5', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r)?.total ?? (data(r) || []).length) >= 1, '批次列表为空');
    return `批次 total=${data(r)?.total ?? (data(r) || []).length}`;
  });

  // ============ 5. 审批流程 ============
  console.log('[5] 审批流程 APR');
  await runCase('UAT-APR-01', '审批流程定义列表', 'APR', async () => {
    const r = await api('GET', '/api/v1/approvals/processes', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r) || []).length >= 1, '流程列表为空');
    return `流程数=${(data(r) || []).length}`;
  });
  await runCase('UAT-APR-02', '审批待办查询', 'APR', async () => {
    const r = await api('GET', '/api/v1/approvals/todo', undefined, stewardToken);
    ok(r.body?.code === 0 && Array.isArray(data(r)), '待办返回异常');
    return `steward 待办 ${ (data(r) || []).length } 条`;
  });
  await runCase('UAT-APR-03', '发起抄送审批', 'APR', async () => {
    const h = await api('GET', '/api/v1/approvals/handlers', undefined, adminToken);
    leaders = (data(h) || []).filter((u) => u.username === 'leader');
    const ccId = (leaders[0] || (data(h) || [])[0])?.id;
    const c = await api('POST', '/api/v1/master-data/customer', {
      data: { customerName: `UAT客户-${stamp}`, customerLevel: 'A', region: 'EAST', creditLimit: 100, contact: '李四', phone: '13900000000' },
    }, adminToken);
    ok(c.body?.code === 0 && data(c)?.id, '客户草稿创建失败');
    const s = await api('POST', `/api/v1/master-data/customer/${data(c).id}/submit`, { ccUserIds: ccId ? [ccId] : [] }, adminToken);
    ok(s.body?.code === 0, `带抄送提交失败：${s.body?.msg}`);
    return `抄送人=${ccId || '—'}，提交成功`;
  });

  // ============ 6. 工作流 ============
  console.log('[6] 工作流 WF');
  await runCase('UAT-WF-01', '工作流元数据与定义', 'WF', async () => {
    const m = await api('GET', '/api/v1/workflow/meta', undefined, adminToken);
    ok(m.body?.code === 0 && (data(m)?.nodeTypes || []).length >= 13, `算子目录不足 13 项`);
    const r = await api('GET', '/api/v1/workflow/definitions', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r) || []).length >= 1, '定义列表为空');
    return `算子 ${(data(m)?.nodeTypes || []).length} 项，定义 ${(data(r) || []).length} 个`;
  });
  await runCase('UAT-WF-02', '执行工作流运行', 'WF', async () => {
    const defs = (data(await api('GET', '/api/v1/workflow/definitions', undefined, adminToken)) || []);
    const def = defs.find((d) => d.code === 'WF-MAT-CLEAN') || defs[0];
    const run = await api('POST', `/api/v1/workflow/definitions/${def.id}/run`, undefined, adminToken);
    ok(run.body?.code === 0, `运行失败：${run.body?.msg}`);
    const runs = await api('GET', '/api/v1/workflow/runs?page=1&size=5', undefined, adminToken);
    ok(runs.body?.code === 0 && (data(runs)?.total ?? 1) >= 1, '运行历史为空');
    return `运行 ${def.code} 成功，历史 total=${data(runs)?.total}`;
  });

  // ============ 7. 数据质量 ============
  console.log('[7] 数据质量 QA');
  await runCase('UAT-QA-01', '质量总览', 'QA', async () => {
    const r = await api('GET', '/api/v1/quality/overview', undefined, adminToken);
    ok(r.body?.code === 0 && data(r) && (data(r).score !== undefined || data(r).rules !== undefined), '总览数据异常');
    return `score=${data(r)?.score ?? '—'}`;
  });
  let scanId = 0;
  await runCase('UAT-QA-02', '执行全域巡检', 'QA', async () => {
    const r = await api('POST', '/api/v1/quality/scan', {}, adminToken);
    ok(r.body?.code === 0 && data(r)?.total > 0, '巡检执行异常');
    scanId = data(r)?.id;
    const rep = await api('GET', `/api/v1/quality/runs/${scanId}/report`, undefined, adminToken);
    ok(rep.body?.code === 0, '巡检报告查询失败');
    return `检查 ${data(r)?.total} 项，问题 ${data(r)?.failed} 条，评分 ${data(r)?.score}`;
  });
  await runCase('UAT-QA-03', '质量问题清单', 'QA', async () => {
    const r = await api('GET', '/api/v1/quality/issues?page=1&size=5&status=OPEN', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r)?.total ?? 0) >= 1, 'OPEN 问题为空');
    return `待整改 ${data(r)?.total} 条`;
  });

  // ============ 8. 任务调度 ============
  console.log('[8] 任务调度 SCH');
  await runCase('UAT-SCH-01', '调度任务列表', 'SCH', async () => {
    const r = await api('GET', '/api/v1/schedule/jobs', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r) || []).length >= 1, '调度任务为空');
    return `任务 ${(data(r) || []).length} 个`;
  });
  await runCase('UAT-SCH-02', '手动执行与运行历史', 'SCH', async () => {
    const jobs = (data(await api('GET', '/api/v1/schedule/jobs', undefined, adminToken)) || []);
    const job = jobs.find((j) => j.code === 'SCH-DQ-DAILY') || jobs[0];
    const run = await api('POST', `/api/v1/schedule/jobs/${job.id}/run`, undefined, adminToken);
    ok(run.body?.code === 0, `手动执行失败：${run.body?.msg}`);
    const runs = await api('GET', '/api/v1/schedule/runs?page=1&size=5', undefined, adminToken);
    ok(runs.body?.code === 0 && (data(runs)?.total ?? 1) >= 1, '运行历史为空');
    return `执行 ${job.code} 成功，历史 total=${data(runs)?.total}`;
  });

  // ============ 9. 数据采集 ============
  console.log('[9] 数据采集 COL');
  const tmpDbPath = join(__dirname, '..', 'results', `uat-src-${stamp}.db`);
  try { unlinkSync(tmpDbPath); } catch { /* 无残留 */ }
  let dbSysId = 0;
  await runCase('UAT-COL-01', '采集源列表查询', 'COL', async () => {
    const r = await api('GET', '/api/v1/collect/systems', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r) || []).length >= 1, '采集源为空');
    return `源 ${(data(r) || []).length} 个`;
  });
  await runCase('UAT-COL-02', '创建数据库直连采集源', 'COL', async () => {
    const tdb = new Database(tmpDbPath);
    tdb.exec('CREATE TABLE erp_items (erp_name TEXT, erp_spec TEXT, erp_unit TEXT, erp_category TEXT, erp_price TEXT, updated_at TEXT)');
    const ins = tdb.prepare('INSERT INTO erp_items VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 1; i <= 5; i++) ins.run(`UAT直连物料${i}-${stamp}`, `SPEC-UAT-${i}`, '个', '耗材', String(i * 2), `2026-01-0${i} 08:00:00`);
    tdb.close();
    const r = await api('POST', '/api/v1/collect/systems', {
      code: `SRC-UAT-${stamp}`, name: 'UAT 直连源', domainCode: 'material', channel: 'DB',
      config: { dbType: 'sqlite', dbPath: tmpDbPath, tableName: 'erp_items', incremental: true, tsField: 'updated_at' },
      fieldMaps: [
        { source: 'erp_name', target: 'materialName' }, { source: 'erp_spec', target: 'spec' },
        { source: 'erp_unit', target: 'unit' }, { source: 'erp_category', target: 'category' },
        { source: 'erp_price', target: 'price' },
      ],
      valueMaps: [{ field: 'unit', map: { 个: 'PCS' } }, { field: 'category', map: { 耗材: 'CONSUME' } }],
      cleanRules: ['trim'],
    }, adminToken);
    ok(r.body?.code === 0 && data(r)?.id, `创建失败：${r.body?.msg}`);
    dbSysId = data(r)?.id;
    return `源 #${dbSysId}，路径=${tmpDbPath}`;
  });
  await runCase('UAT-COL-03', '首次采集（全量 5 行）', 'COL', async () => {
    const r = await api('POST', `/api/v1/collect/systems/${dbSysId}/run`, undefined, adminToken);
    const b = data(r);
    ok(r.body?.code === 0 && b?.total === 5 && b?.mode === 'INCR' && !!b?.lastTs, `首次采集异常：total=${b?.total}`);
    return `拉取 5 行，水位=${b?.lastTs}`;
  });
  await runCase('UAT-COL-04', '增量采集仅拉取新数据', 'COL', async () => {
    const tdb = new Database(tmpDbPath);
    const ins = tdb.prepare('INSERT INTO erp_items VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(`UAT直连物料A-${stamp}`, 'SPEC-UAT-NEW', '个', '耗材', '1.1', '2026-07-01 09:00:00');
    ins.run(`UAT直连物料B-${stamp}`, 'SPEC-UAT-NEW', '件', '耗材', '2.2', '2026-07-02 10:00:00');
    tdb.close();
    const r = await api('POST', `/api/v1/collect/systems/${dbSysId}/run`, undefined, adminToken);
    const b = data(r);
    ok(r.body?.code === 0 && b?.total === 2 && b?.lastTs === '2026-07-02 10:00:00', `增量异常：total=${b?.total}`);
    return `仅拉取 2 行，水位推进到 ${b?.lastTs}`;
  });
  await runCase('UAT-COL-05', '无增量返回空结果', 'COL', async () => {
    const r = await api('POST', `/api/v1/collect/systems/${dbSysId}/run`, undefined, adminToken);
    ok(r.body?.code === 0 && data(r)?.skipped === true && data(r)?.total === 0, '无增量应返回 skipped');
    return 'skipped=true，未生成批次';
  });
  await runCase('UAT-COL-06', '采集执行留痕', 'COL', async () => {
    const r = await api('GET', '/api/v1/collect/logs?page=1&size=10', undefined, adminToken);
    const l = data(r);
    ok(r.body?.code === 0 && l?.total >= 3 && (l.list || [])[0]?.skipped === 1, '采集留痕异常');
    return `共 ${l?.total} 条，最近一次=无增量`;
  });
  try { unlinkSync(tmpDbPath); } catch { /* 清理 */ }

  // ============ 10. 分发 / 通知 / 统计 ============
  console.log('[10] 分发与通知 INT/NTF/ST');
  await runCase('UAT-INT-01', '分发事件列表', 'INT', async () => {
    const r = await api('GET', '/api/v1/integration/push-events?page=1&size=5', undefined, adminToken);
    ok(r.body?.code === 0, '分发事件查询失败');
    return `total=${data(r)?.total ?? (data(r) || []).length}`;
  });
  await runCase('UAT-NTF-01', '站内通知列表', 'NTF', async () => {
    const r = await api('GET', '/api/v1/notices?page=1&size=5', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r)?.list || []).length >= 1, '通知列表为空');
    return `最新通知：${data(r)?.list?.[0]?.title || '—'}`;
  });
  await runCase('UAT-NTF-02', '标记已读', 'NTF', async () => {
    const before = data(await api('GET', '/api/v1/notices/unread-count', undefined, adminToken))?.count;
    const r = await api('POST', '/api/v1/notices/read', { all: true }, adminToken);
    ok(r.body?.code === 0 && data(r)?.unread === 0, '标记已读失败');
    const after = data(await api('GET', '/api/v1/notices/unread-count', undefined, adminToken))?.count;
    ok(after === 0, `未读数未归零：${after}`);
    return `未读 ${before ?? 0} → 0`;
  });
  await runCase('UAT-ST-01', '仪表板统计', 'ST', async () => {
    const r = await api('GET', '/api/v1/stats/dashboard', undefined, adminToken);
    ok(r.body?.code === 0 && data(r)?.volume && data(r)?.quality, '仪表板统计异常');
    return `volume/quality 指标正常`;
  });
  await runCase('UAT-ST-02', '审计日志查询', 'ST', async () => {
    const r = await api('GET', '/api/v1/audit?page=1&size=5', undefined, adminToken);
    ok(r.body?.code === 0 && (data(r)?.total ?? 0) >= 1, '审计日志为空');
    return `total=${data(r)?.total}`;
  });

  // ============ 汇总输出 ============
  const pass = results.filter((x) => x.status === 'PASS').length;
  const fail = results.filter((x) => x.status === 'FAIL').length;
  const summary = {
    suite: 'MasterHub UAT API',
    baseUrl: BASE,
    startedAt: new Date().toISOString(),
    total: results.length,
    pass,
    fail,
    results,
  };
  const out = join(__dirname, '..', 'results', 'uat-api-results.json');
  const { writeFileSync } = await import('fs');
  writeFileSync(out, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`\n========== UAT API 结果：${pass} 通过 / ${fail} 失败 / 共 ${results.length} ==========`);
  console.log(`结果已写入：${out}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('UAT 执行异常：', e);
  process.exit(2);
});
