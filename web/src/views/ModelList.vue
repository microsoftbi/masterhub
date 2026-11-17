<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { metaApi } from '../api';
import { useAuth } from '../stores/auth';

const auth = useAuth();
const tab = ref('models');
const models = ref<any[]>([]);
const domains = ref<any[]>([]);
const dicts = ref<any[]>([]);
const rules = ref<any[]>([]);
const current = ref<any>(null);
const loading = ref(false);

const fieldVisible = ref(false);
const fieldForm = reactive<any>({});
const fieldIsEdit = ref(false);

const createVisible = ref(false);
const createForm = reactive<any>({ code: '', name: '', domainCode: '', nameKey: 'name', description: '' });

const ruleVisible = ref(false);
const ruleForm = reactive<any>({ domain: '', name: '', segments: [] as any[] });
const rulePreview = ref<any>(null);

// 数据域管理：新建数据域（建域即对管理员/数据管理员授权可见）
const domainVisible = ref(false);
const domainForm = reactive<any>({ code: '', name: '', owner: '', description: '' });

function openDomain() {
  Object.assign(domainForm, { code: '', name: '', owner: '', description: '' });
  domainVisible.value = true;
}

async function saveDomain() {
  await metaApi.createDomain({ ...domainForm });
  domainVisible.value = false;
  ElMessage.success('数据域已创建，可立即为其新建模型');
  await load();
}

const canManage = computed(() => auth.has('model.manage'));

async function load() {
  loading.value = true;
  try {
    const [m, d, dd] = await Promise.all([metaApi.models(), metaApi.domains(), metaApi.dicts()]);
    models.value = m || [];
    domains.value = d || [];
    dicts.value = dd || [];
  } finally {
    loading.value = false;
  }
}

async function loadRules() {
  rules.value = (await metaApi.codeRules()) || [];
}

async function manage(m: any) {
  current.value = await metaApi.model(m.id);
  parentFieldSel.value = current.value?.parent_field || '';
}

// M5：层级模型——配置层级字段后，主数据支持父子层级（字段值为父记录编码）
const parentFieldSel = ref('');

async function saveParentField() {
  try {
    current.value = await metaApi.updateModel(current.value.id, { parentField: parentFieldSel.value || '' });
    ElMessage.success(parentFieldSel.value ? `层级字段已设置为「${parentFieldSel.value}」` : '已取消层级配置');
  } catch {
    parentFieldSel.value = current.value?.parent_field || '';
  }
  await load();
}

function openCreate() {
  Object.assign(createForm, { code: '', name: '', domainCode: domains.value[0]?.code || '', nameKey: 'name', description: '' });
  createVisible.value = true;
}

async function saveCreate() {
  current.value = await metaApi.createModel({ ...createForm });
  createVisible.value = false;
  ElMessage.success('模型已创建，请补充字段');
  await load();
}

function openField(f?: any) {
  fieldIsEdit.value = !!f;
  Object.assign(fieldForm, f ? { ...f } : {
    id: null, fieldKey: '', label: '', type: 'TEXT', required: false, uniqueFlag: false,
    queryFlag: false, dictCode: '', refDomain: '', maxLength: null, regex: '', placeholder: '', sort: null,
  });
  fieldVisible.value = true;
}

async function saveField() {
  await metaApi.saveField(current.value.id, { ...fieldForm });
  fieldVisible.value = false;
  current.value = await metaApi.model(current.value.id);
  ElMessage.success('字段已保存');
  await load();
}

async function removeField(f: any) {
  await ElMessageBox.confirm(`确认删除字段「${f.label}」？`, '删除字段', { type: 'warning' });
  current.value = await metaApi.deleteField(current.value.id, f.id);
  ElMessage.success('字段已删除');
  await load();
}

async function publish() {
  const compat = await metaApi.compat(current.value.id);
  const msg = [
    `字段 ${current.value.fields.length} 个，存量数据 ${compat.recordCount} 条。`,
    compat.newFieldCount ? `存在 ${compat.newFieldCount} 个存量数据为空的字段，将按“保留存量”处理。` : '',
    `发布后版本 v${(current.value.version || 0) + 1}，查询字段将自动建索引。确认发布？`,
  ].filter(Boolean).join('\n');
  await ElMessageBox.confirm(msg, '发布模型', { type: 'warning' });
  const res = await metaApi.publish(current.value.id);
  current.value = res.model;
  ElMessage.success(`发布成功 v${res.version}，新增索引 ${res.indexes?.created?.length || 0} 个`);
  await load();
}

async function openRule(r: any) {
  if (r) {
    Object.assign(ruleForm, { domain: r.domain_code, name: r.name, segments: JSON.parse(JSON.stringify(r.segments || [])) });
  } else {
    Object.assign(ruleForm, { domain: domains.value[0]?.code || '', name: '', segments: [{ type: 'FIX', value: 'DM' }, { type: 'SEQ', len: 4, reset: 'DAY' }] });
  }
  rulePreview.value = null;
  ruleVisible.value = true;
}

function addSegment() {
  ruleForm.segments.push({ type: 'DATE', fmt: 'yyyyMMdd' });
}

function removeSegment(i: number) {
  ruleForm.segments.splice(i, 1);
}

async function previewRule() {
  await metaApi.updateCodeRule(ruleForm.domain, { name: ruleForm.name, segments: ruleForm.segments });
  await loadRules();
  rulePreview.value = await metaApi.previewCode(ruleForm.domain, {});
  ElMessage.success('已保存并按当前规则预览');
}

async function saveRule() {
  await metaApi.updateCodeRule(ruleForm.domain, { name: ruleForm.name, segments: ruleForm.segments });
  ruleVisible.value = false;
  ElMessage.success('编码规则已保存');
  await loadRules();
}

onMounted(async () => {
  await load();
  await loadRules();
});
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>模型管理</h2>
        <p class="desc">主数据元数据模型、字段定义与编码规则，发布后动态生成查询列与索引</p>
      </div>
      <div class="flex">
        <button v-if="tab === 'domains' && canManage" class="btn primary" @click="openDomain">新建数据域</button>
        <button v-if="tab === 'models' && canManage" class="btn primary" @click="openCreate">新建模型</button>
        <button v-if="tab === 'rules' && canManage" class="btn primary" @click="openRule(null)">新增编码规则</button>
      </div>
    </div>

    <div class="tabs">
      <div class="tab" :class="{ active: tab === 'domains' }" @click="tab = 'domains'">数据域</div>
      <div class="tab" :class="{ active: tab === 'models' }" @click="tab = 'models'">数据模型</div>
      <div class="tab" :class="{ active: tab === 'rules' }" @click="tab = 'rules'">编码规则</div>
    </div>

    <div v-if="tab === 'domains'" class="card">
      <div class="card-head">数据域列表</div>
      <table class="tbl">
        <thead><tr><th>数据域</th><th>编码</th><th>归口部门</th><th>说明</th><th>数据量</th><th>已发布</th><th>草稿</th><th>模型</th></tr></thead>
        <tbody>
          <tr v-for="d in domains" :key="d.code">
            <td><b>{{ d.name }}</b></td>
            <td class="muted">{{ d.code }}</td>
            <td>{{ d.owner || '—' }}</td>
            <td class="muted" style="max-width:260px">{{ d.description || '—' }}</td>
            <td class="num">{{ d.total }}</td>
            <td class="num">{{ d.published }}</td>
            <td class="num">{{ d.drafts }}</td>
            <td>
              <template v-if="d.model">{{ d.model.name }}</template>
              <span v-else class="tag s">未建模</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="tab === 'models'" class="grid-2">
      <div class="card">
        <div class="card-head">模型列表</div>
        <table class="tbl">
          <thead><tr><th>模型</th><th>所属域</th><th>字段</th><th>数据量</th><th>版本</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="m in models" :key="m.id">
              <td>
                <b>{{ m.name }}</b>
                <div class="hint">{{ m.code }}</div>
              </td>
              <td>{{ m.domain_name }}</td>
              <td class="num">{{ m.field_count }}</td>
              <td class="num">{{ m.record_count }}</td>
              <td class="num">v{{ m.version }}</td>
              <td>
                <span class="tag" :class="m.status === 'PUBLISHED' ? 'g' : 's'">
                  {{ m.status === 'PUBLISHED' ? '已发布' : '草稿' }}
                </span>
              </td>
              <td><span class="link" @click="manage(m)">管理</span></td>
            </tr>
            <tr v-if="!loading && !models.length"><td colspan="7" class="muted">暂无模型</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-head">
          <span>{{ current ? current.name + ' · 字段' : '字段配置' }}</span>
          <span v-if="current" class="flex">
            <button v-if="canManage" class="btn sm" @click="openField()">添加字段</button>
            <button v-if="canManage" class="btn sm primary" @click="publish">发布</button>
          </span>
        </div>
        <div v-if="current" class="card-body">
          <div class="kv"><b>名称字段</b><span>{{ current.name_key }}</span></div>
          <div class="kv">
            <b>层级字段</b>
            <select v-if="canManage" v-model="parentFieldSel" style="max-width:220px" @change="saveParentField">
              <option value="">（无 · 平铺数据）</option>
              <option v-for="f in current.fields.filter((x: any) => x.field_key !== current.name_key)" :key="f.id" :value="f.field_key">
                {{ f.label }}（{{ f.field_key }}）
              </option>
            </select>
            <span v-else>{{ current.parent_field || '（无）' }}</span>
          </div>
          <table class="tbl">
            <thead><tr><th>字段</th><th>类型</th><th>必填</th><th>唯一</th><th>查询</th><th>绑定</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="f in current.fields" :key="f.id">
                <td>
                  <b>{{ f.label }}</b>
                  <div class="hint">{{ f.field_key }}</div>
                </td>
                <td><span class="tag s">{{ f.type }}</span></td>
                <td>{{ f.required ? '是' : '—' }}</td>
                <td>{{ f.unique_flag ? '是' : '—' }}</td>
                <td>{{ f.query_flag ? '是' : '—' }}</td>
                <td class="muted">{{ f.dict_code || f.ref_domain || '—' }}</td>
                <td>
                  <span v-if="canManage" class="link" @click="openField(f)">编辑</span>
                  <span v-if="canManage && f.field_key !== current.name_key" class="link" style="margin-left:8px;color:var(--err)" @click="removeField(f)">删除</span>
                </td>
              </tr>
              <tr v-if="!current.fields.length"><td colspan="7" class="muted">请添加字段</td></tr>
            </tbody>
          </table>
        </div>
        <div v-else class="card-body muted">从左侧选择模型进行字段配置</div>
      </div>
    </div>

    <div v-else class="card">
      <div class="card-head">编码规则</div>
      <table class="tbl">
        <thead><tr><th>主数据域</th><th>规则名称</th><th>规则段</th><th>预览编码</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id">
            <td>{{ r.domain_name }}<div class="hint">{{ r.domain_code }}</div></td>
            <td>{{ r.name }}</td>
            <td class="muted">
              <span v-for="(s, i) in r.segments" :key="i" class="tag s" style="margin-right:4px">
                {{ s.type }}{{ s.value ? ':' + s.value : '' }}{{ s.len ? ':' + s.len : '' }}
              </span>
            </td>
            <td class="num">{{ r.preview?.code || r.preview?.error || '—' }}</td>
            <td><span v-if="canManage" class="link" @click="openRule(r)">编辑</span></td>
          </tr>
          <tr v-if="!rules.length"><td colspan="5" class="muted">暂无编码规则</td></tr>
        </tbody>
      </table>
    </div>

    <el-dialog v-model="createVisible" title="新建数据模型" width="520px" destroy-on-close>
      <div class="form-item req"><label>模型编码</label><input v-model="createForm.code" placeholder="如 material" style="width:100%" /></div>
      <div class="form-item req"><label>模型名称</label><input v-model="createForm.name" placeholder="如 物料主数据" style="width:100%" /></div>
      <div class="form-item req"><label>所属主数据域</label>
        <select v-model="createForm.domainCode" style="width:100%">
          <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}（{{ d.code }}）</option>
        </select>
      </div>
      <div class="form-item"><label>名称字段标识</label><input v-model="createForm.nameKey" style="width:100%" /></div>
      <div class="form-item"><label>说明</label><input v-model="createForm.description" style="width:100%" /></div>
      <template #footer>
        <button class="btn" @click="createVisible = false">取消</button>
        <button class="btn primary" @click="saveCreate">创建</button>
      </template>
    </el-dialog>

    <el-dialog v-model="fieldVisible" :title="fieldIsEdit ? '编辑字段' : '添加字段'" width="560px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>字段标识</label><input v-model="fieldForm.fieldKey" :disabled="fieldIsEdit" style="width:100%" /></div>
        <div class="form-item req"><label>字段名称</label><input v-model="fieldForm.label" style="width:100%" /></div>
        <div class="form-item"><label>字段类型</label>
          <select v-model="fieldForm.type" style="width:100%">
            <option value="TEXT">文本</option><option value="NUMBER">数值</option><option value="DATE">日期</option>
            <option value="ENUM">枚举（码表）</option><option value="REF">引用主数据</option><option value="BOOL">布尔</option>
          </select>
        </div>
        <div v-if="fieldForm.type === 'ENUM'" class="form-item req"><label>绑定码表</label>
          <select v-model="fieldForm.dictCode" style="width:100%">
            <option value="">请选择</option>
            <option v-for="d in dicts" :key="d.code" :value="d.code">{{ d.name }}（{{ d.code }}）</option>
          </select>
        </div>
        <div v-if="fieldForm.type === 'REF'" class="form-item req"><label>引用主数据域</label>
          <select v-model="fieldForm.refDomain" style="width:100%">
            <option value="">请选择</option>
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}</option>
          </select>
        </div>
        <div class="form-item"><label>占位提示</label><input v-model="fieldForm.placeholder" style="width:100%" /></div>
        <div class="form-item"><label>最大长度（文本）</label><input v-model.number="fieldForm.maxLength" type="number" style="width:100%" /></div>
        <div class="form-item"><label>格式校验正则</label><input v-model="fieldForm.regex" placeholder="可选" style="width:100%" /></div>
      </div>
      <div class="flex" style="gap:18px">
        <label class="hint"><input v-model="fieldForm.required" type="checkbox" /> 必填</label>
        <label class="hint"><input v-model="fieldForm.uniqueFlag" type="checkbox" /> 唯一</label>
        <label class="hint"><input v-model="fieldForm.queryFlag" type="checkbox" /> 可查询（建索引）</label>
      </div>
      <template #footer>
        <button class="btn" @click="fieldVisible = false">取消</button>
        <button class="btn primary" @click="saveField">保存</button>
      </template>
    </el-dialog>

    <el-dialog v-model="ruleVisible" title="编码规则配置" width="640px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>主数据域</label>
          <select v-model="ruleForm.domain" style="width:100%" @change="rulePreview = null">
            <option v-for="d in domains" :key="d.code" :value="d.code">{{ d.name }}（{{ d.code }}）</option>
          </select>
        </div>
        <div class="form-item"><label>规则名称</label><input v-model="ruleForm.name" style="width:100%" /></div>
      </div>
      <div class="card-head" style="padding:0;border:none">规则段
        <button class="btn sm" @click="addSegment">添加段</button>
      </div>
      <div v-for="(s, i) in ruleForm.segments" :key="i" class="flex mt10">
        <select v-model="s.type" style="width:110px">
          <option value="FIX">固定值</option><option value="DATE">日期</option><option value="JOIN">连接符</option><option value="SEQ">流水号</option>
        </select>
        <input v-if="['FIX', 'JOIN'].includes(s.type)" v-model="s.value" :placeholder="s.type === 'FIX' ? '如 WL' : '如 -'" style="width:100px" />
        <input v-if="s.type === 'DATE'" v-model="s.fmt" placeholder="yyyyMMdd" style="width:120px" />
        <input v-if="s.type === 'SEQ'" v-model.number="s.len" type="number" placeholder="位数" style="width:70px" />
        <select v-if="s.type === 'SEQ'" v-model="s.reset" style="width:110px">
          <option value="DAY">按日重置</option><option value="MONTH">按月重置</option><option value="FOREVER">永久累加</option>
        </select>
        <span class="link" style="color:var(--err)" @click="removeSegment(i)">移除</span>
      </div>
      <div class="flex mt10">
        <button class="btn sm" @click="previewRule">保存并预览</button>
        <span v-if="rulePreview" class="num" style="font-weight:700">{{ rulePreview.code }}</span>
        <span v-if="rulePreview?.error" class="hint" style="color:var(--err)">{{ rulePreview.error }}</span>
      </div>
      <template #footer>
        <button class="btn" @click="ruleVisible = false">取消</button>
        <button class="btn primary" @click="saveRule">保存</button>
      </template>
    </el-dialog>

    <el-dialog v-model="domainVisible" title="新建数据域" width="520px" destroy-on-close>
      <div class="form-item req"><label>数据域编码</label><input v-model="domainForm.code" placeholder="如 sales_team（小写字母开头，仅小写字母/数字/下划线）" style="width:100%" /></div>
      <div class="form-item req"><label>数据域名称</label><input v-model="domainForm.name" placeholder="如 销售团队主数据" style="width:100%" /></div>
      <div class="form-item"><label>归口部门</label><input v-model="domainForm.owner" placeholder="如 销售部" style="width:100%" /></div>
      <div class="form-item"><label>说明</label><input v-model="domainForm.description" placeholder="选填" style="width:100%" /></div>
      <template #footer>
        <button class="btn" @click="domainVisible = false">取消</button>
        <button class="btn primary" @click="saveDomain">创建</button>
      </template>
    </el-dialog>
  </div>
</template>
