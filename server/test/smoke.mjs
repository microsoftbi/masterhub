/**
 * 后端冒烟测试（Node 18+ 原生 fetch + better-sqlite3 造数）。
 * 用法：先启动服务（npm run start:dev 或 node dist/main.js），再执行：
 *   node test/smoke.mjs [baseUrl]
 * 覆盖：登录、元数据、主数据 CRUD、质量巡检、问题指派、工作流运行、
 *       OUTPUT 落库、任务调度（手动执行 + 运行历史）、数据采集、站内通知、
 *       审批转办/加签、批量生命周期、版本回滚、仪表板统计、
 *       采集通道扩展（数据库直连 + 时间戳增量 + 执行留痕）。
 */
import Database from 'better-sqlite3';
import { unlinkSync } from 'fs';

const BASE = process.argv[2] || 'http://localhost:3000';
let token = '';
let passed = 0;
let failed = 0;

function assert(cond, name, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.error(`  ✘ ${name}${extra ? '  ' + extra : ''}`);
  }
}

async function api(method, path, body, asToken) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(asToken || token ? { Authorization: `Bearer ${asToken || token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, body: json };
}

/** 用指定账号登录并返回 token */
async function loginAs(username, password) {
  const r = await api('POST', '/api/v1/auth/login', { username, password });
  return data(r)?.token || '';
}

function data(r) {
  return r.body?.data;
}

/** 反复通过指定标题的审批待办，直至待办清空或达到轮次上限 */
async function approveAll(title, tokens, rounds = 5) {
  let passes = 0;
  for (let i = 0; i < rounds; i++) {
    let progressed = false;
    for (const tk of tokens) {
      const todo = data(await api('GET', '/api/v1/approvals/todo', undefined, tk)) || [];
      const t = todo.find((x) => String(x.title || '').includes(title));
      if (!t) continue;
      const p = await api('POST', `/api/v1/approvals/${t.instance_id}/pass`, { comment: '冒烟测试通过' }, tk);
      if (p.body?.code === 0) {
        passes++;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return passes;
}

async function main() {
  console.log(`\n冒烟测试目标：${BASE}\n`);

  // ---------- 1. 认证 ----------
  console.log('[认证]');
  let r = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'admin123' });
  token = data(r)?.token || '';
  assert([200, 201].includes(r.status) && r.body?.code === 0 && token, '管理员登录获取 token');
  r = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'wrong' });
  assert(r.body?.code !== 0, '错误密码被拒绝');
  r = await api('GET', '/api/v1/auth/me');
  assert(r.body?.code === 0 && data(r)?.username === 'admin', '获取当前用户');

  // ---------- 2. 元数据 ----------
  console.log('[元数据]');
  r = await api('GET', '/api/v1/domains');
  assert(r.body?.code === 0 && Array.isArray(data(r)) && data(r).length >= 3, '数据域列表');
  r = await api('GET', '/api/v1/models');
  assert(r.body?.code === 0 && Array.isArray(data(r)) && data(r).length >= 3, '模型列表');

  // ---------- 3. 主数据 CRUD ----------
  console.log('[主数据]');
  r = await api('GET', '/api/v1/master-data/material?page=1&size=5');
  assert(r.body?.code === 0 && data(r)?.total >= 1, `物料列表（${data(r)?.total} 条）`);
  const stamp = Date.now().toString().slice(-6);
  r = await api('POST', '/api/v1/master-data/material', {
    data: { materialName: `冒烟物料-${stamp}`, spec: 'SMOKE-1', unit: 'EA', category: 'CONSUME', price: 9.9 },
  });
  assert(r.body?.code === 0 && data(r)?.id, '新增物料草稿');
  const draftId = data(r)?.id;
  r = await api('POST', `/api/v1/master-data/material/${draftId}/submit`);
  assert(r.body?.code === 0 && ['PENDING', 'PUBLISHED'].includes(data(r)?.status), '提交审批（进入审批中或直接发布）');

  // 审批链路：部门主管初审 → 数据治理岗复审 → 自动发布（pass 按 实例 id）
  const leaderToken = await loginAs('leader', 'leader123');
  const stewardToken = await loginAs('steward', 'steward123');
  for (const [who, tk] of [['部门主管', leaderToken], ['数据治理岗', stewardToken]]) {
    let t = await api('GET', '/api/v1/approvals/todo', undefined, tk);
    const task = (data(t) || []).find((x) => x.title?.includes(`冒烟物料-${stamp}`));
    if (task) {
      const p = await api('POST', `/api/v1/approvals/${task.instance_id}/pass`, { comment: '冒烟测试通过' }, tk);
      assert(p.body?.code === 0, `${who}审批通过`);
    } else {
      assert(false, `${who}审批通过`, '待办中未找到该审批任务');
    }
  }
  r = await api('GET', `/api/v1/master-data/material/${draftId}`);
  const smokeRec = data(r);
  assert(r.body?.code === 0 && smokeRec?.status === 'PUBLISHED' && smokeRec?.master_code, `审批完成自动发布（${smokeRec?.master_code || ''}）`);
  r = await api('GET', `/api/v1/master-data/material/export`);
  assert(r.body?.code === 0 && data(r)?.content?.includes('主数据编码'), 'CSV 导出');

  // ---------- 4. 数据质量 ----------
  console.log('[数据质量]');
  r = await api('POST', '/api/v1/quality/scan', {});
  const scan = data(r);
  assert(r.body?.code === 0 && scan?.total > 0, `全域巡检（${scan?.total} 项，问题 ${scan?.failed} 条，评分 ${scan?.score}）`);
  const scanRunId = scan?.id;
  r = await api('GET', '/api/v1/quality/issues?page=1&size=5&status=OPEN');
  assert(r.body?.code === 0 && data(r)?.total >= 1, `待整改问题清单（${data(r)?.total} 条）`);
  const openIssue = data(r)?.list?.[0];
  r = await api('GET', '/api/v1/quality/issues/candidates');
  assert(r.body?.code === 0 && data(r)?.length >= 2, `可指派候选人（${data(r)?.length} 人）`);
  const candidate = data(r)?.find((u) => u.username === 'buyer') || data(r)?.[0];
  r = await api('POST', `/api/v1/quality/issues/${openIssue?.id}/assign`, { userId: candidate?.id });
  assert(r.body?.code === 0 && data(r)?.assignee_name === candidate?.display_name, `问题指派给 ${candidate?.display_name}`);
  r = await api('GET', `/api/v1/quality/issues?page=1&size=10&assigneeId=${candidate?.id}&status=OPEN`);
  assert(r.body?.code === 0 && data(r)?.total >= 1, '按责任人筛选问题');
  r = await api('GET', `/api/v1/quality/runs/${scanRunId}/report`);
  assert(r.body?.code === 0 && data(r)?.filename?.endsWith('.csv') && data(r)?.content?.includes('质量巡检报告'), '巡检报告 CSV 导出');

  // ---------- 5. 数据工作流 ----------
  console.log('[数据工作流]');
  r = await api('GET', '/api/v1/workflow/definitions');
  assert(r.body?.code === 0 && data(r)?.length >= 2, '工作流定义列表');
  const wfClean = data(r)?.find((d) => d.code === 'WF-MAT-CLEAN');
  r = await api('POST', `/api/v1/workflow/definitions/${wfClean?.id}/run`);
  const wfRun = data(r);
  assert(r.body?.code === 0 && wfRun?.status === 'SUCCESS' && wfRun?.row_count >= 0, `运行物料清洗工作流（${wfRun?.row_count} 行）`);
  // OUTPUT submit 落库：读取指定状态物料，按查重键写回
  const smokeNodes = (status) => [
    { id: 'in1', type: 'DB_INPUT', name: '读取物料', x: 40, y: 80, config: { limit: 50, status } },
    {
      id: 'f1', type: 'FILTER', name: '筛选冒烟物料', x: 230, y: 80,
      config: { logic: 'AND', conditions: [{ field: 'materialName', op: 'contains', value: `冒烟物料-${stamp}` }] },
    },
    { id: 'o1', type: 'OUTPUT', name: '写回输出', x: 420, y: 80, config: { fields: [], submit: true, domainCode: 'material', keyField: 'materialName' } },
  ];
  r = await api('POST', '/api/v1/workflow/definitions', {
    code: `WF-SMOKE-${stamp}`,
    name: '冒烟-落库测试',
    domainCode: 'material',
    status: 'PUBLISHED',
    nodes: smokeNodes('PUBLISHED'),
  });
  assert(r.body?.code === 0, '创建带写回配置的工作流');
  const wfSmokeId = data(r)?.id;
  const outMsg = (run) => run?.nodeRuns?.find((n) => n.node_type === 'OUTPUT')?.message || '';
  // 第一次运行：同名 PUBLISHED 记录存在，按查重键全部跳过
  r = await api('POST', `/api/v1/workflow/definitions/${wfSmokeId}/run`);
  let smokeRun = data(r);
  assert(
    r.body?.code === 0 && smokeRun?.status === 'SUCCESS' && /写回主数据 0 条（跳过 [1-9]/.test(outMsg(smokeRun)),
    `已存在记录按查重键跳过（${outMsg(smokeRun)}）`,
  );

  // ---------- 5.1 工作流算子扩展（JOIN / UNION / 码值映射 / 标准化 / 空值填充） ----------
  console.log('[工作流算子扩展]');
  r = await api('GET', '/api/v1/workflow/meta');
  assert(
    r.body?.code === 0 && data(r)?.nodeTypes?.length >= 13 && data(r)?.dicts?.some((d) => d.code === 'unit'),
    '算子元数据包含新增算子与码表目录',
  );
  const opNodes = [
    { id: 'in1', type: 'DB_INPUT', name: '读取物料', x: 40, y: 60, config: { limit: 200, status: 'PUBLISHED' } },
    { id: 'f1', type: 'FILTER', name: '筛选冒烟物料', x: 200, y: 60, config: { logic: 'AND', conditions: [{ field: 'materialName', op: 'contains', value: `冒烟物料-${stamp}` }] } },
    { id: 'j1', type: 'JOIN', name: '内连接自关联', x: 360, y: 60, config: { joinDomain: 'material', joinStatus: 'PUBLISHED', joinType: 'inner', leftKey: 'materialName', rightKey: 'materialName', rightFields: [] } },
    { id: 'n1', type: 'NORMALIZE', name: '标准化规格', x: 520, y: 60, config: { fields: ['spec'], trim: true, case: 'upper', replace: [{ from: '-1', to: '-ONE' }] } },
    { id: 'j2', type: 'JOIN', name: '左连接无匹配', x: 680, y: 60, config: { joinDomain: 'material', joinStatus: 'PUBLISHED', joinType: 'left', leftKey: 'spec', rightKey: 'spec', rightFields: ['brand', 'price'] } },
    { id: 'cm1', type: 'CODE_MAP', name: '码表转单位', x: 840, y: 60, config: { field: 'unit', mode: 'dict', dictCode: 'unit', defaultVal: '' } },
    { id: 'cm2', type: 'CODE_MAP', name: '手工映射分类', x: 1000, y: 60, config: { field: 'category', mode: 'manual', mapping: [{ from: 'CONSUME', to: '耗材' }], defaultVal: '未知' } },
    { id: 'fe1', type: 'FILL_EMPTY', name: '填充品牌', x: 1160, y: 60, config: { fills: [{ field: 'brand', value: '默认品牌' }] } },
    { id: 'u1', type: 'UNION', name: '并集客户', x: 1320, y: 60, config: { unionDomain: 'customer', unionStatus: 'PUBLISHED' } },
    { id: 'o1', type: 'OUTPUT', name: '输出', x: 1480, y: 60, config: { fields: [], submit: false } },
  ];
  r = await api('POST', '/api/v1/workflow/definitions', {
    code: `WF-SMOKE-OP-${stamp}`, name: '冒烟-算子扩展', domainCode: 'material', status: 'DRAFT', nodes: opNodes,
  });
  assert(r.body?.code === 0, '创建含新算子的工作流定义');
  const wfOpId = data(r)?.id;
  r = await api('POST', `/api/v1/workflow/definitions/${wfOpId}/run`);
  const opRun = data(r);
  const nr = (id) => opRun?.nodeRuns?.find((n) => n.node_id === id);
  const pv = (id) => nr(id)?.preview?.[0] || {};
  assert(r.body?.code === 0 && opRun?.status === 'SUCCESS', '含新算子的工作流运行成功');
  assert(nr('f1')?.rows_out === 1, 'FILTER 后剩 1 行');
  assert(nr('j1')?.rows_out === 1 && pv('j1').r_price === 9.9, `内连接按主数据名匹配合并（r_price=${pv('j1').r_price}）`);
  assert(pv('n1').spec === 'SMOKE-ONE', `标准化替换 + 大小写（spec=${pv('n1').spec}）`);
  assert(nr('j2')?.rows_out === 1 && pv('j2').r_price === null, '左连接无匹配时保留左表且右字段置空');
  assert(pv('cm1').unit === '件', `码表映射 value→label（unit=${pv('cm1').unit}）`);
  assert(pv('cm2').category === '耗材', `手工码值映射（category=${pv('cm2').category}）`);
  assert(pv('fe1').brand === '默认品牌', `空值填充（brand=${pv('fe1').brand}）`);
  assert(nr('u1')?.rows_out > nr('fe1')?.rows_out, `并集追加客户记录（${nr('fe1')?.rows_out} → ${nr('u1')?.rows_out} 行）`);

  // 归档源记录后改读 ARCHIVED 数据再运行：查重口径排除归档 → 真实写回 1 条并进入审批
  r = await api('POST', `/api/v1/master-data/material/${smokeRec.id}/archive`);
  assert(r.body?.code === 0 && data(r)?.status === 'ARCHIVED', '归档源物料记录');
  r = await api('POST', '/api/v1/workflow/definitions', {
    id: wfSmokeId, code: `WF-SMOKE-${stamp}`, name: '冒烟-落库测试', domainCode: 'material', status: 'PUBLISHED',
    nodes: smokeNodes('ARCHIVED'),
  });
  assert(r.body?.code === 0, '更新工作流改读归档数据');
  r = await api('POST', `/api/v1/workflow/definitions/${wfSmokeId}/run`);
  smokeRun = data(r);
  assert(/写回主数据 1 条（跳过 0，失败 0\）/.test(outMsg(smokeRun)), `真实写回主数据（${outMsg(smokeRun)}）`);
  r = await api('GET', '/api/v1/master-data/material?page=1&size=20&keyword=' + encodeURIComponent(`冒烟物料-${stamp}`));
  const relisted = data(r)?.list || [];
  const reWritten = relisted.find((x) => x.status === 'PENDING' || x.status === 'DRAFT');
  assert(!!reWritten, '写回记录已进入主数据（草稿/审批中）');

  // ---------- 6. 任务调度 ----------
  console.log('[任务调度]');
  r = await api('GET', '/api/v1/schedule/jobs');
  assert(r.body?.code === 0 && data(r)?.length >= 3, `调度任务列表（${data(r)?.length} 个）`);
  const dqJob = data(r)?.find((j) => j.code === 'SCH-DQ-DAILY');
  const dispatchJob = data(r)?.find((j) => j.code === 'SCH-DISPATCH');
  assert(dqJob?.next_run_at && dispatchJob?.next_run_at, '启用的任务已计算下次执行时间');
  r = await api('POST', `/api/v1/schedule/jobs/${dqJob?.id}/run`);
  assert(r.body?.code === 0 && data(r)?.status === 'SUCCESS', `手动执行质量巡检任务（${data(r)?.message}）`);
  r = await api('POST', `/api/v1/schedule/jobs/${dispatchJob?.id}/run`);
  assert(r.body?.code === 0 && data(r)?.status === 'SUCCESS', `手动执行分发补偿任务（${data(r)?.message}）`);
  r = await api('POST', `/api/v1/schedule/jobs/${dqJob?.id}/toggle`, { enabled: false });
  assert(r.body?.code === 0 && data(r)?.next_run_at === null, '停用任务后清空下次执行时间');
  r = await api('POST', `/api/v1/schedule/jobs/${dqJob?.id}/toggle`, { enabled: true });
  assert(r.body?.code === 0 && !!data(r)?.next_run_at, '重新启用任务并重算下次执行时间');
  r = await api('POST', '/api/v1/schedule/jobs', { code: `SCH-SMOKE-${stamp}`, name: '冒烟调度任务', jobType: 'WORKFLOW', targetId: wfSmokeId, cron: 'bad cron' });
  assert(r.body?.code !== 0, '非法 cron 被拒绝');
  r = await api('GET', '/api/v1/schedule/runs?page=1&size=10');
  assert(r.body?.code === 0 && data(r)?.total >= 2, `调度运行历史（${data(r)?.total} 条）`);

  // ---------- 7. 数据采集（M4） ----------
  console.log('[数据采集]');
  r = await api('GET', '/api/v1/collect/systems');
  const seededSys = (data(r) || []).find((s) => s.code === 'SRC-ERP');
  assert(r.body?.code === 0 && seededSys?.fieldMaps?.length >= 3, `采集源列表（SRC-ERP 映射 ${seededSys?.fieldMaps?.length || 0} 条）`);
  r = await api('POST', '/api/v1/collect/systems', {
    code: `SRC-SMOKE-${stamp}`, name: '冒烟采集源', domainCode: 'material', channel: 'API',
    endpoint: `${BASE}/api/v1/collect/mock/SRC-ERP`, apiKey: 'demo-erp-key', status: 'ACTIVE',
    fieldMaps: [
      { source: 'erp_name', target: 'materialName' },
      { source: 'erp_spec', target: 'spec' },
      { source: 'erp_unit', target: 'unit' },
      { source: 'erp_category', target: 'category' },
      { source: 'erp_price', target: 'price' },
    ],
    valueMaps: [
      { field: 'unit', map: { 个: 'PCS', 件: 'EA' } },
      { field: 'category', map: { 紧固件: 'FASTENER', 耗材: 'CONSUME' } },
    ],
    cleanRules: ['trim'],
  });
  assert(r.body?.code === 0 && data(r)?.id, '注册采集源与字段/码值映射');
  const smokeSysId = data(r)?.id;
  r = await api('POST', `/api/v1/collect/systems/${smokeSysId}/run`);
  const collectBatch = data(r);
  assert(
    r.body?.code === 0 && collectBatch?.total === 5 && collectBatch?.valid >= 3,
    `执行采集并生成校验批次（${collectBatch?.total} 行，通过 ${collectBatch?.valid}，失败 ${collectBatch?.invalid}）`,
  );
  r = await api('POST', '/api/v1/collect/systems', { code: `SRC-BAD-${stamp}`, name: '非法采集源', domainCode: 'material', channel: 'API', endpoint: 'http://x' });
  assert(r.body?.code !== 0, '缺少字段映射的采集源被拒绝');

  // ---------- 7.1 采集通道扩展（M7）：数据库直连 + 时间戳增量 + 执行留痕 ----------
  console.log('[采集通道扩展]');
  const tmpDbPath = `${process.cwd()}/test/tmp-collect-${stamp}.db`;
  try { unlinkSync(tmpDbPath); } catch { /* 首次运行无残留 */ }
  const tdb = new Database(tmpDbPath);
  tdb.exec('CREATE TABLE erp_items (erp_name TEXT, erp_spec TEXT, erp_unit TEXT, erp_category TEXT, erp_price TEXT, updated_at TEXT)');
  const insItem = tdb.prepare('INSERT INTO erp_items VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= 5; i++) {
    insItem.run(`直连物料${i}-${stamp}`, `SPEC-DB-${i}`, '个', '耗材', String(i * 1.5), `2026-01-0${i} 08:00:00`);
  }
  tdb.close();
  const dbFieldMaps = [
    { source: 'erp_name', target: 'materialName' },
    { source: 'erp_spec', target: 'spec' },
    { source: 'erp_unit', target: 'unit' },
    { source: 'erp_category', target: 'category' },
    { source: 'erp_price', target: 'price' },
  ];
  r = await api('POST', '/api/v1/collect/systems', {
    code: `SRC-DB-${stamp}`, name: '冒烟直连源', domainCode: 'material', channel: 'DB',
    config: { dbType: 'sqlite', dbPath: tmpDbPath, tableName: 'erp_items', incremental: true, tsField: 'updated_at' },
    fieldMaps: dbFieldMaps,
    valueMaps: [{ field: 'unit', map: { 个: 'PCS' } }, { field: 'category', map: { 耗材: 'CONSUME' } }],
    cleanRules: ['trim'],
  });
  assert(r.body?.code === 0 && data(r)?.id, '注册数据库直连采集源（SQLite + 时间戳增量）');
  const dbSysId = data(r)?.id;
  r = await api('POST', `/api/v1/collect/systems/${dbSysId}/run`);
  const dbBatch1 = data(r);
  assert(
    r.body?.code === 0 && dbBatch1?.total === 5 && dbBatch1?.mode === 'INCR' && !!dbBatch1?.lastTs,
    `直连首次采集 5 行并记录增量水位（${dbBatch1?.total} 行，水位 ${dbBatch1?.lastTs || '—'}）`,
  );
  // 源库新增 2 行新数据（时间戳晚于水位）
  const tdb2 = new Database(tmpDbPath);
  const insNew = tdb2.prepare('INSERT INTO erp_items VALUES (?, ?, ?, ?, ?, ?)');
  insNew.run(`直连物料A-${stamp}`, 'SPEC-DB-NEW', '个', '耗材', '9.9', '2026-06-01 09:00:00');
  insNew.run(`直连物料B-${stamp}`, 'SPEC-DB-NEW', '件', '耗材', '8.8', '2026-06-02 10:00:00');
  tdb2.close();
  r = await api('POST', `/api/v1/collect/systems/${dbSysId}/run`);
  const dbBatch2 = data(r);
  assert(
    r.body?.code === 0 && dbBatch2?.total === 2 && dbBatch2?.lastTs === '2026-06-02 10:00:00',
    `增量采集仅拉取新增 2 行（${dbBatch2?.total} 行，水位推进到 ${dbBatch2?.lastTs || '—'}）`,
  );
  r = await api('POST', `/api/v1/collect/systems/${dbSysId}/run`);
  assert(r.body?.code === 0 && data(r)?.skipped === true && data(r)?.total === 0, '无增量时返回空结果（skipped，不生成批次）');
  r = await api('GET', '/api/v1/collect/logs?page=1&size=10');
  const cLogs = data(r);
  assert(
    r.body?.code === 0 && cLogs?.total >= 3 && cLogs.list[0]?.skipped === 1 && cLogs.list[1]?.pulled === 2,
    `采集执行留痕（共 ${cLogs?.total} 条，最近一次无增量，上一次拉取 2 行）`,
  );
  r = await api('POST', '/api/v1/collect/systems', {
    code: `SRC-MYSQL-${stamp}`, name: '非法通道类型', domainCode: 'material', channel: 'DB',
    config: { dbType: 'mysql', dbPath: tmpDbPath, tableName: 'erp_items' }, fieldMaps: dbFieldMaps,
  });
  assert(r.body?.code !== 0, '非 SQLite 的直连类型被拒绝');
  r = await api('POST', '/api/v1/collect/systems', {
    code: `SRC-NODB-${stamp}`, name: '文件缺失直连源', domainCode: 'material', channel: 'DB',
    config: { dbType: 'sqlite', dbPath: '/not-exists-xxx.db', tableName: 'erp_items' }, fieldMaps: dbFieldMaps,
  });
  assert(r.body?.code !== 0, '数据库文件不存在被拒绝');
  try { unlinkSync(tmpDbPath); } catch { /* 清理失败不影响结果 */ }

  // ---------- 8. 站内通知（M4） ----------
  console.log('[站内通知]');
  r = await api('GET', '/api/v1/notices/unread-count');
  assert(r.body?.code === 0 && data(r)?.count >= 1, `未读通知数（${data(r)?.count} 条）`);
  r = await api('GET', '/api/v1/notices?page=1&size=5');
  const noticeList = data(r)?.list || [];
  assert(r.body?.code === 0 && noticeList.length >= 1 && !!noticeList[0]?.type_label, `通知列表（最新：${noticeList[0]?.title || '—'}）`);
  r = await api('POST', '/api/v1/notices/read', { all: true });
  assert(r.body?.code === 0 && data(r)?.unread === 0, '全部标记已读');
  r = await api('GET', '/api/v1/notices/unread-count');
  assert(data(r)?.count === 0, '未读数归零');

  // ---------- 9. 审批转办 / 加签（M4） ----------
  console.log('[审批转办与加签]');
  const trTitle = `冒烟转办-${stamp}`;
  r = await api('POST', '/api/v1/master-data/material', {
    data: { materialName: trTitle, spec: 'TR-1', unit: 'EA', category: 'CONSUME', price: 3 },
  });
  const trId = data(r)?.id;
  assert(r.body?.code === 0 && trId, '新增转办用例物料');
  await api('POST', `/api/v1/master-data/material/${trId}/submit`);
  r = await api('GET', '/api/v1/approvals/todo', undefined, leaderToken);
  const trTask = (data(r) || []).find((t) => String(t.title || '').includes(trTitle));
  assert(!!trTask?.instance_id, '转办用例已生成部门主管待办');
  r = await api('GET', '/api/v1/approvals/handlers', undefined, leaderToken);
  const handlers = data(r) || [];
  assert(r.body?.code === 0 && handlers.length >= 2 && handlers.every((h) => h.display_name), `可转办处理人（${handlers.length} 人）`);
  const leaderMe = data(await api('GET', '/api/v1/auth/me', undefined, leaderToken));
  const stewardMe = data(await api('GET', '/api/v1/auth/me', undefined, stewardToken));
  r = await api('POST', `/api/v1/approvals/${trTask?.instance_id}/transfer`, { userId: stewardMe?.id, comment: '冒烟转办' }, leaderToken);
  assert(r.body?.code === 0 && data(r)?.assignee_name === stewardMe?.displayName, `转办给 ${stewardMe?.displayName}`);
  r = await api('POST', `/api/v1/approvals/${trTask?.instance_id}/add-sign`, { userId: leaderMe?.id, comment: '冒烟加签' }, stewardToken);
  assert(r.body?.code === 0 && data(r)?.added === leaderMe?.displayName, '加签一名会签人');
  const trPasses = await approveAll(trTitle, [leaderToken, stewardToken]);
  r = await api('GET', `/api/v1/master-data/material/${trId}`);
  assert(trPasses >= 2 && data(r)?.status === 'PUBLISHED', `转办/加签后审批继续完成并发布（通过 ${trPasses} 次）`);

  // ---------- 10. 审批抄送 + 可视化流程设计器（M6） ----------
  console.log('[审批抄送与流程设计器]');
  r = await api('GET', '/api/v1/approvals/designer-options', undefined, token);
  assert(r.body?.code === 0 && data(r)?.users?.length >= 3 && data(r)?.roles?.length >= 3 && data(r)?.domains?.length >= 3, '设计器选项（用户/角色/域）');
  const ccCode = `CC_TEST_${stamp}`;
  // 防御：停用历史遗留的客户域 CREATE 专用流程，确保本用例命中新建的抄送流程
  r = await api('GET', '/api/v1/approvals/processes');
  for (const p of (data(r) || [])) {
    if (p.status === 'ACTIVE' && p.code !== ccCode && p.bind?.domain === 'customer' && p.bind?.action === 'CREATE') {
      await api('POST', `/api/v1/approvals/processes/${p.code}/toggle`);
    }
  }
  r = await api('POST', '/api/v1/approvals/processes', {
    code: ccCode, name: `冒烟抄送流程-${stamp}`,
    bind: { domain: 'customer', action: 'CREATE' },
    nodes: [
      { id: 'start', type: 'START' },
      { id: 'cc1', type: 'CC', name: '抄送备案', assigneeType: 'USER', username: 'steward' },
      { id: 'n1', type: 'APPROVAL', name: '部门初审', assigneeType: 'ROLE', role: 'DEPT_LEADER', multi: 'OR' },
      { id: 'auto', type: 'AUTO', name: '自动发布', handler: 'publishWithCode' },
      { id: 'end', type: 'END' },
    ],
    flows: [
      { from: 'start', to: 'cc1' }, { from: 'cc1', to: 'n1' },
      { from: 'n1', to: 'auto' }, { from: 'auto', to: 'end' },
    ],
  });
  assert(r.body?.code === 0 && data(r)?.code === ccCode, '保存含抄送节点的流程定义');
  r = await api('POST', '/api/v1/approvals/processes', {
    code: `CC_BAD_${stamp}`, name: '坏流程',
    bind: { domain: 'customer', action: 'CREATE' },
    nodes: [
      { id: 'start', type: 'START' },
      { id: 'n1', type: 'APPROVAL', name: '审批', assigneeType: 'ROLE', role: 'DEPT_LEADER' },
      { id: 'end', type: 'END' },
    ],
    flows: [{ from: 'start', to: 'n1' }],
  });
  assert(r.body?.code !== 0, '缺少向下连线的非法定义被拒绝');
  // 客户域新增提交：命中抄送流程（发起抄送 leader + CC 节点抄送 steward）
  r = await api('POST', '/api/v1/master-data/customer', {
    data: { customerName: `冒烟客户-${stamp}`, customerLevel: 'A', region: 'EAST', creditLimit: 100, contact: '张三', phone: '13800000000' },
  });
  const ccDraftId = data(r)?.id;
  assert(r.body?.code === 0 && ccDraftId, '新增客户草稿（抄送用例）');
  r = await api('POST', `/api/v1/master-data/customer/${ccDraftId}/submit`, { ccUserIds: [leaderMe?.id] });
  assert(r.body?.code === 0, '提交客户审批（发起时抄送 leader）');
  r = await api('GET', '/api/v1/approvals/ccd', undefined, stewardToken);
  const stewardCc = (data(r) || []).find((x) => x.title?.includes(`冒烟客户-${stamp}`));
  assert(!!stewardCc && stewardCc.node_id === 'cc1', 'CC 节点抄送进入「抄送我的」（steward）');
  r = await api('GET', '/api/v1/approvals/ccd', undefined, leaderToken);
  const leaderCc = (data(r) || []).find((x) => x.title?.includes(`冒烟客户-${stamp}`));
  assert(!!leaderCc && leaderCc.node_id === 'start', '发起时抄送进入「抄送我的」（leader）');
  // 打开详情：ccList 展示 + 已读回执
  r = await api('GET', `/api/v1/approvals/${stewardCc.instance_id}`, undefined, stewardToken);
  const ccDetail = data(r);
  const myCcRow = (ccDetail?.ccList || []).find((c) => c.user_name === stewardMe?.displayName);
  assert(r.body?.code === 0 && (ccDetail?.ccList?.length >= 2) && !!myCcRow?.read_at, '审批详情抄送列表与已读回执');
  // leader 审批通过 → 自动发布
  r = await api('GET', '/api/v1/approvals/todo', undefined, leaderToken);
  const ccTask = (data(r) || []).find((t) => t.title?.includes(`冒烟客户-${stamp}`));
  assert(!!ccTask?.instance_id, '抄送流程生成部门主管待办');
  r = await api('POST', `/api/v1/approvals/${ccTask.instance_id}/pass`, { comment: '冒烟通过' }, leaderToken);
  assert(r.body?.code === 0, '抄送流程审批通过');
  r = await api('GET', `/api/v1/master-data/customer/${ccDraftId}`);
  assert(r.body?.code === 0 && data(r)?.status === 'PUBLISHED' && data(r)?.master_code, `抄送流程自动发布（${data(r)?.master_code || ''}）`);
  // 流程启停 + 定义读取
  r = await api('POST', `/api/v1/approvals/processes/${ccCode}/toggle`);
  assert(r.body?.code === 0 && data(r)?.status === 'DISABLED', '流程停用');
  r = await api('GET', '/api/v1/approvals/processes');
  const ccProc = (data(r) || []).find((p) => p.code === ccCode);
  assert(!!ccProc && ccProc.definition?.nodes?.some((n) => n.type === 'CC') && ccProc.status === 'DISABLED', '流程定义读取（含 CC 节点）');

  // ---------- 11. 批量生命周期 / 版本回滚（M4） ----------
  console.log('[批量操作与回滚]');
  r = await api('POST', '/api/v1/master-data/material/batch-lifecycle', { ids: [trId, 999999], action: 'freeze' });
  assert(r.body?.code === 0 && data(r)?.success === 1 && data(r)?.failed === 1, `批量冻结（成功 ${data(r)?.success}，失败 ${data(r)?.failed}）`);
  r = await api('POST', '/api/v1/master-data/material/batch-lifecycle', { ids: [trId], action: 'unfreeze' });
  assert(r.body?.code === 0 && data(r)?.success === 1, '批量解冻');
  r = await api('POST', '/api/v1/master-data/material/batch-lifecycle', { ids: [trId], action: 'explode' });
  assert(r.body?.code !== 0, '非法批量操作类型被拒绝');
  // 发起一次变更审批并完成，产生 v2
  r = await api('PUT', `/api/v1/master-data/material/${trId}`, {
    data: { materialName: trTitle, spec: 'TR-2', unit: 'EA', category: 'CONSUME', price: 3.5 },
  });
  assert(r.body?.code === 0, '修改已发布数据发起变更');
  await approveAll(trTitle, [leaderToken, stewardToken]);
  r = await api('GET', `/api/v1/master-data/material/${trId}/versions`);
  const trVersions = data(r)?.list || [];
  assert(r.body?.code === 0 && trVersions.length >= 2, `历史版本（${trVersions.length} 个）`);
  r = await api('POST', `/api/v1/master-data/material/${trId}/rollback`, { version: 1 });
  assert(r.body?.code === 0 && ['CHANGING', 'PUBLISHED'].includes(data(r)?.status), `回滚到 v1（状态 ${data(r)?.status}）`);

  // ---------- 12. 树形码表与层级模型（M5） ----------
  console.log('[树形码表与层级模型]');
  r = await api('GET', '/api/v1/dicts');
  const matCat = (data(r) || []).find((d) => d.code === 'material_category');
  assert(r.body?.code === 0 && matCat?.is_tree === 1, '物料分类码表已开启树形');
  r = await api('GET', '/api/v1/dicts/material_category/items');
  const boltItem = (data(r)?.items || []).find((i) => i.value === 'BOLT');
  assert(r.body?.code === 0 && boltItem?.parent_value === 'FASTENER', '树形码值螺栓挂载在紧固件之下');
  // 新建树形码表 + 层级码值 + 防环校验（code 带时间戳，保证可重复运行）
  const treeCode = `smoke_tree_${stamp}`;
  r = await api('POST', '/api/v1/dicts', { code: treeCode, name: '冒烟树形码表', isTree: true });
  assert(r.body?.code === 0, '创建树形码表');
  r = await api('POST', `/api/v1/dicts/${treeCode}/items`, { value: 'L1', label: '一级', sort: 1 });
  assert(r.body?.code === 0, '创建顶级码值');
  r = await api('POST', `/api/v1/dicts/${treeCode}/items`, { value: 'L2', label: '二级', parentValue: 'L1', sort: 2 });
  assert(r.body?.code === 0, '创建下级码值');
  r = await api('POST', `/api/v1/dicts/${treeCode}/items`, { value: 'L3', label: '三级', parentValue: 'NO_SUCH' });
  assert(r.body?.code !== 0, '上级码值不存在被拒绝');
  const l2 = (data(await api('GET', `/api/v1/dicts/${treeCode}/items`))?.items || []).find((i) => i.value === 'L2');
  r = await api('POST', `/api/v1/dicts/${treeCode}/items`, { id: l2?.id, value: 'L2', label: '二级', parentValue: 'L2' });
  assert(r.body?.code !== 0, '上级不能是自身');
  // 先建 L3 再测环：L1 → L2 → L3，将 L1 的上级改为 L3 应形成环
  await api('POST', `/api/v1/dicts/${treeCode}/items`, { value: 'L3', label: '三级', parentValue: 'L2', sort: 3 });
  const l1 = (data(await api('GET', `/api/v1/dicts/${treeCode}/items`))?.items || []).find((i) => i.value === 'L1');
  r = await api('POST', `/api/v1/dicts/${treeCode}/items`, { id: l1?.id, value: 'L1', label: '一级', parentValue: 'L3' });
  assert(r.body?.code !== 0, '层级环（上级链回到自身）被拒绝');
  r = await api('DELETE', `/api/v1/dicts/${treeCode}/items/${l1?.id}`);
  assert(r.body?.code !== 0, '存在下级码值时删除被拒绝');
  // 清理：自下而上删除
  const items = (data(await api('GET', `/api/v1/dicts/${treeCode}/items`))?.items || []);
  for (const v of ['L3', 'L2', 'L1']) {
    const it = items.find((i) => i.value === v);
    if (it) await api('DELETE', `/api/v1/dicts/${treeCode}/items/${it.id}`);
  }
  // 层级模型：物料模型 parent_field = parentMaterial（种子已配置），校验配置与树形列表
  r = await api('GET', '/api/v1/models');
  const matModel = (data(r) || []).find((m) => m.code === 'material');
  r = await api('PUT', `/api/v1/models/${matModel?.id}`, { parentField: 'not_exist_field' });
  assert(r.body?.code !== 0, '层级字段不存在于模型时被拒绝');
  r = await api('PUT', `/api/v1/models/${matModel?.id}`, { parentField: 'parentMaterial' });
  assert(r.body?.code === 0 && data(r)?.parent_field === 'parentMaterial', '层级字段配置生效');
  r = await api('GET', '/api/v1/master-data/material?tree=1');
  const treeList = data(r);
  assert(r.body?.code === 0 && treeList?.model?.parentField === 'parentMaterial' && treeList?.treeMode === true, '树形模式列表（全量加载）');
  const g1 = (treeList?.list || []).find((x) => x.master_code === 'WL-GROUP-0001');
  const g2 = (treeList?.list || []).find((x) => x.master_code === 'WL-GROUP-0002');
  assert(g1 && g2 && g2.data?.parentMaterial === 'WL-GROUP-0001', '层级演示数据父子关系正确');
  // 层级校验：新增带合法上级的草稿 / 非法上级被拒 / 环被拒
  r = await api('POST', '/api/v1/master-data/material', {
    data: { materialName: `冒烟层级子件-${stamp}`, spec: 'TREE-1', unit: 'EA', category: 'BOLT', parentMaterial: 'WL-GROUP-0001' },
  });
  assert(r.body?.code === 0 && data(r)?.id, '新增带上级物料的草稿');
  const treeDraftId = data(r)?.id;
  r = await api('POST', '/api/v1/master-data/material', {
    data: { materialName: `冒烟层级非法-${stamp}`, spec: 'TREE-2', unit: 'EA', category: 'BOLT', parentMaterial: 'WL-NO-SUCH' },
  });
  assert(r.body?.code !== 0, '上级主数据不存在被拒绝');
  // 环：把 WL-GROUP-0001 的上级改为其孙级 WL-GROUP-003（需全量字段，取详情后改）
  r = await api('GET', '/api/v1/master-data/material/WL-GROUP-0001');
  const g1Detail = data(r);
  r = await api('PUT', '/api/v1/master-data/material/WL-GROUP-0001', {
    data: { ...g1Detail?.data, parentMaterial: 'WL-GROUP-0003' },
  });
  assert(r.body?.code !== 0, '主数据层级环被拒绝（不能以下级为上级）');
  // 清理：草稿提交走审批或保留均可，归档清理
  r = await api('GET', `/api/v1/master-data/material/${treeDraftId}`);
  assert(r.body?.code === 0, '层级草稿详情可查询');

  // ---------- 13. 统计与权限 ----------
  console.log('[统计与权限]');
  r = await api('GET', '/api/v1/stats/dashboard');
  assert(r.body?.code === 0 && data(r)?.volume && data(r)?.quality, '治理仪表板统计');
  r = await api('GET', '/api/v1/audit?page=1&size=5');
  assert(r.body?.code === 0 && data(r)?.total >= 1, '审计日志');
  // 未携带 token 访问受保护接口应 401
  const saved = token;
  token = '';
  r = await api('GET', '/api/v1/schedule/jobs');
  assert(r.status === 401, '未登录访问调度接口被拒绝');
  token = saved;

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('冒烟测试异常中断：', e);
  process.exit(1);
});
