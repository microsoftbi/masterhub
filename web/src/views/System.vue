<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { scheduleApi, systemApi } from '../api';
import { useAuth } from '../stores/auth';

const auth = useAuth();
const tab = ref('users');
const users = ref<any[]>([]);
const roles = ref<any[]>([]);
const groups = ref<any[]>([]);
const audit = ref<any>({ list: [], total: 0, page: 1, size: 15, modules: [] });
const auditFilters = reactive<any>({ module: '', username: '', keyword: '', page: 1, size: 15 });
const roleCode = ref('');
const roleAllowed = ref<string[]>([]);
const loading = ref(false);

const canUser = computed(() => auth.has('system.user'));
const canRole = computed(() => auth.has('system.role'));
const canAudit = computed(() => auth.has('system.audit'));
const canSchedule = computed(() => auth.has('system.manage'));

const userVisible = ref(false);
const userForm = reactive<any>({ id: null, username: '', password: '', display_name: '', dept: '', roles: [] as string[], status: 'ACTIVE' });

async function loadUsers() {
  const res = await systemApi.users();
  users.value = res.list || [];
}

async function loadRoles() {
  const res = await systemApi.roles();
  roles.value = res.list || [];
  groups.value = res.groups || [];
  if (!roleCode.value && roles.value.length) {
    await pickRole(roles.value.find((r) => r.code !== 'SYS_ADMIN')?.code || roles.value[0].code);
  }
}

async function pickRole(code: string) {
  roleCode.value = code;
  const res = await systemApi.rolePerms(code);
  roleAllowed.value = res.allowed || [];
}

async function savePerms() {
  const res = await systemApi.saveRolePerms(roleCode.value, { perms: roleAllowed.value });
  roleAllowed.value = res.allowed || [];
  await loadRoles();
  ElMessage.success('权限已保存');
}

async function loadAudit() {
  loading.value = true;
  try {
    const params: any = { ...auditFilters };
    Object.keys(params).forEach((k) => { if (!params[k]) delete params[k]; });
    audit.value = await systemApi.audit(params);
  } finally { loading.value = false; }
}

function openUser(u?: any) {
  Object.assign(userForm, u ? {
    id: u.id, username: u.username, password: '', display_name: u.display_name, dept: u.dept, status: u.status,
    roles: (u.roles || []).map((r: any) => r.code),
  } : { id: null, username: '', password: '', display_name: '', dept: '', roles: [], status: 'ACTIVE' });
  userVisible.value = true;
}

async function saveUser() {
  if (userForm.id) {
    const dto: any = { display_name: userForm.display_name, dept: userForm.dept, status: userForm.status, roles: userForm.roles };
    if (userForm.password) dto.password = userForm.password;
    await systemApi.updateUser(userForm.id, dto);
  } else {
    await systemApi.createUser({ ...userForm });
  }
  userVisible.value = false;
  ElMessage.success('用户已保存');
  await loadUsers();
}

function groupChecked(g: any) {
  return g.perms.every((([code]: any) => roleAllowed.value.includes(code)));
}

function toggleGroup(g: any) {
  const codes = g.perms.map(([c]: any) => c);
  if (groupChecked(g)) roleAllowed.value = roleAllowed.value.filter((c) => !codes.includes(c));
  else roleAllowed.value = Array.from(new Set([...roleAllowed.value, ...codes]));
}

// ---------------- 任务调度 ----------------
const schJobs = ref<any[]>([]);
const schMeta = ref<any>({ jobTypes: [], qualityTasks: [], workflows: [], domains: [], presets: [] });
const schRuns = ref<any>({ list: [], total: 0, page: 1, size: 10 });
const schRunsFilter = reactive<any>({ jobId: '', status: '', page: 1, size: 10 });
const jobVisible = ref(false);
const runningJob = ref(0);
const jobForm = reactive<any>({
  id: null, code: '', name: '', jobType: 'QUALITY_SCAN', targetId: null as number | null,
  domainCode: '', cron: '0 2 * * *', enabled: true,
});

async function loadSchJobs() {
  const [jobs, meta] = await Promise.all([scheduleApi.jobs(), scheduleApi.meta()]);
  schJobs.value = jobs || [];
  if (meta) schMeta.value = meta;
}

async function loadSchRuns() {
  const params: any = { ...schRunsFilter };
  Object.keys(params).forEach((k) => { if (!params[k]) delete params[k]; });
  schRuns.value = await scheduleApi.runs(params);
}

function openJob(j?: any) {
  Object.assign(jobForm, j ? {
    id: j.id, code: j.code, name: j.name, jobType: j.job_type, targetId: j.target_id || null,
    domainCode: j.domain_code || '', cron: j.cron, enabled: j.enabled,
  } : {
    id: null, code: '', name: '', jobType: 'QUALITY_SCAN', targetId: null,
    domainCode: '', cron: '0 2 * * *', enabled: true,
  });
  jobVisible.value = true;
}

function jobTargets() {
  if (jobForm.jobType === 'QUALITY_TASK') return schMeta.value.qualityTasks || [];
  if (jobForm.jobType === 'WORKFLOW') return schMeta.value.workflows || [];
  return [];
}

async function saveJob() {
  await scheduleApi.save({ ...jobForm, targetId: jobForm.targetId || null });
  jobVisible.value = false;
  ElMessage.success('调度任务已保存');
  await Promise.all([loadSchJobs(), loadSchRuns()]);
}

async function toggleJob(j: any) {
  await scheduleApi.toggle(j.id, !j.enabled);
  ElMessage.success(!j.enabled ? '任务已启用' : '任务已停用');
  await loadSchJobs();
}

async function runJobNow(j: any) {
  runningJob.value = j.id;
  try {
    const res = await scheduleApi.runNow(j.id);
    if (res.status === 'SUCCESS') ElMessage.success(`${res.message}（${res.duration_ms}ms）`);
    else ElMessage.warning(`执行失败：${res.message}`);
    await Promise.all([loadSchJobs(), loadSchRuns()]);
  } finally {
    runningJob.value = 0;
  }
}

function viewJobRuns(j: any) {
  schRunsFilter.jobId = j.id;
  schRunsFilter.page = 1;
  loadSchRuns();
}

// ---------------- 参数配置（M4） ----------------
const configs = ref<any[]>([]);

async function loadConfigs() {
  configs.value = (await systemApi.configs()) || [];
}

async function saveConfigs() {
  configs.value = await systemApi.saveConfigs({
    items: configs.value.map((c: any) => ({ key: c.key, value: c.value })),
  });
  ElMessage.success('参数已保存并即时生效（会话时长对下次登录生效）');
}

onMounted(async () => {
  await Promise.all([loadUsers(), loadRoles(), loadSchJobs(), loadSchRuns()]);
  await loadAudit();
});
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>系统管理</h2>
        <p class="desc">用户与角色、权限矩阵与操作审计</p>
      </div>
    </div>

    <div class="tabs">
      <div class="tab" :class="{ active: tab === 'users' }" @click="tab = 'users'">用户（{{ users.length }}）</div>
      <div class="tab" :class="{ active: tab === 'roles' }" @click="tab = 'roles'">角色权限</div>
      <div class="tab" :class="{ active: tab === 'jobs' }" @click="tab = 'jobs'; loadSchJobs()">任务调度（{{ schJobs.length }}）</div>
      <div class="tab" :class="{ active: tab === 'configs' }" @click="tab = 'configs'; loadConfigs()">参数配置</div>
      <div class="tab" :class="{ active: tab === 'audit' }" @click="tab = 'audit'; loadAudit()">审计日志</div>
    </div>

    <div v-if="tab === 'users'" class="card">
      <div class="card-head">
        <span>用户列表</span>
        <button v-if="canUser" class="btn sm" @click="openUser()">新增用户</button>
      </div>
      <table class="tbl">
        <thead><tr><th>账号</th><th>姓名</th><th>部门</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="num">{{ u.username }}</td>
            <td>{{ u.display_name }}</td>
            <td>{{ u.dept || '—' }}</td>
            <td>
              <span v-for="r in u.roles" :key="r.code" class="tag p" style="margin-right:4px">{{ r.name }}</span>
            </td>
            <td><span class="tag" :class="u.status === 'ACTIVE' ? 'g' : 's'">{{ u.statusLabel }}</span></td>
            <td class="muted">{{ String(u.created_at || '').replace('T', ' ') }}</td>
            <td><span v-if="canUser" class="link" @click="openUser(u)">编辑</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="tab === 'roles'" class="grid-2">
      <div class="card">
        <div class="card-head">角色</div>
        <table class="tbl">
          <thead><tr><th>角色</th><th>编码</th><th>权限数</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="r in roles" :key="r.code" :style="roleCode === r.code ? 'background:#f8fafc' : ''">
              <td><b>{{ r.name }}</b></td>
              <td class="num">{{ r.code }}</td>
              <td class="num">{{ r.perms?.length || 0 }}</td>
              <td class="muted">{{ r.remark || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-head">
          <span>权限矩阵 · {{ roles.find((r) => r.code === roleCode)?.name || '选择角色' }}</span>
          <button v-if="canRole && roleCode !== 'SYS_ADMIN'" class="btn sm primary" @click="savePerms">保存</button>
        </div>
        <div class="card-body">
          <p v-if="roleCode === 'SYS_ADMIN'" class="hint" style="color:var(--warn)">系统管理员拥有全部权限，不可修改</p>
          <div v-for="g in groups" :key="g.module" class="mt10">
            <div class="flex" style="justify-content:space-between;border-bottom:1px solid var(--bd);padding-bottom:4px">
              <b>{{ g.label }}</b>
              <span v-if="roleCode !== 'SYS_ADMIN'" class="link" @click="toggleGroup(g)">{{ groupChecked(g) ? '取消全组' : '全选本组' }}</span>
            </div>
            <div class="flex" style="flex-wrap:wrap;margin-top:6px">
              <label v-for="p in g.perms" :key="p[0]" class="hint" style="margin-right:14px;min-width:78px">
                <input v-model="roleAllowed" type="checkbox" :value="p[0]" :disabled="roleCode === 'SYS_ADMIN'" /> {{ p[1] }}
              </label>
            </div>
          </div>
          <p class="hint mt10">切换角色：</p>
          <div class="flex" style="flex-wrap:wrap">
            <span v-for="r in roles" :key="r.code" class="tag" :class="roleCode === r.code ? 'b' : 's'" style="margin-right:6px;cursor:pointer" @click="pickRole(r.code)">
              {{ r.name }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="tab === 'jobs'" class="card">
      <div class="card-head">
        <span>调度任务（质量巡检 / 数据工作流 / 分发补偿）</span>
        <button v-if="canSchedule" class="btn sm primary" @click="openJob()">新增任务</button>
      </div>
      <table class="tbl">
        <thead><tr><th>编码</th><th>名称</th><th>类型</th><th>执行目标</th><th>调度规则</th><th>下次执行</th><th>上次执行</th><th>状态</th><th style="width:190px">操作</th></tr></thead>
        <tbody>
          <tr v-for="j in schJobs" :key="j.id">
            <td class="num">{{ j.code }}</td>
            <td><b>{{ j.name }}</b></td>
            <td><span class="tag b">{{ j.type_label }}</span></td>
            <td>{{ j.target_label }}</td>
            <td>
              <span class="num">{{ j.cron }}</span>
              <div class="hint">{{ j.cron_desc }}</div>
            </td>
            <td class="muted">{{ j.enabled && j.next_run_at ? String(j.next_run_at).replace('T', ' ') : '—' }}</td>
            <td>
              <template v-if="j.last_run_at">
                <span class="tag" :class="j.last_run_status === 'SUCCESS' ? 'g' : 'r'">{{ j.last_run_status === 'SUCCESS' ? '成功' : '失败' }}</span>
                <div class="hint" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ j.last_message }}</div>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td><span class="tag" :class="j.enabled ? 'g' : 's'">{{ j.enabled ? '启用' : '停用' }}</span></td>
            <td>
              <span v-if="canSchedule" class="link" @click="runJobNow(j)">{{ runningJob === j.id ? '执行中…' : '立即执行' }}</span>
              <span v-if="canSchedule" class="link" style="margin-left:8px" @click="toggleJob(j)">{{ j.enabled ? '停用' : '启用' }}</span>
              <span v-if="canSchedule" class="link" style="margin-left:8px" @click="openJob(j)">编辑</span>
              <span class="link" style="margin-left:8px" @click="viewJobRuns(j)">记录（{{ j.run_count }}）</span>
            </td>
          </tr>
          <tr v-if="!schJobs.length"><td colspan="9" class="muted">暂无调度任务</td></tr>
        </tbody>
      </table>

      <div class="card-head" style="border-top:1px solid var(--bd);margin-top:4px">
        <span>运行历史</span>
        <div class="flex">
          <select v-model="schRunsFilter.jobId" style="margin-right:8px" @change="schRunsFilter.page = 1; loadSchRuns()">
            <option value="">全部任务</option>
            <option v-for="j in schJobs" :key="j.id" :value="j.id">{{ j.name }}</option>
          </select>
          <select v-model="schRunsFilter.status" @change="schRunsFilter.page = 1; loadSchRuns()">
            <option value="">全部状态</option>
            <option value="SUCCESS">成功</option>
            <option value="FAILED">失败</option>
          </select>
        </div>
      </div>
      <table class="tbl">
        <thead><tr><th>批次</th><th>任务</th><th>类型</th><th>触发</th><th>状态</th><th>执行结果</th><th>耗时</th><th>执行人</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="r in schRuns.list" :key="r.id">
            <td class="num">#{{ r.id }}</td>
            <td>{{ r.job_name || '—' }}</td>
            <td><span class="tag s">{{ r.type_label }}</span></td>
            <td>{{ r.trigger === 'MANUAL' ? '手动' : '定时' }}</td>
            <td><span class="tag" :class="r.status === 'SUCCESS' ? 'g' : 'r'">{{ r.status === 'SUCCESS' ? '成功' : '失败' }}</span></td>
            <td style="max-width:300px">{{ r.message }}</td>
            <td class="num">{{ r.duration_ms }}ms</td>
            <td>{{ r.operator }}</td>
            <td class="muted">{{ String(r.created_at || '').replace('T', ' ') }}</td>
          </tr>
          <tr v-if="!schRuns.list.length"><td colspan="9" class="muted">暂无运行记录</td></tr>
        </tbody>
      </table>
      <div class="pgn" style="padding:10px 16px 14px">
        <span>共 {{ schRuns.total }} 条</span>
        <button :disabled="schRunsFilter.page <= 1" @click="schRunsFilter.page--; loadSchRuns()">‹</button>
        <button class="cur">{{ schRunsFilter.page }}</button>
        <button :disabled="schRunsFilter.page * schRunsFilter.size >= schRuns.total" @click="schRunsFilter.page++; loadSchRuns()">›</button>
      </div>
    </div>

    <div v-else-if="tab === 'configs'" class="card">
      <div class="card-head">
        <span>全局参数（保存后即时生效）</span>
        <button v-if="canSchedule" class="btn sm primary" :disabled="!configs.length" @click="saveConfigs">保存</button>
      </div>
      <table class="tbl">
        <thead><tr><th>参数键</th><th style="width:260px">参数值</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="c in configs" :key="c.key">
            <td class="num">{{ c.key }}</td>
            <td><input v-model="c.value" :disabled="!canSchedule" style="width:240px" /></td>
            <td class="muted">{{ c.remark }}</td>
          </tr>
          <tr v-if="!configs.length"><td colspan="3" class="muted">暂无参数</td></tr>
        </tbody>
      </table>
      <p class="hint" style="padding:10px 16px 14px">
        生效点：主数据列表默认分页、单次导入最大行数、用户密码最小长度、登录会话时长（下次登录起）、分发最大重试次数。
      </p>
    </div>

    <div v-else class="card">
      <div class="fbar" style="padding:12px 16px 0">
        <div class="f-item">
          <select v-model="auditFilters.module" @change="auditFilters.page = 1; loadAudit()">
            <option value="">全部模块</option>
            <option v-for="m in audit.modules" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div class="f-item">
          <input v-model="auditFilters.username" placeholder="操作人账号" style="width:140px" @keyup.enter="auditFilters.page = 1; loadAudit()" />
        </div>
        <div class="f-item">
          <input v-model="auditFilters.keyword" placeholder="对象 / 详情 / 动作" style="width:180px" @keyup.enter="auditFilters.page = 1; loadAudit()" />
        </div>
        <button class="btn sm" @click="auditFilters.page = 1; loadAudit()">查询</button>
      </div>
      <table class="tbl">
        <thead><tr><th>时间</th><th>操作人</th><th>模块</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
        <tbody>
          <tr v-for="l in audit.list" :key="l.id">
            <td class="muted">{{ String(l.created_at || '').replace('T', ' ') }}</td>
            <td>{{ l.username }}</td>
            <td><span class="tag s">{{ l.module }}</span></td>
            <td><span class="tag b">{{ l.action }}</span></td>
            <td>{{ l.target || '—' }}</td>
            <td class="muted" style="max-width:320px;overflow:hidden;text-overflow:ellipsis">{{ l.detail }}</td>
          </tr>
          <tr v-if="!loading && !audit.list.length"><td colspan="6" class="muted">暂无审计日志</td></tr>
        </tbody>
      </table>
      <div class="pgn" style="padding:10px 16px 14px">
        <span>共 {{ audit.total }} 条</span>
        <button :disabled="auditFilters.page <= 1" @click="auditFilters.page--; loadAudit()">‹</button>
        <button class="cur">{{ auditFilters.page }}</button>
        <button :disabled="auditFilters.page * auditFilters.size >= audit.total" @click="auditFilters.page++; loadAudit()">›</button>
      </div>
    </div>

    <el-dialog v-model="userVisible" :title="userForm.id ? '编辑用户' : '新增用户'" width="520px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>登录账号</label><input v-model="userForm.username" :disabled="!!userForm.id" style="width:100%" /></div>
        <div class="form-item"><label>{{ userForm.id ? '重置密码（留空不变）' : '初始密码' }}</label><input v-model="userForm.password" type="password" style="width:100%" /></div>
        <div class="form-item req"><label>姓名</label><input v-model="userForm.display_name" style="width:100%" /></div>
        <div class="form-item"><label>部门</label><input v-model="userForm.dept" style="width:100%" /></div>
      </div>
      <div class="form-item"><label>角色</label>
        <div class="flex" style="flex-wrap:wrap">
          <label v-for="r in roles" :key="r.code" class="hint" style="margin-right:14px">
            <input v-model="userForm.roles" type="checkbox" :value="r.code" /> {{ r.name }}
          </label>
        </div>
      </div>
      <div class="form-item"><label>状态</label>
        <select v-model="userForm.status" style="width:100%"><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select>
      </div>
      <template #footer>
        <button class="btn" @click="userVisible = false">取消</button>
        <button class="btn primary" @click="saveUser">保存</button>
      </template>
    </el-dialog>

    <el-dialog v-model="jobVisible" :title="jobForm.id ? '编辑调度任务' : '新增调度任务'" width="620px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>任务编码</label><input v-model="jobForm.code" placeholder="SCH-XXX" style="width:100%" /></div>
        <div class="form-item req"><label>任务名称</label><input v-model="jobForm.name" style="width:100%" /></div>
      </div>
      <div class="grid-form">
        <div class="form-item req"><label>任务类型</label>
          <select v-model="jobForm.jobType" style="width:100%" @change="jobForm.targetId = null">
            <option v-for="t in schMeta.jobTypes" :key="t.type" :value="t.type">{{ t.name }}</option>
          </select>
        </div>
        <div class="form-item" :class="{ req: jobForm.jobType === 'QUALITY_TASK' || jobForm.jobType === 'WORKFLOW' }"><label>执行目标</label>
          <select v-if="jobTargets().length" v-model="jobForm.targetId" style="width:100%">
            <option :value="null">— 选择目标 —</option>
            <option v-for="t in jobTargets()" :key="t.id" :value="t.id">{{ t.name }}（{{ t.code }}）</option>
          </select>
          <input v-else disabled :value="jobForm.jobType === 'DISPATCH' ? '全部待分发事件' : '默认全部数据域'" style="width:100%" />
        </div>
      </div>
      <div class="grid-form">
        <div v-if="jobForm.jobType === 'QUALITY_SCAN'" class="form-item"><label>限定数据域（可选）</label>
          <select v-model="jobForm.domainCode" style="width:100%">
            <option value="">全部数据域</option>
            <option v-for="d in schMeta.domains" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
        </div>
        <div class="form-item req"><label>调度规则（cron：分 时 日 月 周）</label>
          <input v-model="jobForm.cron" placeholder="0 2 * * *" style="width:100%" />
        </div>
      </div>
      <div class="flex" style="flex-wrap:wrap;margin-top:4px">
        <span v-for="p in schMeta.presets" :key="p.cron" class="tag s" style="margin-right:6px;margin-bottom:6px;cursor:pointer" @click="jobForm.cron = p.cron">{{ p.label }}</span>
      </div>
      <div class="form-item"><label>
        <input v-model="jobForm.enabled" type="checkbox" style="vertical-align:-2px" /> 创建后立即启用（后台每 30 秒轮询到点任务）
      </label></div>
      <template #footer>
        <button class="btn" @click="jobVisible = false">取消</button>
        <button class="btn primary" @click="saveJob">保存</button>
      </template>
    </el-dialog>
  </div>
</template>
