<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { workflowApi } from '../api';
import { useAuth } from '../stores/auth';

const auth = useAuth();
const canManage = computed(() => auth.has('workflow.manage'));

const meta = ref<any>({ nodeTypes: [], domains: [] });
const defs = ref<any[]>([]);
const current = ref<any>({ id: null, code: '', name: '', domainCode: '', description: '', status: 'DRAFT', nodes: [] });
const selectedNodeId = ref('');
const selectedNode = computed(() => current.value.nodes.find((n: any) => n.id === selectedNodeId.value) || null);
const dirty = ref(false);

const canvasRef = ref<HTMLElement | null>(null);
const runs = ref<any>({ list: [], total: 0, page: 1, size: 8 });
const resultVisible = ref(false);
const runDetail = ref<any>(null);
const previewRows = ref<any[]>([]);
const previewTitle = ref('输出结果');

const infoVisible = ref(false);
const infoForm = reactive<any>({ code: '', name: '', description: '' });

const nodeTypeMeta = computed(() =>
  Object.fromEntries((meta.value.nodeTypes || []).map((t: any) => [t.type, t])),
);
const domainFields = computed(() => meta.value.domains.find((d: any) => d.code === current.value.domainCode)?.fields || []);
const joinFields = computed(() => meta.value.domains.find((d: any) => d.code === selectedNode.value?.config?.joinDomain)?.fields || []);
const canvasHeight = computed(() => Math.max(430, ...current.value.nodes.map((n: any) => Number(n.y) + 120)));

const TYPE_ICON: Record<string, string> = {
  DB_INPUT: '▤', SELECT: '◫', FILTER: '⛃', FORMULA: 'ƒ', DEDUP: '⧉', SORT: '↕', AGG: 'Σ',
  JOIN: '⛓', UNION: '⊞', CODE_MAP: '⇄', NORMALIZE: '✎', FILL_EMPTY: '▢', OUTPUT: '◉',
};

// ---------------- 加载 ----------------
async function loadMeta() {
  meta.value = await workflowApi.meta();
}
async function loadDefs(selectId?: number) {
  defs.value = (await workflowApi.definitions()) || [];
  const target = selectId || current.value.id || defs.value[0]?.id;
  if (target) await openDef(target);
  else newDef();
}
async function openDef(id: number) {
  const d = await workflowApi.definition(id);
  current.value = { ...d, nodes: JSON.parse(JSON.stringify(d.nodes || [])) };
  selectedNodeId.value = '';
  dirty.value = false;
  resultVisible.value = false;
  runs.value.page = 1;
  await loadRuns();
}
async function loadRuns() {
  if (!current.value.id) {
    runs.value = { list: [], total: 0, page: 1, size: 8 };
    return;
  }
  runs.value = await workflowApi.runs({ definitionId: current.value.id, page: runs.value.page, size: runs.value.size });
}

function newDef() {
  current.value = {
    id: null, code: '', name: '', domainCode: meta.value.domains[0]?.code || '', description: '',
    status: 'DRAFT', nodes: [],
  };
  selectedNodeId.value = '';
  dirty.value = false;
  runs.value = { list: [], total: 0, page: 1, size: 8 };
}
function onSelectDef(e: any) {
  const id = Number(e.target.value);
  if (id) openDef(id);
  else newDef();
}

// ---------------- 画布编辑 ----------------
function defaultConfig(type: string) {
  switch (type) {
    case 'DB_INPUT': return { limit: 200, status: 'PUBLISHED' };
    case 'SELECT': return { fields: [] };
    case 'FILTER': return { logic: 'AND', conditions: [] };
    case 'FORMULA': return { target: 'newField', expression: '' };
    case 'DEDUP': return { fields: [] };
    case 'SORT': return { field: '', order: 'asc' };
    case 'AGG': return { groupBy: [], metrics: [{ field: 'recordId', agg: 'count', as: 'cnt' }] };
    case 'JOIN': return { joinDomain: '', joinStatus: 'PUBLISHED', joinType: 'inner', leftKey: '', rightKey: '', rightFields: [] };
    case 'UNION': return { unionDomain: '', unionStatus: 'PUBLISHED' };
    case 'CODE_MAP': return { field: '', mode: 'manual', dictCode: '', mapping: [{ from: '', to: '' }], defaultVal: '' };
    case 'NORMALIZE': return { fields: [], trim: true, case: '', replace: [] };
    case 'FILL_EMPTY': return { fills: [{ field: '', value: '' }] };
    case 'OUTPUT': return { fields: [], submit: false, domainCode: '', keyField: '' };
    default: return {};
  }
}
function addNode(type: string) {
  if (!canManage.value) return;
  const idx = current.value.nodes.length;
  const node = {
    id: `${type.toLowerCase()}_${Date.now().toString(36)}`,
    type,
    name: nodeTypeMeta.value[type]?.name || type,
    x: 24 + (idx % 4) * 196,
    y: 24 + Math.floor(idx / 4) * 132,
    config: defaultConfig(type),
  };
  current.value.nodes.push(node);
  selectedNodeId.value = node.id;
  dirty.value = true;
}
function removeNode(id: string) {
  current.value.nodes = current.value.nodes.filter((n: any) => n.id !== id);
  if (selectedNodeId.value === id) selectedNodeId.value = '';
  dirty.value = true;
}
function nodeCenter(n: any) {
  return { x: Number(n.x) + 156, y: Number(n.y) + 32 };
}
const links = computed(() =>
  current.value.nodes.slice(0, -1).map((n: any, i: number) => {
    const a = nodeCenter(n);
    const b = current.value.nodes[i + 1];
    return { id: `${n.id}-${b.id}`, d: `M ${a.x} ${a.y} C ${a.x + 40} ${a.y}, ${Number(b.x) - 40} ${Number(b.y) + 32}, ${Number(b.x)} ${Number(b.y) + 32}` };
  }),
);

let drag: { id: string; dx: number; dy: number } | null = null;
function startDrag(e: MouseEvent, node: any) {
  if (!canManage.value || !canvasRef.value) return;
  selectedNodeId.value = node.id;
  const rect = canvasRef.value.getBoundingClientRect();
  drag = { id: node.id, dx: e.clientX - rect.left - Number(node.x), dy: e.clientY - rect.top - Number(node.y) };
  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', endDrag);
}
function onDrag(e: MouseEvent) {
  if (!drag || !canvasRef.value) return;
  const rect = canvasRef.value.getBoundingClientRect();
  const node = current.value.nodes.find((n: any) => n.id === drag!.id);
  if (!node) return;
  node.x = Math.max(0, Math.round(e.clientX - rect.left - drag.dx));
  node.y = Math.max(0, Math.round(e.clientY - rect.top - drag.dy));
  dirty.value = true;
}
function endDrag() {
  drag = null;
  window.removeEventListener('mousemove', onDrag);
  window.removeEventListener('mouseup', endDrag);
}

// ---------------- 文本 <-> 数组 ----------------
function arrText(arr: any) {
  return Array.isArray(arr) ? arr.join(', ') : '';
}
function setArr(node: any, key: string, text: string) {
  node.config[key] = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
  dirty.value = true;
}
function touch() { dirty.value = true; }

// ---------------- 保存 / 运行 ----------------
function openInfo() {
  Object.assign(infoForm, { code: current.value.code, name: current.value.name, description: current.value.description });
  infoVisible.value = true;
}
function applyInfo() {
  current.value.code = infoForm.code;
  current.value.name = infoForm.name;
  current.value.description = infoForm.description;
  infoVisible.value = false;
  dirty.value = true;
}
async function save(status?: string) {
  if (!current.value.code || !current.value.name || !current.value.domainCode) {
    ElMessage.warning('请先补全编码、名称与数据域');
    openInfo();
    return null;
  }
  if (!current.value.nodes.length) {
    ElMessage.warning('请至少添加一个节点');
    return null;
  }
  const payload = {
    id: current.value.id, code: current.value.code, name: current.value.name,
    domainCode: current.value.domainCode, description: current.value.description,
    status: status || current.value.status, nodes: current.value.nodes,
  };
  const res = await workflowApi.save(payload);
  if (status) current.value.status = status;
  dirty.value = false;
  ElMessage.success('工作流已保存');
  defs.value = (await workflowApi.definitions()) || [];
  await openDef(res.id || current.value.id);
  return res.id || current.value.id;
}
async function publish() {
  await save('PUBLISHED');
}
async function run() {
  let id = current.value.id;
  if (!id || dirty.value) id = await save();
  if (!id) return;
  const res = await workflowApi.run(id);
  runDetail.value = res;
  previewRows.value = res.output || [];
  previewTitle.value = '最终输出';
  resultVisible.value = true;
  await loadRuns();
  if (res.status === 'SUCCESS') ElMessage.success(`运行成功：输出 ${res.row_count} 行`);
  else ElMessage.error(res.message || '工作流运行失败');
}
async function openRun(id: number) {
  const res = await workflowApi.runDetail(id);
  runDetail.value = res;
  previewRows.value = res.output || [];
  previewTitle.value = '最终输出';
  resultVisible.value = true;
}
function showPreview(nr: any) {
  previewRows.value = nr.preview || [];
  previewTitle.value = `「${nr.node_name}」预览`;
}
const previewCols = computed(() => {
  const cols: string[] = [];
  for (const r of previewRows.value || []) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols;
});

onMounted(async () => {
  await loadMeta();
  await loadDefs();
});
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>数据工作流</h2>
        <p class="desc">节点式编排主数据加工：读取 → 过滤 / 计算 / 聚合 → 预览输出，按节点顺序执行并留存运行轨迹</p>
      </div>
      <div class="flex">
        <button class="btn" @click="openInfo">基本信息</button>
        <button v-if="canManage" class="btn" @click="save()">保存草稿</button>
        <button v-if="canManage" class="btn" @click="publish">发布</button>
        <button v-if="canManage" class="btn primary" @click="run">▶ 运行</button>
      </div>
    </div>

    <div class="fbar">
      <div class="f-item">
        <select :value="current.id || ''" @change="onSelectDef" style="min-width:260px">
          <option value="">— 新建工作流 —</option>
          <option v-for="d in defs" :key="d.id" :value="d.id">{{ d.name }}（{{ d.code }}）</option>
        </select>
      </div>
      <span v-if="current.code" class="tag" :class="current.status === 'PUBLISHED' ? 'g' : 's'">{{ current.status === 'PUBLISHED' ? '已发布' : '草稿' }}</span>
      <span v-if="current.domainCode" class="tag b">{{ meta.domains.find((d: any) => d.code === current.domainCode)?.name || current.domainCode }}</span>
      <span v-if="dirty" class="hint">有未保存的修改</span>
      <div class="fr"></div>
      <button v-if="canManage" class="btn sm" @click="newDef">新建</button>
      <button class="btn sm" @click="loadRuns">刷新历史</button>
    </div>

    <div class="wf-layout">
      <!-- 工具箱 -->
      <div class="card wf-toolbox">
        <div class="card-head">算子工具箱</div>
        <div class="wf-tool-list">
          <div v-for="t in meta.nodeTypes" :key="t.type" class="wf-tool" :class="{ disabled: !canManage }" @click="addNode(t.type)">
            <span class="wf-tool-ico">{{ TYPE_ICON[t.type] || '▪' }}</span>
            <span class="wf-tool-name">{{ t.name }}</span>
            <span class="wf-tool-group">{{ t.group }}</span>
          </div>
        </div>
        <div class="wf-tip">
          <p class="hint">点击算子添加到画布，拖动节点调整位置。</p>
          <p class="hint">执行顺序按节点添加顺序串联。</p>
        </div>
      </div>

      <!-- 画布 -->
      <div class="card wf-canvas-card">
        <div class="card-head">
          <span>流程画布</span>
          <span class="hint">{{ current.nodes.length }} 个节点</span>
        </div>
        <div ref="canvasRef" class="wf-canvas" :style="{ height: canvasHeight + 'px' }">
          <svg class="wf-links" :width="'100%'" :height="canvasHeight">
            <path v-for="l in links" :key="l.id" :d="l.d" fill="none" stroke="#93c5fd" stroke-width="2" />
          </svg>
          <div
            v-for="n in current.nodes"
            :key="n.id"
            class="wf-node"
            :class="[`t-${n.type}`, { active: selectedNodeId === n.id }]"
            :style="{ left: n.x + 'px', top: n.y + 'px' }"
            @mousedown="startDrag($event, n)"
            @click="selectedNodeId = n.id"
          >
            <div class="wf-node-head">
              <span class="wf-node-ico">{{ TYPE_ICON[n.type] || '▪' }}</span>
              <span class="wf-node-name">{{ n.name }}</span>
              <span v-if="canManage" class="wf-node-del" @click.stop="removeNode(n.id)">×</span>
            </div>
            <div class="wf-node-body">
              <span class="tag s">{{ nodeTypeMeta[n.type]?.name || n.type }}</span>
              <span class="hint wf-node-id">{{ n.id }}</span>
            </div>
          </div>
          <div v-if="!current.nodes.length" class="wf-empty">
            <p>从左侧工具箱添加算子，搭建你的数据加工流程</p>
            <button v-if="canManage" class="btn sm primary" @click="addNode('DB_INPUT')">添加「读取主数据」</button>
          </div>
        </div>
      </div>

      <!-- 配置 + 历史 -->
      <div class="wf-side">
        <div class="card">
          <div class="card-head">节点配置</div>
          <div v-if="selectedNode" class="card-body wf-config">
            <div class="form-item"><label>节点名称</label>
              <input v-model="selectedNode.name" style="width:100%" @input="touch" />
            </div>
            <div class="form-item"><label>算子类型</label>
              <span class="tag b">{{ nodeTypeMeta[selectedNode.type]?.name || selectedNode.type }}</span>
            </div>

            <template v-if="selectedNode.type === 'DB_INPUT'">
              <div class="grid-form">
                <div class="form-item"><label>读取数据域</label>
                  <span class="hint">{{ current.domainCode }}</span>
                </div>
                <div class="form-item"><label>记录上限</label>
                  <input v-model.number="selectedNode.config.limit" type="number" style="width:100%" @input="touch" />
                </div>
              </div>
              <div class="form-item"><label>记录状态</label>
                <select v-model="selectedNode.config.status" style="width:100%" @change="touch">
                  <option value="PUBLISHED">已发布</option>
                  <option value="DRAFT">草稿</option>
                </select>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'SELECT'">
              <div class="form-item"><label>保留字段（逗号分隔，留空保留全部）</label>
                <input :value="arrText(selectedNode.config.fields)" placeholder="masterCode, name, unit" style="width:100%" @input="setArr(selectedNode, 'fields', ($event.target as any).value)" />
              </div>
              <div class="wf-field-chips">
                <span v-for="f in domainFields" :key="f.field_key" class="wf-chip" @click="selectedNode.config.fields = Array.from(new Set([...(selectedNode.config.fields || []), f.field_key])); touch()">{{ f.field_key }}</span>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'FILTER'">
              <div class="form-item"><label>条件逻辑</label>
                <select v-model="selectedNode.config.logic" style="width:100%" @change="touch">
                  <option value="AND">全部满足（AND）</option><option value="OR">任一满足（OR）</option>
                </select>
              </div>
              <div class="form-item"><label>过滤条件</label>
                <div v-for="(c, i) in selectedNode.config.conditions" :key="i" class="wf-cond">
                  <input v-model="c.field" placeholder="字段" style="flex:1" @input="touch" />
                  <select v-model="c.op" style="width:88px" @change="touch">
                    <option value="notEmpty">非空</option><option value="empty">为空</option>
                    <option value="eq">等于</option><option value="ne">不等于</option>
                    <option value="gt">大于</option><option value="gte">大于等于</option>
                    <option value="lt">小于</option><option value="lte">小于等于</option>
                    <option value="contains">包含</option><option value="regex">正则</option>
                  </select>
                  <input v-model="c.value" placeholder="值" style="width:82px" @input="touch" />
                  <span class="link" @click="selectedNode.config.conditions.splice(i, 1); touch()">×</span>
                </div>
                <button class="btn sm" style="margin-top:6px" @click="selectedNode.config.conditions.push({ field: '', op: 'eq', value: '' }); touch()">+ 添加条件</button>
              </div>
              <div class="wf-field-chips">
                <span v-for="f in domainFields" :key="f.field_key" class="wf-chip" @click="selectedNode.config.conditions.push({ field: f.field_key, op: 'notEmpty', value: '' }); touch()">{{ f.field_key }}</span>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'FORMULA'">
              <div class="form-item"><label>目标字段</label>
                <input v-model="selectedNode.config.target" style="width:100%" @input="touch" />
              </div>
              <div class="form-item"><label>表达式（支持 + - * / 与字段名）</label>
                <input v-model="selectedNode.config.expression" placeholder="如 price * 1.13" style="width:100%" @input="touch" />
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'DEDUP'">
              <div class="form-item"><label>去重字段（逗号分隔）</label>
                <input :value="arrText(selectedNode.config.fields)" placeholder="unit" style="width:100%" @input="setArr(selectedNode, 'fields', ($event.target as any).value)" />
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'SORT'">
              <div class="grid-form">
                <div class="form-item"><label>排序字段</label><input v-model="selectedNode.config.field" style="width:100%" @input="touch" /></div>
                <div class="form-item"><label>方向</label>
                  <select v-model="selectedNode.config.order" style="width:100%" @change="touch"><option value="asc">升序</option><option value="desc">降序</option></select>
                </div>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'AGG'">
              <div class="form-item"><label>分组字段（逗号分隔）</label>
                <input :value="arrText(selectedNode.config.groupBy)" placeholder="region" style="width:100%" @input="setArr(selectedNode, 'groupBy', ($event.target as any).value)" />
              </div>
              <div class="form-item"><label>聚合指标</label>
                <div v-for="(m, i) in selectedNode.config.metrics" :key="i" class="wf-cond">
                  <input v-model="m.field" placeholder="字段" style="flex:1" @input="touch" />
                  <select v-model="m.agg" style="width:72px" @change="touch">
                    <option value="count">计数</option><option value="sum">求和</option><option value="avg">平均</option>
                    <option value="max">最大</option><option value="min">最小</option>
                  </select>
                  <input v-model="m.as" placeholder="别名" style="width:82px" @input="touch" />
                  <span class="link" @click="selectedNode.config.metrics.splice(i, 1); touch()">×</span>
                </div>
                <button class="btn sm" style="margin-top:6px" @click="selectedNode.config.metrics.push({ field: '', agg: 'count', as: 'cnt' }); touch()">+ 添加指标</button>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'JOIN'">
              <div class="grid-form">
                <div class="form-item req"><label>右表数据域</label>
                  <select v-model="selectedNode.config.joinDomain" style="width:100%" @change="touch">
                    <option value="">请选择</option>
                    <option v-for="d in meta.domains" :key="d.code" :value="d.code">{{ d.name }}（{{ d.code }}）</option>
                  </select>
                </div>
                <div class="form-item"><label>连接类型</label>
                  <select v-model="selectedNode.config.joinType" style="width:100%" @change="touch">
                    <option value="inner">内连接（交集）</option>
                    <option value="left">左连接（保留左表）</option>
                    <option value="right">右连接（保留右表）</option>
                    <option value="full">全连接（并集）</option>
                  </select>
                </div>
              </div>
              <div class="grid-form">
                <div class="form-item req"><label>左表连接键</label>
                  <input v-model="selectedNode.config.leftKey" placeholder="如 masterCode" style="width:100%" @input="touch" />
                </div>
                <div class="form-item req"><label>右表连接键</label>
                  <input v-model="selectedNode.config.rightKey" placeholder="如 masterCode" style="width:100%" @input="touch" />
                </div>
              </div>
              <div class="form-item"><label>右表记录状态</label>
                <select v-model="selectedNode.config.joinStatus" style="width:100%" @change="touch">
                  <option value="PUBLISHED">已发布</option>
                  <option value="DRAFT">草稿</option>
                </select>
              </div>
              <div class="form-item"><label>右表保留字段（逗号分隔，留空取全部，重名字段自动加 r_ 前缀）</label>
                <input :value="arrText(selectedNode.config.rightFields)" placeholder="如 name, unit" style="width:100%" @input="setArr(selectedNode, 'rightFields', ($event.target as any).value)" />
              </div>
              <div class="wf-field-chips">
                <span v-for="f in joinFields" :key="f.field_key" class="wf-chip" @click="selectedNode.config.rightFields = Array.from(new Set([...(selectedNode.config.rightFields || []), f.field_key])); touch()">{{ f.field_key }}</span>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'UNION'">
              <div class="form-item req"><label>追加数据域</label>
                <select v-model="selectedNode.config.unionDomain" style="width:100%" @change="touch">
                  <option value="">请选择</option>
                  <option v-for="d in meta.domains" :key="d.code" :value="d.code">{{ d.name }}（{{ d.records }} 条）</option>
                </select>
              </div>
              <div class="form-item"><label>追加记录状态</label>
                <select v-model="selectedNode.config.unionStatus" style="width:100%" @change="touch">
                  <option value="PUBLISHED">已发布</option>
                  <option value="DRAFT">草稿</option>
                </select>
              </div>
              <div class="hint">将该数据域的记录追加到当前数据流末尾，字段取并集，缺失字段留空。</div>
            </template>

            <template v-else-if="selectedNode.type === 'CODE_MAP'">
              <div class="form-item req"><label>目标字段</label>
                <input v-model="selectedNode.config.field" placeholder="如 status" style="width:100%" @input="touch" />
              </div>
              <div class="wf-field-chips">
                <span v-for="f in domainFields" :key="f.field_key" class="wf-chip" @click="selectedNode.config.field = f.field_key; touch()">{{ f.field_key }}</span>
              </div>
              <div class="grid-form">
                <div class="form-item"><label>映射方式</label>
                  <select v-model="selectedNode.config.mode" style="width:100%" @change="touch">
                    <option value="manual">手工映射</option>
                    <option value="dict">按码表转换（value → label）</option>
                  </select>
                </div>
                <div class="form-item"><label>未命中默认值</label>
                  <input v-model="selectedNode.config.defaultVal" placeholder="留空保留原值" style="width:100%" @input="touch" />
                </div>
              </div>
              <div v-if="selectedNode.config.mode === 'dict'" class="form-item req"><label>码表</label>
                <select v-model="selectedNode.config.dictCode" style="width:100%" @change="touch">
                  <option value="">请选择</option>
                  <option v-for="d in meta.dicts" :key="d.code" :value="d.code">{{ d.name }}（{{ d.code }}）</option>
                </select>
              </div>
              <div v-else class="form-item"><label>映射规则（原值 → 映射值）</label>
                <div v-for="(m, i) in selectedNode.config.mapping" :key="i" class="wf-cond">
                  <input v-model="m.from" placeholder="原值" style="flex:1" @input="touch" />
                  <span class="hint">→</span>
                  <input v-model="m.to" placeholder="映射值" style="flex:1" @input="touch" />
                  <span class="link" @click="selectedNode.config.mapping.splice(i, 1); touch()">×</span>
                </div>
                <button class="btn sm" style="margin-top:6px" @click="selectedNode.config.mapping.push({ from: '', to: '' }); touch()">+ 添加规则</button>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'NORMALIZE'">
              <div class="form-item req"><label>标准化字段（逗号分隔）</label>
                <input :value="arrText(selectedNode.config.fields)" placeholder="如 name, unit" style="width:100%" @input="setArr(selectedNode, 'fields', ($event.target as any).value)" />
              </div>
              <div class="wf-field-chips">
                <span v-for="f in domainFields" :key="f.field_key" class="wf-chip" @click="selectedNode.config.fields = Array.from(new Set([...(selectedNode.config.fields || []), f.field_key])); touch()">{{ f.field_key }}</span>
              </div>
              <div class="grid-form">
                <div class="form-item"><label>去首尾空格</label>
                  <label><input v-model="selectedNode.config.trim" type="checkbox" style="vertical-align:-2px" @change="touch" /> 开启</label>
                </div>
                <div class="form-item"><label>大小写</label>
                  <select v-model="selectedNode.config.case" style="width:100%" @change="touch">
                    <option value="">不转换</option>
                    <option value="upper">转大写</option>
                    <option value="lower">转小写</option>
                  </select>
                </div>
              </div>
              <div class="form-item"><label>字符替换</label>
                <div v-for="(rep, i) in selectedNode.config.replace" :key="i" class="wf-cond">
                  <input v-model="rep.from" placeholder="查找" style="flex:1" @input="touch" />
                  <span class="hint">→</span>
                  <input v-model="rep.to" placeholder="替换为" style="flex:1" @input="touch" />
                  <span class="link" @click="selectedNode.config.replace.splice(i, 1); touch()">×</span>
                </div>
                <button class="btn sm" style="margin-top:6px" @click="selectedNode.config.replace.push({ from: '', to: '' }); touch()">+ 添加替换</button>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'FILL_EMPTY'">
              <div class="form-item"><label>填充规则（字段为空时填充指定值）</label>
                <div v-for="(f, i) in selectedNode.config.fills" :key="i" class="wf-cond">
                  <input v-model="f.field" placeholder="字段" style="flex:1" @input="touch" />
                  <span class="hint">=</span>
                  <input v-model="f.value" placeholder="填充值" style="flex:1" @input="touch" />
                  <span class="link" @click="selectedNode.config.fills.splice(i, 1); touch()">×</span>
                </div>
                <button class="btn sm" style="margin-top:6px" @click="selectedNode.config.fills.push({ field: '', value: '' }); touch()">+ 添加规则</button>
              </div>
              <div class="wf-field-chips">
                <span v-for="f in domainFields" :key="f.field_key" class="wf-chip" @click="selectedNode.config.fills.push({ field: f.field_key, value: '' }); touch()">{{ f.field_key }}</span>
              </div>
            </template>

            <template v-else-if="selectedNode.type === 'OUTPUT'">
              <div class="form-item"><label>输出字段（逗号分隔，留空输出全部）</label>
                <input :value="arrText(selectedNode.config.fields)" placeholder="masterCode, name" style="width:100%" @input="setArr(selectedNode, 'fields', ($event.target as any).value)" />
              </div>
              <div class="form-item">
                <label><input v-model="selectedNode.config.submit" type="checkbox" style="vertical-align:-2px" @change="touch" /> 运行结束后写回主数据并提交审批</label>
              </div>
              <template v-if="selectedNode.config.submit">
                <div class="form-item req"><label>写回数据域</label>
                  <select v-model="selectedNode.config.domainCode" style="width:100%" @change="touch">
                    <option value="">默认当前数据域</option>
                    <option v-for="d in meta.domains" :key="d.code" :value="d.code">{{ d.name }}（{{ d.code }}）</option>
                  </select>
                </div>
                <div class="form-item"><label>查重键字段（选填）</label>
                  <input v-model="selectedNode.config.keyField" placeholder="如 materialName" style="width:100%" @input="touch" />
                  <div class="hint">已存在同值记录（主数据编码或该字段）的行将跳过，避免重复落库。</div>
                </div>
              </template>
              <div v-else class="hint">默认仅生成预览，不写回主数据；勾选后按目标域模型校验并走新增 + 审批链路。</div>
            </template>
          </div>
          <div v-else class="card-body hint">在画布中选择一个节点进行配置</div>
        </div>

        <div class="card mt14">
          <div class="card-head">
            <span>运行历史</span>
            <span v-if="runs.total" class="hint">共 {{ runs.total }} 次</span>
          </div>
          <div class="wf-runs">
            <div v-for="r in runs.list" :key="r.id" class="wf-run" @click="openRun(r.id)">
              <span class="tag" :class="r.status === 'SUCCESS' ? 'g' : 'r'">{{ r.status === 'SUCCESS' ? '成功' : '失败' }}</span>
              <span class="wf-run-main">#{{ r.id }} · {{ r.row_count }} 行</span>
              <span class="hint">{{ String(r.started_at || '').slice(5, 16).replace('T', ' ') }}</span>
            </div>
            <div v-if="!runs.list.length" class="hint" style="padding:10px 14px">暂无运行记录</div>
            <div v-if="runs.total > runs.size" class="pgn" style="padding:8px 14px">
              <button :disabled="runs.page <= 1" @click="runs.page--; loadRuns()">‹</button>
              <button class="cur">{{ runs.page }}</button>
              <button :disabled="runs.page * runs.size >= runs.total" @click="runs.page++; loadRuns()">›</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 基本信息 -->
    <el-dialog v-model="infoVisible" title="工作流基本信息" width="560px" destroy-on-close>
      <div class="grid-form">
        <div class="form-item req"><label>编码</label><input v-model="infoForm.code" placeholder="WF-XXX" style="width:100%" /></div>
        <div class="form-item req"><label>名称</label><input v-model="infoForm.name" style="width:100%" /></div>
      </div>
      <div class="form-item req"><label>数据域</label>
        <select v-model="current.domainCode" style="width:100%" @change="touch">
          <option v-for="d in meta.domains" :key="d.code" :value="d.code">{{ d.name }}（{{ d.records }} 条已发布）</option>
        </select>
      </div>
      <div class="form-item"><label>说明</label><textarea v-model="infoForm.description" rows="3" style="width:100%" /></div>
      <template #footer>
        <button class="btn" @click="infoVisible = false">取消</button>
        <button class="btn primary" @click="applyInfo">确定</button>
      </template>
    </el-dialog>

    <!-- 运行结果 -->
    <el-drawer v-model="resultVisible" title="运行结果" size="820px" destroy-on-close>
      <template v-if="runDetail">
        <div class="flex" style="justify-content:space-between">
          <div>
            <b>#{{ runDetail.id }} · {{ runDetail.definition_name }}</b>
            <div class="hint">{{ String(runDetail.started_at || '').replace('T', ' ') }} · 输出 {{ runDetail.row_count }} 行 · {{ runDetail.created_by }}</div>
          </div>
          <span class="tag" :class="runDetail.status === 'SUCCESS' ? 'g' : 'r'">{{ runDetail.status === 'SUCCESS' ? '运行成功' : '运行失败' }}</span>
        </div>
        <div v-if="runDetail.message" class="hint mt10" style="color:var(--err)">{{ runDetail.message }}</div>
        <h4 class="mt14">节点轨迹</h4>
        <div class="wf-timeline">
          <div v-for="(nr, i) in runDetail.nodeRuns" :key="nr.id" class="wf-tl" :class="{ ok: nr.status === 'SUCCESS', bad: nr.status !== 'SUCCESS' }" @click="showPreview(nr)">
            <i>{{ i + 1 }}</i>
            <div class="wf-tl-main">
              <b>{{ nr.node_name }}</b>
              <span class="hint"> {{ nr.node_type }} · 入 {{ nr.rows_in }} → 出 {{ nr.rows_out }} · {{ nr.duration_ms }}ms</span>
              <div class="hint">{{ nr.message }}</div>
            </div>
            <span class="tag s">预览</span>
          </div>
          <div v-if="!runDetail.nodeRuns?.length" class="hint">无节点执行记录</div>
        </div>
        <div class="flex mt14" style="justify-content:space-between">
          <h4>{{ previewTitle }}</h4>
          <span class="hint">最多展示 50 行</span>
        </div>
        <div class="wf-preview">
          <table class="tbl">
            <thead><tr><th v-for="c in previewCols" :key="c">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(row, i) in previewRows.slice(0, 20)" :key="i">
                <td v-for="c in previewCols" :key="c">{{ row[c] }}</td>
              </tr>
              <tr v-if="!previewRows.length"><td :colspan="previewCols.length || 1" class="muted">暂无数据</td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.wf-layout { display: grid; grid-template-columns: 186px minmax(420px, 1fr) 320px; gap: 12px; align-items: start; }
.wf-toolbox .wf-tool-list { padding: 8px; }
.wf-tool { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--bd); border-radius: 8px; margin-bottom: 6px; cursor: pointer; font-size: 12.5px; transition: .15s; }
.wf-tool:hover { border-color: var(--p); background: #f5f9ff; }
.wf-tool.disabled { opacity: .55; cursor: not-allowed; }
.wf-tool-ico { width: 18px; text-align: center; color: var(--p); }
.wf-tool-name { flex: 1; }
.wf-tool-group { font-size: 11px; color: var(--mut); }
.wf-tip { padding: 4px 12px 12px; }
.wf-canvas { position: relative; background-color: #fbfdff; background-image: linear-gradient(#eef4fb 1px, transparent 1px), linear-gradient(90deg, #eef4fb 1px, transparent 1px); background-size: 20px 20px; overflow: auto; }
.wf-links { position: absolute; left: 0; top: 0; pointer-events: none; }
.wf-node { position: absolute; width: 156px; background: #fff; border: 1px solid #bfdbfe; border-radius: 9px; box-shadow: 0 2px 6px rgba(37, 99, 235, .08); cursor: grab; user-select: none; z-index: 2; }
.wf-node.active { border-color: var(--p); box-shadow: 0 0 0 3px var(--pl); }
.wf-node-head { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-bottom: 1px solid #eff6ff; background: #f7fbff; border-radius: 9px 9px 0 0; }
.wf-node-ico { color: var(--p); flex: none; }
.wf-node-name { font-size: 12px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-node-del { color: var(--mut); cursor: pointer; padding: 0 2px; }
.wf-node-del:hover { color: var(--err); }
.wf-node-body { padding: 6px 9px; display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.wf-node-id { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--mut); font-size: 13px; }
.wf-side { min-width: 0; }
.wf-config { max-height: 460px; overflow: auto; }
.wf-cond { display: flex; gap: 4px; align-items: center; margin-bottom: 5px; }
.wf-cond input, .wf-cond select { border: 1px solid var(--bd); border-radius: 5px; padding: 3px 6px; font-size: 12px; }
.wf-field-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.wf-chip { font-size: 11px; background: #f1f5f9; border-radius: 10px; padding: 1px 7px; cursor: pointer; color: var(--mut); }
.wf-chip:hover { background: var(--pl); color: var(--pd); }
.wf-runs { max-height: 260px; overflow: auto; }
.wf-run { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px dashed #eef2f7; cursor: pointer; font-size: 12px; }
.wf-run:hover { background: #f8fbff; }
.wf-run-main { flex: 1; }
.wf-timeline { border-left: 2px solid #e2e8f0; margin-left: 8px; padding-left: 12px; }
.wf-tl { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; cursor: pointer; }
.wf-tl i { font-style: normal; width: 18px; height: 18px; line-height: 18px; border-radius: 50%; background: var(--ok); color: #fff; font-size: 11px; text-align: center; flex: none; margin-left: -22px; }
.wf-tl.bad i { background: var(--err); }
.wf-tl-main { flex: 1; }
.wf-tl:hover .wf-tl-main b { color: var(--p); }
.wf-preview { max-height: 380px; overflow: auto; border: 1px solid var(--bd); border-radius: 8px; }
.wf-preview table { font-size: 12px; }
</style>
