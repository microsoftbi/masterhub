<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { collectApi, importApi, integrationApi, metaApi } from '../api';
import { useAuth } from '../stores/auth';

const auth = useAuth();
const summary = ref<any>({});
const subscribers = ref<any[]>([]);
const domains = ref<any[]>([]);
const events = ref<any>({ list: [], total: 0, page: 1, size: 10 });
const logs = ref<any>({ list: [], total: 0, page: 1, size: 10 });
const tab = ref('events');
const loading = ref(false);
const canManage = computed(() => auth.has('integration.manage'));

const subVisible = ref(false);
const subForm = reactive<any>({ id: null, code: '', name: '', domainCodes: [] as string[], url: '', secret: '', status: 'ACTIVE' });
const eventFilters = reactive<any>({ status: '', domain: '', keyword: '', page: 1, size: 10 });

const drawer = ref(false);
const eventDetail = ref<any>(null);

const STATUS: Record<string, string> = { PENDING: '待推送', PUSHED: '已推送', FAILED: '失败', DEAD: '死信' };
const EVENT_TYPE: Record<string, string> = { CREATE: '新增', UPDATE: '变更', FREEZE: '冻结', UNFREEZE: '解冻', ARCHIVE: '归档' };

async function loadSummary() {
  summary.value = await integrationApi.summary();
}
async function loadSubscribers() {
  subscribers.value = (await integrationApi.subscribers()) || [];
}
async function loadEvents() {
  loading.value = true;
  try {
    const params: any = { ...eventFilters };
    Object.keys(params).forEach((k) => { if (!params[k]) delete params[k]; });
    events.value = await integrationApi.events(params);
  } finally { loading.value = false; }
}
async function loadLogs() {
  logs.value = await integrationApi.logs({ page: 1, size: 20 });
}

function openSub(s?: any) {
  Object.assign(subForm, s ? { ...s, domainCodes: [...(s.domain_codes || [])] } : {
    id: null, code: '', name: '', domainCodes: [], url: 'http://127.0.0.1:3000/api/v1/integration/mock-webhook', secret: 'mock-secret', status: 'ACTIVE',
  });
  subVisible.value = true;
}

async function saveSub() {
  await integrationApi.saveSubscriber({ ...subForm });
  subVisible.value = false;
  ElMessage.success('订阅方已保存');
  await loadSubscribers();
}

async function dispatch() {
  const res = await integrationApi.dispatch();
  ElMessage.success(`本次尝试 ${res.attempted} 条，成功 ${res.success} 条，失败 ${res.failed} 条`);
  await Promise.all([loadSummary(), loadEvents(), loadLogs()]);
}

async function retry(id: number) {
  const res = await integrationApi.retry(id);
  if (res.success) ElMessage.success('重试成功');
  else ElMessage.error('重试失败：' + (res.message || ''));
  await Promise.all([loadSummary(), loadEvents()]);
}

async function openEvent(id: number) {
  eventDetail.value = await integrationApi.eventDetail(id);
  drawer.value = true;
}

// ---------------- 数据采集（M4） ----------------
const collectSystems = ref<any[]>([]);
const collectVisible = ref(false);
const collectRunning = ref(0);
const collectResultVisible = ref(false);
const collectResult = ref<any>(null);
const collectForm = reactive<any>({
  id: null, code: '', name: '', domainCode: '', channel: 'API',
  endpoint: '', apiKey: '', status: 'ACTIVE', remark: '',
  dbPath: '', tableName: '', incremental: false, tsField: '',
  fieldMaps: [{ source: '', target: '' }] as any[],
  valueMaps: [] as any[],
  cleanRules: ['trim'] as string[],
});
const collectLogs = ref<any>({ list: [], total: 0 });

async function loadCollect() {
  collectSystems.value = (await collectApi.systems()) || [];
  loadCollectLogs().catch(() => undefined);
}

/** 采集执行历史（M7 留痕） */
async function loadCollectLogs() {
  collectLogs.value = (await collectApi.logs({ page: 1, size: 10 })) || { list: [], total: 0 };
}

/** 当前编辑源的增量水位（只读展示，服务端维护） */
function lastTsOf(id: any) {
  return collectSystems.value.find((s) => s.id === id)?.config?.lastTs || '';
}

function collectFields() {
  const d = collectForm.domainCode;
  const sys = collectSystems.value.find((s) => s.domain_code === d && s.fields?.length);
  return sys?.fields || [];
}

function openCollect(s?: any) {
  const toPairs = (m: any) =>
    Object.entries(m || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  Object.assign(collectForm, s ? {
    id: s.id, code: s.code, name: s.name, domainCode: s.domain_code, channel: s.channel,
    endpoint: s.endpoint || '', apiKey: s.api_key || '', status: s.status, remark: s.remark || '',
    dbPath: s.config?.dbPath || '', tableName: s.config?.tableName || '',
    incremental: !!s.config?.incremental, tsField: s.config?.tsField || '',
    fieldMaps: (s.fieldMaps || []).map((f: any) => ({ ...f })),
    valueMaps: (s.valueMaps || []).map((v: any) => ({ field: v.field, pairsText: toPairs(v.map) })),
    cleanRules: [...(s.cleanRules || [])],
  } : {
    id: null, code: '', name: '', domainCode: domains.value[0]?.code || '', channel: 'API',
    endpoint: '', apiKey: '', status: 'ACTIVE', remark: '',
    dbPath: '', tableName: '', incremental: false, tsField: '',
    fieldMaps: [{ source: '', target: '' }], valueMaps: [], cleanRules: ['trim'],
  });
  collectVisible.value = true;
}

async function saveCollect() {
  const valueMaps = (collectForm.valueMaps || [])
    .filter((v: any) => v.field && String(v.pairsText || '').trim())
    .map((v: any) => ({
      field: v.field,
      map: String(v.pairsText).split(',').map((p) => p.split('=')).filter((kv) => kv.length === 2)
        .reduce((acc: any, kv) => { acc[kv[0].trim()] = kv[1].trim(); return acc; }, {}),
    }));
  await collectApi.save({
    ...collectForm,
    config: {
      dbType: 'sqlite',
      dbPath: collectForm.channel === 'DB' ? collectForm.dbPath : '',
      tableName: collectForm.channel === 'DB' ? collectForm.tableName : '',
      incremental: !!collectForm.incremental,
      tsField: collectForm.incremental ? collectForm.tsField : '',
    },
    valueMaps,
  });
  collectVisible.value = false;
  ElMessage.success('采集源已保存');
  await loadCollect();
}

async function runCollect(s: any) {
  collectRunning.value = s.id;
  try {
    collectResult.value = await collectApi.run(s.id);
    if (collectResult.value?.skipped) {
      ElMessage.info(`「${s.name}」${collectResult.value.message || '本次无增量数据'}`);
      collectResult.value = null;
    } else {
      collectResultVisible.value = true;
    }
    await loadCollect();
  } catch { /* 错误提示由拦截器统一处理 */ } finally {
    collectRunning.value = 0;
  }
}

async function commitCollect() {
  const res = await importApi.commit(collectResult.value.id, { autoPublish: false });
  collectResult.value = res;
  ElMessage.success('采集数据已入库（草稿状态）');
}

onMounted(async () => {
  await Promise.all([loadSummary(), loadSubscribers(), loadEvents(), loadLogs(), metaApi.domains().then((r: any) => { domains.value = r || []; })]);
  loadCollect().catch(() => undefined);
});
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>数据集成</h2>
        <p class="desc">Outbox 事件驱动分发：发布/变更/生命周期事件按订阅关系推送并签名，失败自动退避重试</p>
      </div>
      <div class="flex">
        <button v-if="canManage" class="btn primary" @click="dispatch">手动触发分发</button>
      </div>
    </div>

    <div class="cards-row">
      <div class="kpi"><div class="k-label">事件总量</div><div class="k-num">{{ summary.total || 0 }}</div></div>
      <div class="kpi"><div class="k-label">待推送</div><div class="k-num" style="color:var(--warn)">{{ summary.pending || 0 }}</div></div>
      <div class="kpi"><div class="k-label">已推送</div><div class="k-num" style="color:var(--ok)">{{ summary.pushed || 0 }}</div></div>
      <div class="kpi"><div class="k-label">失败 / 死信</div><div class="k-num" style="color:var(--err)">{{ (summary.failed || 0) + (summary.dead || 0) }}</div></div>
      <div class="kpi"><div class="k-label">成功率</div><div class="k-num">{{ summary.successRate ?? 0 }}%</div></div>
      <div class="kpi"><div class="k-label">活跃订阅方</div><div class="k-num">{{ summary.subscribers || 0 }}</div></div>
    </div>

    <div class="tabs">
      <div class="tab" :class="{ active: tab === 'events' }" @click="tab = 'events'">分发事件</div>
      <div class="tab" :class="{ active: tab === 'subscribers' }" @click="tab = 'subscribers'">订阅方（{{ subscribers.length }}）</div>
      <div class="tab" :class="{ active: tab === 'collect' }" @click="tab = 'collect'; loadCollect()">数据采集（{{ collectSystems.length }}）</div>
      <div class="tab" :class="{ active: tab === 'logs' }" @click="tab = 'logs'">分发日志</div>
    </div>

    <div v-if="tab === 'events'" class="card">
      <div class="fbar" style="padding:12px 16px 0">
        <div class="f-item">
          <input v-model="eventFilters.keyword" placeholder="事件号 / 主数据编码" style="width:180px" @keyup.enter="eventFilters.page = 1; loadEvents()" />
        </div>
        <div class="f-item">
          <select v-model="eventFilters.status" @change="eventFilters.page = 1; loadEvents()">
            <option value="">全部状态</option>
            <option value="PENDING">待推送</option><option value="PUSHED">已推送</option>
            <option value="FAILED">失败</option><option value="DEAD">死信</option>
          </select>
        </div>
        <div class="f-item">
          <select v-model="eventFilters.domain" @change="eventFilters.page = 1; loadEvents()">
            <option value="">全部主数据域</option>
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
        </div>
        <button class="btn sm" @click="loadEvents">刷新</button>
      </div>
      <table class="tbl">
        <thead><tr><th>事件号</th><th>主数据</th><th>域</th><th>类型</th><th>订阅方</th><th>重试</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="e in events.list" :key="e.id">
            <td class="num">{{ e.event_no }}</td>
            <td>{{ e.master_code }}<div class="hint">{{ e.payloadPreview?.name }}</div></td>
            <td>{{ e.domain_code }}</td>
            <td><span class="tag b">{{ EVENT_TYPE[e.event_type] || e.event_type }}</span></td>
            <td>{{ e.subscriber_name || '—' }}</td>
            <td class="num">{{ e.retry_count }}</td>
            <td><span class="tag" :class="e.status === 'PUSHED' ? 'g' : e.status === 'PENDING' ? 'o' : 'r'">{{ STATUS[e.status] || e.status }}</span></td>
            <td class="muted">{{ String(e.created_at || '').replace('T', ' ') }}</td>
            <td>
              <span class="link" @click="openEvent(e.id)">详情</span>
              <span v-if="canManage && e.status !== 'PUSHED'" class="link" style="margin-left:8px" @click="retry(e.id)">重试</span>
            </td>
          </tr>
          <tr v-if="!loading && !events.list.length"><td colspan="9" class="muted">暂无分发事件</td></tr>
        </tbody>
      </table>
      <div class="pgn" style="padding:10px 16px 14px">
        <span>共 {{ events.total }} 条</span>
        <button :disabled="eventFilters.page <= 1" @click="eventFilters.page--; loadEvents()">‹</button>
        <button class="cur">{{ eventFilters.page }}</button>
        <button :disabled="eventFilters.page * eventFilters.size >= events.total" @click="eventFilters.page++; loadEvents()">›</button>
      </div>
    </div>

    <div v-else-if="tab === 'subscribers'" class="card">
      <div class="card-head">
        <span>订阅方配置</span>
        <button v-if="canManage" class="btn sm" @click="openSub()">新增订阅方</button>
      </div>
      <table class="tbl">
        <thead><tr><th>编码</th><th>名称</th><th>订阅主数据域</th><th>回调地址</th><th>事件数</th><th>待推送</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in subscribers" :key="s.id">
            <td class="num">{{ s.code }}</td>
            <td>{{ s.name }}</td>
            <td>
              <span v-for="c in s.domain_codes" :key="c" class="tag s" style="margin-right:4px">{{ c }}</span>
            </td>
            <td class="muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">{{ s.url }}</td>
            <td class="num">{{ s.event_count }}</td>
            <td class="num">{{ s.pending_count }}</td>
            <td><span class="tag" :class="s.status === 'ACTIVE' ? 'g' : 's'">{{ s.status === 'ACTIVE' ? '启用' : '停用' }}</span></td>
            <td><span v-if="canManage" class="link" @click="openSub(s)">编辑</span></td>
          </tr>
          <tr v-if="!subscribers.length"><td colspan="8" class="muted">暂无订阅方</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 数据采集 -->
    <div v-else-if="tab === 'collect'" class="card">
      <div class="card-head">
        <span>源系统采集（拉取 → 清洗 / 映射 / 码值转换 → 预校验批次 → 提交入库）</span>
        <button v-if="canManage" class="btn sm primary" @click="openCollect()">新增采集源</button>
      </div>
      <table class="tbl">
        <thead><tr><th>编码</th><th>名称</th><th>数据域</th><th>通道</th><th>拉取地址</th><th>字段映射</th><th>上次采集</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in collectSystems" :key="s.id">
            <td class="num">{{ s.code }}</td>
            <td><b>{{ s.name }}</b><div class="hint">{{ s.remark }}</div></td>
            <td>{{ s.domain_name || s.domain_code }}</td>
            <td><span class="tag b">{{ s.channel === 'DB' ? '数据库直连' : s.channel === 'FILE' ? '文件' : 'API' }}</span>
              <span v-if="s.config?.incremental" class="tag o" style="margin-left:4px">增量</span></td>
            <td class="muted" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">
              {{ s.channel === 'DB' ? `${s.config?.dbPath || ''} # ${s.config?.tableName || ''}` : (s.endpoint || '—') }}
            </td>
            <td class="num">{{ (s.fieldMaps || []).length }} 项</td>
            <td class="muted">{{ s.last_run_at ? String(s.last_run_at).replace('T', ' ') : '—' }}</td>
            <td><span class="tag" :class="s.status === 'ACTIVE' ? 'g' : 's'">{{ s.status === 'ACTIVE' ? '启用' : '停用' }}</span></td>
            <td>
              <span v-if="canManage" class="link" @click="runCollect(s)">{{ collectRunning === s.id ? '采集中…' : '立即采集' }}</span>
              <span v-if="canManage" class="link" style="margin-left:8px" @click="openCollect(s)">编辑</span>
            </td>
          </tr>
          <tr v-if="!collectSystems.length"><td colspan="9" class="muted">暂无采集源系统</td></tr>
        </tbody>
      </table>

      <div class="card-head" style="margin-top:18px">采集记录（最近 10 次执行，含增量水位）</div>
      <table class="tbl">
        <thead><tr><th>时间</th><th>源系统</th><th>模式</th><th>拉取</th><th>通过</th><th>失败</th><th>批次</th><th>增量水位</th><th>结果</th><th>操作人</th></tr></thead>
        <tbody>
          <tr v-for="l in collectLogs.list" :key="l.id">
            <td class="muted">{{ String(l.created_at || '').replace('T', ' ') }}</td>
            <td>{{ l.system_name || l.system_code }}</td>
            <td><span class="tag" :class="l.mode === 'INCR' ? 'o' : 'b'">{{ l.mode === 'INCR' ? '增量' : '全量' }}</span></td>
            <td class="num">{{ l.pulled }}</td>
            <td class="num">{{ l.valid }}</td>
            <td class="num">{{ l.invalid }}</td>
            <td class="num">{{ l.batch_id ? '#' + l.batch_id : '—' }}</td>
            <td class="muted">{{ l.last_ts ? String(l.last_ts).replace('T', ' ') : '—' }}</td>
            <td><span class="tag" :class="l.skipped ? 's' : 'g'">{{ l.skipped ? '无增量' : '完成' }}</span></td>
            <td class="muted">{{ l.created_by }}</td>
          </tr>
          <tr v-if="!collectLogs.list.length"><td colspan="10" class="muted">暂无采集记录</td></tr>
        </tbody>
      </table>
    </div>

    <div v-else class="card">
      <div class="card-head">推送日志（最近 20 条）</div>
      <table class="tbl">
        <thead><tr><th>事件</th><th>订阅方</th><th>结果</th><th>耗时</th><th>信息</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="l in logs.list" :key="l.id">
            <td class="num">{{ l.event_no }}<div class="hint">{{ l.master_code }}</div></td>
            <td>{{ l.subscriber_name }}</td>
            <td><span class="tag" :class="l.success ? 'g' : 'r'">{{ l.success ? '成功' : '失败' }}</span></td>
            <td class="num">{{ l.duration_ms }}ms</td>
            <td class="muted">{{ l.message }}</td>
            <td class="muted">{{ String(l.created_at || '').replace('T', ' ') }}</td>
          </tr>
          <tr v-if="!logs.list.length"><td colspan="6" class="muted">暂无日志</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 采集源编辑 -->
    <el-dialog v-model="collectVisible" :title="collectForm.id ? '编辑采集源' : '新增采集源'" width="680px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>源系统编码</label><input v-model="collectForm.code" placeholder="SRC-XXX" style="width:100%" /></div>
        <div class="form-item req"><label>源系统名称</label><input v-model="collectForm.name" style="width:100%" /></div>
      </div>
      <div class="grid-form">
        <div class="form-item req"><label>目标数据域</label>
          <select v-model="collectForm.domainCode" style="width:100%">
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}（{{ d.code }}）</option>
          </select>
        </div>
        <div class="form-item req"><label>采集通道</label>
          <select v-model="collectForm.channel" style="width:100%">
            <option value="API">REST API 拉取</option>
            <option value="DB">数据库直连（SQLite）</option>
            <option value="FILE">文件（走主数据导入）</option>
          </select>
        </div>
      </div>
      <div v-if="collectForm.channel === 'DB'" class="grid-form">
        <div class="form-item req"><label>数据库文件路径（SQLite，只读直连）</label>
          <input v-model="collectForm.dbPath" placeholder="如 /data/erp.db（绝对路径或相对服务端目录）" style="width:100%" />
        </div>
        <div class="form-item req"><label>数据表名</label>
          <input v-model="collectForm.tableName" placeholder="如 t_material（仅字母、数字与下划线）" style="width:100%" />
        </div>
      </div>
      <div v-else-if="collectForm.channel === 'API'" class="grid-form">
        <div class="form-item req"><label>拉取地址</label><input v-model="collectForm.endpoint" placeholder="http://erp.example.com/api/materials" style="width:100%" /></div>
        <div class="form-item"><label>API Key</label><input v-model="collectForm.apiKey" placeholder="通过 X-Api-Key 头传递" style="width:100%" /></div>
      </div>
      <div class="form-item" style="margin-top:8px"><label>增量采集</label>
        <div class="flex" style="align-items:center;flex-wrap:wrap">
          <label class="hint" style="margin-right:14px">
            <input v-model="collectForm.incremental" type="checkbox" style="vertical-align:-2px" />
            按时间戳字段增量拉取（仅采集上次水位之后的新数据）
          </label>
          <template v-if="collectForm.incremental">
            <input v-model="collectForm.tsField" placeholder="时间戳字段名，如 updated_at" style="width:230px" />
            <span v-if="collectForm.id && lastTsOf(collectForm.id)" class="tag o" style="margin-left:8px">
              当前水位：{{ String(lastTsOf(collectForm.id)).replace('T', ' ') }}
            </span>
          </template>
        </div>
      </div>
      <div class="form-item req" style="margin-top:8px"><label>字段映射（源字段 → 主数据字段）</label>
        <div v-for="(fm, i) in collectForm.fieldMaps" :key="i" class="wf-cond" style="margin-top:4px">
          <input v-model="fm.source" placeholder="源字段，如 erp_name" style="flex:1" />
          <span style="color:#94a3b8">→</span>
          <select v-model="fm.target" style="flex:1">
            <option value="">— 目标字段 —</option>
            <option v-for="f in collectFields()" :key="f.field_key" :value="f.field_key">{{ f.label }}（{{ f.field_key }}）</option>
          </select>
          <span class="link" @click="collectForm.fieldMaps.splice(i, 1)">×</span>
        </div>
        <button class="btn sm" style="margin-top:6px" @click="collectForm.fieldMaps.push({ source: '', target: '' })">+ 添加映射</button>
      </div>
      <div class="form-item" style="margin-top:8px"><label>码值映射（选填，格式：原值=标准值，逗号分隔）</label>
        <div v-for="(vm, i) in collectForm.valueMaps" :key="i" class="wf-cond" style="margin-top:4px">
          <select v-model="vm.field" style="flex:1">
            <option value="">— 字段 —</option>
            <option v-for="f in collectForm.fieldMaps" :key="f.target" :value="f.target">{{ f.target }}</option>
          </select>
          <input v-model="vm.pairsText" placeholder="个=PCS, 件=EA" style="flex:1.6" />
          <span class="link" @click="collectForm.valueMaps.splice(i, 1)">×</span>
        </div>
        <button class="btn sm" style="margin-top:6px" @click="collectForm.valueMaps.push({ field: '', pairsText: '' })">+ 添加码值映射</button>
      </div>
      <div class="form-item" style="margin-top:8px"><label>清洗规则</label>
        <div class="flex">
          <label class="hint" style="margin-right:14px"><input v-model="collectForm.cleanRules" type="checkbox" value="trim" /> 去除首尾空格</label>
          <label class="hint"><input v-model="collectForm.cleanRules" type="checkbox" value="upper" /> 统一转大写</label>
        </div>
      </div>
      <template #footer>
        <button class="btn" @click="collectVisible = false">取消</button>
        <button class="btn primary" @click="saveCollect">保存</button>
      </template>
    </el-dialog>

    <!-- 采集结果 -->
    <el-dialog v-model="collectResultVisible" title="采集结果（导入批次）" width="680px" destroy-on-close>
      <template v-if="collectResult">
        <div class="cards-row" style="margin-bottom:10px">
          <div class="kpi"><div class="k-label">批次</div><div class="k-num">#{{ collectResult.id }}</div></div>
          <div class="kpi"><div class="k-label">总行数</div><div class="k-num">{{ collectResult.total }}</div></div>
          <div class="kpi"><div class="k-label">校验通过</div><div class="k-num" style="color:var(--ok)">{{ collectResult.valid }}</div></div>
          <div class="kpi"><div class="k-label">校验失败</div><div class="k-num" style="color:var(--err)">{{ collectResult.invalid }}</div></div>
        </div>
        <div style="max-height:300px;overflow:auto">
          <table class="tbl">
            <thead><tr><th>行号</th><th>结果</th><th>错误信息</th></tr></thead>
            <tbody>
              <tr v-for="r in collectResult.rows" :key="r.id">
                <td class="num">{{ r.row_no }}</td>
                <td><span class="tag" :class="r.valid ? 'g' : 'r'">{{ r.valid ? '通过' : '失败' }}</span></td>
                <td class="muted">{{ r.errors.join('；') || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="hint" style="margin-top:10px">
          {{ collectResult.statusLabel === '已提交'
            ? '该批次已提交入库，可在主数据维护列表查看（草稿状态）。'
            : `校验通过的行可直接提交入库为草稿（${collectResult.filename}），失败行需到源系统修正后重新采集。` }}
        </p>
      </template>
      <template #footer>
        <button class="btn" @click="collectResultVisible = false">关闭</button>
        <button
          v-if="collectResult.valid && collectResult.statusLabel !== '已提交'"
          class="btn primary"
          @click="commitCollect"
        >提交入库（{{ collectResult.valid }} 条）</button>
      </template>
    </el-dialog>

    <el-dialog v-model="subVisible" title="订阅方配置" width="560px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>订阅编码</label><input v-model="subForm.code" style="width:100%" /></div>
        <div class="form-item req"><label>订阅名称</label><input v-model="subForm.name" style="width:100%" /></div>
      </div>
      <div class="form-item req"><label>订阅主数据域</label>
        <div class="flex" style="flex-wrap:wrap">
          <label v-for="d in domains" :key="d.code" class="hint" style="margin-right:12px">
            <input v-model="subForm.domainCodes" type="checkbox" :value="d.code" /> {{ d.name }}
          </label>
        </div>
      </div>
      <div class="form-item req"><label>回调地址</label><input v-model="subForm.url" placeholder="https://..." style="width:100%" /></div>
      <div class="grid-form">
        <div class="form-item"><label>签名密钥</label><input v-model="subForm.secret" style="width:100%" /></div>
        <div class="form-item"><label>状态</label>
          <select v-model="subForm.status" style="width:100%"><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select>
        </div>
      </div>
      <template #footer>
        <button class="btn" @click="subVisible = false">取消</button>
        <button class="btn primary" @click="saveSub">保存</button>
      </template>
    </el-dialog>

    <el-drawer v-model="drawer" title="分发事件详情" size="620px" destroy-on-close>
      <template v-if="eventDetail">
        <div class="kv"><b>事件号</b><span>{{ eventDetail.event_no }}</span></div>
        <div class="kv"><b>主数据</b><span>{{ eventDetail.master_code }}</span></div>
        <div class="kv"><b>类型 / 状态</b><span>{{ EVENT_TYPE[eventDetail.event_type] }} / {{ STATUS[eventDetail.status] }}</span></div>
        <div class="kv"><b>订阅方</b><span>{{ eventDetail.subscriber_name }}</span></div>
        <h4 class="mt10">Payload</h4>
        <pre style="background:#f8fafc;border:1px solid var(--bd);border-radius:8px;padding:10px;font-size:12px;overflow:auto;max-height:320px">{{ JSON.stringify(eventDetail.payload, null, 2) }}</pre>
        <h4 class="mt10">推送日志</h4>
        <div class="tl">
          <div v-for="l in eventDetail.logs" :key="l.id" class="tl-item" :class="{ ok: l.success }">
            <div class="flex" style="justify-content:space-between">
              <b>{{ l.success ? '推送成功' : '推送失败' }}</b>
              <span class="hint">{{ l.duration_ms }}ms · {{ String(l.created_at || '').replace('T', ' ') }}</span>
            </div>
            <p class="hint">{{ l.message }}</p>
          </div>
          <p v-if="!eventDetail.logs.length" class="hint">尚未推送</p>
        </div>
      </template>
    </el-drawer>
  </div>
</template>
