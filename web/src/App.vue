<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from './stores/auth';
import { approvalApi, noticeApi } from './api';

const auth = useAuth();
const route = useRoute();
const router = useRouter();
const todoCount = ref(0);

// ---------------- 全局搜索 ----------------
const searchKeyword = ref('');
function doSearch() {
  const kw = searchKeyword.value.trim();
  if (!kw) return;
  router.push({ path: '/data', query: { kw } });
}

// ---------------- 站内通知 ----------------
const notices = ref<any>({ list: [], total: 0, page: 1, size: 10 });
const unread = ref(0);
const noticeVisible = ref(false);
let noticeTimer: any = null;

async function loadUnread() {
  try {
    const res = await noticeApi.unreadCount();
    unread.value = res?.count || 0;
  } catch { /* ignore */ }
}

async function loadNotices() {
  try {
    notices.value = await noticeApi.list({ page: 1, size: 10 });
  } catch { /* ignore */ }
}

function openNotices() {
  noticeVisible.value = true;
  loadNotices();
}

async function readNotice(n: any) {
  if (!n.read_flag) {
    await noticeApi.markRead({ id: n.id }).catch(() => undefined);
    n.read_flag = true;
    unread.value = Math.max(0, unread.value - 1);
  }
  noticeVisible.value = false;
  if (n.link) router.push(n.link);
}

async function readAll() {
  await noticeApi.markRead({ all: true }).catch(() => undefined);
  (notices.value.list || []).forEach((n: any) => { n.read_flag = true; });
  unread.value = 0;
}

const navGroups = [
  { title: '总览', items: [{ key: 'home', path: '/', label: '工作台', icon: 'HomeFilled', perm: 'workbench.view' }] },
  {
    title: '数据管理',
    items: [
      { key: 'data', path: '/data', label: '主数据维护', icon: 'Grid', perm: 'master.view' },
      { key: 'model', path: '/model', label: '模型管理', icon: 'SetUp', perm: 'model.view' },
      { key: 'dict', path: '/dict', label: '数据标准', icon: 'Collection', perm: 'dict.view' },
    ],
  },
  {
    title: '治理与集成',
    items: [
      { key: 'quality', path: '/quality', label: '数据质量', icon: 'CircleCheck', perm: 'quality.view' },
      { key: 'integration', path: '/integration', label: '数据集成', icon: 'Link', perm: 'integration.view' },
    ],
  },
  {
    title: '流程',
    items: [
      { key: 'workflow', path: '/workflow', label: '数据工作流', icon: 'Connection', perm: 'workflow.view' },
      { key: 'approval', path: '/approval', label: '审批中心', icon: 'DocumentChecked', perm: 'approval.view' },
    ],
  },
  {
    title: '分析',
    items: [{ key: 'dashboard', path: '/dashboard', label: '治理仪表板', icon: 'DataAnalysis', perm: 'dashboard.view' }],
  },
  {
    title: '系统',
    items: [{ key: 'system', path: '/system', label: '系统管理', icon: 'Tools', perm: 'system.view' }],
  },
];

const visibleGroups = computed(() =>
  navGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => auth.has(i.perm)) }))
    .filter((g) => g.items.length),
);

const activeKey = computed(() => {
  const p = route.path;
  if (p.startsWith('/data')) return 'data';
  if (p.startsWith('/model')) return 'model';
  if (p.startsWith('/dict')) return 'dict';
  if (p.startsWith('/approval')) return 'approval';
  if (p.startsWith('/integration')) return 'integration';
  if (p.startsWith('/quality')) return 'quality';
  if (p.startsWith('/workflow')) return 'workflow';
  if (p.startsWith('/dashboard')) return 'dashboard';
  if (p.startsWith('/system')) return 'system';
  if (p.startsWith('/placeholder/')) return p.split('/')[2];
  return 'home';
});

function goto(path: string) {
  router.push(path);
}

async function loadTodo() {
  if (!auth.has('approval.view')) return;
  try {
    const list = await approvalApi.todo();
    todoCount.value = (list || []).length;
  } catch { /* ignore */ }
}

function logout() {
  auth.logout();
  router.push('/login');
}

onMounted(() => {
  loadTodo();
  loadUnread();
  // 每 60 秒轮询未读数
  noticeTimer = setInterval(loadUnread, 60000);
});

onUnmounted(() => {
  if (noticeTimer) clearInterval(noticeTimer);
});
</script>

<template>
  <div v-if="route.meta.public" class="public-root">
    <router-view />
  </div>
  <div v-else class="app">
    <header class="topbar">
      <div class="logo">
        <el-icon style="color:#60a5fa"><Grid /></el-icon>
        Master<b>Hub</b><span class="sub">主数据管理系统</span>
      </div>
      <div class="top-search">
        <el-icon><Search /></el-icon>
        <input v-model="searchKeyword" placeholder="全局搜索主数据，回车跳转" @keyup.enter="doSearch" />
      </div>
      <el-popover v-model:visible="noticeVisible" placement="bottom-end" :width="380" trigger="manual">
        <template #reference>
          <div class="icon-btn" title="消息中心" style="position:relative" @click="openNotices">
            <el-icon><Bell /></el-icon>
            <span v-if="unread" class="bell-badge">{{ unread > 99 ? '99+' : unread }}</span>
          </div>
        </template>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <b style="font-size:13px">消息中心</b>
          <span class="link" style="font-size:12px" @click="readAll">全部已读</span>
        </div>
        <div style="max-height:360px;overflow:auto">
          <div
            v-for="n in notices.list"
            :key="n.id"
            class="notice-item"
            :class="{ unread: !n.read_flag }"
            style="padding:8px 6px;border-bottom:1px solid #eef2f7;cursor:pointer"
            @click="readNotice(n)"
          >
            <div style="display:flex;justify-content:space-between;gap:8px">
              <span style="font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ n.title }}</span>
              <span style="font-size:11px;color:#94a3b8;flex:none">{{ String(n.created_at || '').replace('T', ' ').slice(5, 16) }}</span>
            </div>
            <div style="font-size:12px;color:#64748b;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ n.content }}</div>
            <div style="margin-top:3px">
              <span class="tag s" style="font-size:11px">{{ n.type_label }}</span>
              <span v-if="!n.read_flag" class="tag r" style="font-size:11px;margin-left:4px">未读</span>
            </div>
          </div>
          <div v-if="!(notices.list || []).length" style="padding:24px;text-align:center;color:#94a3b8;font-size:12px">暂无通知</div>
        </div>
      </el-popover>
      <div class="avatar" :title="auth.user?.displayName">{{ (auth.user?.displayName || '用')[0] }}</div>
      <el-dropdown trigger="click">
        <span style="color:#cbd5e1;cursor:pointer;font-size:12px">{{ auth.user?.displayName }} · {{ (auth.user?.roles || [])[0] }}</span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item @click="logout">退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </header>
    <div class="body">
      <aside class="sidebar">
        <template v-for="g in visibleGroups" :key="g.title">
          <div class="gtitle">{{ g.title }}</div>
          <div
            v-for="i in g.items"
            :key="i.key"
            class="nav-item"
            :class="{ active: activeKey === i.key }"
            @click="goto(i.path)"
          >
            <el-icon><component :is="i.icon" /></el-icon>
            {{ i.label }}
            <span v-if="i.key === 'approval' && todoCount" class="cnt">{{ todoCount }}</span>
          </div>
        </template>
      </aside>
      <main class="main">
        <router-view :key="route.fullPath" />
      </main>
    </div>
  </div>
</template>

<style scoped>
.public-root { height: 100%; }
.bell-badge {
  position: absolute;
  top: -4px;
  right: -6px;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #ef4444;
  color: #fff;
  font-size: 10px;
  text-align: center;
}
.notice-item:hover { background: #f8fafc; }
</style>
