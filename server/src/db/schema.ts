/**
 * SQLite 初期库表定义（M1）。
 * 方言隔离说明：DDL 集中在本文件，迁移 PostgreSQL 时替换为 `db/schema/postgres.ts`，
 * 业务代码不直接写方言相关 SQL（JSON 取值由 IndexManager 统一生成列）。
 */
export const SCHEMA_SQL = `
-- ============ 权限与系统 ============
CREATE TABLE IF NOT EXISTS sys_role (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  remark      TEXT
);

CREATE TABLE IF NOT EXISTS sys_user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  dept          TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sys_user_role (
  user_id  INTEGER NOT NULL,
  role_id  INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sys_menu_perm (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id    INTEGER NOT NULL,
  perm_code  TEXT NOT NULL,
  allowed    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (role_id, perm_code)
);

CREATE TABLE IF NOT EXISTS sys_data_perm (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id      INTEGER NOT NULL,
  domain_code  TEXT NOT NULL,
  row_expr     TEXT,
  field_masks  TEXT
);

CREATE TABLE IF NOT EXISTS sys_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  username    TEXT,
  module      TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sys_audit_log_created ON sys_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_sys_audit_log_module ON sys_audit_log(module, created_at);

CREATE TABLE IF NOT EXISTS sys_config (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  key     TEXT NOT NULL UNIQUE,
  value   TEXT,
  remark  TEXT
);

-- ============ 元数据 ============
CREATE TABLE IF NOT EXISTS md_domain (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  owner        TEXT,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS md_model (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_code  TEXT NOT NULL,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'DRAFT',
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS md_field (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id    INTEGER NOT NULL,
  field_key   TEXT NOT NULL,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL,
  required    INTEGER NOT NULL DEFAULT 0,
  unique_flag INTEGER NOT NULL DEFAULT 0,
  query_flag  INTEGER NOT NULL DEFAULT 0,
  dict_code   TEXT,
  ref_domain  TEXT,
  max_length  INTEGER,
  regex       TEXT,
  placeholder TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (model_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_md_field_model ON md_field(model_id, sort);

CREATE TABLE IF NOT EXISTS md_dict (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL,
  remark  TEXT
);

CREATE TABLE IF NOT EXISTS md_dict_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dict_code    TEXT NOT NULL,
  value        TEXT NOT NULL,
  label        TEXT NOT NULL,
  parent_value TEXT,
  sort         INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (dict_code, value)
);

CREATE TABLE IF NOT EXISTS md_code_rule (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_code  TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  segments     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS md_sequence (
  rule_hash   TEXT NOT NULL,
  period      TEXT NOT NULL,
  cur         INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (rule_hash, period)
);

-- ============ 主数据 ============
CREATE TABLE IF NOT EXISTS md_master_data (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id    INTEGER,
  domain_code TEXT NOT NULL,
  master_code TEXT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DRAFT',
  version     INTEGER NOT NULL DEFAULT 1,
  data        TEXT NOT NULL,
  fingerprint TEXT,
  created_by  INTEGER,
  created_at  TEXT,
  updated_by  INTEGER,
  updated_at  TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_md_master_data_dom_code ON md_master_data(domain_code, master_code);
CREATE INDEX IF NOT EXISTS idx_md_master_data_dom_status ON md_master_data(domain_code, status);
CREATE INDEX IF NOT EXISTS idx_md_master_data_dom_upd ON md_master_data(domain_code, updated_at);

CREATE TABLE IF NOT EXISTS md_data_version (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id    INTEGER NOT NULL,
  domain_code  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  data         TEXT NOT NULL,
  diff         TEXT,
  action       TEXT NOT NULL,
  operator     TEXT,
  instance_id  INTEGER,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_md_data_version_record ON md_data_version(record_id, version);

CREATE TABLE IF NOT EXISTS md_dup_rule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_code   TEXT NOT NULL UNIQUE,
  exact_fields  TEXT NOT NULL,
  fuzzy_fields  TEXT NOT NULL,
  threshold     REAL NOT NULL DEFAULT 0.6
);

CREATE TABLE IF NOT EXISTS md_merge_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_code   TEXT NOT NULL,
  gold_id       INTEGER NOT NULL,
  gold_code     TEXT,
  merged_ids    TEXT NOT NULL,
  merged_codes  TEXT,
  field_choices TEXT,
  operator      TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS md_import_batch (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_code  TEXT NOT NULL,
  filename     TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  valid        INTEGER NOT NULL DEFAULT 0,
  invalid      INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'VALIDATED',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE IF NOT EXISTS md_import_row (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id  INTEGER NOT NULL,
  row_no    INTEGER NOT NULL,
  raw       TEXT NOT NULL,
  valid     INTEGER NOT NULL DEFAULT 1,
  errors    TEXT,
  record_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_md_import_row_batch ON md_import_row(batch_id, row_no);

-- ============ 审批 ============
CREATE TABLE IF NOT EXISTS ap_process_def (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_instance (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  process_code   TEXT NOT NULL,
  biz_type       TEXT NOT NULL,
  biz_id         INTEGER NOT NULL,
  domain_code    TEXT NOT NULL,
  action         TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL,
  current_node   TEXT,
  prev_status    TEXT,
  data_snapshot  TEXT,
  applicant_id   INTEGER,
  applicant_name TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_instance_status ON ap_instance(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ap_instance_biz ON ap_instance(domain_code, biz_id);

CREATE TABLE IF NOT EXISTS ap_task (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id    INTEGER NOT NULL,
  node_id        TEXT NOT NULL,
  node_name      TEXT NOT NULL,
  assignee_id    INTEGER,
  assignee_name  TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  comment        TEXT,
  created_at     TEXT NOT NULL,
  handled_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ap_task_instance ON ap_task(instance_id, status);
CREATE INDEX IF NOT EXISTS idx_ap_task_assignee ON ap_task(assignee_id, status);

-- ============ 集成分发 ============
CREATE TABLE IF NOT EXISTS int_subscriber (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  domain_codes TEXT NOT NULL,
  url          TEXT NOT NULL,
  secret       TEXT,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS int_push_event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_no       TEXT NOT NULL UNIQUE,
  subscriber_id  INTEGER NOT NULL,
  domain_code    TEXT NOT NULL,
  master_code    TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  next_retry_at  TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_int_push_event_status_retry ON int_push_event(status, next_retry_at);

CREATE TABLE IF NOT EXISTS int_push_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL,
  attempt      INTEGER NOT NULL,
  success      INTEGER NOT NULL,
  request      TEXT,
  response     TEXT,
  duration_ms  INTEGER,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_int_push_log_event ON int_push_log(event_id);
`;

/** M2 增量库表：数据质量与数据工作流（幂等执行，版本号 2） */
export const SCHEMA_V2_SQL = `
-- ============ 数据质量 ============
CREATE TABLE IF NOT EXISTS dq_rule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  domain_code TEXT NOT NULL,
  dimension   TEXT NOT NULL,
  field_key   TEXT,
  rule_type   TEXT NOT NULL,
  params      TEXT,
  level       TEXT NOT NULL DEFAULT 'MEDIUM',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dq_rule_domain ON dq_rule(domain_code, enabled);

CREATE TABLE IF NOT EXISTS dq_task (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  domain_code TEXT,
  schedule    TEXT,
  last_run_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dq_task_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER,
  domain_code TEXT,
  status      TEXT NOT NULL DEFAULT 'SUCCESS',
  total       INTEGER NOT NULL DEFAULT 0,
  passed      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  score       REAL NOT NULL DEFAULT 100,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  operator    TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dq_task_run_created ON dq_task_run(created_at);

CREATE TABLE IF NOT EXISTS dq_issue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER,
  rule_id     INTEGER,
  domain_code TEXT NOT NULL,
  record_id   INTEGER,
  master_code TEXT,
  field_key   TEXT,
  value       TEXT,
  message     TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'MEDIUM',
  dimension   TEXT,
  status      TEXT NOT NULL DEFAULT 'OPEN',
  handled_by  TEXT,
  handled_at  TEXT,
  remark      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dq_issue_status ON dq_issue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_dq_issue_rule ON dq_issue(rule_id);

-- ============ 数据工作流 ============
CREATE TABLE IF NOT EXISTS wf_definition (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  domain_code TEXT NOT NULL,
  description TEXT,
  nodes       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DRAFT',
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wf_run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_id INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'RUNNING',
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  row_count     INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  created_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_wf_run_def ON wf_run(definition_id, id);

CREATE TABLE IF NOT EXISTS wf_node_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  node_id     TEXT NOT NULL,
  node_type   TEXT NOT NULL,
  node_name   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'SUCCESS',
  rows_in     INTEGER NOT NULL DEFAULT 0,
  rows_out    INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  preview     TEXT,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_wf_node_run_run ON wf_node_run(run_id);
`;

/** M3 增量库表：任务调度中心 + 质量问题指派（幂等执行，版本号 3） */
export const SCHEMA_V3_SQL = `
-- ============ 任务调度中心 ============
CREATE TABLE IF NOT EXISTS sch_job (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  job_type    TEXT NOT NULL,
  target_id   INTEGER,
  domain_code TEXT,
  cron        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sch_job_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL,
  trigger     TEXT NOT NULL,
  status      TEXT NOT NULL,
  message     TEXT,
  result      TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  operator    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sch_job_run_job ON sch_job_run(job_id, id);

-- 质量问题指派（责任人）
ALTER TABLE dq_issue ADD COLUMN assignee_id INTEGER;
ALTER TABLE dq_issue ADD COLUMN assignee_name TEXT;
CREATE INDEX IF NOT EXISTS idx_dq_issue_assignee ON dq_issue(assignee_id, status);
`;

/** M4 增量库表：数据采集接入 + 站内通知（幂等执行，版本号 4） */
export const SCHEMA_V4_SQL = `
-- ============ 采集接入 ============
CREATE TABLE IF NOT EXISTS src_system (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  domain_code TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'API',
  endpoint    TEXT,
  api_key     TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  remark      TEXT,
  last_run_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS src_mapping (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id   INTEGER NOT NULL,
  domain_code TEXT NOT NULL,
  field_maps  TEXT NOT NULL,
  value_maps  TEXT,
  clean_rules TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  updated_at  TEXT NOT NULL
);

-- ============ 站内通知 ============
CREATE TABLE IF NOT EXISTS sys_notice (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT,
  link        TEXT,
  read_flag   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sys_notice_user ON sys_notice(user_id, read_flag, id);
`;

/** M5 增量库表：树形码表 + 层级模型（幂等执行，版本号 5） */
export const SCHEMA_V5_SQL = `
-- 树形码表：开启后码值通过 parent_value 建立父子层级（md_dict_item.parent_value 已存在）
ALTER TABLE md_dict ADD COLUMN is_tree INTEGER NOT NULL DEFAULT 0;

-- 层级模型：模型配置层级字段（parent_field 存字段标识，字段值为父记录的 master_code）
ALTER TABLE md_model ADD COLUMN parent_field TEXT;
`;

/** M6 增量库表：审批抄送（幂等执行，版本号 6） */
export const SCHEMA_V6_SQL = `
-- 审批抄送：发起时可选抄送人 + 流程 CC 节点抄送记录，read_at 为抄送人阅读时间
CREATE TABLE IF NOT EXISTS ap_cc (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  node_id     TEXT,
  user_id     INTEGER NOT NULL,
  user_name   TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_cc_user ON ap_cc(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ap_cc_instance ON ap_cc(instance_id, id);
`;

/** M7 增量库表：采集通道扩展（数据库直连 + 时间戳增量，幂等执行，版本号 7） */
export const SCHEMA_V7_SQL = `
-- src_system 追加通道配置（JSON）：DB 直连 { dbType, dbPath, tableName } + 增量 { incremental, tsField, lastTs }
ALTER TABLE src_system ADD COLUMN config TEXT;

-- 采集执行留痕：每次执行一条记录（含增量水位），供采集运行历史查询
CREATE TABLE IF NOT EXISTS src_collect_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id   INTEGER NOT NULL,
  system_code TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'FULL',
  pulled      INTEGER NOT NULL DEFAULT 0,
  valid       INTEGER NOT NULL DEFAULT 0,
  invalid     INTEGER NOT NULL DEFAULT 0,
  batch_id    INTEGER,
  last_ts     TEXT,
  skipped     INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collect_log_sys ON src_collect_log(system_id, id);
`;
