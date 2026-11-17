<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { qualityApi } from '../api';
import { useAuth } from '../stores/auth';

const auth = useAuth();
const canManage = computed(() => auth.has('quality.manage'));

const tab = ref('overview');
const overview = ref<any>({ dims: [], counts: {}, trend: [], recentIssues: [] });
const rules = ref<any[]>([]);
const tasks = ref<any[]>([]);
const runs = ref<any>({ list: [], total: 0, page: 1, size: 10 });
const issues = ref<any>({ list: [], total: 0, page: 1, size: 10 });
const domains = ref<any[]>([]);
const loading = ref(false);

const DIM_LABELS: Record<string, string> = {
  COMPLETENESS: '完整性', UNIQUENESS: '唯一性', VALIDITY: '合法性', CONSISTENCY: '一致性', TIMELINESS: '及时性',
};
const RULE_LABELS: Record<string, string> = {
  NOT_EMPTY: '非空', UNIQUE: '唯一', REGEX: '正则', RANGE: '范围', REF_EXISTS: '码表引用',
};
const LEVEL_LABELS: Record<string, string> = { HIGH: '高', MEDIUM: '中', LOW: '低' };
const STATUS_LABELS: Record<string, string> = { OPEN: '待整改', FIXED: '已修复', IGNORED: '已忽略' };
const RULE_TYPES = [
  { value: 'NOT_EMPTY', label: '非空校验' },
  { value: 'UNIQUE', label: '唯一性校验' },
  { value: 'REGEX', label: '正则校验' },
  { value: 'RANGE', label: '数值 / 日期范围' },
  { value: 'REF_EXISTS', label: '码表引用校验' },
];

const ruleFilter = reactive({ domain: '', keyword: '' });
const issueFilter = reactive<any>({ status: 'OPEN', domain: '', dimension: '', level: '', keyword: '', mine: false, page: 1, size: 10 });
const runDomain = ref('');
const assignees = ref<any[]>([]);

// ---------------- 加载 ----------------
async function loadOverview() {
  overview.value = await qualityApi.overview();
}
async function loadRules() {
  const params: any = { ...ruleFilter };
  Object.keys(params).forEach((k) => { if (!params[k]) delete params[k]; });
  rules.value = (await qualityApi.rules(params)) || [];
}
async function loadTasks() {
  tasks.value = (await qualityApi.tasks()) || [];
}
async function loadRuns() {
  const params: any = { page: runs.value.page, size: runs.value.size };
  if (runDomain.value) params.domain = runDomain.value;
  runs.value = await qualityApi.runs(params);
}
async function loadIssues() {
  loading.value = true;
  try {
    const params: any = { ...issueFilter };
    Object.keys(params).forEach((k) => { if (!params[k]) delete params[k]; });
    issues.value = await qualityApi.issues(params);
  } finally {
    loading.value = false;
  }
}

async function refreshAll() {
  await Promise.all([loadOverview(), loadRules(), loadTasks(), loadRuns(), loadIssues()]);
}

// ---------------- 巡检 ----------------
async function runTask(task: any) {
  const res = await qualityApi.runTask(task.id);
  ElMessage.success(`「${task.name}」完成：检查 ${res.total} 项，问题 ${res.failed} 条，评分 ${res.score}`);
  await Promise.all([loadOverview(), loadTasks(), loadRuns(), loadIssues(), loadRules()]);
}
async function scanNow() {
  const res = await qualityApi.scan({});
  ElMessage.success(`全域巡检完成：检查 ${res.total} 项，问题 ${res.failed} 条，评分 ${res.score}`);
  await Promise.all([loadOverview(), loadTasks(), loadRuns(), loadIssues(), loadRules()]);
}

// ---------------- 规则编辑 ----------------
const ruleVisible = ref(false);
const ruleForm = reactive<any>({
  id: null, code: '', name: '', domainCode: '', dimension: 'COMPLETENESS', fieldKey: '',
  ruleType: 'NOT_EMPTY', level: 'MEDIUM', enabled: true,
  pDict: '', pPattern: '', pMin: '', pMax: '', pDateAfter: false,
});
const domainFields = ref<any[]>([]);

function openRule(r?: any) {
  Object.assign(ruleForm, r ? {
    id: r.id, code: r.code, name: r.name, domainCode: r.domain_code, dimension: r.dimension,
    fieldKey: r.field_key || '', ruleType: r.rule_type, level: r.level, enabled: r.enabled,
    pDict: r.params?.dict || '', pPattern: r.params?.pattern || '',
    pMin: r.params?.min ?? '', pMax: r.params?.max ?? '', pDateAfter: r.params?.dateAfter === 'TODAY',
  } : {
    id: null, code: '', name: '', domainCode: domains.value[0]?.code || '', dimension: 'COMPLETENESS',
    fieldKey: '', ruleType: 'NOT_EMPTY', level: 'MEDIUM', enabled: true,
    pDict: '', pPattern: '', pMin: '', pMax: '', pDateAfter: false,
  });
  onDomainChange();
  ruleVisible.value = true;
}
function onDomainChange() {
  const d = domains.value.find((x) => x.code === ruleForm.domainCode);
  domainFields.value = d?.fields || [];
}
async function saveRule() {
  const params: any = {};
  if (ruleForm.ruleType === 'REF_EXISTS') params.dict = ruleForm.pDict;
  if (ruleForm.ruleType === 'REGEX') params.pattern = ruleForm.pPattern;
  if (ruleForm.ruleType === 'RANGE') {
    if (ruleForm.pDateAfter) params.dateAfter = 'TODAY';
    else {
      if (ruleForm.pMin !== '') params.min = Number(ruleForm.pMin);
      if (ruleForm.pMax !== '') params.max = Number(ruleForm.pMax);
    }
  }
  await qualityApi.saveRule({
    id: ruleForm.id, code: ruleForm.code, name: ruleForm.name, domainCode: ruleForm.domainCode,
    dimension: ruleForm.dimension, fieldKey: ruleForm.fieldKey, ruleType: ruleForm.ruleType,
    level: ruleForm.level, enabled: ruleForm.enabled, params,
  });
  ruleVisible.value = false;
  ElMessage.success('质量规则已保存');
  await Promise.all([loadRules(), loadOverview()]);
}
async function toggleRule(r: any) {
  await qualityApi.saveRule({
    id: r.id, code: r.code, name: r.name, domainCode: r.domain_code, dimension: r.dimension,
    fieldKey: r.field_key, ruleType: r.rule_type, level: r.level, enabled: !r.enabled, params: r.params,
  });
  ElMessage.success(!r.enabled ? '规则已启用' : '规则已停用');
  await loadRules();
}

// ---------------- 任务编辑 ----------------
const taskVisible = ref(false);
const taskForm = reactive<any>({ id: null, code: '', name: '', domainCode: '', schedule: '' });
function openTask(t?: any) {
  Object.assign(taskForm, t ? { id: t.id, code: t.code, name: t.name, domainCode: t.domain_code || '', schedule: t.schedule || '' }
    : { id: null, code: '', name: '', domainCode: '', schedule: '每日 02:00' });
  taskVisible.value = true;
}
async function saveTask() {
  await qualityApi.saveTask({ ...taskForm });
  taskVisible.value = false;
  ElMessage.success('巡检任务已保存');
  await Promise.all([loadTasks(), loadOverview()]);
}

// ---------------- 问题闭环 ----------------
const drawer = ref(false);
const issueDetail = ref<any>(null);
async function openIssue(row: any) {
  issueDetail.value = await qualityApi.issueDetail(row.id);
  drawer.value = true;
}
async function handleIssue(row: any, action: 'FIX' | 'IGNORE') {
  const tip = action === 'FIX' ? '确认该问题已完成整改并闭环？' : '确认忽略该问题？';
  let remark = '';
  try {
    const res: any = await ElMessageBox.prompt(tip, action === 'FIX' ? '整改闭环' : '忽略问题', {
      confirmButtonText: '确认', cancelButtonText: '取消', inputPlaceholder: '处置说明（选填）',
      inputValue: '',
    });
    remark = res.value || '';
  } catch {
    return;
  }
  await qualityApi.handleIssue(row.id, { action, remark });
  ElMessage.success(action === 'FIX' ? '问题已闭环' : '问题已忽略');
  await Promise.all([loadIssues(), loadOverview()]);
}

function viewRunIssues(run: any) {
  issueFilter.status = '';
  issueFilter.runId = run.id;
  issueFilter.page = 1;
  tab.value = 'issues';
  loadIssues();
}
function gotoIssues() {
  issueFilter.status = 'OPEN';
  issueFilter.runId = '';
  tab.value = 'issues';
  loadIssues();
}

// ---------------- 指派与报告 ----------------
const assignVisible = ref(false);
const assignForm = reactive<any>({ issueId: 0, issueTitle: '', userId: null });

function openAssign(row: any) {
  Object.assign(assignForm, { issueId: row.id, issueTitle: row.master_code ? `${row.master_code} · ${row.message}` : row.message, userId: null });
  assignVisible.value = true;
}

async function confirmAssign() {
  if (!assignForm.userId) {
    ElMessage.warning('请选择责任人');
    return;
  }
  const res = await qualityApi.assignIssue(assignForm.issueId, { userId: assignForm.userId });
  assignVisible.value = false;
  ElMessage.success(`已指派给 ${res.assignee_name}`);
  await Promise.all([loadIssues(), loadOverview()]);
}

/** 巡检批次报告 CSV 下载 */
async function exportRunReport(run: any) {
  const res = await qualityApi.runReport(run.id);
  const blob = new Blob(['\uFEFF' + res.content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = res.filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

onMounted(async () => {
  const meta = await qualityApi.meta();
  domains.value = meta?.domains || [];
  assignees.value = (await qualityApi.assignees()) || [];
  await refreshAll();
});
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>数据质量</h2>
        <p class="desc">规则驱动的质量巡检：五维评估、问题闭环与趋势跟踪，扫描已发布主数据</p>
      </div>
      <div class="flex">
        <button class="btn" @click="gotoIssues">待整改问题（{{ overview.counts?.open || 0 }}）</button>
        <button v-if="canManage" class="btn primary" @click="scanNow">立即全域巡检</button>
      </div>
    </div>

    <div class="cards-row">
      <div class="kpi">
        <div class="k-label">综合质量评分</div>
        <div class="k-num" :style="{ color: overview.score >= 90 ? 'var(--ok)' : overview.score >= 75 ? 'var(--warn)' : 'var(--err)' }">{{ overview.score ?? 100 }}</div>
        <div class="k-delta"><span class="hint">最近巡检 {{ String(overview.lastRunAt || '').replace('T', ' ') || '—' }}</span></div>
      </div>
      <div class="kpi"><div class="k-label">待整改问题</div><div class="k-num" style="color:var(--warn)">{{ overview.counts?.open || 0 }}</div><div class="k-delta"><span class="hint">高风险 {{ overview.counts?.highOpen || 0 }}</span></div></div>
      <div class="kpi"><div class="k-label">已闭环</div><div class="k-num" style="color:var(--ok)">{{ overview.counts?.fixed || 0 }}</div><div class="k-delta"><span class="hint">累计问题 {{ overview.counts?.total || 0 }}</span></div></div>
      <div class="kpi"><div class="k-label">启用规则</div><div class="k-num">{{ overview.rules || 0 }}</div><div class="k-delta"><span class="hint">巡检任务 {{ overview.tasks || 0 }}</span></div></div>
    </div>

    <div class="tabs">
      <div class="tab" :class="{ active: tab === 'overview' }" @click="tab = 'overview'">质量概览</div>
      <div class="tab" :class="{ active: tab === 'rules' }" @click="tab = 'rules'">规则管理（{{ rules.length }}）</div>
      <div class="tab" :class="{ active: tab === 'tasks' }" @click="tab = 'tasks'">巡检任务</div>
      <div class="tab" :class="{ active: tab === 'issues' }" @click="tab = 'issues'">问题清单（{{ overview.counts?.open || 0 }}）</div>
      <div class="tab" :class="{ active: tab === 'runs' }" @click="tab = 'runs'">巡检记录</div>
    </div>

    <!-- 概览 -->
    <div v-if="tab === 'overview'">
      <div class="q-grid">
        <div class="card">
          <div class="card-head">五维质量评分</div>
          <div class="card-body">
            <div v-for="d in overview.dims" :key="d.dimension" class="dim-row">
              <div class="dim-name">{{ d.label }}</div>
              <div class="q-bar"><div class="q-bar-in" :style="{ width: d.score + '%', background: d.score >= 90 ? 'var(--ok)' : d.score >= 75 ? 'var(--warn)' : 'var(--err)' }"></div></div>
              <div class="dim-score">{{ d.score }}</div>
              <div class="dim-issues">{{ d.issues }} 条待整改</div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">评分趋势（近 7 次巡检）</div>
          <div class="card-body">
            <div class="q-trend">
              <div v-for="(t, i) in overview.trend" :key="i" class="q-col">
                <div class="q-col-val">{{ t.score }}</div>
                <div class="q-col-bar" :style="{ height: Math.max(10, (t.score - 70) * 3) + 'px' }"></div>
                <div class="q-col-label">{{ String(t.at || '').slice(5, 10) }}</div>
              </div>
              <div v-if="!overview.trend.length" class="hint">暂无巡检记录，先执行一次巡检</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card mt14">
        <div class="card-head">
          <span>最近质量问题</span>
          <span class="link" @click="gotoIssues">查看全部</span>
        </div>
        <table class="tbl">
          <thead><tr><th>主数据编码</th><th>数据域</th><th>规则</th><th>问题描述</th><th>级别</th><th>状态</th><th>发现时间</th></tr></thead>
          <tbody>
            <tr v-for="i in overview.recentIssues" :key="i.id" @click="openIssue(i)">
              <td class="num">{{ i.master_code || '—' }}</td>
              <td>{{ i.domain_name }}</td>
              <td>{{ i.rule_name || '—' }}</td>
              <td>{{ i.message }}</td>
              <td><span class="tag" :class="i.level === 'HIGH' ? 'r' : i.level === 'MEDIUM' ? 'o' : 's'">{{ LEVEL_LABELS[i.level] }}</span></td>
              <td><span class="tag" :class="i.status === 'OPEN' ? 'o' : i.status === 'FIXED' ? 'g' : 's'">{{ STATUS_LABELS[i.status] }}</span></td>
              <td class="muted">{{ String(i.created_at || '').replace('T', ' ') }}</td>
            </tr>
            <tr v-if="!overview.recentIssues?.length"><td colspan="7" class="muted">暂无质量问题</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 规则 -->
    <div v-else-if="tab === 'rules'" class="card">
      <div class="fbar" style="padding:12px 16px 0">
        <div class="f-item">
          <select v-model="ruleFilter.domain" @change="loadRules">
            <option value="">全部数据域</option>
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
        </div>
        <div class="f-item"><input v-model="ruleFilter.keyword" placeholder="规则名称 / 编码 / 字段" style="width:200px" @keyup.enter="loadRules" /></div>
        <button class="btn sm" @click="loadRules">筛选</button>
        <div class="fr"></div>
        <button v-if="canManage" class="btn sm primary" @click="openRule()">新增规则</button>
      </div>
      <table class="tbl">
        <thead><tr><th>规则</th><th>数据域</th><th>维度</th><th>校验字段</th><th>类型</th><th>级别</th><th>未闭环</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id">
            <td><b>{{ r.name }}</b><div class="hint">{{ r.code }}</div></td>
            <td>{{ r.domain_name }}</td>
            <td><span class="tag b">{{ DIM_LABELS[r.dimension] || r.dimension }}</span></td>
            <td class="num">{{ r.field_key || '—' }}</td>
            <td>{{ RULE_LABELS[r.rule_type] || r.rule_type }}</td>
            <td><span class="tag" :class="r.level === 'HIGH' ? 'r' : r.level === 'MEDIUM' ? 'o' : 's'">{{ LEVEL_LABELS[r.level] }}</span></td>
            <td class="num">{{ r.open_issues }}</td>
            <td><span class="tag" :class="r.enabled ? 'g' : 's'">{{ r.enabled ? '启用' : '停用' }}</span></td>
            <td>
              <span v-if="canManage" class="link" @click="openRule(r)">编辑</span>
              <span v-if="canManage" class="link" style="margin-left:8px" @click="toggleRule(r)">{{ r.enabled ? '停用' : '启用' }}</span>
            </td>
          </tr>
          <tr v-if="!rules.length"><td colspan="9" class="muted">暂无质量规则</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 任务 -->
    <div v-else-if="tab === 'tasks'" class="card">
      <div class="card-head">
        <span>巡检任务</span>
        <button v-if="canManage" class="btn sm" @click="openTask()">新增任务</button>
      </div>
      <table class="tbl">
        <thead><tr><th>任务</th><th>巡检范围</th><th>调度频率</th><th>上次执行</th><th>最近评分</th><th>最近问题</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.id">
            <td><b>{{ t.name }}</b><div class="hint">{{ t.code }}</div></td>
            <td>{{ t.domain_name || '全部数据域' }}</td>
            <td>{{ t.schedule || '手动执行' }}</td>
            <td class="muted">{{ String(t.last_run_at || '').replace('T', ' ') || '—' }}</td>
            <td><span class="tag" :class="(t.last_score || 0) >= 90 ? 'g' : 'o'">{{ t.last_score ?? '—' }}</span></td>
            <td class="num">{{ t.last_failed ?? '—' }}</td>
            <td>
              <span v-if="canManage" class="link" @click="runTask(t)">立即执行</span>
              <span v-if="canManage" class="link" style="margin-left:8px" @click="openTask(t)">编辑</span>
            </td>
          </tr>
          <tr v-if="!tasks.length"><td colspan="7" class="muted">暂无巡检任务</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 问题 -->
    <div v-else-if="tab === 'issues'" class="card">
      <div class="fbar" style="padding:12px 16px 0">
        <div class="f-item">
          <select v-model="issueFilter.status" @change="issueFilter.page = 1; loadIssues()">
            <option value="">全部状态</option>
            <option value="OPEN">待整改</option><option value="FIXED">已修复</option><option value="IGNORED">已忽略</option>
          </select>
        </div>
        <div class="f-item">
          <select v-model="issueFilter.domain" @change="issueFilter.page = 1; loadIssues()">
            <option value="">全部数据域</option>
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
        </div>
        <div class="f-item">
          <select v-model="issueFilter.dimension" @change="issueFilter.page = 1; loadIssues()">
            <option value="">全部维度</option>
            <option v-for="(v, k) in DIM_LABELS" :key="k" :value="k">{{ v }}</option>
          </select>
        </div>
        <div class="f-item">
          <select v-model="issueFilter.level" @change="issueFilter.page = 1; loadIssues()">
            <option value="">全部级别</option><option value="HIGH">高</option><option value="MEDIUM">中</option><option value="LOW">低</option>
          </select>
        </div>
        <div class="f-item"><input v-model="issueFilter.keyword" placeholder="主数据编码 / 描述" style="width:170px" @keyup.enter="issueFilter.page = 1; loadIssues()" /></div>
        <button class="btn sm" :class="{ primary: issueFilter.mine }" @click="issueFilter.mine = !issueFilter.mine; issueFilter.page = 1; loadIssues()">我的待整改</button>
        <button class="btn sm" @click="issueFilter.page = 1; loadIssues()">查询</button>
      </div>
      <table class="tbl">
        <thead><tr><th>主数据</th><th>数据域</th><th>规则 / 字段</th><th>问题描述</th><th>维度</th><th>级别</th><th>状态</th><th>责任人</th><th>处置人</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="i in issues.list" :key="i.id">
            <td class="num">{{ i.master_code || '—' }}</td>
            <td>{{ i.domain_name }}</td>
            <td>{{ i.rule_name || '—' }}<div class="hint">{{ i.field_key }}</div></td>
            <td style="max-width:320px">{{ i.message }}</td>
            <td>{{ DIM_LABELS[i.dimension] || i.dimension }}</td>
            <td><span class="tag" :class="i.level === 'HIGH' ? 'r' : i.level === 'MEDIUM' ? 'o' : 's'">{{ LEVEL_LABELS[i.level] }}</span></td>
            <td><span class="tag" :class="i.status === 'OPEN' ? 'o' : i.status === 'FIXED' ? 'g' : 's'">{{ STATUS_LABELS[i.status] }}</span></td>
            <td>{{ i.assignee_name || '未指派' }}</td>
            <td class="muted">{{ i.handled_by || '—' }}</td>
            <td>
              <span class="link" @click="openIssue(i)">定位</span>
              <span v-if="canManage && i.status === 'OPEN'" class="link" style="margin-left:8px" @click="handleIssue(i, 'FIX')">整改</span>
              <span v-if="canManage && i.status === 'OPEN'" class="link" style="margin-left:8px;color:var(--mut)" @click="handleIssue(i, 'IGNORE')">忽略</span>
              <span v-if="canManage && i.status === 'OPEN'" class="link" style="margin-left:8px" @click="openAssign(i)">指派</span>
            </td>
          </tr>
          <tr v-if="!loading && !issues.list.length"><td colspan="10" class="muted">暂无质量问题</td></tr>
        </tbody>
      </table>
      <div class="pgn" style="padding:10px 16px 14px">
        <span>共 {{ issues.total }} 条</span>
        <button :disabled="issueFilter.page <= 1" @click="issueFilter.page--; loadIssues()">‹</button>
        <button class="cur">{{ issueFilter.page }}</button>
        <button :disabled="issueFilter.page * issueFilter.size >= issues.total" @click="issueFilter.page++; loadIssues()">›</button>
      </div>
    </div>

    <!-- 巡检记录 -->
    <div v-else class="card">
      <div class="fbar" style="padding:12px 16px 0">
        <div class="f-item">
          <select v-model="runDomain" @change="runs.page = 1; loadRuns()">
            <option value="">全部数据域</option>
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
        </div>
        <button class="btn sm" @click="loadRuns">刷新</button>
      </div>
      <table class="tbl">
        <thead><tr><th>批次</th><th>任务</th><th>范围</th><th>检查项</th><th>通过</th><th>问题</th><th>评分</th><th>耗时</th><th>执行人</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in runs.list" :key="r.id">
            <td class="num">#{{ r.id }}</td>
            <td>{{ r.task_name || '手动巡检' }}</td>
            <td>{{ r.domain_name || '全部' }}</td>
            <td class="num">{{ r.total }}</td>
            <td class="num" style="color:var(--ok)">{{ r.passed }}</td>
            <td class="num" :style="{ color: r.failed ? 'var(--err)' : 'inherit' }">{{ r.failed }}</td>
            <td><span class="tag" :class="r.score >= 90 ? 'g' : r.score >= 75 ? 'o' : 'r'">{{ r.score }}</span></td>
            <td class="num">{{ r.duration_ms }}ms</td>
            <td>{{ r.operator || '—' }}</td>
            <td class="muted">{{ String(r.created_at || '').replace('T', ' ') }}</td>
            <td>
              <span class="link" @click="viewRunIssues(r)">问题（{{ r.failed }}）</span>
              <span class="link" style="margin-left:8px" @click="exportRunReport(r)">报告</span>
            </td>
          </tr>
          <tr v-if="!runs.list.length"><td colspan="11" class="muted">暂无巡检记录</td></tr>
        </tbody>
      </table>
      <div class="pgn" style="padding:10px 16px 14px">
        <span>共 {{ runs.total }} 条</span>
        <button :disabled="runs.page <= 1" @click="runs.page--; loadRuns()">‹</button>
        <button class="cur">{{ runs.page }}</button>
        <button :disabled="runs.page * runs.size >= runs.total" @click="runs.page++; loadRuns()">›</button>
      </div>
    </div>

    <!-- 规则对话框 -->
    <el-dialog v-model="ruleVisible" :title="ruleForm.id ? '编辑质量规则' : '新增质量规则'" width="620px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>规则编码</label><input v-model="ruleForm.code" style="width:100%" /></div>
        <div class="form-item req"><label>规则名称</label><input v-model="ruleForm.name" style="width:100%" /></div>
      </div>
      <div class="grid-form">
        <div class="form-item req"><label>数据域</label>
          <select v-model="ruleForm.domainCode" style="width:100%" @change="onDomainChange">
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
        </div>
        <div class="form-item req"><label>校验字段</label>
          <select v-model="ruleForm.fieldKey" style="width:100%">
            <option value="">— 选择字段 —</option>
            <option v-for="f in domainFields" :key="f.field_key" :value="f.field_key">{{ f.label }}（{{ f.field_key }}）</option>
          </select>
        </div>
      </div>
      <div class="grid-form">
        <div class="form-item req"><label>质量维度</label>
          <select v-model="ruleForm.dimension" style="width:100%">
            <option v-for="(v, k) in DIM_LABELS" :key="k" :value="k">{{ v }}</option>
          </select>
        </div>
        <div class="form-item req"><label>规则类型</label>
          <select v-model="ruleForm.ruleType" style="width:100%">
            <option v-for="t in RULE_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
          </select>
        </div>
      </div>
      <div v-if="ruleForm.ruleType === 'REF_EXISTS'" class="form-item req"><label>引用码表编码</label><input v-model="ruleForm.pDict" placeholder="如 material_category" style="width:100%" /></div>
      <div v-if="ruleForm.ruleType === 'REGEX'" class="form-item req"><label>正则表达式</label><input v-model="ruleForm.pPattern" placeholder="如 ^[0-9]{6}$" style="width:100%" /></div>
      <div v-if="ruleForm.ruleType === 'RANGE'" class="grid-form">
        <div class="form-item"><label>最小值</label><input v-model="ruleForm.pMin" type="number" style="width:100%" /></div>
        <div class="form-item"><label>最大值</label><input v-model="ruleForm.pMax" type="number" style="width:100%" /></div>
      </div>
      <div v-if="ruleForm.ruleType === 'RANGE'" class="form-item">
        <label><input v-model="ruleForm.pDateAfter" type="checkbox" /> 日期须不早于今天（证照时效类）</label>
      </div>
      <div class="grid-form">
        <div class="form-item"><label>严重级别</label>
          <select v-model="ruleForm.level" style="width:100%"><option value="HIGH">高</option><option value="MEDIUM">中</option><option value="LOW">低</option></select>
        </div>
        <div class="form-item"><label>启用状态</label>
          <select v-model="ruleForm.enabled" style="width:100%"><option :value="true">启用</option><option :value="false">停用</option></select>
        </div>
      </div>
      <template #footer>
        <button class="btn" @click="ruleVisible = false">取消</button>
        <button class="btn primary" @click="saveRule">保存</button>
      </template>
    </el-dialog>

    <!-- 任务对话框 -->
    <el-dialog v-model="taskVisible" :title="taskForm.id ? '编辑巡检任务' : '新增巡检任务'" width="520px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>任务编码</label><input v-model="taskForm.code" style="width:100%" /></div>
        <div class="form-item req"><label>任务名称</label><input v-model="taskForm.name" style="width:100%" /></div>
      </div>
      <div class="grid-form">
        <div class="form-item"><label>巡检范围</label>
          <select v-model="taskForm.domainCode" style="width:100%">
            <option value="">全部数据域</option>
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
        </div>
        <div class="form-item"><label>调度频率</label><input v-model="taskForm.schedule" placeholder="如 每日 02:00" style="width:100%" /></div>
      </div>
      <div class="hint">调度为展示配置，当前版本通过「立即执行」或按钮手动触发扫描。</div>
      <template #footer>
        <button class="btn" @click="taskVisible = false">取消</button>
        <button class="btn primary" @click="saveTask">保存</button>
      </template>
    </el-dialog>

    <!-- 问题定位抽屉 -->
    <el-drawer v-model="drawer" title="质量问题定位" size="640px" destroy-on-close>
      <template v-if="issueDetail">
        <div class="kv"><b>问题描述</b><span>{{ issueDetail.issue.message }}</span></div>
        <div class="kv"><b>主数据编码</b><span>{{ issueDetail.issue.master_code || '—' }}</span></div>
        <div class="kv"><b>数据域 / 字段</b><span>{{ issueDetail.issue.domain_code }} / {{ issueDetail.issue.field_key || '—' }}</span></div>
        <div class="kv"><b>规则</b><span>{{ issueDetail.rule?.name || '—' }}</span></div>
        <div class="kv"><b>当前值</b><span>{{ issueDetail.issue.value || '（空）' }}</span></div>
        <div class="kv"><b>状态</b><span>{{ STATUS_LABELS[issueDetail.issue.status] }}</span></div>
        <div class="kv"><b>处置</b><span>{{ issueDetail.issue.handled_by || '—' }} {{ String(issueDetail.issue.handled_at || '').replace('T', ' ') }}</span></div>
        <h4 class="mt10">记录现状</h4>
        <div v-if="issueDetail.record" class="kv"><b>名称</b><span>{{ issueDetail.record.name }}</span></div>
        <pre style="background:#f8fafc;border:1px solid var(--bd);border-radius:8px;padding:10px;font-size:12px;overflow:auto;max-height:320px">{{ JSON.stringify(issueDetail.record?.data || {}, null, 2) }}</pre>
        <h4 class="mt10">规则配置</h4>
        <pre style="background:#f8fafc;border:1px solid var(--bd);border-radius:8px;padding:10px;font-size:12px">{{ JSON.stringify({ type: issueDetail.rule?.rule_type, params: issueDetail.rule?.params }, null, 2) }}</pre>
        <div v-if="canManage && issueDetail.issue.status === 'OPEN'" class="flex mt14">
          <button class="btn primary" @click="drawer = false; handleIssue(issueDetail.issue, 'FIX')">标记已整改</button>
          <button class="btn" @click="drawer = false; handleIssue(issueDetail.issue, 'IGNORE')">忽略该问题</button>
        </div>
      </template>
    </el-drawer>

    <!-- 指派责任人 -->
    <el-dialog v-model="assignVisible" title="指派责任人" width="480px" destroy-on-close>
      <div class="form-item"><label>问题</label><div class="hint" style="max-height:60px;overflow:auto">{{ assignForm.issueTitle }}</div></div>
      <div class="form-item req"><label>指派给</label>
        <select v-model="assignForm.userId" style="width:100%">
          <option :value="null">— 选择责任人 —</option>
          <option v-for="u in assignees" :key="u.id" :value="u.id">{{ u.display_name }}（{{ u.dept || u.username }}）</option>
        </select>
      </div>
      <p class="hint">指派后，责任人可在「问题清单 → 我的待整改」中过滤到自己名下的问题。</p>
      <template #footer>
        <button class="btn" @click="assignVisible = false">取消</button>
        <button class="btn primary" @click="confirmAssign">确认指派</button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.q-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 12px; }
.dim-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
.dim-name { width: 62px; font-size: 12.5px; color: var(--mut); flex: none; }
.q-bar { flex: 1; height: 10px; background: #eef2f7; border-radius: 6px; overflow: hidden; }
.q-bar-in { height: 100%; border-radius: 6px; transition: width .3s; }
.dim-score { width: 42px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.dim-issues { width: 72px; text-align: right; font-size: 12px; color: var(--mut); }
.q-trend { display: flex; align-items: flex-end; gap: 16px; height: 120px; padding: 0 8px; }
.q-col { flex: 1; text-align: center; }
.q-col-val { font-size: 12px; color: var(--mut); margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.q-col-bar { width: 100%; max-width: 38px; margin: 0 auto; background: linear-gradient(180deg, #60a5fa, #2563eb); border-radius: 5px 5px 0 0; }
.q-col-label { font-size: 11px; color: var(--mut); margin-top: 6px; }
</style>
