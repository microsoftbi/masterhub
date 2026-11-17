<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { approvalApi, statsApi } from '../api';
import { useAuth } from '../stores/auth';

const router = useRouter();
const auth = useAuth();
const wb = ref<any>({ todo: 0, myRunning: 0, recentPublished: [], recentAudit: [], domains: [] });
const ov = ref<any>(null);
const todos = ref<any[]>([]);
const loading = ref(true);

const totals = computed(() => ov.value?.totals || { total: 0, published: 0, pending: 0 });
const push = computed(() => ov.value?.push || { pushed: 0, pending: 0, failed: 0, dead: 0 });
const successRate = computed(() => {
  const p = push.value;
  const done = (p.pushed || 0) + (p.failed || 0) + (p.dead || 0);
  return done ? Math.round((p.pushed / done) * 1000) / 10 : null;
});

function pct(v: number, t: number) {
  if (!t) return 0;
  return Math.round((v / t) * 100);
}

function waitHours(ts: string) {
  if (!ts) return 0;
  const diff = (Date.now() - new Date(ts).getTime()) / 3600000;
  return Math.max(0, Math.round(diff * 10) / 10);
}

function go(path: string) {
  router.push(path);
}

onMounted(async () => {
  try {
    wb.value = await statsApi.workbench();
  } catch { /* ignore */ }
  try {
    ov.value = await statsApi.overview();
  } catch { /* 无仪表板权限时忽略 */ }
  try {
    todos.value = (await approvalApi.todo()) || [];
  } catch { /* ignore */ }
  loading.value = false;
});
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>工作台</h2>
        <p class="desc">主数据资产、待办事项与分发状态总览</p>
      </div>
      <div class="flex">
        <button class="btn" @click="go('/data')">进入主数据维护</button>
        <button class="btn primary" @click="go('/data/material/new')">新增物料</button>
      </div>
    </div>

    <div class="cards-row">
      <div class="kpi">
        <div class="k-label">主数据总量</div>
        <div class="k-num">{{ totals.total }}</div>
        <div class="k-delta up">已发布 {{ totals.published }} 条</div>
      </div>
      <div class="kpi">
        <div class="k-label">待我审批</div>
        <div class="k-num">{{ wb.todo }}</div>
        <div class="k-delta" style="color:var(--warn)">运行中流程 {{ ov?.approval?.running ?? 0 }} 个</div>
      </div>
      <div class="kpi">
        <div class="k-label">我发起的在途单据</div>
        <div class="k-num">{{ wb.myRunning }}</div>
        <div class="k-delta muted">审批通过后自动生效</div>
      </div>
      <div class="kpi">
        <div class="k-label">活跃订阅方</div>
        <div class="k-num">{{ ov?.meta?.subscribers ?? '—' }}</div>
        <div class="k-delta muted">Webhook / 开放 API</div>
      </div>
      <div class="kpi">
        <div class="k-label">分发成功率</div>
        <div class="k-num">{{ successRate === null ? '—' : successRate + '%' }}</div>
        <div class="k-delta" :class="push.failed || push.dead ? 'down' : 'up'">
          待推 {{ push.pending }} · 失败 {{ push.failed + push.dead }}
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">主数据域概览<span class="link" @click="go('/data')">进入维护</span></div>
        <table class="tbl">
          <thead>
            <tr><th>主数据域</th><th>数据总量</th><th>已发布</th><th>草稿</th><th>审批/变更中</th><th>发布占比</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in (ov?.domains || wb.domains || [])" :key="d.code">
              <td><b>{{ d.name }}</b></td>
              <td class="num">{{ d.total }}</td>
              <td class="num">{{ d.published ?? '—' }}</td>
              <td class="num">{{ d.drafts ?? '—' }}</td>
              <td class="num">{{ (d.pending || 0) + (d.changing || 0) }}</td>
              <td>
                <span class="tag g">已发布 {{ pct(d.published || 0, d.total) }}%</span>
                <span class="tag s">其他 {{ 100 - pct(d.published || 0, d.total) }}%</span>
              </td>
            </tr>
            <tr v-if="!(ov?.domains || wb.domains || []).length">
              <td colspan="6" class="muted">暂无可见主数据域</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-head">我的待办<span v-if="todos.length" class="tag r">{{ todos.length }}</span></div>
        <div class="card-body" style="padding-top:6px">
          <div v-for="t in todos" :key="t.id" class="todo-item" @click="go('/approval')">
            <span class="ap-ico" :class="t.action === 'CREATE' ? 'b' : 'o'">
              <el-icon><Document /></el-icon>
            </span>
            <div style="flex:1;min-width:0">
              <div class="t-title">{{ t.title }}</div>
              <div class="t-meta">{{ t.node_name }} · 等待 {{ waitHours(t.created_at) }}h</div>
            </div>
            <el-icon class="muted"><ArrowRight /></el-icon>
          </div>
          <div v-if="!todos.length" class="muted" style="padding:12px 0">暂无待办，审批任务会出现在这里。</div>
        </div>
      </div>
    </div>

    <div class="grid-2 mt14">
      <div class="card">
        <div class="card-head">最近更新的主数据<span class="link" @click="go('/data')">查看全部</span></div>
        <table class="tbl">
          <thead><tr><th>编码</th><th>名称</th><th>域</th><th>状态</th><th>更新时间</th></tr></thead>
          <tbody>
            <tr v-for="r in wb.recentPublished" :key="r.id">
              <td class="num">{{ r.master_code || '—' }}</td>
              <td>{{ r.name }}</td>
              <td>{{ r.domain_name }}</td>
              <td><span class="tag" :class="'st-' + r.status">{{ r.status === 'PUBLISHED' ? '已发布' : r.status }}</span></td>
              <td class="muted">{{ String(r.updated_at || '').replace('T', ' ').slice(0, 16) }}</td>
            </tr>
            <tr v-if="!wb.recentPublished?.length"><td colspan="5" class="muted">暂无数据</td></tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-head">我的最近操作</div>
        <div class="card-body" style="padding-top:6px">
          <div v-for="(a, i) in wb.recentAudit" :key="i" class="kv">
            <b>{{ String(a.created_at).replace('T', ' ').slice(5, 16) }}</b>
            <span style="flex:1;text-align:right">{{ a.target }}</span>
          </div>
          <div v-if="!wb.recentAudit?.length" class="muted">暂无操作记录</div>
        </div>
      </div>
    </div>
  </div>
</template>
