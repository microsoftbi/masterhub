<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { masterApi, metaApi, approvalApi } from '../api';
import { useAuth } from '../stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuth();

const domain = ref<string>(String(route.params.domain || 'material'));
const key = ref<string>(String(route.params.key || ''));
const isNew = computed(() => !key.value || key.value === 'new');

const loading = ref(true);
const saving = ref(false);
const tab = ref('info');
const domainInfo = ref<any>(null);
const modelInfo = ref<any>(null);
const detail = ref<any>(null);
const versions = ref<any[]>([]);
const dictMap = reactive<Record<string, any[]>>({});
const form = reactive<Record<string, any>>({});
const dupList = ref<any[]>([]);
const dupLoading = ref(false);

const mergeVisible = ref(false);
const mergeCandidates = reactive<any[]>([]);
const mergeIds = ref<number[]>([]);
const mergeKeyword = ref('');

const canEdit = computed(() => auth.has('master.edit') || auth.has('master.create'));
const canSubmit = computed(() => auth.has('master.submit'));
const canLifecycle = computed(() => auth.has('master.lifecycle'));
const canMerge = computed(() => auth.has('master.merge'));

const fields = computed<any[]>(() => {
  if (detail.value?.fields?.length) {
    return detail.value.fields.map((f: any) => ({
      field_key: f.key, label: f.label, type: f.type, dict_code: f.dictCode, required: f.required,
    }));
  }
  return modelInfo.value?.fields || [];
});

const status = computed(() => detail.value?.status || 'DRAFT');
const statusLabel = computed(
  () => ({ DRAFT: '草稿', PENDING: '审批中', CHANGING: '变更中', PUBLISHED: '已发布', FROZEN: '已冻结', ARCHIVED: '已归档' }[status.value] || status.value),
);
const readonly = computed(() => isNew.value ? false : ['PENDING', 'CHANGING', 'FROZEN', 'ARCHIVED'].includes(status.value));
const draftEditable = computed(() => isNew.value || status.value === 'DRAFT');
const pendingApproval = computed(() => detail.value?.approval || null);

const fieldLabels = computed(() => {
  const map: Record<string, string> = {};
  for (const f of fields.value) map[f.field_key] = f.label;
  return map;
});

function dictItems(code?: string) {
  return (code && dictMap[code]) || [];
}

function labelValue(f: any, v: any) {
  if (v === null || v === undefined || v === '') return '—';
  if (f.dict_code) {
    const it = dictItems(f.dict_code).find((x) => String(x.value) === String(v));
    return it?.label || v;
  }
  if (f.type === 'BOOL') return v ? '是' : '否';
  return v;
}

function fillForm(data: any, fs: any[]) {
  Object.keys(form).forEach((k) => delete form[k]);
  for (const f of fs) {
    let v = data?.[f.field_key];
    if (v === undefined || v === null) v = f.type === 'BOOL' ? false : '';
    form[f.field_key] = v;
  }
}

async function loadDicts(fs: any[]) {
  const codes = Array.from(new Set(fs.map((f: any) => f.dict_code).filter(Boolean)));
  await Promise.all(codes.map(async (code: any) => {
    try {
      const res = await metaApi.dictItems(code);
      dictMap[code] = res.items || [];
    } catch { /* 忽略单个码表异常 */ }
  }));
}

async function loadMeta() {
  const domains = await metaApi.domains();
  domainInfo.value = (domains || []).find((d: any) => d.code === domain.value) || null;
  if (domainInfo.value?.model?.id) {
    modelInfo.value = await metaApi.model(domainInfo.value.model.id);
  }
}

async function load() {
  loading.value = true;
  try {
    await loadMeta();
    if (!isNew.value) {
      dedupeDomain();
      detail.value = await masterApi.detail(domain.value, key.value);
      fillForm(detail.value.data, fields.value);
      const v = await masterApi.versions(domain.value, key.value);
      versions.value = v.list || [];
    } else {
      fillForm({}, modelInfo.value?.fields || []);
      detail.value = null;
      versions.value = [];
    }
    await loadDicts(fields.value);
  } catch (e: any) {
    ElMessage.error(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

/** detail.fields 查重接口按 excludeId 排除自身 */
function dedupeDomain() { dupList.value = []; }

async function checkDup() {
  dupLoading.value = true;
  try {
    const res = await masterApi.checkDup(domain.value, {
      data: { ...form },
      excludeId: isNew.value ? undefined : detail.value?.id,
    });
    dupList.value = res.list || [];
    if (dupList.value.length) ElMessage.warning(`发现 ${dupList.value.length} 条疑似重复数据`);
    else ElMessage.success('未发现重复数据');
  } catch { /* 接口已提示 */ } finally {
    dupLoading.value = false;
  }
}

async function save(submitAfter = false) {
  if (!canEdit.value) { ElMessage.warning('无编辑权限'); return; }
  // 提交审批前先选择抄送人（可跳过）
  let ccUserIds: number[] | null | undefined;
  if (submitAfter) {
    ccUserIds = await askCc();
    if (ccUserIds === null) return;
  }
  saving.value = true;
  try {
    let res: any;
    if (isNew.value) {
      res = await masterApi.create(domain.value, { data: { ...form }, submit: submitAfter, ccUserIds });
      ElMessage.success(submitAfter ? '已创建并提交审批' : '草稿已保存');
      router.replace(`/data/${domain.value}/${res.id}`);
    } else {
      res = await masterApi.update(domain.value, key.value, { data: { ...form }, submit: submitAfter, ccUserIds });
      if (status.value === 'PUBLISHED') ElMessage.success('变更已提交审批');
      else ElMessage.success(submitAfter ? '已提交审批' : '草稿已保存');
      key.value = String(res.id);
      detail.value = res;
      fillForm(res.data, fields.value);
      versions.value = (await masterApi.versions(domain.value, key.value)).list || [];
    }
  } catch { /* 接口已提示 */ } finally {
    saving.value = false;
  }
}

// ---------------- 提交审批抄送人（M6） ----------------
const ccVisible = ref(false);
const ccCandidates = ref<any[]>([]);
const ccSelected = ref<number[]>([]);
let ccResolve: ((v: number[] | null) => void) | null = null;

/** 打开抄送人选择对话框，resolve：null=取消，[]=不抄送，[ids]=抄送所选 */
function askCc(): Promise<number[] | null> {
  return new Promise((resolve) => {
    ccResolve = resolve;
    ccSelected.value = [];
    ccVisible.value = true;
    if (!ccCandidates.value.length) {
      approvalApi.ccUsers().then((list: any) => { ccCandidates.value = list || []; }).catch(() => { /* 无权限则仅跳过抄送 */ });
    }
  });
}

function confirmCc(cancel = false) {
  ccVisible.value = false;
  ccResolve?.(cancel ? null : [...ccSelected.value]);
  ccResolve = null;
}

async function doSubmit() {
  const ccUserIds = await askCc();
  if (ccUserIds === null) return;
  const res = await masterApi.submit(domain.value, key.value, { ccUserIds });
  detail.value = res;
  fillForm(res.data, fields.value);
  ElMessage.success(ccUserIds.length ? `已提交审批，抄送 ${ccUserIds.length} 人` : '已提交审批');
}

async function lifecycle(action: 'freeze' | 'unfreeze' | 'archive') {
  const text = { freeze: '冻结后该数据将不可变更，确认冻结？', unfreeze: '确认解冻该数据？', archive: '归档后该数据将退出业务使用，确认归档？' }[action];
  await ElMessageBox.confirm(text, '状态变更', { type: 'warning' });
  const res = await masterApi.lifecycle(domain.value, key.value, action);
  detail.value = res;
  ElMessage.success('状态已更新');
}

async function searchMerge() {
  const res = await masterApi.list(domain.value, { keyword: mergeKeyword.value, size: 20, all: 1 });
  mergeCandidates.length = 0;
  for (const r of res.list || []) {
    if (r.id !== detail.value?.id) mergeCandidates.push(r);
  }
}

async function openMerge() {
  if (!detail.value?.master_code) { ElMessage.warning('金数据尚未发布，无法合并'); return; }
  mergeIds.value = [];
  mergeKeyword.value = detail.value.name || '';
  mergeVisible.value = true;
  await searchMerge();
}

async function doMerge() {
  if (!mergeIds.value.length) { ElMessage.warning('请选择需合并的数据'); return; }
  await ElMessageBox.confirm(`将 ${mergeIds.value.length} 条数据合并到当前记录（合并后源数据归档）？`, '合并确认', { type: 'warning' });
  const res = await masterApi.merge(domain.value, { goldId: detail.value.id, mergeIds: mergeIds.value });
  mergeVisible.value = false;
  detail.value = res.gold;
  key.value = String(res.gold.id);
  versions.value = (await masterApi.versions(domain.value, key.value)).list || [];
  ElMessage.success(`已合并 ${res.mergedCount} 条`);
}

function diffRows(diff: Record<string, any>) {
  if (!diff) return [];
  return Object.entries(diff).map(([k, v]) => ({ key: k, label: fieldLabels.value[k] || k, old: (v as any).old, new: (v as any).new }));
}

/** M4：回滚到历史版本（草稿直接覆盖；已发布数据以历史内容发起变更审批） */
async function rollbackTo(v: any) {
  try {
    await ElMessageBox.confirm(
      `确认将数据回滚到 v${v.version}？${detail.value.status === 'PUBLISHED' ? '已发布数据将以该版本内容发起变更审批。' : '当前草稿将被该版本内容覆盖。'}`,
      '版本回滚',
      { type: 'warning', confirmButtonText: '确认回滚', cancelButtonText: '取消' },
    );
  } catch { return; }
  await masterApi.rollback(domain.value, key.value, { version: v.version });
  ElMessage.success(`已回滚到 v${v.version}（${detail.value.status === 'PUBLISHED' ? '变更审批已发起' : '草稿已更新'}）`);
  await load();
  tab.value = 'info';
}

function back() {
  router.push(`/data/${domain.value}`);
}

watch(() => route.params.key, (v) => {
  if (v && String(v) !== key.value) { key.value = String(v); load(); }
});
watch(tab, async (v) => {
  if (v === 'versions' && !isNew.value && !versions.value.length) {
    versions.value = (await masterApi.versions(domain.value, key.value)).list || [];
  }
});

onMounted(load);
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>
          {{ isNew ? '新增' : '维护' }}{{ domainInfo?.name || '主数据' }}
          <span v-if="!isNew" class="tag ml8" :class="'st-' + status">{{ statusLabel }}</span>
          <span v-if="!isNew && detail?.master_code" class="muted" style="font-size:12px;margin-left:8px">{{ detail.master_code }} · v{{ detail.version }}</span>
        </h2>
        <p class="desc">{{ isNew ? '填写字段后保存草稿，或直接提交审批' : '修改已发布数据将自动发起变更审批' }}</p>
      </div>
      <div class="flex">
        <button class="btn" @click="back">返回列表</button>
        <button v-if="!isNew" class="btn" :disabled="dupLoading" @click="checkDup">查重</button>
        <button v-if="!isNew && canMerge && status === 'PUBLISHED'" class="btn" @click="openMerge">合并</button>
        <button v-if="draftEditable && canEdit" class="btn" :disabled="saving" @click="save(false)">保存草稿</button>
        <button v-if="draftEditable && canEdit && canSubmit" class="btn primary" :disabled="saving" @click="save(true)">保存并提交</button>
        <button v-if="status === 'PUBLISHED' && canEdit && canSubmit" class="btn primary" :disabled="saving" @click="save(true)">提交变更</button>
        <button v-if="!isNew && status === 'DRAFT' && canSubmit" class="btn primary" @click="doSubmit">提交审批</button>
        <button v-if="!isNew && status === 'PUBLISHED' && canLifecycle" class="btn" @click="lifecycle('freeze')">冻结</button>
        <button v-if="!isNew && status === 'FROZEN' && canLifecycle" class="btn" @click="lifecycle('unfreeze')">解冻</button>
        <button v-if="!isNew && ['PUBLISHED', 'FROZEN'].includes(status) && canLifecycle" class="btn danger" @click="lifecycle('archive')">归档</button>
      </div>
    </div>

    <div class="tabs">
      <div class="tab" :class="{ active: tab === 'info' }" @click="tab = 'info'">基本信息</div>
      <div v-if="!isNew" class="tab" :class="{ active: tab === 'versions' }" @click="tab = 'versions'">版本历史（{{ detail?.versionCount || versions.length }}）</div>
      <div v-if="!isNew" class="tab" :class="{ active: tab === 'dup' }" @click="tab = 'dup'">查重与合并</div>
    </div>

    <div v-if="loading" class="card"><div class="card-body muted">加载中…</div></div>

    <template v-else>
      <div v-if="pendingApproval" class="card" style="margin-bottom:12px;border-color:#fde68a;background:#fffbeb">
        <div class="card-body">
          <div class="flex" style="justify-content:space-between">
            <b>审批中：{{ pendingApproval.title }}</b>
            <span class="tag o">{{ pendingApproval.status === 'RUNNING' ? '审批流转中' : pendingApproval.status }}</span>
          </div>
          <p class="hint mt10">申请人 {{ pendingApproval.applicant_name }} · 当前节点 {{ pendingApproval.current_node || '—' }}</p>
          <table v-if="pendingApproval.diff" class="tbl diff mt10">
            <thead><tr><th>字段</th><th>当前值</th><th>申请变更值</th></tr></thead>
            <tbody>
              <tr v-for="d in diffRows(pendingApproval.diff)" :key="d.key">
                <td>{{ d.label }}</td><td class="old">{{ d.old ?? '—' }}</td><td class="new">{{ d.new ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div class="mt10"><span class="link" @click="router.push('/approval')">前往审批中心处理 ›</span></div>
        </div>
      </div>

      <div v-if="tab === 'info'" class="card">
        <div class="card-head">
          <span>{{ isNew ? '字段录入' : '数据字段' }}</span>
          <span v-if="detail?.maskedFields?.length" class="hint">含 {{ detail.maskedFields.length }} 个脱敏字段</span>
        </div>
        <div class="card-body">
          <div class="grid-form">
            <div v-for="f in fields" :key="f.field_key" class="form-item" :class="{ req: f.required }">
              <label>{{ f.label }}<span class="hint" style="margin-left:6px">{{ f.field_key }}</span></label>
              <select v-if="f.type === 'ENUM'" v-model="form[f.field_key]" :disabled="readonly" style="width:100%">
                <option value="">请选择</option>
                <option v-for="i in dictItems(f.dict_code)" :key="i.value" :value="i.value">{{ i.label }}（{{ i.value }}）</option>
              </select>
              <select v-else-if="f.type === 'BOOL'" v-model="form[f.field_key]" :disabled="readonly" style="width:100%">
                <option :value="true">是</option>
                <option :value="false">否</option>
              </select>
              <input v-else-if="f.type === 'DATE'" v-model="form[f.field_key]" type="date" :disabled="readonly" style="width:100%" />
              <input v-else-if="f.type === 'NUMBER'" v-model.number="form[f.field_key]" type="number" :disabled="readonly" :placeholder="f.placeholder || '请输入数字'" style="width:100%" />
              <input v-else v-model="form[f.field_key]" :disabled="readonly" :placeholder="f.type === 'REF' ? `引用 ${f.ref_domain || ''} 主数据编码` : (f.placeholder || '请输入')" style="width:100%" />
              <p v-if="f.type === 'REF'" class="hint">填写被引用数据的主数据编码（master_code）</p>
            </div>
          </div>
          <p v-if="!fields.length" class="muted">该数据域尚未发布元数据模型</p>

          <div v-if="dupList.length" class="card mt10" style="border-color:#fecaca">
            <div class="card-head" style="color:var(--err)">疑似重复数据（{{ dupList.length }}）</div>
            <table class="tbl">
              <thead><tr><th>编码</th><th>名称</th><th>相似度</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="d in dupList" :key="d.id">
                  <td class="num">{{ d.master_code || d.id }}</td>
                  <td>{{ d.name }}</td>
                  <td class="num">{{ Math.round(d.score * 100) }}%<span v-if="d.exact" class="tag r ml8">精确命中</span></td>
                  <td>{{ d.status_label }}</td>
                  <td><span class="link" @click="router.push(`/data/${domain}/${d.id}`)">查看</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="!isNew" class="mt10">
            <div class="kv"><b>创建时间</b><span>{{ String(detail?.created_at || '').replace('T', ' ') }}</span></div>
            <div class="kv"><b>更新时间</b><span>{{ String(detail?.updated_at || '').replace('T', ' ') }}</span></div>
            <div v-if="detail?.mergeOf" class="kv"><b>合并来源</b><span>{{ detail.mergeOf.merged_codes }} → {{ detail.mergeOf.gold_code }}（{{ detail.mergeOf.operator }}）</span></div>
          </div>
        </div>
      </div>

      <div v-else-if="tab === 'versions'" class="card">
        <div class="card-head">版本历史</div>
        <div class="card-body">
          <div class="tl">
            <div v-for="(v, idx) in versions" :key="v.id" class="tl-item" :class="{ cur: idx === 0, ok: v.action === 'CREATE' }">
              <div class="flex" style="justify-content:space-between">
                <b>v{{ v.version }} · {{ { CREATE: '创建发布', UPDATE: '变更生效', MERGE: '合并' }[v.action] || v.action }}</b>
                <span class="muted">{{ String(v.created_at || '').replace('T', ' ') }}</span>
              </div>
              <p class="hint">操作人 {{ v.operator || '—' }}<span v-if="v.instance_id"> · 审批实例 #{{ v.instance_id }}</span></p>
              <div v-if="idx > 0 && v.version < detail.version && canEdit && !['PENDING', 'CHANGING'].includes(detail.status)" style="margin-top:4px">
                <span class="link" @click="rollbackTo(v)">回滚到此版本</span>
              </div>
              <table v-if="v.diff && Object.keys(v.diff).length" class="tbl diff mt10">
                <thead><tr><th>字段</th><th>原值</th><th>新值</th></tr></thead>
                <tbody>
                  <tr v-for="(val, k) in v.diff" :key="k">
                    <td>{{ fieldLabels[k] || v.diffLabels?.[k] || k }}</td>
                    <td class="old">{{ val.old ?? '—' }}</td>
                    <td class="new">{{ val.new ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="hint mt10">初始版本，无字段差异</p>
            </div>
          </div>
          <p v-if="!versions.length" class="muted">暂无版本记录</p>
        </div>
      </div>

      <div v-else class="grid-2">
        <div class="card">
          <div class="card-head">
            <span>查重结果</span>
            <button class="btn sm" :disabled="dupLoading" @click="checkDup">重新检查</button>
          </div>
          <div class="card-body">
            <table class="tbl">
              <thead><tr><th>编码</th><th>名称</th><th>相似度</th><th>匹配字段</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="d in dupList" :key="d.id">
                  <td class="num">{{ d.master_code || d.id }}</td>
                  <td>{{ d.name }}</td>
                  <td class="num">{{ Math.round(d.score * 100) }}%</td>
                  <td class="muted">{{ (d.matchedFields || []).map((k: string) => fieldLabels[k] || k).join('、') }}</td>
                  <td>{{ d.status_label }}</td>
                </tr>
                <tr v-if="!dupList.length"><td colspan="5" class="muted">暂无查重结果，点击「重新检查」</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-head">合并说明</div>
          <div class="card-body">
            <p class="hint">以当前记录为金数据，将选中记录的核心字段合并后归档源数据，并生成合并日志与新版本。</p>
            <div class="kv"><b>当前记录</b><span>{{ detail?.master_code || '未发布' }}</span></div>
            <div class="kv"><b>合并记录数</b><span>{{ detail?.mergeOf ? 1 : 0 }}</span></div>
            <button class="btn primary mt10" :disabled="!canMerge || status !== 'PUBLISHED'" @click="openMerge">发起合并</button>
          </div>
        </div>
      </div>
    </template>

    <el-dialog v-model="mergeVisible" title="合并重复数据" width="720px" destroy-on-close>
      <p class="hint">当前记录为金数据：{{ detail?.master_code }} · {{ detail?.name }}（保留当前字段值）</p>
      <div class="flex mt10">
        <input v-model="mergeKeyword" placeholder="搜索待合并数据" style="width:220px" @keyup.enter="searchMerge" />
        <button class="btn sm" @click="searchMerge">查询</button>
      </div>
      <div style="max-height:320px;overflow:auto;margin-top:8px">
        <table class="tbl">
          <thead><tr><th style="width:40px"></th><th>编码</th><th>名称</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="c in mergeCandidates" :key="c.id">
              <td><input v-model="mergeIds" type="checkbox" :value="c.id" /></td>
              <td class="num">{{ c.master_code || c.id }}</td>
              <td>{{ c.name }}</td>
              <td>{{ { DRAFT: '草稿', PENDING: '审批中', CHANGING: '变更中', PUBLISHED: '已发布', FROZEN: '已冻结', ARCHIVED: '已归档' }[c.status] || c.status }}</td>
            </tr>
            <tr v-if="!mergeCandidates.length"><td colspan="4" class="muted">未找到可合并数据</td></tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <button class="btn" @click="mergeVisible = false">取消</button>
        <button class="btn primary" :disabled="!mergeIds.length" @click="doMerge">确认合并（{{ mergeIds.length }}）</button>
      </template>
    </el-dialog>

    <!-- 提交审批抄送人选择 -->
    <el-dialog v-model="ccVisible" title="提交审批" width="480px" destroy-on-close>
      <p class="hint">确认提交该数据进入审批流程，可勾选抄送人（选填，抄送人可查看审批进展）。</p>
      <div class="form-item mt10"><label>抄送人</label>
        <el-select v-model="ccSelected" multiple filterable placeholder="不抄送" style="width:100%">
          <el-option v-for="u in ccCandidates" :key="u.id" :value="u.id" :label="`${u.display_name}（${u.dept || '—'}）`" />
        </el-select>
      </div>
      <template #footer>
        <button class="btn" @click="confirmCc(true)">取消</button>
        <button class="btn primary" @click="confirmCc(false)">提交审批</button>
      </template>
    </el-dialog>
  </div>
</template>
