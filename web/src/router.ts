import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from './stores/auth';

const routes = [
  { path: '/login', component: () => import('./views/Login.vue'), meta: { public: true, title: '登录' } },
  { path: '/', component: () => import('./views/Workbench.vue'), meta: { title: '工作台' } },
  { path: '/data', component: () => import('./views/DataList.vue'), meta: { title: '主数据维护' } },
  { path: '/data/:domain', component: () => import('./views/DataList.vue'), meta: { title: '主数据维护' } },
  { path: '/data/:domain/new', component: () => import('./views/DataDetail.vue'), meta: { title: '新增主数据' } },
  { path: '/data/:domain/:key', component: () => import('./views/DataDetail.vue'), meta: { title: '主数据详情' } },
  { path: '/model', component: () => import('./views/ModelList.vue'), meta: { title: '模型管理' } },
  { path: '/dict', component: () => import('./views/DictList.vue'), meta: { title: '数据标准' } },
  { path: '/approval', component: () => import('./views/ApprovalCenter.vue'), meta: { title: '审批中心' } },
  { path: '/integration', component: () => import('./views/Integration.vue'), meta: { title: '数据集成' } },
  { path: '/quality', component: () => import('./views/Quality.vue'), meta: { title: '数据质量' } },
  { path: '/workflow', component: () => import('./views/Workflow.vue'), meta: { title: '数据工作流' } },
  { path: '/dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '治理仪表板' } },
  { path: '/system', component: () => import('./views/System.vue'), meta: { title: '系统管理' } },
  { path: '/placeholder/:module', component: () => import('./views/Placeholder.vue'), meta: { title: '规划中' } },
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  const auth = useAuth();
  if (!auth.token) return '/login';
  if (!auth.loaded) {
    try {
      await auth.load();
    } catch {
      auth.logout();
      return '/login';
    }
  }
  return true;
});

export default router;
