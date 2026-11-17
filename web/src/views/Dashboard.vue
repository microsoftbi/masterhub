<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { statsApi } from '../api';

const dash = ref<any>(null);
const loading = ref(false);

const DIM_LABELS: Record<string, string> = {
  COMPLETENESS: '完整性',
  UNIQUENESS: '唯一性',
  VALIDITY: '合法性',
  CONSISTENCY: '一致性',
  TIMELINESS: '时效性',
};

async function load() {
  loading.value = true;
  try {
    dash.value = await statsApi.dashboard();
  } finally {
    loading.value = false;
  }
}

const volumeTrend = computed<any[]>(() => dash.value?.volume?.trend || []);
const approvalTrend = computed<any[]>(() => dash.value?.approval?.trend || []);
const pushTrend = computed<any[]>(() => dash.value?.push?.trend || []);
const domainRows = computed<any[]>(() => dash.value?.volume?.domains || []);

const maxCreated = computed(() => Math.max(1, ...volumeTrend.value.map((t: any) => t.created || 0)));
const maxApproval = computed(() =>
  Math.max(1, ...approvalTrend.value.map((t: any) => Math.max(t.submitted || 0, t.completed || 0))),
);
const maxPush = computed(() =>
  Math.max(1, ...pushTrend.value.map((t: any) => Math.max(t.success || 0, t.failed || 0))),
);

function hPct(n: number, max: number, min = 4) {
  const v = Math.round((Number(n) || 0) / max * 100);
  return Math.max(n ? min : 0, Math.min(100, v)) + '%';
}

/** 质量五维雷达图坐标 */
const radar = computed(() => {
  const dims = dash.value?.quality?.dims || [];
  const cx = 116;
  const cy = 104;
  const r = 72;
  const n = dims.length || 5;
  const pts = dims.map((d: any, i: number) => {
    const ang = -Math.PI / 2 + i * (2 * Math.PI / n);
    const ratio = Math.max(0, Math.min(100, Number(d.score) || 0)) / 100;
    return {
      x: +(cx + Math.cos(ang) * r * ratio).toFixed(1),
      y: +(cy + Math.sin(ang) * r * ratio).toFixed(1),
      ax: +(cx + Math.cos(ang) * r).toFixed(1),
      ay: +(cy + Math.sin(ang) * r).toFixed(1),
      lx: +(cx + Math.cos(ang) * (r + 22)).toFixed(1),
      ly: +(cy + Math.sin(ang) * (r + 22)).toFixed(1),
      label: DIM_LABELS[d.dimension] || d.dimension,
      score: d.score,
    };
  });
  const rings = [0.25, 0.5, 0.75, 1].map((k) =>
    dims.map((_: any, i: number) => {
      const ang = -Math.PI / 2 + i * (2 * Math.PI / n);
      return `${cx + Math.cos(ang) * r * k},${cy + Math.sin(ang) * r * k}`;
    }).join(' '),
  );
  return {
    cx,
    cy,
    pts,
    rings,
    poly: pts.map((p: any) => `${p.x},${p.y}`).join(' '),
  };
});

/** 分发成功率环形图 */
const donut = computed(() => {
  const p = dash.value?.push || {};
  const success = p.success || 0;
  const failed = p.failed || 0;
  const pending = p.pending || 0;
  const total = success + failed + pending || 1;
  const a = (success / total) * 360;
  const b = a + (failed / total) * 360;
  return {
    success,
    failed,
    pending,
    rate: p.successRate ?? 0,
    bg: `conic-gradient(var(--ok) 0deg ${a}deg, var(--err) ${a}deg ${b}deg, var(--warn) ${b}deg 360deg)`,
  };
});

const pushSubs = computed<any[]>(() => dash.value?.push?.bySubscriber || []);
const wfRecent = computed<any[]>(() => dash.value?.workflow?.recent || []);
const nodeStats = computed<any[]>(() => dash.value?.approval?.nodeStats || []);
const slowest = computed<any[]>(() => dash.value?.approval?.slowest || []);

const RUN_STATUS: Record<string, string> = { SUCCESS: '成功', FAILED: '失败', RUNNING: '运行中' };

onMounted(load);
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>治理仪表板</h2>
        <p class="desc">汇总主数据规模、质量评分、审批效率、分发成功率与工作流运行情况</p>
      </div>
      <div class="flex">
        <span class="muted" style="font-size:12px">统计窗口：最近 7 天</span>
        <button class="btn sm" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </div>

    <div class="cards-row">
      <div class="kpi">
        <div class="k-label">主数据总量</div>
        <div class="k-num">{{ dash?.volume?.total ?? 0 }}</div>
        <div class="k-delta">覆盖 {{ domainRows.length }} 个主数据域</div>
      </div>
      <div class="kpi">
        <div class="k-label">已发布</div>
        <div class="k-num" style="color:var(--ok)">{{ dash?.volume?.published ?? 0 }}</div>
        <div class="k-delta">草稿 {{ dash?.volume?.draft ?? 0 }} · 审批中 {{ dash?.volume?.pending ?? 0 }}</div>
      </div>
      <div class="kpi">
        <div class="k-label">质量评分</div>
        <div class="k-num" style="color:var(--p)">{{ dash?.quality?.score ?? 100 }}</div>
        <div class="k-delta">开放问题 {{ dash?.quality?.counts?.open ?? 0 }} 项</div>
      </div>
      <div class="kpi">
        <div class="k-label">审批平均耗时</div>
        <div class="k-num">{{ dash?.approval?.avgHours ?? 0 }}<span style="font-size:13px;font-weight:400"> h</span></div>
        <div class="k-delta">我待处理 {{ dash?.approval?.myTodo ?? 0 }} 项</div>
      </div>
      <div class="kpi">
        <div class="k-label">分发成功率</div>
        <div class="k-num" style="color:var(--ok)">{{ dash?.push?.successRate ?? 100 }}<span style="font-size:13px;font-weight:400">%</span></div>
        <div class="k-delta">共 {{ dash?.push?.total ?? 0 }} 个事件</div>
      </div>
      <div class="kpi">
        <div class="k-label">工作流成功率</div>
        <div class="k-num">{{ dash?.workflow?.successRate ?? 100 }}<span style="font-size:13px;font-weight:400">%</span></div>
        <div class="k-delta">定义 {{ dash?.workflow?.definitions ?? 0 }} · 运行 {{ dash?.workflow?.runs ?? 0 }}</div>
      </div>
    </div>

    <div class="dash-grid">
      <!-- 数据量趋势 -->
      <div class="card">
        <div class="card-head"><span>主数据新增趋势</span><span class="hint">近 7 日新建记录数</span></div>
        <div class="card-body">
          <div class="bars">
            <div v-for="t in volumeTrend" :key="t.date" class="bar-col">
              <div class="bar-val">{{ t.created }}</div>
              <div class="bar b" :style="{ height: hPct(t.created, maxCreated) }"></div>
              <div class="bar-lab">{{ t.date.slice(5) }}</div>
            </div>
            <div v-if="!volumeTrend.length" class="muted">暂无数据</div>
          </div>
        </div>
      </div>

      <!-- 质量五维 -->
      <div class="card">
        <div class="card-head"><span>质量五维评分</span><span class="hint">规则 {{ dash?.quality?.rules ?? 0 }} 条</span></div>
        <div class="card-body radar-body">
          <svg viewBox="0 0 236 208" class="radar">
            <polygon
              v-for="(ring, i) in radar.rings"
              :key="'r' + i"
              :points="ring"
              fill="none"
              stroke="#e2e8f0"
              stroke-width="1"
            />
            <line
              v-for="(p, i) in radar.pts"
              :key="'l' + i"
              :x1="radar.cx"
              :y1="radar.cy"
              :x2="p.ax"
              :y2="p.ay"
              stroke="#eef2f7"
            />
            <polygon :points="radar.poly" fill="rgba(37,99,235,.16)" stroke="#2563eb" stroke-width="2" />
            <circle v-for="(p, i) in radar.pts" :key="'c' + i" :cx="p.x" :cy="p.y" r="3" fill="#2563eb" />
            <text
              v-for="(p, i) in radar.pts"
              :key="'t' + i"
              :x="p.lx"
              :y="p.ly"
              text-anchor="middle"
              dominant-baseline="middle"
              font-size="11"
              fill="#475569"
            >{{ p.label }} {{ p.score }}</text>
          </svg>
          <div class="q-sum">
            <div class="kv"><b>开放问题</b><span class="num">{{ dash?.quality?.counts?.open ?? 0 }}</span></div>
            <div class="kv"><b>高危问题</b><span class="num" style="color:var(--err)">{{ dash?.quality?.counts?.high ?? 0 }}</span></div>
            <div class="kv"><b>已整改</b><span class="num" style="color:var(--ok)">{{ dash?.quality?.counts?.fixed ?? 0 }}</span></div>
            <div class="kv"><b>最近巡检</b><span>{{ String(dash?.quality?.lastRunAt || '—').replace('T', ' ') }}</span></div>
          </div>
        </div>
      </div>

      <!-- 审批效率 -->
      <div class="card">
        <div class="card-head"><span>审批效率（近 7 日）</span><span class="hint">提交 / 完成</span></div>
        <div class="card-body">
          <div class="bars">
            <div v-for="t in approvalTrend" :key="t.date" class="bar-col">
              <div class="bar-pair">
                <div class="bar b" :style="{ height: hPct(t.submitted, maxApproval) }" :title="'提交 ' + t.submitted"></div>
                <div class="bar g" :style="{ height: hPct(t.completed, maxApproval) }" :title="'完成 ' + t.completed"></div>
              </div>
              <div class="bar-lab">{{ t.date.slice(5) }}</div>
            </div>
            <div v-if="!approvalTrend.length" class="muted">暂无数据</div>
          </div>
          <div class="legend">
            <span><i class="dot b"></i>提交 {{ approvalTrend.reduce((a: number, t: any) => a + (t.submitted || 0), 0) }}</span>
            <span><i class="dot g"></i>完成 {{ approvalTrend.reduce((a: number, t: any) => a + (t.completed || 0), 0) }}</span>
            <span class="fr">在办 {{ dash?.approval?.running ?? 0 }} · 已驳回 {{ dash?.approval?.rejected ?? 0 }}</span>
          </div>
          <div class="eff-extra">
            <span>待办积压 <b class="num">{{ dash?.approval?.backlog ?? 0 }}</b> 项</span>
            <span>驳回率 <b class="num" :style="{ color: (dash?.approval?.rejectRate ?? 0) > 20 ? 'var(--err)' : '' }">{{ dash?.approval?.rejectRate ?? 0 }}%</b></span>
          </div>
        </div>
      </div>

      <!-- 审批环节效率 -->
      <div class="card span2">
        <div class="card-head"><span>审批环节效率</span><span class="hint">按节点统计任务量与平均处理耗时</span></div>
        <div class="card-body node-body">
          <table class="tbl">
            <thead><tr><th>环节</th><th>任务数</th><th>待办</th><th>平均耗时</th></tr></thead>
            <tbody>
              <tr v-for="n in nodeStats" :key="n.node_name">
                <td>{{ n.node_name }}</td>
                <td class="num">{{ n.total }}</td>
                <td class="num" :style="{ color: n.pending ? 'var(--warn)' : '' }">{{ n.pending || 0 }}</td>
                <td class="num">{{ n.avgHours }} h</td>
              </tr>
              <tr v-if="!nodeStats.length"><td colspan="4" class="muted">暂无审批任务</td></tr>
            </tbody>
          </table>
          <div class="slow-list">
            <div class="sub-title">最慢已办实例</div>
            <div v-for="(s, i) in slowest" :key="i" class="slow-row">
              <span class="slow-idx">{{ i + 1 }}</span>
              <span class="slow-title" :title="s.title">{{ s.title }}</span>
              <span class="tag s">{{ s.process_code }}</span>
              <span class="num">{{ s.hours }} h</span>
            </div>
            <div v-if="!slowest.length" class="muted">暂无已完成实例</div>
          </div>
        </div>
      </div>

      <!-- 分发成功率 -->
      <div class="card">
        <div class="card-head"><span>分发成功率</span><span class="hint">Outbox 推送结果</span></div>
        <div class="card-body push-body">
          <div class="donut-wrap">
            <div class="donut" :style="{ background: donut.bg }">
              <div class="donut-hole">
                <div class="donut-num">{{ donut.rate }}%</div>
                <div class="hint">成功率</div>
              </div>
            </div>
            <div class="donut-legend">
              <div><i class="dot g"></i>成功 <b class="num">{{ donut.success }}</b></div>
              <div><i class="dot r"></i>失败 <b class="num">{{ donut.failed }}</b></div>
              <div><i class="dot o"></i>待推送 <b class="num">{{ donut.pending }}</b></div>
            </div>
          </div>
          <div class="sub-bars">
            <div v-for="s in pushSubs" :key="s.code" class="sub-row">
              <div class="sub-name">{{ s.name }}</div>
              <div class="sub-track">
                <div class="sub-fill" :style="{ width: (s.total ? Math.round((s.success / s.total) * 100) : 0) + '%' }"></div>
              </div>
              <div class="num" style="width:38px;text-align:right">{{ s.success }}/{{ s.total }}</div>
            </div>
            <div v-if="!pushSubs.length" class="muted">暂无订阅方</div>
          </div>
        </div>
      </div>

      <!-- 工作流最近运行 -->
      <div class="card">
        <div class="card-head"><span>工作流最近运行</span><span class="hint">成功 {{ dash?.workflow?.success ?? 0 }} 次</span></div>
        <table class="tbl">
          <thead><tr><th>流程</th><th>状态</th><th>行数</th><th>完成时间</th></tr></thead>
          <tbody>
            <tr v-for="r in wfRecent" :key="r.id">
              <td>{{ r.definition_name }}</td>
              <td><span class="tag" :class="r.status === 'SUCCESS' ? 'g' : r.status === 'FAILED' ? 'r' : 'o'">{{ RUN_STATUS[r.status] || r.status }}</span></td>
              <td class="num">{{ r.row_count }}</td>
              <td class="muted">{{ String(r.finished_at || r.started_at || '').replace('T', ' ') }}</td>
            </tr>
            <tr v-if="!wfRecent.length"><td colspan="4" class="muted">暂无运行记录</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 域分布 -->
      <div class="card">
        <div class="card-head"><span>主数据域分布</span><span class="hint">按域统计记录量</span></div>
        <table class="tbl">
          <thead><tr><th>主数据域</th><th>总量</th><th>已发布</th><th>草稿</th><th>审批中</th><th style="width:140px">发布占比</th></tr></thead>
          <tbody>
            <tr v-for="d in domainRows" :key="d.code">
              <td>{{ d.name }} <span class="hint">{{ d.code }}</span></td>
              <td class="num">{{ d.total }}</td>
              <td class="num" style="color:var(--ok)">{{ d.published }}</td>
              <td class="num">{{ d.draft }}</td>
              <td class="num" style="color:var(--warn)">{{ d.pending }}</td>
              <td>
                <div class="sub-track" style="margin:0">
                  <div class="sub-fill" :style="{ width: (d.total ? Math.round((d.published / d.total) * 100) : 0) + '%' }"></div>
                </div>
              </td>
            </tr>
            <tr v-if="!domainRows.length"><td colspan="6" class="muted">暂无可见域数据</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 1080px) { .dash-grid { grid-template-columns: 1fr; } }

.bars { display: flex; align-items: flex-end; gap: 12px; height: 168px; padding: 10px 4px 0; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; min-width: 0; height: 100%; }
.bar-val { font-size: 11px; color: var(--mut); margin-bottom: 3px; }
.bar { width: 60%; max-width: 34px; border-radius: 4px 4px 0 0; transition: height .3s; }
.bar.b { background: #3b82f6; }
.bar.g { background: #22c55e; }
.bar-pair { display: flex; align-items: flex-end; gap: 4px; width: 100%; justify-content: center; flex: 1; }
.bar-pair .bar { width: 34%; max-width: 22px; }
.bar-lab { font-size: 11px; color: var(--mut); margin-top: 6px; white-space: nowrap; }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--mut); margin-top: 6px; padding-top: 8px; border-top: 1px dashed #eef2f7; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
.dot.b { background: #3b82f6; }
.dot.g { background: #22c55e; }
.dot.r { background: var(--err); }
.dot.o { background: var(--warn); }

.radar-body { display: flex; gap: 10px; align-items: center; }
.radar { width: 236px; height: 208px; flex: none; }
.q-sum { flex: 1; min-width: 0; }

.push-body { display: flex; flex-direction: column; gap: 12px; }
.donut-wrap { display: flex; align-items: center; gap: 20px; }
.donut { width: 110px; height: 110px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; }
.donut-hole { width: 74px; height: 74px; border-radius: 50%; background: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.donut-num { font-size: 19px; font-weight: 700; }
.donut-legend { font-size: 12px; color: var(--mut); display: flex; flex-direction: column; gap: 4px; }
.donut-legend b { color: var(--tx); margin-left: 4px; }

.sub-bars { display: flex; flex-direction: column; gap: 7px; }
.sub-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.sub-name { width: 110px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-track { flex: 1; height: 8px; background: #eef2f7; border-radius: 4px; overflow: hidden; }
.sub-fill { height: 100%; background: linear-gradient(90deg, #60a5fa, #2563eb); border-radius: 4px; }

.span2 { grid-column: 1 / -1; }
.eff-extra { display: flex; gap: 20px; font-size: 12px; color: var(--mut); margin-top: 8px; }
.eff-extra b { color: var(--tx); margin: 0 2px; }
.node-body { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 18px; align-items: start; }
@media (max-width: 1080px) { .node-body { grid-template-columns: 1fr; } }
.slow-list { display: flex; flex-direction: column; gap: 6px; }
.sub-title { font-size: 12px; color: var(--mut); font-weight: 600; margin-bottom: 2px; }
.slow-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 8px; background: #f8fafc; border-radius: 6px; }
.slow-idx { width: 18px; height: 18px; flex: none; border-radius: 50%; background: #e2e8f0; color: #475569; font-size: 11px; display: flex; align-items: center; justify-content: center; }
.slow-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
