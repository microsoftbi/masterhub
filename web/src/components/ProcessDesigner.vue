<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { approvalApi } from '../api';

/**
 * 可视化流程设计器（M6）：线性审批链编排 —— 开始 → [抄送/审批/自动节点…] → 结束。
 * 保存为 ap_process_def.definition（nodes + flows），连线由链路顺序自动生成。
 */
const props = defineProps<{ process: any }>();
const emit = defineEmits(['saved']);

const options = ref<any>({ users: [], roles: [], domains: [] });
const form = reactive<any>({ code: '', name: '', domain: '*', action: 'CREATE' });
const chain = ref<any[]>([]);
const selectedId = ref('');
const saving = ref(false);

const TYPE_META: Record<string, { label: string; tag: string }> = {
  APPROVAL: { label: '审批', tag: 'b' },
  CC: { label: '抄送', tag: 'p' },
  AUTO: { label: '自动', tag: 's' },
};

const selected = computed(() => chain.value.find((n) => n.id === selectedId.value) || null);

const roleNames = computed(() => {
  const map: Record<string, string> = {};
  for (const r of options.value.roles || []) map[r.code] = r.name;
  return map;
});
const userNames = computed(() => {
  const map: Record<string, string> = {};
  for (const u of options.value.users || []) map[u.username] = u.display_name;
  return map;
});

function assigneeText(n: any) {
  if (n.type === 'AUTO') return `处理器：${n.handler || '—'}`;
  if (n.assigneeType === 'ROLE') return `角色：${roleNames.value[n.role] || n.role || '—'}`;
  return `用户：${userNames.value[n.username] || n.username || '—'}`;
}

let seq = 1;
function nextId() {
  while (chain.value.some((n) => n.id === `n${seq}`)) seq++;
  return `n${seq}`;
}

function addNode(type: 'APPROVAL' | 'CC' | 'AUTO') {
  const node: any = { id: nextId(), type };
  if (type === 'APPROVAL') {
    node.name = '审批节点';
    node.assigneeType = 'ROLE';
    node.role = (options.value.roles || [])[0]?.code || '';
    node.multi = 'OR';
  } else if (type === 'CC') {
    node.name = '抄送节点';
    node.assigneeType = 'ROLE';
    node.role = (options.value.roles || [])[0]?.code || '';
  } else {
    node.name = '自动执行';
    node.handler = form.action === 'CHANGE' ? 'applyChange' : 'publishWithCode';
  }
  chain.value.push(node);
  selectedId.value = node.id;
}

function removeNode(id: string) {
  chain.value = chain.value.filter((n) => n.id !== id);
  if (selectedId.value === id) selectedId.value = '';
}

/** 由既有 definition 重建链路：沿 approved 连线自 START 走到 END */
function restore() {
  const def = props.process?.definition || {};
  if (props.process) {
    form.code = props.process.code || '';
    form.name = props.process.name || '';
    form.domain = def.bind?.domain || '*';
    form.action = def.bind?.action || 'CREATE';
    const nodes: any[] = def.nodes || [];
    const flows = (def.flows || []).filter((f: any) => (f.when || 'approved') === 'approved');
    const start = nodes.find((n) => n.type === 'START');
    const chainNodes: any[] = [];
    let cur = start?.id;
    const guard = new Set<string>();
    while (cur) {
      if (guard.has(cur)) break;
      guard.add(cur);
      const next = flows.find((f: any) => f.from === cur)?.to;
      if (!next) break;
      const node = nodes.find((n) => n.id === next);
      if (!node || node.type === 'END') break;
      chainNodes.push({ ...node });
      cur = next;
    }
    chain.value = chainNodes;
  } else {
    form.code = '';
    form.name = '';
    form.domain = '*';
    form.action = 'CREATE';
    // 新流程默认：审批 → 自动执行
    chain.value = [
      { id: 'n1', type: 'APPROVAL', name: '部门初审', assigneeType: 'ROLE', role: (options.value.roles || [])[0]?.code || '', multi: 'OR' },
      { id: 'n2', type: 'AUTO', name: '自动执行', handler: 'publishWithCode' },
    ];
    seq = 3;
  }
  selectedId.value = chain.value[0]?.id || '';
}

async function save() {
  if (!form.code || !form.name) { ElMessage.warning('请填写流程编码与名称'); return; }
  if (!chain.value.length) { ElMessage.warning('请至少添加一个流程节点'); return; }
  saving.value = true;
  try {
    const nodes = [
      { id: 'start', type: 'START' },
      ...chain.value.map((n) => ({
        id: n.id, type: n.type, name: n.name,
        assigneeType: n.assigneeType, role: n.role, username: n.username,
        ...(n.type === 'APPROVAL' ? { multi: n.multi } : {}),
        ...(n.type === 'AUTO' ? { handler: n.handler } : {}),
      })),
      { id: 'end', type: 'END' },
    ];
    const flows = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id, when: 'approved' }));
    const res = await approvalApi.saveProcess({
      code: form.code, name: form.name,
      bind: { domain: form.domain, action: form.action },
      nodes, flows,
    });
    ElMessage.success(`流程「${res.name}」已保存`);
    emit('saved');
  } catch { /* 接口已提示 */ } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  options.value = (await approvalApi.designerOptions()) || { users: [], roles: [], domains: [] };
  restore();
});
</script>

<template>
  <div class="pd">
    <div class="pd-form">
      <div class="form-item req"><label>流程编码</label>
        <input v-model="form.code" placeholder="如 MATERIAL_ADD（同编码覆盖更新）" :disabled="!!process" style="width:100%" />
      </div>
      <div class="form-item req"><label>流程名称</label>
        <input v-model="form.name" placeholder="如 物料新增审批" style="width:100%" />
      </div>
      <div class="form-item"><label>绑定主数据域</label>
        <select v-model="form.domain" style="width:100%">
          <option value="*">全部主数据域</option>
          <option v-for="d in options.domains" :key="d.code" :value="d.code">{{ d.name }}（{{ d.code }}）</option>
        </select>
      </div>
      <div class="form-item"><label>绑定动作</label>
        <select v-model="form.action" style="width:100%">
          <option value="CREATE">新增（CREATE）</option>
          <option value="CHANGE">变更（CHANGE）</option>
        </select>
      </div>
    </div>

    <div class="pd-canvas card">
      <div class="card-head">
        <span>流程画布</span>
        <span class="flex" style="gap:6px">
          <button class="btn sm" @click="addNode('APPROVAL')">+ 审批节点</button>
          <button class="btn sm" @click="addNode('CC')">+ 抄送节点</button>
          <button class="btn sm" @click="addNode('AUTO')">+ 自动节点</button>
        </span>
      </div>
      <div class="card-body pd-flow">
        <div class="pd-node start">
          <b>开始</b>
          <p class="hint">发起审批</p>
        </div>
        <template v-for="n in chain" :key="n.id">
          <div class="pd-arrow" />
          <div class="pd-node" :class="{ sel: selectedId === n.id, cc: n.type === 'CC' }" @click="selectedId = n.id">
            <div class="flex" style="justify-content:space-between">
              <b>{{ n.name || TYPE_META[n.type]?.label }}</b>
              <span class="tag" :class="TYPE_META[n.type]?.tag || 's'">{{ TYPE_META[n.type]?.label || n.type }}</span>
            </div>
            <p class="hint">{{ assigneeText(n) }}</p>
            <p v-if="n.type === 'APPROVAL'" class="hint">{{ n.multi === 'AND' ? '会签：全部通过' : '或签：任一通过' }}</p>
            <span class="pd-del link" @click.stop="removeNode(n.id)">删除</span>
          </div>
        </template>
        <div class="pd-arrow" />
        <div class="pd-node end">
          <b>结束</b>
          <p class="hint">流程归档</p>
        </div>
        <p v-if="!chain.length" class="hint" style="grid-column:1/-1">暂无节点，请从右上角添加</p>
      </div>
    </div>

    <div v-if="selected" class="card pd-edit">
      <div class="card-head"><span>节点配置 · {{ TYPE_META[selected.type]?.label }}</span></div>
      <div class="card-body">
        <div class="grid-form">
          <div class="form-item"><label>节点名称</label>
            <input v-model="selected.name" style="width:100%" />
          </div>
          <div v-if="selected.type !== 'AUTO'" class="form-item"><label>处理人类型</label>
            <select v-model="selected.assigneeType" style="width:100%">
              <option value="ROLE">按角色</option>
              <option value="USER">按用户</option>
            </select>
          </div>
          <div v-if="selected.type !== 'AUTO' && selected.assigneeType === 'ROLE'" class="form-item"><label>角色</label>
            <select v-model="selected.role" style="width:100%">
              <option v-for="r in options.roles" :key="r.code" :value="r.code">{{ r.name }}（{{ r.code }}）</option>
            </select>
          </div>
          <div v-if="selected.type !== 'AUTO' && selected.assigneeType === 'USER'" class="form-item"><label>用户</label>
            <select v-model="selected.username" style="width:100%">
              <option value="">— 选择用户 —</option>
              <option v-for="u in options.users" :key="u.username" :value="u.username">{{ u.display_name }}（{{ u.username }}）</option>
            </select>
          </div>
          <div v-if="selected.type === 'APPROVAL'" class="form-item"><label>多人审批方式</label>
            <select v-model="selected.multi" style="width:100%">
              <option value="OR">或签（任一通过）</option>
              <option value="AND">会签（全部通过）</option>
            </select>
          </div>
          <div v-if="selected.type === 'AUTO'" class="form-item"><label>处理器</label>
            <select v-model="selected.handler" style="width:100%">
              <option value="publishWithCode">publishWithCode（生成编码并发布）</option>
              <option value="applyChange">applyChange（应用变更）</option>
            </select>
          </div>
        </div>
        <p v-if="selected.type === 'CC'" class="hint mt10">抄送节点：流转到该节点时向配置人员推送抄送通知，不阻塞流程。</p>
      </div>
    </div>

    <div class="flex" style="justify-content:flex-end;gap:8px;margin-top:12px">
      <span class="hint" style="align-self:center">链路：开始 → {{ chain.map((n) => n.name || n.type).join(' → ') || '…' }} → 结束</span>
      <button class="btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存流程' }}</button>
    </div>
  </div>
</template>

<style scoped>
.pd-form { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 12px; }
.pd-flow { display: grid; justify-items: center; gap: 0; padding: 16px; }
.pd-node { width: 100%; max-width: 320px; border: 1px solid var(--bd, #dcdfe6); border-radius: 8px; padding: 10px 12px; background: var(--bg-card, #fff); position: relative; cursor: pointer; }
.pd-node.start, .pd-node.end { max-width: 200px; text-align: center; background: #f5f7fa; }
.pd-node.sel { border-color: #409eff; box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15); }
.pd-node.cc { background: #f4f2ff; }
.pd-arrow { width: 2px; height: 18px; background: #b8c2cc; position: relative; }
.pd-arrow::after { content: ''; position: absolute; bottom: -1px; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-top-color: #b8c2cc; }
.pd-del { position: absolute; top: 8px; right: 10px; font-size: 12px; color: #f56c6c; }
.pd-node .tag { margin-right: 24px; }
@media (max-width: 900px) { .pd-form { grid-template-columns: 1fr 1fr; } }
</style>
