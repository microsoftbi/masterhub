<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { approvalApi } from '../api';
import { useAuth } from '../stores/auth';
import ProcessDesigner from '../components/ProcessDesigner.vue';

const auth = useAuth();
const tab = ref('todo');
const todo = ref<any[]>([]);
const ccdList = ref<any[]>([]);
const instances = ref<any>({ list: [], total: 0, page: 1, size: 10 });
const processes = ref<any[]>([]);
const filters = reactive<any>({ status: '', onlyMine: '', page: 1, size: 10 });
const loading = ref(false);

const drawer = ref(false);
const detail = ref<any>(null);
const comment = ref('');
const canHandle = computed(() => auth.has('approval.handle'));
const canManage = computed(() => auth.has('approval.manage'));

const STATUS_LABEL: Record<string, string> = {
  RUNNING: '审批中', COMPLETED: '已通过', REJECTED: '已驳回', CANCELLED: '已撤销', ERROR: '异常',
};
const ACTION_LABEL: Record<string, string> = { CREATE: '新增', CHANGE: '变更' };

function statusTag(s: string) {
  return { RUNNING: 'o', COMPLETED: 'g', REJECTED: 'r', ERROR: 'r' }[s] || 's';
}

async function loadTodo() {
  todo.value = (await approvalApi.todo()) || [];
}

async function loadCcd() {
  ccdList.value = (await approvalApi.ccd()) || [];
}

async function loadInstances() {
  loading.value = true;
  try {
    const params: any = { ...filters };
    Object.keys(params).forEach((k) => { if (!params[k]) delete params[k]; });
    instances.value = await approvalApi.instances(params);
  } finally {
    loading.value = false;
  }
}

async function loadProcesses() {
  processes.value = (await approvalApi.processes()) || [];
}

async function open(id: number) {
  detail.value = await approvalApi.detail(id);
  comment.value = '';
  drawer.value = true;
}

async function handle(pass: boolean) {
  if (!pass && !comment.value.trim()) { ElMessage.warning('驳回请填写审批意见'); return; }
  await ElMessageBox.confirm(pass ? '确认通过该审批？' : '确认驳回该审批？', '审批处理', { type: 'warning' });
  const res = pass
    ? await approvalApi.pass(detail.value.id, { comment: comment.value })
    : await approvalApi.reject(detail.value.id, { comment: comment.value });
  ElMessage.success(pass ? (res?.waiting ? `已通过，等待其余 ${res.waiting} 位会签人` : '审批已通过') : '已驳回');
  drawer.value = false;
  await Promise.all([loadTodo(), loadInstances()]);
}

// ---------------- 转办 / 加签（M4） ----------------
const opVisible = ref(false);
const opMode = ref<'transfer' | 'addSign'>('transfer');
const opForm = reactive<any>({ userId: null, comment: '' });
const handlers = ref<any[]>([]);

async function openOp(mode: 'transfer' | 'addSign') {
  opMode.value = mode;
  Object.assign(opForm, { userId: null, comment: '' });
  if (!handlers.value.length) handlers.value = (await approvalApi.handlers()) || [];
  handlers.value = handlers.value.filter((h) => h.id !== auth.user?.id);
  opVisible.value = true;
}

async function confirmOp() {
  if (!opForm.userId) { ElMessage.warning('请选择目标用户'); return; }
  const res = opMode.value === 'transfer'
    ? await approvalApi.transfer(detail.value.id, { userId: opForm.userId, comment: opForm.comment })
    : await approvalApi.addSign(detail.value.id, { userId: opForm.userId, comment: opForm.comment });
  ElMessage.success(opMode.value === 'transfer' ? `已转办给 ${res.assignee_name}` : `已加签 ${res.added}`);
  opVisible.value = false;
  drawer.value = false;
  await Promise.all([loadTodo(), loadInstances()]);
}

// ---------------- 流程设计器（M6） ----------------
const designerVisible = ref(false);
const editingProcess = ref<any>(null);

function openDesigner(p: any | null) {
  editingProcess.value = p;
  designerVisible.value = true;
}

function onDesignerSaved() {
  designerVisible.value = false;
  loadProcesses();
}

async function toggleProcess(p: any) {
  const verb = p.status === 'ACTIVE' ? '停用' : '启用';
  await ElMessageBox.confirm(`确认${verb}流程「${p.name}」？${verb === '停用' ? '停用后不再匹配新发起的审批。' : ''}`, '流程启停', { type: 'warning' });
  const res = await approvalApi.toggleProcess(p.code);
  ElMessage.success(`已${verb}`);
  await loadProcesses();
}

function diffRows(diff: any) {
  if (!diff) return [];
  return Object.entries(diff).map(([k, v]: any) => ({ key: k, label: detail.value?.fields?.find((f: any) => f.key === k)?.label || k, old: v.old, new: v.new }));
}

onMounted(async () => {
  await Promise.all([loadTodo(), loadCcd(), loadInstances(), loadProcesses()]);
});
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>审批中心</h2>
        <p class="desc">主数据新增/变更审批待办、实例流转与流程定义</p>
      </div>
      <div class="flex">
        <span class="tag o">待我处理 {{ todo.length }}</span>
      </div>
    </div>

    <div class="tabs">
      <div class="tab" :class="{ active: tab === 'todo' }" @click="tab = 'todo'">待我审批（{{ todo.length }}）</div>
      <div class="tab" :class="{ active: tab === 'ccd' }" @click="tab = 'ccd'">抄送我的（{{ ccdList.length }}）</div>
      <div class="tab" :class="{ active: tab === 'instances' }" @click="tab = 'instances'">审批实例</div>
      <div class="tab" :class="{ active: tab === 'processes' }" @click="tab = 'processes'">流程定义</div>
    </div>

    <div v-if="tab === 'todo'" class="card">
      <table class="tbl">
        <thead><tr><th>实例</th><th>主数据域</th><th>动作</th><th>当前节点</th><th>申请人</th><th>提交时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in todo" :key="t.id">
            <td><b>{{ t.title }}</b><div class="hint">{{ t.process_name }}</div></td>
            <td>{{ t.domain_code }}</td>
            <td><span class="tag b">{{ ACTION_LABEL[t.action] || t.action }}</span></td>
            <td>{{ t.node_name }}</td>
            <td>{{ t.applicant_name }}</td>
            <td class="muted">{{ String(t.created_at || '').replace('T', ' ') }}</td>
            <td><span class="link" @click="open(t.instance_id)">处理</span></td>
          </tr>
          <tr v-if="!todo.length"><td colspan="7" class="muted">暂无待办，工作愉快</td></tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="tab === 'ccd'" class="card">
      <table class="tbl">
        <thead><tr><th>实例</th><th>主数据域</th><th>动作</th><th>状态</th><th>申请人</th><th>抄送时间</th><th>阅读状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in ccdList" :key="c.cc_id">
            <td><b>{{ c.title }}</b><div class="hint">{{ c.process_name }} · #{{ c.instance_id }}</div></td>
            <td>{{ c.domain_code }}</td>
            <td><span class="tag b">{{ ACTION_LABEL[c.action] || c.action }}</span></td>
            <td><span class="tag" :class="statusTag(c.status)">{{ STATUS_LABEL[c.status] || c.status }}</span></td>
            <td>{{ c.applicant_name }}</td>
            <td class="muted">{{ String(c.cc_time || '').replace('T', ' ') }}</td>
            <td><span class="tag" :class="c.read_at ? 'g' : 'o'">{{ c.read_at ? '已读' : '未读' }}</span></td>
            <td><span class="link" @click="open(c.instance_id)">查看</span></td>
          </tr>
          <tr v-if="!ccdList.length"><td colspan="8" class="muted">暂无抄送给我的审批</td></tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="tab === 'instances'" class="card">
      <div class="fbar" style="padding:12px 16px 0">
        <div class="f-item">
          <select v-model="filters.status" @change="filters.page = 1; loadInstances()">
            <option value="">全部状态</option>
            <option value="RUNNING">审批中</option><option value="COMPLETED">已通过</option>
            <option value="REJECTED">已驳回</option><option value="ERROR">异常</option>
          </select>
        </div>
        <div class="f-item">
          <select v-model="filters.onlyMine" @change="filters.page = 1; loadInstances()">
            <option value="">全部申请人</option><option value="1">我发起的</option>
          </select>
        </div>
        <button class="btn sm" @click="loadInstances">刷新</button>
      </div>
      <table class="tbl">
        <thead><tr><th>实例</th><th>域</th><th>动作</th><th>状态</th><th>申请人</th><th>节点</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="i in instances.list" :key="i.id">
            <td><b>{{ i.title }}</b><div class="hint">{{ i.process_name }} · #{{ i.id }}</div></td>
            <td>{{ i.domain_code }}</td>
            <td><span class="tag b">{{ ACTION_LABEL[i.action] || i.action }}</span></td>
            <td><span class="tag" :class="statusTag(i.status)">{{ STATUS_LABEL[i.status] || i.status }}</span></td>
            <td>{{ i.applicant_name }}</td>
            <td class="muted">{{ i.current_node || '—' }}</td>
            <td class="muted">{{ String(i.updated_at || '').replace('T', ' ') }}</td>
            <td><span class="link" @click="open(i.id)">详情</span></td>
          </tr>
          <tr v-if="!loading && !instances.list.length"><td colspan="8" class="muted">暂无审批实例</td></tr>
        </tbody>
      </table>
      <div class="pgn" style="padding:10px 16px 14px">
        <span>共 {{ instances.total }} 条</span>
        <button :disabled="filters.page <= 1" @click="filters.page--; loadInstances()">‹</button>
        <button class="cur">{{ filters.page }}</button>
        <button :disabled="filters.page * filters.size >= instances.total" @click="filters.page++; loadInstances()">›</button>
      </div>
    </div>

    <div v-else>
      <div v-if="canManage" class="flex" style="justify-content:flex-end;margin-bottom:10px">
        <button class="btn primary sm" @click="openDesigner(null)">+ 新增流程</button>
      </div>
      <div class="cards-row">
      <div v-for="p in processes" :key="p.code" class="card" style="width:100%">
        <div class="card-head">
          <span>{{ p.name }} <span class="hint" style="margin-left:6px">{{ p.code }}</span></span>
          <span class="flex" style="gap:8px;align-items:center">
            <span class="tag" :class="p.status === 'ACTIVE' ? 'g' : 's'">{{ p.status === 'ACTIVE' ? '启用' : '停用' }}</span>
            <template v-if="canManage">
              <span class="link" @click="openDesigner(p)">编辑</span>
              <span class="link" @click="toggleProcess(p)">{{ p.status === 'ACTIVE' ? '停用' : '启用' }}</span>
            </template>
          </span>
        </div>
        <div class="card-body">
          <div class="kv"><b>绑定</b><span>{{ p.bind?.domain === '*' ? '全部主数据域' : p.bind?.domain }} · {{ ACTION_LABEL[p.bind?.action] || p.bind?.action }}</span></div>
          <div class="flex mt10" style="flex-wrap:wrap">
            <span v-for="n in p.nodes" :key="n.id" class="tag" :class="n.type === 'END' ? 's' : n.type === 'AUTO' ? 'p' : n.type === 'CC' ? 'g' : 'b'" style="margin-right:6px">
              {{ n.name }}（{{ { START: '开始', APPROVAL: n.multi === 'AND' ? '会签' : '或签', CC: '抄送', AUTO: '自动', END: '结束' }[n.type] || n.type }}）
            </span>
          </div>
          <p class="hint mt10">运行中实例 {{ p.runningCount }} 个</p>
        </div>
      </div>
      <div v-if="!processes.length" class="card"><div class="card-body muted">暂无流程定义</div></div>
      </div>
    </div>

    <el-drawer v-model="drawer" :title="detail?.title || '审批详情'" size="640px" destroy-on-close>
      <template v-if="detail">
        <div class="flex" style="justify-content:space-between;margin-bottom:10px">
          <span class="tag" :class="statusTag(detail.status)">{{ STATUS_LABEL[detail.status] || detail.status }}</span>
          <span class="hint">{{ detail.process_name }} · #{{ detail.id }}</span>
        </div>
        <div class="kv"><b>主数据域</b><span>{{ detail.domainName }}（{{ detail.domain_code }}）</span></div>
        <div class="kv"><b>动作</b><span>{{ ACTION_LABEL[detail.action] || detail.action }}</span></div>
        <div class="kv"><b>申请人</b><span>{{ detail.applicant_name }}</span></div>
        <div class="kv"><b>当前记录</b><span>{{ detail.record?.master_code || '未发布' }} · v{{ detail.record?.version || 1 }}</span></div>

        <h4 class="mt10">字段变更</h4>
        <table v-if="diffRows(detail.diff).length" class="tbl diff">
          <thead><tr><th>字段</th><th>当前值</th><th>申请值</th></tr></thead>
          <tbody>
            <tr v-for="d in diffRows(detail.diff)" :key="d.key">
              <td>{{ d.label }}</td><td class="old">{{ d.old ?? '—' }}</td><td class="new">{{ d.new ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="hint">无字段差异（新增数据以申请快照为准）</p>

        <h4 class="mt10">审批流转</h4>
        <div class="tl">
          <div v-for="t in detail.tasks" :key="t.id" class="tl-item" :class="{ ok: t.status === 'APPROVED', cur: t.status === 'PENDING' }">
            <div class="flex" style="justify-content:space-between">
              <b>{{ t.node_name }} · {{ t.assignee_name }}</b>
              <span class="tag" :class="t.status === 'APPROVED' ? 'g' : t.status === 'PENDING' ? 'o' : 's'">
                {{ { PENDING: '待处理', APPROVED: '已通过', REJECTED: '已驳回', CANCELLED: '已取消' }[t.status] || t.status }}
              </span>
            </div>
            <p class="hint">{{ String(t.handled_at || t.created_at || '').replace('T', ' ') }} {{ t.comment ? '· ' + t.comment : '' }}</p>
          </div>
          <p v-if="!detail.tasks.length" class="hint">暂无任务记录</p>
        </div>

        <h4 class="mt10">抄送人</h4>
        <div class="flex" style="flex-wrap:wrap;gap:6px">
          <span v-for="c in detail.ccList" :key="c.id" class="tag" :class="c.read_at ? 'g' : 'o'">
            {{ c.user_name }}（{{ c.node_id === 'start' ? '发起时抄送' : '节点抄送' }} · {{ c.read_at ? '已读' : '未读' }}）
          </span>
        </div>
        <p v-if="!detail.ccList?.length" class="hint">无抄送人</p>

        <div v-if="detail.canHandle && canHandle" class="card mt10">
          <div class="card-body">
            <div class="form-item"><label>审批意见</label>
              <textarea v-model="comment" rows="3" placeholder="通过可选填，驳回必填" style="width:100%;border:1px solid var(--bd);border-radius:6px;padding:8px;font-family:inherit" />
            </div>
            <div class="flex">
              <button class="btn primary" @click="handle(true)">通过</button>
              <button class="btn danger" @click="handle(false)">驳回</button>
              <button class="btn" @click="openOp('transfer')">转办</button>
              <button class="btn" @click="openOp('addSign')">加签</button>
            </div>
          </div>
        </div>
        <p v-else-if="detail.status === 'RUNNING'" class="hint mt10">您不是当前节点处理人</p>
      </template>
    </el-drawer>

    <!-- 转办 / 加签对话框 -->
    <el-dialog v-model="opVisible" :title="opMode === 'transfer' ? '转办待办' : '节点加签'" width="460px" destroy-on-close>
      <div class="form-item req"><label>{{ opMode === 'transfer' ? '转办给' : '加签给' }}</label>
        <select v-model="opForm.userId" style="width:100%">
          <option :value="null">— 选择用户 —</option>
          <option v-for="h in handlers" :key="h.id" :value="h.id">{{ h.display_name }}（{{ h.dept || h.id }}）</option>
        </select>
      </div>
      <div class="form-item"><label>说明（选填）</label>
        <input v-model="opForm.comment" placeholder="转办 / 加签原因" style="width:100%" />
      </div>
      <p class="hint">{{ opMode === 'transfer' ? '转办后该待办由目标用户处理，处理记录全程留痕。' : '加签后目标用户加入当前节点：会签节点需其通过，或签节点任一通过即结束。' }}</p>
      <template #footer>
        <button class="btn" @click="opVisible = false">取消</button>
        <button class="btn primary" @click="confirmOp">确认</button>
      </template>
    </el-dialog>

    <!-- 可视化流程设计器 -->
    <el-dialog v-model="designerVisible" :title="editingProcess ? `编辑流程 · ${editingProcess.name}` : '新增流程'" width="920px" top="4vh" destroy-on-close>
      <ProcessDesigner :process="editingProcess" @saved="onDesignerSaved" />
    </el-dialog>
  </div>
</template>
