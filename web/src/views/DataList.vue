<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import * as XLSX from 'xlsx';
import { importApi, masterApi, metaApi } from '../api';
import { useAuth } from '../stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuth();

const domains = ref<any[]>([]);
const domain = ref<string>((route.params.domain as string) || 'material');
const data = ref<any>({ list: [], total: 0, fields: [], dicts: {}, statusCounts: {} });
const loading = ref(false);
const filters = reactive<any>({ keyword: '', status: '', page: 1, size: 10 });
const queryFilters = reactive<Record<string, string>>({});

// ---------------- 树形视图（M5 层级模型） ----------------
const treeMode = ref(false);
const rowExpanded = ref<Record<number, boolean>>({});
const isTreeDomain = computed(() => !!data.value.model?.parentField);
const parentField = computed(() => data.value.model?.parentField || '');

/** 平铺模式直接渲染行；树形模式按层级字段组装树并展开为带缩进的行序列 */
const renderRows = computed(() => {
  const list: any[] = data.value.list || [];
  if (!treeMode.value || !isTreeDomain.value) {
    return list.map((r) => ({ row: r, depth: 0, hasChildren: false, expanded: false }));
  }
  const key = parentField.value;
  const byCode = new Map<string, any>();
  for (const r of list) if (r.master_code) byCode.set(String(r.master_code), r);
  const childrenOf = new Map<number, any[]>();
  const claimed = new Set<number>();
  for (const r of list) {
    const pv = r.data?.[key];
    const parent = pv ? byCode.get(String(pv)) : null;
    if (parent && parent.id !== r.id) {
      if (!childrenOf.has(parent.id)) childrenOf.set(parent.id, []);
      childrenOf.get(parent.id)!.push(r);
      claimed.add(r.id);
    }
  }
  const roots = list.filter((r) => !claimed.has(r.id));
  const out: Array<{ row: any; depth: number; hasChildren: boolean; expanded: boolean }> = [];
  const walk = (rows: any[], depth: number) => {
    for (const r of rows) {
      const kids = childrenOf.get(r.id) || [];
      const expanded = rowExpanded.value[r.id] !== false;
      out.push({ row: r, depth, hasChildren: kids.length > 0, expanded });
      if (kids.length && expanded) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
});

function toggleRow(id: number) {
  rowExpanded.value[id] = !(rowExpanded.value[id] !== false);
}

function toggleTreeMode() {
  treeMode.value = !treeMode.value;
  rowExpanded.value = {};
  filters.page = 1;
  load();
}

const importVisible = ref(false);
const step = ref(0);
const importForm = reactive<any>({ filename: '', content: '', batch: null as any, autoPublish: false });
const importLoading = ref(false);
const fileInput = ref<HTMLInputElement>();

const canCreate = computed(() => auth.has('master.create'));
const canImport = computed(() => auth.has('master.import'));
const canExport = computed(() => auth.has('master.export'));
const canLifecycle = computed(() => auth.has('master.lifecycle'));

// ---------------- 批量生命周期（M4） ----------------
const selected = ref<number[]>([]);
const allChecked = computed(() => {
  const ids = (data.value.list || []).map((r: any) => r.id);
  return ids.length > 0 && ids.every((id: number) => selected.value.includes(id));
});
function toggleAll() {
  const ids = (data.value.list || []).map((r: any) => r.id);
  if (allChecked.value) selected.value = selected.value.filter((id) => !ids.includes(id));
  else selected.value = Array.from(new Set([...selected.value, ...ids]));
}
function toggleOne(id: number) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id];
}
async function batchAction(action: 'freeze' | 'unfreeze' | 'archive') {
  if (!selected.value.length) return;
  const labels = { freeze: '冻结', unfreeze: '解冻', archive: '归档' } as any;
  try {
    await ElMessageBox.confirm(`确认对选中的 ${selected.value.length} 条数据执行「${labels[action]}」？`, '批量操作', { type: 'warning' });
  } catch { return; }
  const res = await masterApi.batchLifecycle(domain.value, { ids: selected.value, action });
  if (res.failed) ElMessage.warning(`批量${labels[action]}完成：成功 ${res.success} 条，失败 ${res.failed} 条`);
  else ElMessage.success(`批量${labels[action]}完成：${res.success} 条`);
  selected.value = [];
  await load();
}

const fields = computed(() => data.value.fields || []);
const dicts = computed(() => data.value.dicts || {});
const nameKey = computed(() => data.value.model?.nameKey || 'name');
const enumFields = computed(() => fields.value.filter((f: any) => f.type === 'ENUM' && f.query));

// ---------------- 列显隐（M9）：按数据域持久化到 localStorage ----------------
/** 除名称列外的全部动态字段（列显隐配置对象） */
const configFields = computed(() => fields.value.filter((f: any) => f.key !== nameKey.value));
const hiddenKeys = ref<string[] | null>(null); // null = 未配置（默认展示前 5 列）
function loadColCfg() {
  try {
    const saved = JSON.parse(localStorage.getItem(`mh-cols-${domain.value}`) || 'null');
    hiddenKeys.value = Array.isArray(saved) ? saved : null;
  } catch { hiddenKeys.value = null; }
}
function isColVisible(key: string) {
  if (hiddenKeys.value === null) return configFields.value.slice(0, 5).some((f: any) => f.key === key);
  return !hiddenKeys.value.includes(key);
}
function toggleCol(key: string) {
  const base = hiddenKeys.value === null
    ? configFields.value.slice(5).map((f: any) => f.key)
    : [...hiddenKeys.value];
  const idx = base.indexOf(key);
  if (idx >= 0) base.splice(idx, 1);
  else {
    if (configFields.value.length - base.length <= 1) { ElMessage.warning('至少保留一列'); return; }
    base.push(key);
  }
  hiddenKeys.value = base;
  localStorage.setItem(`mh-cols-${domain.value}`, JSON.stringify(base));
}
function resetCols() {
  hiddenKeys.value = null;
  localStorage.removeItem(`mh-cols-${domain.value}`);
}
const displayFields = computed(() => {
  if (hiddenKeys.value === null) return configFields.value.slice(0, 5);
  return configFields.value.filter((f: any) => !hiddenKeys.value!.includes(f.key));
});

function labelOf(f: any, v: any) {
  if (v === null || v === undefined || v === '') return '—';
  const d = dicts.value[f.dictCode];
  if (d) {
    const item = (d || []).find((i: any) => i.value === String(v));
    return item ? item.label : v;
  }
  return v;
}

function statusClass(s: string) {
  return 'tag st-' + s;
}

function statusLabel(s: string) {
  return { DRAFT: '草稿', PENDING: '审批中', CHANGING: '变更中', PUBLISHED: '已发布', FROZEN: '已冻结', ARCHIVED: '已归档' }[s] || s;
}

async function load() {
  loading.value = true;
  try {
    const params: any = { ...filters, ...queryFilters };
    if (treeMode.value && isTreeDomain.value) params.tree = 1;
    Object.keys(params).forEach((k) => {
      if (params[k] === '' || params[k] === undefined) delete params[k];
    });
    data.value = await masterApi.list(domain.value, params);
  } catch { /* ignore */ } finally {
    loading.value = false;
  }
}

async function loadDomains() {
  const res = await metaApi.domains();
  domains.value = (res || []).filter((d: any) => auth.domains.length === 0 || auth.domains.includes(d.code));
  const visible = res || [];
  if (!visible.find((d: any) => d.code === domain.value)) domain.value = visible[0]?.code || 'material';
}

watch([() => filters.status, () => filters.page, () => filters.size], load);
watch(domain, (v) => {
  filters.page = 1;
  treeMode.value = false;
  loadColCfg();
  router.replace(`/data/${v}`);
  Object.keys(queryFilters).forEach((k) => delete queryFilters[k]);
  load();
});
watch(() => route.params.domain, (v) => {
  if (v && v !== domain.value) domain.value = v as string;
});

function search() {
  filters.page = 1;
  load();
}

function create() {
  router.push(`/data/${domain.value}/new`);
}

function open(row: any) {
  router.push(`/data/${domain.value}/${row.id}`);
}

async function doExport() {
  const res = await masterApi.exportCsv(domain.value, { ...filters, ...queryFilters });
  const blob = new Blob(['\uFEFF' + res.content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = res.filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** M9：导出 Excel（.xlsx）——服务端生成 CSV（含码值翻译），前端 SheetJS 转为 xlsx 工作簿 */
async function doExportXlsx() {
  const res = await masterApi.exportCsv(domain.value, { ...filters, ...queryFilters });
  const wb = XLSX.read(res.content, { type: 'string' });
  wb.SheetNames.forEach((n) => { (wb.Sheets[n] as any)['!cols'] = []; });
  XLSX.writeFile(wb, res.filename.replace(/\.csv$/, '.xlsx'));
}

function openImport() {
  step.value = 0;
  importForm.filename = '';
  importForm.content = '';
  importForm.batch = null;
  importForm.autoPublish = false;
  importVisible.value = true;
}

async function downloadTemplate() {
  const res = await importApi.template(domain.value);
  const blob = new Blob(['\uFEFF' + res.content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = res.filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** M9：下载 Excel 导入模板（首行字段名称，第二行字段 key 说明） */
async function downloadTemplateXlsx() {
  const res = await importApi.template(domain.value);
  const wb = XLSX.read(res.content, { type: 'string' });
  XLSX.writeFile(wb, res.filename.replace(/\.csv$/, '.xlsx'));
}

function pickFile() {
  fileInput.value?.click();
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    // Excel：前端解析为 CSV 文本后走统一校验链路
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        importForm.filename = file.name;
        importForm.content = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        ElMessage.success(`已解析 Excel 工作表「${wb.SheetNames[0]}」，共 ${wb.SheetNames.length} 个表`);
      } catch {
        ElMessage.error('Excel 解析失败，请另存为 CSV 后重试');
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = () => {
      importForm.filename = file.name;
      importForm.content = String(reader.result || '');
    };
    reader.readAsText(file, 'utf-8');
  }
  input.value = '';
}

/** 校验失败行明细导出（CSV，前端生成） */
function exportErrorRows() {
  const batch = importForm.batch;
  const bad = (batch?.rows || []).filter((r: any) => !r.valid);
  if (!bad.length) {
    ElMessage.info('本批次没有校验失败的行');
    return;
  }
  const keys: string[] = [];
  for (const r of bad) {
    Object.keys(r.data || {}).forEach((k) => { if (!keys.includes(k)) keys.push(k); });
  }
  const q = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['行号', ...keys, '错误信息'].map(q).join(',')];
  for (const r of bad) {
    lines.push([r.row_no, ...keys.map((k) => r.data?.[k] ?? ''), r.errors.join('；')].map(q).join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `导入错误明细-批次${batch.id}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function validateImport() {
  if (!importForm.content.trim()) {
    ElMessage.warning('请上传 CSV 文件或粘贴数据');
    return;
  }
  importLoading.value = true;
  try {
    importForm.batch = await importApi.validate(domain.value, {
      filename: importForm.filename || '手动粘贴.csv',
      content: importForm.content,
    });
    step.value = 1;
  } catch { /* ignore */ } finally {
    importLoading.value = false;
  }
}

async function commitImport() {
  importLoading.value = true;
  try {
    importForm.batch = await importApi.commit(importForm.batch.id, { autoPublish: importForm.autoPublish });
    step.value = 2;
    ElMessage.success('导入提交完成');
    load();
  } catch { /* ignore */ } finally {
    importLoading.value = false;
  }
}

onMounted(async () => {
  await loadDomains();
  loadColCfg();
  // 顶栏全局搜索带入的关键字
  const kw = String(route.query.kw || '').trim();
  if (kw) filters.keyword = kw;
  load();
});
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>主数据维护</h2>
        <p class="desc">按元数据模型动态生成的查询、新增、导入与生命周期管理</p>
      </div>
      <div class="flex">
        <button v-if="canImport" class="btn" @click="openImport">批量导入</button>
        <button v-if="canExport" class="btn" @click="doExport">导出 CSV</button>
        <button v-if="canExport" class="btn" @click="doExportXlsx">导出 Excel</button>
        <button v-if="canCreate" class="btn primary" @click="create">新增</button>
      </div>
    </div>

    <div class="tabs">
      <div
        v-for="d in domains"
        :key="d.code"
        class="tab"
        :class="{ active: domain === d.code }"
        @click="domain = d.code"
      >
        {{ d.name }}
      </div>
    </div>

      <div class="card">
      <div class="fbar" style="padding:12px 16px 0">
        <div class="f-item">
          <input v-model="filters.keyword" placeholder="搜索名称 / 编码" style="width:200px" @keyup.enter="search" />
        </div>
        <div class="f-item">
          <select v-model="filters.status">
            <option value="">全部状态</option>
            <option value="PUBLISHED">已发布（{{ (data.statusCounts || {}).PUBLISHED || 0 }}）</option>
            <option value="DRAFT">草稿（{{ (data.statusCounts || {}).DRAFT || 0 }}）</option>
            <option value="PENDING">审批中（{{ (data.statusCounts || {}).PENDING || 0 }}）</option>
            <option value="CHANGING">变更中（{{ (data.statusCounts || {}).CHANGING || 0 }}）</option>
            <option value="FROZEN">已冻结（{{ (data.statusCounts || {}).FROZEN || 0 }}）</option>
            <option value="ARCHIVED">已归档</option>
          </select>
        </div>
        <div v-for="f in enumFields" :key="f.key" class="f-item">
          <label>{{ f.label }}</label>
          <select v-model="queryFilters[f.key]">
            <option value="">全部</option>
            <option v-for="i in (dicts[f.dictCode] || [])" :key="i.value" :value="i.value">{{ i.label }}</option>
          </select>
        </div>
        <button class="btn primary sm" @click="search">查询</button>
        <button class="btn sm" @click="filters.keyword = ''; filters.status = ''; Object.keys(queryFilters).forEach(k => delete queryFilters[k]); search()">重置</button>
        <el-popover placement="bottom-start" :width="280" trigger="click">
          <template #reference>
            <button class="btn sm" @click="loadColCfg">列显隐</button>
          </template>
          <div style="max-height:260px;overflow:auto">
            <label v-for="f in configFields" :key="f.key" style="display:block;margin:5px 0;font-size:12px">
              <input type="checkbox" :checked="isColVisible(f.key)" @change="toggleCol(f.key)" /> {{ f.label }}（{{ f.key }}）
            </label>
          </div>
          <div style="margin-top:8px;border-top:1px solid #e2e8f0;padding-top:8px;text-align:right">
            <button class="btn sm" @click="resetCols">恢复默认（前 5 列）</button>
          </div>
        </el-popover>
        <button v-if="isTreeDomain" class="btn sm" @click="toggleTreeMode">{{ treeMode ? '切为平铺视图' : '切为树形视图' }}</button>
        <template v-if="canLifecycle && selected.length">
          <span class="hint" style="margin-left:10px">已选 {{ selected.length }} 条</span>
          <button class="btn sm" @click="batchAction('freeze')">批量冻结</button>
          <button class="btn sm" @click="batchAction('unfreeze')">批量解冻</button>
          <button class="btn sm" @click="batchAction('archive')">批量归档</button>
        </template>
      </div>

      <table class="tbl">
        <thead>
          <tr>
            <th v-if="canLifecycle" style="width:34px"><input type="checkbox" :checked="allChecked" @change="toggleAll" /></th>
            <th>编码</th>
            <th v-for="f in displayFields" :key="f.key">{{ f.label }}</th>
            <th>状态</th>
            <th>版本</th>
            <th>更新时间</th>
            <th style="width:120px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rr in renderRows" :key="rr.row.id">
            <td v-if="canLifecycle"><input type="checkbox" :checked="selected.includes(rr.row.id)" @change="toggleOne(rr.row.id)" /></td>
            <td class="num" :style="{ paddingLeft: 6 + rr.depth * 18 + 'px' }">
              <span
                v-if="rr.hasChildren"
                class="link"
                style="display:inline-block;width:16px;color:#999"
                @click="toggleRow(rr.row.id)"
              >{{ rr.expanded ? '▾' : '▸' }}</span>
              <span v-else style="display:inline-block;width:16px"></span>
              <span class="link" @click="open(rr.row)">{{ rr.row.master_code || '（未生成）' }}</span>
            </td>
            <td v-for="f in displayFields" :key="f.key">
              {{ f.key === nameKey ? rr.row.name : labelOf(f, rr.row.data ? rr.row.data[f.key] : rr.row[f.key]) }}
            </td>
            <td><span :class="statusClass(rr.row.status)">{{ statusLabel(rr.row.status) }}</span></td>
            <td class="num">v{{ rr.row.version }}</td>
            <td class="muted">{{ String(rr.row.updated_at || '').replace('T', ' ').slice(5, 16) }}</td>
            <td>
              <span class="link" @click="open(rr.row)">查看</span>
              <span v-if="canCreate" class="link" @click="router.push(`/data/${domain}/${rr.row.id}`)">维护</span>
            </td>
          </tr>
          <tr v-if="!loading && !data.list.length">
            <td :colspan="displayFields.length + 4" class="muted">暂无数据{{ filters.keyword || filters.status ? '（当前筛选条件无匹配）' : '' }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="!treeMode" class="pgn" style="padding:10px 16px 14px">
        <span>共 {{ data.total }} 条</span>
        <button :disabled="filters.page <= 1" @click="filters.page--">‹</button>
        <button class="cur">{{ filters.page }}</button>
        <button :disabled="filters.page * filters.size >= data.total" @click="filters.page++">›</button>
        <select v-model.number="filters.size" style="border:1px solid var(--bd);border-radius:5px;padding:2px 4px">
          <option :value="10">10/页</option>
          <option :value="20">20/页</option>
          <option :value="50">50/页</option>
        </select>
      </div>
      <div v-else class="pgn" style="padding:10px 16px 14px">
        <span>树形视图 · 共 {{ data.total }} 条（按「{{ data.parentField?.label || '上级' }}」层级展示，最多加载 2000 条）</span>
      </div>
    </div>

    <el-dialog v-model="importVisible" title="批量导入" width="720px" destroy-on-close>
      <div class="steps">
        <div class="step" :class="{ on: step === 0, done: step > 0 }"><i>1</i>上传数据</div>
        <div class="step" :class="{ on: step === 1, done: step > 1 }"><i>2</i>预校验结果</div>
        <div class="step" :class="{ on: step === 2 }"><i>3</i>提交入库</div>
      </div>

      <div v-if="step === 0">
        <div class="card-body" style="padding:0">
          <p class="hint">1. 下载模板并填写；2. 上传 CSV / Excel 文件或直接粘贴内容（首行为字段名称，Excel 取第一个工作表）。</p>
          <div class="flex mt10">
            <button class="btn" @click="downloadTemplate">下载 CSV 模板</button>
            <button class="btn" @click="downloadTemplateXlsx">下载 Excel 模板</button>
            <button class="btn" @click="pickFile">选择文件（CSV / Excel）</button>
            <input ref="fileInput" type="file" accept=".csv,.xlsx,.xls,text/csv" style="display:none" @change="onFile" />
            <span class="muted">{{ importForm.filename }}</span>
          </div>
          <textarea
            v-model="importForm.content"
            rows="10"
            style="width:100%;margin-top:10px;border:1px solid var(--bd);border-radius:6px;padding:8px;font-family:inherit;font-size:12px"
            placeholder="物料名称,规格型号,计量单位,物料分类,..."
          />
        </div>
      </div>

      <div v-else-if="step === 1 && importForm.batch">
        <div class="cards-row" style="margin-bottom:10px">
          <div class="kpi"><div class="k-label">总行数</div><div class="k-num">{{ importForm.batch.total }}</div></div>
          <div class="kpi"><div class="k-label">校验通过</div><div class="k-num" style="color:var(--ok)">{{ importForm.batch.valid }}</div></div>
          <div class="kpi"><div class="k-label">校验失败</div><div class="k-num" style="color:var(--err)">{{ importForm.batch.invalid }}</div></div>
        </div>
        <div style="max-height:300px;overflow:auto">
          <table class="tbl">
            <thead><tr><th>行号</th><th>结果</th><th>错误信息</th></tr></thead>
            <tbody>
              <tr v-for="r in importForm.batch.rows" :key="r.id">
                <td class="num">{{ r.row_no }}</td>
                <td><span class="tag" :class="r.valid ? 'g' : 'r'">{{ r.valid ? '通过' : '失败' }}</span></td>
                <td class="muted">{{ r.errors.join('；') || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex mt10" style="justify-content:space-between">
          <label class="hint"><input v-model="importForm.autoPublish" type="checkbox" style="vertical-align:-2px" /> 通过后自动提交审批</label>
          <button v-if="importForm.batch.invalid" class="btn sm" @click="exportErrorRows">导出错误行（{{ importForm.batch.invalid }}）</button>
        </div>
      </div>

      <div v-else-if="step === 2 && importForm.batch">
        <div class="card-body" style="text-align:center;padding:24px">
          <div style="font-size:18px;font-weight:700;color:var(--ok)">导入提交完成</div>
          <p class="muted" style="margin-top:6px">
            成功写入 {{ importForm.batch.valid }} 条{{ importForm.autoPublish ? '，并已提交审批' : '，状态为草稿' }}。
          </p>
        </div>
      </div>

      <template #footer>
        <button v-if="step === 0" class="btn" @click="importVisible = false">取消</button>
        <button v-if="step === 0" class="btn primary" :disabled="importLoading" @click="validateImport">开始校验</button>
        <button v-if="step === 1" class="btn" @click="step = 0">返回修改</button>
        <button v-if="step === 1" class="btn primary" :disabled="importLoading || !importForm.batch.valid" @click="commitImport">提交入库</button>
        <button v-if="step === 2" class="btn primary" @click="importVisible = false">完成</button>
      </template>
    </el-dialog>
  </div>
</template>
