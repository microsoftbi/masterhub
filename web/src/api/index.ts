import http from './http';

export const authApi = {
  login: (data: any) => http.post('/api/v1/auth/login', data) as any,
  me: () => http.get('/api/v1/auth/me') as any,
};

export const metaApi = {
  domains: () => http.get('/api/v1/domains') as any,
  createDomain: (data: any) => http.post('/api/v1/domains', data) as any,
  models: () => http.get('/api/v1/models') as any,
  model: (id: number) => http.get(`/api/v1/models/${id}`) as any,
  createModel: (data: any) => http.post('/api/v1/models', data) as any,
  updateModel: (id: number, data: any) => http.put(`/api/v1/models/${id}`, data) as any,
  saveField: (id: number, data: any) => http.post(`/api/v1/models/${id}/fields`, data) as any,
  deleteField: (id: number, fieldId: number) => http.delete(`/api/v1/models/${id}/fields/${fieldId}`) as any,
  compat: (id: number) => http.get(`/api/v1/models/${id}/compat`) as any,
  publish: (id: number) => http.post(`/api/v1/models/${id}/publish`) as any,
  dicts: () => http.get('/api/v1/dicts') as any,
  createDict: (data: any) => http.post('/api/v1/dicts', data) as any,
  updateDict: (code: string, data: any) => http.put(`/api/v1/dicts/${code}`, data) as any,
  dictItems: (code: string) => http.get(`/api/v1/dicts/${code}/items`) as any,
  addDictItem: (code: string, data: any) => http.post(`/api/v1/dicts/${code}/items`, data) as any,
  deleteDictItem: (code: string, id: number) => http.delete(`/api/v1/dicts/${code}/items/${id}`) as any,
  codeRules: () => http.get('/api/v1/code-rules') as any,
  updateCodeRule: (domain: string, data: any) => http.put(`/api/v1/code-rules/${domain}`, data) as any,
  previewCode: (domain: string, data: any) => http.post(`/api/v1/code-rules/${domain}/preview`, data) as any,
};

export const masterApi = {
  list: (domain: string, params: any) => http.get(`/api/v1/master-data/${domain}`, { params }) as any,
  detail: (domain: string, key: string | number) => http.get(`/api/v1/master-data/${domain}/${key}`) as any,
  create: (domain: string, data: any) => http.post(`/api/v1/master-data/${domain}`, data) as any,
  update: (domain: string, key: string | number, data: any) => http.put(`/api/v1/master-data/${domain}/${key}`, data) as any,
  submit: (domain: string, key: string | number, data?: any) => http.post(`/api/v1/master-data/${domain}/${key}/submit`, data || {}) as any,
  versions: (domain: string, key: string | number) => http.get(`/api/v1/master-data/${domain}/${key}/versions`) as any,
  checkDup: (domain: string, data: any) => http.post(`/api/v1/master-data/${domain}/check-dup`, data) as any,
  merge: (domain: string, data: any) => http.post(`/api/v1/master-data/${domain}/merge`, data) as any,
  lifecycle: (domain: string, key: string | number, action: string) =>
    http.post(`/api/v1/master-data/${domain}/${key}/${action}`) as any,
  batchLifecycle: (domain: string, data: any) => http.post(`/api/v1/master-data/${domain}/batch-lifecycle`, data) as any,
  rollback: (domain: string, key: string | number, data: any) =>
    http.post(`/api/v1/master-data/${domain}/${key}/rollback`, data) as any,
  exportCsv: (domain: string, params: any) => http.get(`/api/v1/master-data/${domain}/export`, { params }) as any,
};

export const importApi = {
  template: (domain: string) => http.get(`/api/v1/imports/${domain}/template`) as any,
  validate: (domain: string, data: any) => http.post(`/api/v1/imports/${domain}/validate`, data) as any,
  commit: (batchId: number, data: any) => http.post(`/api/v1/imports/${batchId}/commit`, data) as any,
  batch: (batchId: number) => http.get(`/api/v1/imports/${batchId}`) as any,
  list: (params: any) => http.get('/api/v1/imports', { params }) as any,
};

export const approvalApi = {
  processes: () => http.get('/api/v1/approvals/processes') as any,
  handlers: () => http.get('/api/v1/approvals/handlers') as any,
  todo: () => http.get('/api/v1/approvals/todo') as any,
  instances: (params: any) => http.get('/api/v1/approvals/instances', { params }) as any,
  detail: (id: number) => http.get(`/api/v1/approvals/${id}`) as any,
  pass: (id: number, data: any) => http.post(`/api/v1/approvals/${id}/pass`, data) as any,
  reject: (id: number, data: any) => http.post(`/api/v1/approvals/${id}/reject`, data) as any,
  transfer: (id: number, data: any) => http.post(`/api/v1/approvals/${id}/transfer`, data) as any,
  addSign: (id: number, data: any) => http.post(`/api/v1/approvals/${id}/add-sign`, data) as any,
  ccd: () => http.get('/api/v1/approvals/ccd') as any,
  ccUsers: () => http.get('/api/v1/approvals/cc-users') as any,
  designerOptions: () => http.get('/api/v1/approvals/designer-options') as any,
  saveProcess: (data: any) => http.post('/api/v1/approvals/processes', data) as any,
  toggleProcess: (code: string) => http.post(`/api/v1/approvals/processes/${code}/toggle`) as any,
};

export const integrationApi = {
  summary: () => http.get('/api/v1/integration/summary') as any,
  subscribers: () => http.get('/api/v1/integration/subscribers') as any,
  saveSubscriber: (data: any) => http.post('/api/v1/integration/subscribers', data) as any,
  events: (params: any) => http.get('/api/v1/integration/push-events', { params }) as any,
  eventDetail: (id: number) => http.get(`/api/v1/integration/push-events/${id}`) as any,
  retry: (id: number) => http.post(`/api/v1/integration/push-events/${id}/retry`) as any,
  dispatch: () => http.post('/api/v1/integration/dispatch') as any,
  logs: (params: any) => http.get('/api/v1/integration/push-logs', { params }) as any,
};

export const systemApi = {
  users: (params: any) => http.get('/api/v1/users', { params }) as any,
  createUser: (data: any) => http.post('/api/v1/users', data) as any,
  updateUser: (id: number, data: any) => http.put(`/api/v1/users/${id}`, data) as any,
  roles: () => http.get('/api/v1/roles') as any,
  rolePerms: (code: string) => http.get(`/api/v1/roles/${code}/perms`) as any,
  saveRolePerms: (code: string, data: any) => http.put(`/api/v1/roles/${code}/perms`, data) as any,
  audit: (params: any) => http.get('/api/v1/audit', { params }) as any,
  configs: () => http.get('/api/v1/configs') as any,
  saveConfigs: (data: any) => http.put('/api/v1/configs', data) as any,
};

export const noticeApi = {
  list: (params?: any) => http.get('/api/v1/notices', { params }) as any,
  unreadCount: () => http.get('/api/v1/notices/unread-count') as any,
  markRead: (data: any) => http.post('/api/v1/notices/read', data) as any,
};

export const collectApi = {
  systems: () => http.get('/api/v1/collect/systems') as any,
  save: (data: any) => http.post('/api/v1/collect/systems', data) as any,
  run: (id: number) => http.post(`/api/v1/collect/systems/${id}/run`) as any,
  logs: (params?: any) => http.get('/api/v1/collect/logs', { params }) as any,
};

export const statsApi = {
  overview: () => http.get('/api/v1/stats/overview') as any,
  workbench: () => http.get('/api/v1/stats/workbench') as any,
  dashboard: () => http.get('/api/v1/stats/dashboard') as any,
};

export const qualityApi = {
  meta: () => http.get('/api/v1/quality/meta') as any,
  overview: () => http.get('/api/v1/quality/overview') as any,
  rules: (params?: any) => http.get('/api/v1/quality/rules', { params }) as any,
  saveRule: (data: any) => http.post('/api/v1/quality/rules', data) as any,
  tasks: () => http.get('/api/v1/quality/tasks') as any,
  saveTask: (data: any) => http.post('/api/v1/quality/tasks', data) as any,
  runTask: (id: number) => http.post(`/api/v1/quality/tasks/${id}/run`) as any,
  scan: (data?: any) => http.post('/api/v1/quality/scan', data || {}) as any,
  runs: (params?: any) => http.get('/api/v1/quality/runs', { params }) as any,
  runReport: (id: number) => http.get(`/api/v1/quality/runs/${id}/report`) as any,
  issues: (params?: any) => http.get('/api/v1/quality/issues', { params }) as any,
  issueDetail: (id: number) => http.get(`/api/v1/quality/issues/${id}`) as any,
  handleIssue: (id: number, data: any) => http.post(`/api/v1/quality/issues/${id}/handle`, data) as any,
  assignees: () => http.get('/api/v1/quality/issues/candidates') as any,
  assignIssue: (id: number, data: any) => http.post(`/api/v1/quality/issues/${id}/assign`, data) as any,
};

export const scheduleApi = {
  meta: () => http.get('/api/v1/schedule/meta') as any,
  jobs: () => http.get('/api/v1/schedule/jobs') as any,
  save: (data: any) => http.post('/api/v1/schedule/jobs', data) as any,
  toggle: (id: number, enabled: boolean) => http.post(`/api/v1/schedule/jobs/${id}/toggle`, { enabled }) as any,
  runNow: (id: number) => http.post(`/api/v1/schedule/jobs/${id}/run`) as any,
  runs: (params: any) => http.get('/api/v1/schedule/runs', { params }) as any,
};

export const workflowApi = {
  meta: () => http.get('/api/v1/workflow/meta') as any,
  definitions: (params?: any) => http.get('/api/v1/workflow/definitions', { params }) as any,
  definition: (id: number) => http.get(`/api/v1/workflow/definitions/${id}`) as any,
  save: (data: any) => http.post('/api/v1/workflow/definitions', data) as any,
  run: (id: number) => http.post(`/api/v1/workflow/definitions/${id}/run`) as any,
  runs: (params?: any) => http.get('/api/v1/workflow/runs', { params }) as any,
  runDetail: (id: number) => http.get(`/api/v1/workflow/runs/${id}`) as any,
};
