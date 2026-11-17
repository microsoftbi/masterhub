<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { metaApi } from '../api';
import { useAuth } from '../stores/auth';

const auth = useAuth();
const dicts = ref<any[]>([]);
const current = ref<any>(null);
const loading = ref(false);
const canManage = computed(() => auth.has('dict.manage'));

const dictVisible = ref(false);
const dictIsEdit = ref(false);
const dictForm = reactive<any>({ code: '', name: '', remark: '', isTree: false });
const itemVisible = ref(false);
const itemForm = reactive<any>({ id: null, value: '', label: '', parentValue: '', sort: 0, status: 'ACTIVE' });

// 树形码值展开状态：key 为码值，默认展开（值为 false 才折叠）
const itemExpanded = ref<Record<string, boolean>>({});

async function load() {
  loading.value = true;
  try {
    dicts.value = (await metaApi.dicts()) || [];
    if (current.value) await open(current.value.code);
  } finally {
    loading.value = false;
  }
}

async function open(code: string) {
  current.value = await metaApi.dictItems(code);
  itemExpanded.value = {};
}

function openCreateDict() {
  dictIsEdit.value = false;
  Object.assign(dictForm, { code: '', name: '', remark: '', isTree: false });
  dictVisible.value = true;
}

function openEditDict(d: any) {
  dictIsEdit.value = true;
  Object.assign(dictForm, { code: d.code, name: d.name, remark: d.remark || '', isTree: !!d.is_tree });
  dictVisible.value = true;
}

async function saveDict() {
  if (dictIsEdit.value) {
    current.value = await metaApi.updateDict(dictForm.code, { name: dictForm.name, remark: dictForm.remark, isTree: dictForm.isTree });
    dictVisible.value = false;
    ElMessage.success('码表已更新');
  } else {
    await metaApi.createDict({ ...dictForm });
    dictVisible.value = false;
    ElMessage.success('码表已创建');
  }
  await load();
}

// ---------------- 树形码值 ----------------
interface TreeRow { it: any; depth: number; hasChildren: boolean }

/** 由平铺码值构建树并展开为带缩进层级的行序列 */
const itemTreeRows = computed<TreeRow[]>(() => {
  const items: any[] = current.value?.items || [];
  const byValue = new Map(items.map((i) => [i.value, i]));
  const childrenOf = new Map<string, any[]>();
  const roots: any[] = [];
  for (const it of items) {
    if (it.parent_value && byValue.has(it.parent_value)) {
      if (!childrenOf.has(it.parent_value)) childrenOf.set(it.parent_value, []);
      childrenOf.get(it.parent_value)!.push(it);
    } else {
      roots.push(it);
    }
  }
  const rows: TreeRow[] = [];
  const walk = (list: any[], depth: number) => {
    for (const it of list) {
      const kids = childrenOf.get(it.value) || [];
      rows.push({ it, depth, hasChildren: kids.length > 0 });
      if (kids.length && itemExpanded.value[it.value] !== false) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
});

function toggleItem(value: string) {
  itemExpanded.value[value] = !(itemExpanded.value[value] !== false);
}

/** 编辑码值的可选上级：排除自身及其全部后代，避免形成循环 */
const parentOptions = computed(() => {
  const items: any[] = current.value?.items || [];
  const childrenOf = new Map<string, any[]>();
  for (const it of items) {
    if (!it.parent_value) continue;
    if (!childrenOf.has(it.parent_value)) childrenOf.set(it.parent_value, []);
    childrenOf.get(it.parent_value)!.push(it);
  }
  const excluded = new Set<string>([itemForm.value || '']);
  const collect = (v: string) => {
    for (const c of childrenOf.get(v) || []) {
      excluded.add(c.value);
      collect(c.value);
    }
  };
  collect(itemForm.value || '');
  const rows: Array<{ value: string; label: string }> = [];
  const walk = (list: any[], depth: number) => {
    for (const it of list) {
      if (excluded.has(it.value)) continue; // 自身及其后代整体排除
      rows.push({ value: it.value, label: '\u3000'.repeat(depth) + (depth ? '└ ' : '') + `${it.label}（${it.value}）` });
      walk(childrenOf.get(it.value) || [], depth + 1);
    }
  };
  walk(items.filter((i) => !i.parent_value || !items.some((x) => x.value === i.parent_value)), 0);
  return rows;
});

function openItem(it?: any) {
  Object.assign(itemForm, it ? { ...it } : { id: null, value: '', label: '', parentValue: '', sort: (current.value?.items?.length || 0) + 1, status: 'ACTIVE' });
  itemVisible.value = true;
}

async function saveItem() {
  await metaApi.addDictItem(current.value.code, { ...itemForm });
  itemVisible.value = false;
  ElMessage.success('码值已保存');
  await open(current.value.code);
  await load();
}

async function removeItem(it: any) {
  await ElMessageBox.confirm(`确认停用码值「${it.label}」？`, '停用码值', { type: 'warning' });
  await metaApi.deleteDictItem(current.value.code, it.id);
  ElMessage.success('码值已停用');
  await open(current.value.code);
  await load();
}

onMounted(load);
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>数据标准</h2>
        <p class="desc">统一码表与码值维护，支持树形层级码表；模型枚举字段与主数据校验均引用此处</p>
      </div>
      <div class="flex">
        <button v-if="canManage" class="btn primary" @click="openCreateDict">新建码表</button>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">码表（{{ dicts.length }}）</div>
        <table class="tbl">
          <thead><tr><th>码表</th><th>编码</th><th>类型</th><th>码值数</th><th>说明</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="d in dicts" :key="d.code" :style="current?.code === d.code ? 'background:#f8fafc' : ''">
              <td><b>{{ d.name }}</b></td>
              <td class="num">{{ d.code }}</td>
              <td><span class="tag" :class="d.is_tree ? 'p' : 's'">{{ d.is_tree ? '树形' : '平铺' }}</span></td>
              <td class="num">{{ d.item_count }}</td>
              <td class="muted">{{ d.remark || '—' }}</td>
              <td>
                <span class="link" @click="open(d.code)">维护</span>
                <span v-if="canManage" class="link" style="margin-left:8px" @click="openEditDict(d)">编辑</span>
              </td>
            </tr>
            <tr v-if="!loading && !dicts.length"><td colspan="6" class="muted">暂无码表</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-head">
          <span>{{ current ? current.name + ' · 码值' : '码值明细' }}</span>
          <button v-if="current && canManage" class="btn sm" @click="openItem()">添加码值</button>
        </div>

        <!-- 树形码表：按层级缩进渲染，可展开/折叠 -->
        <table v-if="current && current.is_tree" class="tbl">
          <thead><tr><th>码值 / 显示名</th><th>上级</th><th>排序</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="row in itemTreeRows" :key="row.it.id">
              <td :style="{ paddingLeft: 8 + row.depth * 18 + 'px' }">
                <span
                  v-if="row.hasChildren"
                  class="link"
                  style="display:inline-block;width:16px;color:var(--muted,#999)"
                  @click="toggleItem(row.it.value)"
                >{{ itemExpanded[row.it.value] === false ? '▸' : '▾' }}</span>
                <span v-else style="display:inline-block;width:16px"></span>
                <b>{{ row.it.label }}</b>
                <span class="num muted" style="margin-left:6px">{{ row.it.value }}</span>
              </td>
              <td class="muted">{{ row.it.parent_value || '—' }}</td>
              <td class="num">{{ row.it.sort }}</td>
              <td><span class="tag" :class="row.it.status === 'ACTIVE' ? 'g' : 's'">{{ row.it.status === 'ACTIVE' ? '启用' : '停用' }}</span></td>
              <td>
                <span v-if="canManage" class="link" @click="openItem(row.it)">编辑</span>
                <span v-if="canManage && row.it.status === 'ACTIVE'" class="link" style="margin-left:8px;color:var(--err)" @click="removeItem(row.it)">停用</span>
              </td>
            </tr>
            <tr v-if="!itemTreeRows.length"><td colspan="5" class="muted">暂无码值</td></tr>
          </tbody>
        </table>

        <!-- 平铺码表：保持原有列表 -->
        <table v-else-if="current" class="tbl">
          <thead><tr><th>码值</th><th>显示名</th><th>上级</th><th>排序</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="it in current.items" :key="it.id">
              <td class="num">{{ it.value }}</td>
              <td>{{ it.label }}</td>
              <td class="muted">{{ it.parent_value || '—' }}</td>
              <td class="num">{{ it.sort }}</td>
              <td><span class="tag" :class="it.status === 'ACTIVE' ? 'g' : 's'">{{ it.status === 'ACTIVE' ? '启用' : '停用' }}</span></td>
              <td>
                <span v-if="canManage" class="link" @click="openItem(it)">编辑</span>
                <span v-if="canManage && it.status === 'ACTIVE'" class="link" style="margin-left:8px;color:var(--err)" @click="removeItem(it)">停用</span>
              </td>
            </tr>
            <tr v-if="!current.items.length"><td colspan="6" class="muted">暂无码值</td></tr>
          </tbody>
        </table>
        <div v-else class="card-body muted">从左侧选择码表查看码值</div>
      </div>
    </div>

    <el-dialog v-model="dictVisible" :title="dictIsEdit ? '编辑码表' : '新建码表'" width="480px" destroy-on-close>
      <div class="form-item req"><label>码表编码</label><input v-model="dictForm.code" :disabled="dictIsEdit" placeholder="如 unit" style="width:100%" /></div>
      <div class="form-item req"><label>码表名称</label><input v-model="dictForm.name" placeholder="如 计量单位" style="width:100%" /></div>
      <div class="form-item"><label>说明</label><input v-model="dictForm.remark" style="width:100%" /></div>
      <div class="form-item"><label class="hint"><input v-model="dictForm.isTree" type="checkbox" /> 树形码表（码值支持父子层级）</label></div>
      <template #footer>
        <button class="btn" @click="dictVisible = false">取消</button>
        <button class="btn primary" @click="saveDict">{{ dictIsEdit ? '保存' : '创建' }}</button>
      </template>
    </el-dialog>

    <el-dialog v-model="itemVisible" :title="itemForm.id ? '编辑码值' : '添加码值'" width="480px" destroy-on-close>
      <div class="form-item req"><label>码值</label><input v-model="itemForm.value" style="width:100%" /></div>
      <div class="form-item req"><label>显示名称</label><input v-model="itemForm.label" style="width:100%" /></div>
      <div class="grid-form">
        <div class="form-item">
          <label>上级码值</label>
          <select v-if="current?.is_tree" v-model="itemForm.parentValue" style="width:100%">
            <option value="">（无 / 顶级码值）</option>
            <option v-for="o in parentOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <input v-else v-model="itemForm.parentValue" placeholder="可选" style="width:100%" />
        </div>
        <div class="form-item"><label>排序</label><input v-model.number="itemForm.sort" type="number" style="width:100%" /></div>
      </div>
      <div class="form-item"><label>状态</label>
        <select v-model="itemForm.status" style="width:100%">
          <option value="ACTIVE">启用</option><option value="DISABLED">停用</option>
        </select>
      </div>
      <template #footer>
        <button class="btn" @click="itemVisible = false">取消</button>
        <button class="btn primary" @click="saveItem">保存</button>
      </template>
    </el-dialog>
  </div>
</template>
