import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { canonicalJson, dateOnly, fingerprintOf, hashRule, nowStr, sha256 } from '../common/util';
import { nextRunAfter } from '../common/cron';

/** M1 演示种子数据：三大主数据域、演示账号、审批定义、订阅与待推送事件 */
export function runSeed(db: Database.Database) {
  const exists = db.prepare('SELECT COUNT(*) AS n FROM sys_user').get() as any;
  if (exists.n > 0) return;

  const ts = nowStr();
  const today = dateOnly();

  db.transaction(() => {
    // ---------- 角色与权限 ----------
    const permsAll = [
      'workbench.view',
      'master.view', 'master.create', 'master.edit', 'master.import', 'master.export', 'master.merge', 'master.lifecycle', 'master.submit',
      'approval.view', 'approval.handle', 'approval.manage',
      'model.view', 'model.manage',
      'dict.view', 'dict.manage',
      'quality.view', 'quality.manage',
      'integration.view', 'integration.manage',
      'workflow.view', 'workflow.manage',
      'dashboard.view',
      'system.view', 'system.user', 'system.role', 'system.audit', 'system.manage',
    ];
    const roles: Array<[string, string, string[]]> = [
      ['SYS_ADMIN', '系统管理员', permsAll],
      ['DATA_STEWARD', '数据治理岗', [
        'workbench.view',
        'master.view', 'master.create', 'master.edit', 'master.import', 'master.export', 'master.merge', 'master.lifecycle', 'master.submit',
        'approval.view', 'approval.handle', 'approval.manage',
        'model.view', 'model.manage', 'dict.view', 'dict.manage',
        'integration.view', 'integration.manage', 'dashboard.view', 'system.view', 'system.manage',
      ]],
      ['DEPT_LEADER', '部门主管', ['workbench.view', 'master.view', 'approval.view', 'approval.handle', 'dashboard.view']],
      ['DATA_EDITOR', '业务专员', ['workbench.view', 'master.view', 'master.create', 'master.edit', 'master.submit', 'master.import', 'approval.view', 'dict.view', 'dashboard.view']],
    ];
    const roleIds: Record<string, number> = {};
    for (const [code, name, perms] of roles) {
      const r = db.prepare('INSERT INTO sys_role (code, name) VALUES (?, ?)').run(code, name);
      const roleId = Number(r.lastInsertRowid);
      roleIds[code] = roleId;
      for (const p of perms) {
        db.prepare('INSERT INTO sys_menu_perm (role_id, perm_code, allowed) VALUES (?, ?, 1)').run(roleId, p);
      }
    }

    // ---------- 用户 ----------
    const users: Array<[string, string, string, string, string[]]> = [
      ['admin', 'admin123', '平台管理员', '信息中心', ['SYS_ADMIN']],
      ['steward', 'steward123', '林治理', '数据治理部', ['DATA_STEWARD']],
      ['leader', 'leader123', '周主管', '采购部', ['DEPT_LEADER']],
      ['buyer', 'buyer123', '陈采购', '采购部', ['DATA_EDITOR']],
    ];
    const userIds: Record<string, number> = {};
    for (const [username, pwd, display, dept, rs] of users) {
      const r = db
        .prepare('INSERT INTO sys_user (username, password, display_name, dept, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(username, bcrypt.hashSync(pwd, 10), display, dept, 'ACTIVE', ts);
      userIds[username] = Number(r.lastInsertRowid);
      for (const rc of rs) {
        db.prepare('INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)').run(userIds[username], roleIds[rc]);
      }
    }

    // 数据权限：域可见范围 + 字段脱敏
    const domains = ['material', 'customer', 'supplier'];
    for (const rc of ['SYS_ADMIN', 'DATA_STEWARD']) {
      for (const d of domains) {
        db.prepare('INSERT INTO sys_data_perm (role_id, domain_code) VALUES (?, ?)').run(roleIds[rc], d);
      }
    }
    db.prepare('INSERT INTO sys_data_perm (role_id, domain_code) VALUES (?, ?)').run(roleIds['DEPT_LEADER'], 'material');
    for (const d of ['material', 'customer']) {
      const masks = d === 'customer' ? JSON.stringify({ phone: 'masked' }) : null;
      db.prepare('INSERT INTO sys_data_perm (role_id, domain_code, field_masks) VALUES (?, ?, ?)').run(roleIds['DATA_EDITOR'], d, masks);
    }

    // ---------- 主数据域 ----------
    const domainRows: Array<[string, string, string, string, number]> = [
      ['material', '物料主数据', '采购、生产、库存共用的物料标准信息', '采购部', 1],
      ['customer', '客户主数据', '销售与财务共用的客户标准档案', '销售部', 2],
      ['supplier', '供应商主数据', '采购与质量共用的供应商档案', '采购部', 3],
    ];
    for (const [code, name, desc, owner, sort] of domainRows) {
      db.prepare('INSERT INTO md_domain (code, name, description, owner, status, sort) VALUES (?, ?, ?, ?, ?, ?)').run(code, name, desc, owner, 'ACTIVE', sort);
    }

    // ---------- 码表 ----------
    const dicts: Array<[string, string, Array<[string, string, number]>]> = [
      ['unit', '计量单位', [['EA', '件', 1], ['PCS', '个', 2], ['KG', '千克', 3], ['M', '米', 4], ['BOX', '箱', 5]]],
      ['material_category', '物料分类', [['FASTENER', '紧固件', 1], ['ELECTRIC', '电气', 2], ['MACHINE', '机械', 3], ['CONSUME', '耗材', 4], ['PACK', '包装', 5]]],
      ['customer_level', '客户等级', [['A', 'A · 战略客户', 1], ['B', 'B · 重点客户', 2], ['C', 'C · 普通客户', 3]]],
      ['region', '所属区域', [['EAST', '华东', 1], ['SOUTH', '华南', 2], ['NORTH', '华北', 3], ['WEST', '西南', 4], ['CENTRAL', '华中', 5]]],
      ['supplier_type', '供应商类型', [['MAKER', '生产商', 1], ['TRADER', '贸易商', 2], ['SERVICE', '服务商', 3]]],
    ];
    for (const [code, name, items] of dicts) {
      db.prepare('INSERT INTO md_dict (code, name) VALUES (?, ?)').run(code, name);
      for (const [value, label, sort] of items) {
        db.prepare('INSERT INTO md_dict_item (dict_code, value, label, sort, status) VALUES (?, ?, ?, ?, ?)').run(code, value, label, sort, 'ACTIVE');
      }
    }

    // ---------- 模型与字段 ----------
    type FieldSeed = [string, string, string, number, number, number, string | null, number];
    const models: Array<[string, string, string, string, FieldSeed[]]> = [
      ['material', 'material', '物料模型', 'materialName', [
        ['materialName', '物料名称', 'TEXT', 1, 1, 0, null, 1],
        ['spec', '规格型号', 'TEXT', 1, 0, 0, null, 2],
        ['unit', '计量单位', 'ENUM', 1, 0, 1, 'unit', 3],
        ['category', '物料分类', 'ENUM', 1, 0, 1, 'material_category', 4],
        ['brand', '品牌', 'TEXT', 0, 0, 0, null, 5],
        ['price', '参考单价', 'NUMBER', 0, 0, 0, null, 6],
        ['remark', '备注', 'TEXT', 0, 0, 0, null, 7],
      ]],
      ['customer', 'customer', '客户模型', 'customerName', [
        ['customerName', '客户名称', 'TEXT', 1, 1, 0, null, 1],
        ['customerLevel', '客户等级', 'ENUM', 1, 0, 1, 'customer_level', 2],
        ['region', '所属区域', 'ENUM', 1, 0, 1, 'region', 3],
        ['creditLimit', '信用额度（万元）', 'NUMBER', 0, 0, 0, null, 4],
        ['contact', '联系人', 'TEXT', 0, 0, 0, null, 5],
        ['phone', '联系电话', 'TEXT', 0, 0, 0, null, 6],
        ['address', '注册地址', 'TEXT', 0, 0, 0, null, 7],
      ]],
      ['supplier', 'supplier', '供应商模型', 'supplierName', [
        ['supplierName', '供应商名称', 'TEXT', 1, 1, 0, null, 1],
        ['supplierType', '供应商类型', 'ENUM', 1, 0, 1, 'supplier_type', 2],
        ['contact', '联系人', 'TEXT', 0, 0, 0, null, 3],
        ['phone', '联系电话', 'TEXT', 0, 0, 0, null, 4],
        ['address', '地址', 'TEXT', 0, 0, 0, null, 5],
        ['certDate', '资质有效期', 'DATE', 0, 0, 0, null, 6],
        ['remark', '备注', 'TEXT', 0, 0, 0, null, 7],
      ]],
    ];
    const modelIds: Record<string, number> = {};
    for (const [domain, code, name, nameKey, fields] of models) {
      const m = db
        .prepare("INSERT INTO md_model (domain_code, code, name, name_key, version, status, description, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, 2, 'PUBLISHED', ?, ?, ?, ?)")
        .run(domain, code, name, nameKey, `${name}（元数据驱动）`, ts, ts, ts);
      modelIds[domain] = Number(m.lastInsertRowid);
      for (const f of fields) {
        db.prepare(
          'INSERT INTO md_field (model_id, field_key, label, type, required, unique_flag, query_flag, dict_code, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(modelIds[domain], f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7]);
      }
    }

    // 查询字段生成列（SQLite VIRTUAL 生成列 + 复合索引）
    const genCols: Array<[string, string]> = [
      ['g_unit', '$.unit'],
      ['g_category', '$.category'],
      ['g_customerLevel', '$.customerLevel'],
      ['g_region', '$.region'],
      ['g_supplierType', '$.supplierType'],
    ];
    for (const [col, path] of genCols) {
      db.exec(`ALTER TABLE md_master_data ADD COLUMN ${col} TEXT GENERATED ALWAYS AS (json_extract(data, '${path}')) VIRTUAL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_md_master_data_dom_${col} ON md_master_data(domain_code, ${col})`);
    }

    // ---------- 编码规则 ----------
    const rules: Array<[string, string, any[]]> = [
      ['material', '物料编码规则', [{ type: 'FIX', value: 'WL' }, { type: 'DATE', fmt: 'yyyyMMdd' }, { type: 'SEQ', len: 4, reset: 'DAY' }]],
      ['customer', '客户编码规则', [{ type: 'FIX', value: 'KH' }, { type: 'DATE', fmt: 'yyyyMMdd' }, { type: 'SEQ', len: 4, reset: 'DAY' }]],
      ['supplier', '供应商编码规则', [{ type: 'FIX', value: 'GYS' }, { type: 'DATE', fmt: 'yyyyMMdd' }, { type: 'SEQ', len: 4, reset: 'DAY' }]],
    ];
    const seqHashes: Record<string, string> = {};
    for (const [domain, name, segments] of rules) {
      db.prepare('INSERT INTO md_code_rule (domain_code, name, segments, status, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        domain, name, JSON.stringify(segments), 'ACTIVE', ts,
      );
      seqHashes[domain] = hashRule(domain, segments);
    }

    // ---------- 主数据 ----------
    const insertRecord = (domain: string, name: string, data: any, status: string, code: string | null, hoursAgo: number, version = 1) => {
      const created = nowStr(new Date(Date.now() - hoursAgo * 3600 * 1000));
      const fp = fingerprintOf(data);
      const r = db
        .prepare('INSERT INTO md_master_data (model_id, domain_code, master_code, name, status, version, data, fingerprint, created_by, created_at, updated_by, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
        .run(modelIds[domain], domain, code, name, status, version, JSON.stringify(data), fp, userIds['steward'], created, userIds['steward'], created);
      const id = Number(r.lastInsertRowid);
      if (status === 'PUBLISHED' || status === 'CHANGING' || status === 'FROZEN') {
        db.prepare('INSERT INTO md_data_version (record_id, domain_code, version, data, diff, action, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          id, domain, version, JSON.stringify(data), null, 'CREATE', '林治理', created,
        );
      }
      return { id, code };
    };

    const materials: Array<[string, any, string, number]> = [
      ['六角螺栓 M8×30 · GB/T 5783', { materialName: '六角螺栓 M8×30 · GB/T 5783', spec: 'M8×30 · GB/T 5783', unit: 'EA', category: 'FASTENER', brand: '国标', price: 0.35, remark: '常用紧固件' }, 'WL' + today + '-0001', 26],
      ['内六角圆柱头螺钉 M6×20', { materialName: '内六角圆柱头螺钉 M6×20', spec: 'M6×20 · GB/T 70.1', unit: 'EA', category: 'FASTENER', brand: '晋亿', price: 0.28, remark: '' }, 'WL' + today + '-0002', 24],
      ['不锈钢平垫圈 M8', { materialName: '不锈钢平垫圈 M8', spec: 'M8 · GB/T 97.1', unit: 'EA', category: 'FASTENER', brand: '国标', price: 0.06, remark: '' }, 'WL' + today + '-0003', 20],
      ['PLC 控制器 S7-1200', { materialName: 'PLC 控制器 S7-1200', spec: 'CPU 1214C DC/DC/DC', unit: 'PCS', category: 'ELECTRIC', brand: '西门子', price: 2680, remark: '关键电气件' }, 'WL' + today + '-0004', 16],
      ['交流接触器 CJX2-2510', { materialName: '交流接触器 CJX2-2510', spec: '25A / 220V', unit: 'PCS', category: 'ELECTRIC', brand: '正泰', price: 86, remark: '' }, 'WL' + today + '-0005', 12],
      ['阻燃电缆 RVV 3×2.5', { materialName: '阻燃电缆 RVV 3×2.5', spec: '3×2.5mm²', unit: 'M', category: 'ELECTRIC', brand: '远东', price: 12.5, remark: '' }, 'WL' + today + '-0006', 8],
      ['液压油 46# 200L', { materialName: '液压油 46# 200L', spec: '200L/桶', unit: 'KG', category: 'CONSUME', brand: '长城', price: 17.8, remark: '' }, 'WL' + today + '-0007', 5],
      ['瓦楞纸箱 600×400×300', { materialName: '瓦楞纸箱 600×400×300', spec: '五层加强', unit: 'BOX', category: 'PACK', brand: '本地', price: 4.2, remark: '' }, 'WL' + today + '-0008', 2],
    ];
    const materialIds: number[] = [];
    for (const [name, data, code, hours] of materials) {
      materialIds.push(insertRecord('material', name, data, 'PUBLISHED', code, hours).id);
    }
    // 待审批（新增申请，审批流已启动）
    const pendingId = insertRecord('material', '高强度螺栓 M12×50 · GB/T 1228', {
      materialName: '高强度螺栓 M12×50 · GB/T 1228', spec: 'M12×50 · 10.9级', unit: 'EA', category: 'FASTENER', brand: '国标', price: 1.2, remark: '风电项目专用',
    }, 'PENDING', null, 1).id;

    const customers: Array<[string, any, string, number]> = [
      ['上海电气集团股份有限公司', { customerName: '上海电气集团股份有限公司', customerLevel: 'A', region: 'EAST', creditLimit: 5000, contact: '王经理', phone: '021-62345678', address: '上海市徐汇区漕溪北路 100 号' }, 'KH' + today + '-0001', 22],
      ['苏州精工机械有限公司', { customerName: '苏州精工机械有限公司', customerLevel: 'B', region: 'EAST', creditLimit: 1200, contact: '李经理', phone: '0512-66889900', address: '苏州市工业园区星湖街 218 号' }, 'KH' + today + '-0002', 18],
      ['广州南方电气有限公司', { customerName: '广州南方电气有限公司', customerLevel: 'A', region: 'SOUTH', creditLimit: 3200, contact: '张总', phone: '020-87654321', address: '广州市黄埔区科学大道 182 号' }, 'KH' + today + '-0003', 14],
      ['成都蓉信科技有限公司', { customerName: '成都蓉信科技有限公司', customerLevel: 'C', region: 'WEST', creditLimit: 300, contact: '赵工', phone: '028-85551234', address: '成都市高新区天府大道 666 号' }, 'KH' + today + '-0004', 10],
      ['北京京诚自动化有限公司', { customerName: '北京京诚自动化有限公司', customerLevel: 'B', region: 'NORTH', creditLimit: 1800, contact: '孙经理', phone: '010-62348899', address: '北京市海淀区上地十街 1 号' }, 'KH' + today + '-0005', 6],
      ['武汉华中数控股份有限公司', { customerName: '武汉华中数控股份有限公司', customerLevel: 'B', region: 'CENTRAL', creditLimit: 2200, contact: '刘经理', phone: '027-87180088', address: '武汉市东湖高新区华中科技大学科技园' }, 'KH' + today + '-0006', 3],
    ];
    for (const [name, data, code, hours] of customers) {
      insertRecord('customer', name, data, 'PUBLISHED', code, hours);
    }

    const suppliers: Array<[string, any, string, number]> = [
      ['宁波紧固件制造有限公司', { supplierName: '宁波紧固件制造有限公司', supplierType: 'MAKER', contact: '陈经理', phone: '0574-87881234', address: '宁波市鄞州区集士港镇', certDate: '2027-06-30', remark: '紧固件主力供应商' }, 'GYS' + today + '-0001', 21],
      ['上海西门子工业自动化有限公司', { supplierName: '上海西门子工业自动化有限公司', supplierType: 'TRADER', contact: '周经理', phone: '021-38889900', address: '上海市浦东新区金桥路 1000 号', certDate: '2028-12-31', remark: '电气件授权代理' }, 'GYS' + today + '-0002', 17],
      ['远东电缆有限公司', { supplierName: '远东电缆有限公司', supplierType: 'MAKER', contact: '吴经理', phone: '0510-87219999', address: '宜兴市高塍镇远东大道 1 号', certDate: '2027-09-30', remark: '' }, 'GYS' + today + '-0003', 11],
      ['苏州包装材料厂', { supplierName: '苏州包装材料厂', supplierType: 'MAKER', contact: '徐经理', phone: '0512-65321888', address: '苏州市相城区黄埭镇', certDate: '2026-12-31', remark: '包装耗材' }, 'GYS' + today + '-0004', 7],
      ['深圳捷顺物流有限公司', { supplierName: '深圳捷顺物流有限公司', supplierType: 'SERVICE', contact: '黄经理', phone: '0755-83334444', address: '深圳市福田区深南大道 6008 号', certDate: '2027-03-31', remark: '物流服务' }, 'GYS' + today + '-0005', 4],
    ];
    for (const [name, data, code, hours] of suppliers) {
      insertRecord('supplier', name, data, 'PUBLISHED', code, hours);
    }

    // 编码流水初始化
    db.prepare('INSERT INTO md_sequence (rule_hash, period, cur, updated_at) VALUES (?, ?, ?, ?)').run(seqHashes['material'], today, 8, ts);
    db.prepare('INSERT INTO md_sequence (rule_hash, period, cur, updated_at) VALUES (?, ?, ?, ?)').run(seqHashes['customer'], today, 6, ts);
    db.prepare('INSERT INTO md_sequence (rule_hash, period, cur, updated_at) VALUES (?, ?, ?, ?)').run(seqHashes['supplier'], today, 5, ts);

    // ---------- 查重规则 ----------
    for (const d of domains) {
      db.prepare('INSERT INTO md_dup_rule (domain_code, exact_fields, fuzzy_fields, threshold) VALUES (?, ?, ?, ?)').run(
        d, JSON.stringify([d === 'material' ? 'materialName' : d === 'customer' ? 'customerName' : 'supplierName']),
        JSON.stringify([d === 'material' ? 'materialName' : d === 'customer' ? 'customerName' : 'supplierName']), 0.62,
      );
    }

    // ---------- 审批流程定义 ----------
    const def = (code: string, name: string, bind: any, approvalNodes: Array<{ id: string; name: string; role: string; multi: string }>) => ({
      code,
      bind,
      nodes: [
        { id: 'start', type: 'START' },
        ...approvalNodes.map((n) => ({ id: n.id, type: 'APPROVAL', name: n.name, assigneeType: 'ROLE', role: n.role, multi: n.multi, timeoutHours: 24 })),
        { id: 'auto', type: 'AUTO', handler: bind.action === 'CREATE' ? 'publishWithCode' : 'applyChange' },
        { id: 'end', type: 'END' },
      ],
      flows: [
        { from: 'start', to: approvalNodes[0].id },
        ...approvalNodes.map((n, i) => ({
          from: n.id,
          to: approvalNodes[i + 1]?.id || 'auto',
          when: 'approved',
        })),
        ...approvalNodes.map((n) => ({ from: n.id, to: 'start', when: 'rejected' })),
        { from: 'auto', to: 'end' },
      ],
    });
    const defs: Array<[string, string, any]> = [
      ['MATERIAL_ADD', '物料新增审批', def('MATERIAL_ADD', '物料新增审批', { domain: 'material', action: 'CREATE' }, [
        { id: 'n1', name: '部门初审', role: 'DEPT_LEADER', multi: 'OR' },
        { id: 'n2', name: '数据治理岗复审', role: 'DATA_STEWARD', multi: 'AND' },
      ])],
      ['MATERIAL_CHANGE', '物料变更审批', def('MATERIAL_CHANGE', '物料变更审批', { domain: 'material', action: 'CHANGE' }, [
        { id: 'n1', name: '数据治理岗审核', role: 'DATA_STEWARD', multi: 'AND' },
      ])],
      ['DEFAULT_ADD', '主数据新增通用审批', def('DEFAULT_ADD', '主数据新增通用审批', { domain: '*', action: 'CREATE' }, [
        { id: 'n1', name: '部门初审', role: 'DEPT_LEADER', multi: 'OR' },
        { id: 'n2', name: '数据治理岗复审', role: 'DATA_STEWARD', multi: 'AND' },
      ])],
      ['DEFAULT_CHANGE', '主数据变更通用审批', def('DEFAULT_CHANGE', '主数据变更通用审批', { domain: '*', action: 'CHANGE' }, [
        { id: 'n1', name: '数据治理岗审核', role: 'DATA_STEWARD', multi: 'AND' },
      ])],
    ];
    for (const [code, name, definition] of defs) {
      db.prepare('INSERT INTO ap_process_def (code, name, definition, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
        code, name, JSON.stringify(definition), 'ACTIVE', ts,
      );
    }

    // 演示审批实例（物料新增待部门初审）
    const instance = db
      .prepare(`INSERT INTO ap_instance (process_code, biz_type, biz_id, domain_code, action, title, status, current_node, prev_status, data_snapshot, applicant_id, applicant_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('MATERIAL_ADD', 'MASTER_DATA', pendingId, 'material', 'CREATE', '物料新增：高强度螺栓 M12×50 · GB/T 1228', 'RUNNING', 'n1', 'PENDING', null,
        userIds['buyer'], '陈采购', nowStr(new Date(Date.now() - 3600 * 1000)), nowStr(new Date(Date.now() - 3600 * 1000)));
    const instId = Number(instance.lastInsertRowid);
    const leaderId = userIds['leader'];
    db.prepare('INSERT INTO ap_task (instance_id, node_id, node_name, assignee_id, assignee_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      instId, 'n1', '部门初审', leaderId, '周主管', 'PENDING', nowStr(new Date(Date.now() - 3600 * 1000)),
    );

    // ---------- 订阅与分发 ----------
    const base = process.env.API_BASE || 'http://127.0.0.1:3000';
    const subs: Array<[string, string, string[], string]> = [
      ['ERP', 'ERP 系统', ['material', 'customer', 'supplier'], `${base}/api/v1/integration/mock-webhook`],
      ['MES', 'MES 生产系统', ['material'], `${base}/api/v1/integration/mock-webhook`],
    ];
    const subIds: Record<string, number> = {};
    for (const [code, name, ds, url] of subs) {
      const r = db.prepare('INSERT INTO int_subscriber (code, name, domain_codes, url, secret, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        code, name, ds.join(','), url, 'demo-secret', 'ACTIVE', ts,
      );
      subIds[code] = Number(r.lastInsertRowid);
    }

    // 待推送事件（演示 Outbox 分发）
    const seedEvents: Array<[number, string, string, number]> = [
      [materialIds[7], 'material', 'WL' + today + '-0008', 0],
      [materialIds[6], 'material', 'WL' + today + '-0007', 0],
      [materialIds[5], 'material', 'WL' + today + '-0006', 0],
    ];
    let evtSeq = 1;
    for (const [rid, domain, code, subIdx] of seedEvents) {
      const rec = db.prepare('SELECT * FROM md_master_data WHERE id = ?').get(rid) as any;
      for (const sc of ['ERP', 'MES']) {
        if (sc === 'MES' && domain !== 'material') continue;
        const no = 'EVT' + today + String(evtSeq++).padStart(4, '0');
        db.prepare('INSERT INTO int_push_event (event_no, subscriber_id, domain_code, master_code, event_type, payload, status, retry_count, next_retry_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)').run(
          no, subIds[sc], domain, code, 'CREATE', JSON.stringify({
            eventNo: no, eventType: 'CREATE', domain, masterCode: code,
            occurredAt: nowStr(), data: JSON.parse(rec.data), version: rec.version,
          }), 'PENDING', ts,
        );
      }
    }

    // ---------- 审计样例 ----------
    const audits: Array<[string, string, string, string, string]> = [
      ['master', 'PUBLISH', '物料新增发布 WL' + today + '-0008', '瓦楞纸箱 600×400×300', ts],
      ['approval', 'SUBMIT', '物料新增申请', '高强度螺栓 M12×50 · GB/T 1228', nowStr(new Date(Date.now() - 3600 * 1000))],
      ['master', 'PUBLISH', '物料新增发布 WL' + today + '-0006', '阻燃电缆 RVV 3×2.5', nowStr(new Date(Date.now() - 8 * 3600 * 1000))],
      ['metadata', 'MODEL_PUBLISH', '物料模型发布 v2', 'material', nowStr(new Date(Date.now() - 20 * 3600 * 1000))],
      ['auth', 'LOGIN', '用户登录', 'steward', nowStr(new Date(Date.now() - 22 * 3600 * 1000))],
      ['integration', 'PUSH', '主数据变更推送 ERP', 'WL' + today + '-0005', nowStr(new Date(Date.now() - 26 * 3600 * 1000))],
    ];
    for (const [mod, act, target, detail, at] of audits) {
      db.prepare('INSERT INTO sys_audit_log (user_id, username, module, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        userIds['steward'], 'steward', mod, act, target, detail, '127.0.0.1', at,
      );
    }

    // 数据指纹校验位（保证 fingerprint 与规范化 JSON 一致）
    const bad = db.prepare("SELECT id, data, fingerprint FROM md_master_data WHERE fingerprint IS NULL").all() as any[];
    for (const b of bad) {
      db.prepare('UPDATE md_master_data SET fingerprint = ? WHERE id = ?').run(sha256(canonicalJson(JSON.parse(b.data))), b.id);
    }
  })();
}

/** M2 演示种子：质量规则/任务/历史巡检与工作流定义（独立守卫，兼容已初始化的库） */
export function runSeedExtras(db: Database.Database) {
  const has = db.prepare('SELECT COUNT(*) AS n FROM dq_rule').get() as any;
  if (has.n > 0) return;

  const ts = nowStr();
  db.transaction(() => {
    // ---------- 角色补充授权（兼容已初始化的库） ----------
    const extraPerms: Array<[string, string[]]> = [
      ['DATA_STEWARD', ['quality.view', 'quality.manage', 'workflow.view', 'workflow.manage']],
      ['DEPT_LEADER', ['quality.view']],
      ['DATA_EDITOR', ['quality.view']],
    ];
    for (const [roleCode, perms] of extraPerms) {
      const role = db.prepare('SELECT id FROM sys_role WHERE code = ?').get(roleCode) as any;
      if (!role) continue;
      for (const p of perms) {
        db.prepare('INSERT OR IGNORE INTO sys_menu_perm (role_id, perm_code, allowed) VALUES (?, ?, 1)').run(role.id, p);
      }
    }

    // ---------- 质量规则 ----------
    type RuleSeed = [string, string, string, string, string, string, any, string];
    const rules: RuleSeed[] = [
      ['QL-MAT-UNIT', '物料-计量单位必填', 'material', 'COMPLETENESS', 'unit', 'NOT_EMPTY', {}, 'HIGH'],
      ['QL-MAT-NAME-UQ', '物料-名称唯一', 'material', 'UNIQUENESS', 'materialName', 'UNIQUE', {}, 'HIGH'],
      ['QL-MAT-CAT', '物料-分类合法', 'material', 'VALIDITY', 'category', 'REF_EXISTS', { dict: 'material_category' }, 'MEDIUM'],
      ['QL-MAT-PRICE', '物料-单价范围', 'material', 'VALIDITY', 'price', 'RANGE', { min: 0, max: 1000000 }, 'LOW'],
      ['QL-CUS-NAME-UQ', '客户-名称唯一', 'customer', 'UNIQUENESS', 'customerName', 'UNIQUE', {}, 'HIGH'],
      ['QL-CUS-LVL', '客户-等级合法', 'customer', 'VALIDITY', 'customerLevel', 'REF_EXISTS', { dict: 'customer_level' }, 'MEDIUM'],
      ['QL-CUS-PHONE', '客户-电话格式', 'customer', 'VALIDITY', 'phone', 'REGEX', { pattern: '^([0-9]{3,4}-)?[0-9]{7,8}$' }, 'LOW'],
      ['QL-SUP-NAME-UQ', '供应商-名称唯一', 'supplier', 'UNIQUENESS', 'supplierName', 'UNIQUE', {}, 'HIGH'],
      ['QL-SUP-TYPE', '供应商-类型合法', 'supplier', 'VALIDITY', 'supplierType', 'REF_EXISTS', { dict: 'supplier_type' }, 'MEDIUM'],
      ['QL-SUP-CERT', '供应商-证照时效', 'supplier', 'TIMELINESS', 'certDate', 'RANGE', { dateAfter: 'TODAY' }, 'HIGH'],
    ];
    for (const [code, name, domain, dim, field, type, params, level] of rules) {
      db.prepare('INSERT INTO dq_rule (code, name, domain_code, dimension, field_key, rule_type, params, level, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(
        code, name, domain, dim, field, type, JSON.stringify(params), level, ts, ts,
      );
    }

    // ---------- 质量任务 ----------
    db.prepare('INSERT INTO dq_task (code, name, domain_code, schedule, last_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'DQ-DAILY', '全域质量日检', null, '每日 02:00', null, ts,
    );
    db.prepare('INSERT INTO dq_task (code, name, domain_code, schedule, last_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'DQ-SUP-WEEK', '供应商证照周检', 'supplier', '每周一 03:00', null, ts,
    );

    // ---------- 历史巡检（近 7 天） ----------
    const scores = [93.8, 94.1, 94.6, 93.2, 94.9, 95.2];
    let lastRunId = 0;
    for (let i = 0; i < scores.length; i++) {
      const createdAt = nowStr(new Date(Date.now() - (scores.length - i) * 24 * 3600 * 1000));
      const total = 120;
      const failed = Math.round((100 - scores[i]) * 1.2);
      const r = db.prepare('INSERT INTO dq_task_run (task_id, domain_code, status, total, passed, failed, score, duration_ms, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        1, null, 'SUCCESS', total, total - failed, failed, scores[i], 5200 + i * 300, '林治理', createdAt,
      );
      lastRunId = Number(r.lastInsertRowid);
    }
    db.prepare('UPDATE dq_task SET last_run_at = ? WHERE id = 1').run(nowStr(new Date(Date.now() - 24 * 3600 * 1000)));
    db.prepare('UPDATE dq_task SET last_run_at = ? WHERE id = 2').run(nowStr(new Date(Date.now() - 3 * 24 * 3600 * 1000)));

    // ---------- 问题样例（关联最近一次巡检，含待整改/已闭环/已忽略） ----------
    const mat = db.prepare("SELECT id, master_code FROM md_master_data WHERE domain_code = 'material' AND deleted = 0 AND status = 'PUBLISHED' ORDER BY id LIMIT 1").get() as any;
    const cus = db.prepare("SELECT id, master_code FROM md_master_data WHERE domain_code = 'customer' AND deleted = 0 AND status = 'PUBLISHED' ORDER BY id LIMIT 1").get() as any;
    const sup = db.prepare("SELECT id, master_code FROM md_master_data WHERE domain_code = 'supplier' AND deleted = 0 AND status = 'PUBLISHED' ORDER BY id LIMIT 1").get() as any;
    const demoIssues: Array<[string, string, number, string, string, string, string, string, string, string, string | null]> = [
      ['QL-MAT-UNIT', 'material', mat?.id, mat?.master_code, 'remark', '', '备注字段为空（存量导入批次遗留）', 'COMPLETENESS', 'LOW', 'OPEN', null],
      ['QL-MAT-CAT', 'material', mat?.id, mat?.master_code, 'category', 'OTHER', '物料分类不在码表范围内', 'VALIDITY', 'HIGH', 'OPEN', null],
      ['QL-CUS-NAME-UQ', 'customer', cus?.id, cus?.master_code, 'customerName', cus?.master_code, '客户名称存在疑似重复（相似度 ≥ 0.85）', 'UNIQUENESS', 'MEDIUM', 'FIXED', nowStr(new Date(Date.now() - 6 * 3600 * 1000))],
      ['QL-SUP-CERT', 'supplier', sup?.id, sup?.master_code, 'certDate', '2026-01-31', '资质证照已过期未更新', 'TIMELINESS', 'HIGH', 'OPEN', null],
      ['QL-CUS-PHONE', 'customer', cus?.id, cus?.master_code, 'phone', '021-6234', '联系电话格式不符合规则', 'VALIDITY', 'LOW', 'IGNORED', nowStr(new Date(Date.now() - 2 * 3600 * 1000))],
    ];
    const ruleIds: Record<string, number> = {};
    for (const [code] of rules) {
      const row = db.prepare('SELECT id FROM dq_rule WHERE code = ?').get(code) as any;
      ruleIds[code] = row.id;
    }
    for (const [ruleCode, domain, rid, code, field, value, message, dim, level, status, handledAt] of demoIssues) {
      db.prepare('INSERT INTO dq_issue (run_id, rule_id, domain_code, record_id, master_code, field_key, value, message, level, dimension, status, handled_by, handled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        lastRunId, ruleIds[ruleCode] || null, domain, rid, code, field, value, message, level, dim, status,
        status === 'OPEN' ? null : '林治理', handledAt, nowStr(),
      );
    }

    // ---------- 工作流定义 ----------
    const wf1Nodes = [
      { id: 'in1', type: 'DB_INPUT', name: '读取物料主数据', x: 40, y: 120, config: { limit: 200 } },
      { id: 'f1', type: 'FILTER', name: '过滤空单位', x: 230, y: 120, config: { logic: 'AND', conditions: [{ field: 'unit', op: 'notEmpty' }] } },
      { id: 'fm1', type: 'FORMULA', name: '计算含税单价', x: 420, y: 120, config: { target: 'priceWithTax', expression: 'price * 1.13' } },
      { id: 's1', type: 'SORT', name: '按单价倒序', x: 610, y: 120, config: { field: 'priceWithTax', order: 'desc' } },
      { id: 'o1', type: 'OUTPUT', name: '预览输出', x: 800, y: 120, config: { fields: ['masterCode', 'materialName', 'unit', 'price', 'priceWithTax'] } },
    ];
    const wf2Nodes = [
      { id: 'in2', type: 'DB_INPUT', name: '读取客户主数据', x: 40, y: 120, config: { limit: 200 } },
      { id: 'ag1', type: 'AGG', name: '按区域聚合', x: 250, y: 120, config: { groupBy: ['region'], metrics: [{ field: 'creditLimit', agg: 'sum', as: 'totalCredit' }, { field: 'recordId', agg: 'count', as: 'cnt' }] } },
      { id: 's2', type: 'SORT', name: '按客户数排序', x: 470, y: 120, config: { field: 'cnt', order: 'desc' } },
      { id: 'o2', type: 'OUTPUT', name: '预览输出', x: 660, y: 120, config: { fields: ['region', 'cnt', 'totalCredit'] } },
    ];
    const defs: Array<[string, string, string, string, any[], string]> = [
      ['WF-MAT-CLEAN', '物料存量数据清洗', 'material', '过滤空单位、计算含税单价并排序预览', wf1Nodes, 'PUBLISHED'],
      ['WF-CUS-SEG', '客户区域分布聚合', 'customer', '按区域聚合客户数与信用额度', wf2Nodes, 'PUBLISHED'],
    ];
    for (const [code, name, domain, desc, nodes, status] of defs) {
      db.prepare('INSERT INTO wf_definition (code, name, domain_code, description, nodes, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        code, name, domain, desc, JSON.stringify(nodes), status, '林治理', ts, ts,
      );
    }
  })();
}

/** 幂等补充权限点：system.manage（任务调度管理，v3 起启用；新库由 runSeed 直接写入） */
export function seedSystemManagePerm(db: Database.Database) {
  db.prepare(
    `INSERT OR IGNORE INTO sys_menu_perm (role_id, perm_code, allowed)
     SELECT r.id, 'system.manage', 1 FROM sys_role r WHERE r.code IN ('SYS_ADMIN', 'DATA_STEWARD')`,
  ).run();
}

/** 幂等补充权限点：approval.manage（流程设计器管理，v6 起启用；新库由 runSeed 直接写入） */
export function seedApprovalManagePerm(db: Database.Database) {
  db.prepare(
    `INSERT OR IGNORE INTO sys_menu_perm (role_id, perm_code, allowed)
     SELECT r.id, 'approval.manage', 1 FROM sys_role r WHERE r.code IN ('SYS_ADMIN', 'DATA_STEWARD')`,
  ).run();
}

/** M3 种子：任务调度中心示例任务 + 存量问题指派（幂等） */
export function runSeedSchedule(db: Database.Database) {
  const exists = db.prepare('SELECT COUNT(*) AS n FROM sch_job').get() as any;
  if (exists.n > 0) return;

  const ts = nowStr();
  const wf = db.prepare("SELECT id FROM wf_definition WHERE code = 'WF-MAT-CLEAN'").get() as any;
  const dqSup = db.prepare("SELECT id FROM dq_task WHERE code = 'DQ-SUP-WEEK'").get() as any;

  const jobs: Array<[string, string, string, number | null, string | null, string, number]> = [
    ['SCH-DQ-DAILY', '每日全域质量巡检', 'QUALITY_SCAN', null, null, '0 2 * * *', 1],
    ['SCH-DQ-SUP-WEEK', '供应商证照周检', 'QUALITY_TASK', dqSup?.id ?? null, 'supplier', '0 3 * * 1', 1],
    ['SCH-WF-CLEAN', '物料清洗工作流（演示停用）', 'WORKFLOW', wf?.id ?? null, 'material', '30 3 * * 5', 0],
    ['SCH-DISPATCH', '分发失败补偿轮询', 'DISPATCH', null, null, '*/5 * * * *', 1],
  ];
  for (const [code, name, jobType, targetId, domainCode, cron, enabled] of jobs) {
    const next = enabled ? nextRunAfter(cron) : null;
    db.prepare(
      'INSERT INTO sch_job (code, name, job_type, target_id, domain_code, cron, enabled, last_run_at, next_run_at, last_status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)',
    ).run(code, name, jobType, targetId, domainCode, cron, enabled, next, '平台管理员', ts, ts);
  }

  // 存量待整改问题示例指派：供应商域 → 陈采购，其余 → 林治理
  const buyer = db.prepare("SELECT id, display_name FROM sys_user WHERE username = 'buyer'").get() as any;
  const steward = db.prepare("SELECT id, display_name FROM sys_user WHERE username = 'steward'").get() as any;
  if (buyer?.id) {
    db.prepare('UPDATE dq_issue SET assignee_id = ?, assignee_name = ? WHERE status = \'OPEN\' AND domain_code = \'supplier\' AND assignee_id IS NULL').run(buyer.id, buyer.display_name);
  }
  if (steward?.id) {
    db.prepare('UPDATE dq_issue SET assignee_id = ?, assignee_name = ? WHERE status = \'OPEN\' AND assignee_id IS NULL').run(steward.id, steward.display_name);
  }
}

/** M4 种子：系统全局参数（幂等） */
export function runSeedConfigs(db: Database.Database) {
  const defaults: Array<[string, string, string]> = [
    ['page.size.default', '20', '主数据列表默认每页条数'],
    ['import.maxRows', '5000', '单次导入最大行数'],
    ['pwd.minLength', '6', '用户密码最小长度'],
    ['session.timeoutHours', '8', '登录会话时长（小时）'],
    ['dispatch.maxRetry', '5', '分发失败最大重试次数（超过进入死信）'],
  ];
  for (const [key, value, remark] of defaults) {
    db.prepare('INSERT OR IGNORE INTO sys_config (key, value, remark) VALUES (?, ?, ?)').run(key, value, remark);
  }
}

/** M4 种子：采集源系统与字段映射示例（幂等） */
export function runSeedCollect(db: Database.Database) {
  const exists = db.prepare('SELECT COUNT(*) AS n FROM src_system').get() as any;
  if (exists.n > 0) return;
  const ts = nowStr();
  const r = db.prepare(
    "INSERT INTO src_system (code, name, domain_code, channel, endpoint, api_key, status, remark, created_at, updated_at) VALUES (?, ?, ?, 'API', ?, ?, 'ACTIVE', ?, ?, ?)",
  ).run(
    'SRC-ERP', 'ERP 物料源（演示）', 'material',
    'http://localhost:3000/api/v1/collect/mock/SRC-ERP', 'demo-erp-key',
    '演示用内置 Mock 接口：拉取物料数据并按映射转换、码值标准化', ts, ts,
  );
  db.prepare(
    "INSERT INTO src_mapping (system_id, domain_code, field_maps, value_maps, clean_rules, status, updated_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)",
  ).run(
    Number(r.lastInsertRowid), 'material',
    JSON.stringify([
      { source: 'erp_name', target: 'materialName' },
      { source: 'erp_spec', target: 'spec' },
      { source: 'erp_unit', target: 'unit' },
      { source: 'erp_category', target: 'category' },
      { source: 'erp_price', target: 'price' },
    ]),
    JSON.stringify([
      { field: 'unit', map: { '个': 'PCS', '件': 'EA', '千克': 'KG' } },
      { field: 'category', map: { '紧固件': 'FASTENER', '耗材': 'CONSUME' } },
    ]),
    JSON.stringify(['trim', 'upper']),
    ts,
  );
}

/** M5 种子：树形码表（物料分类层级码值）+ 层级模型（物料模型 parentMaterial 字段 + 三级演示数据），幂等 */
export function runSeedTree(db: Database.Database) {
  const ts = nowStr();

  // ---------- 树形码表：物料分类开启树形 + 层级码值 ----------
  db.prepare("UPDATE md_dict SET is_tree = 1 WHERE code = 'material_category'").run();
  const hasTreeItems = db
    .prepare("SELECT COUNT(*) AS n FROM md_dict_item WHERE dict_code = 'material_category' AND parent_value IS NOT NULL")
    .get() as any;
  if (!hasTreeItems.n) {
    const treeItems: Array<[string, string, string | null, number]> = [
      // 二级：紧固件 → 螺栓 / 螺母 / 垫圈；电气 → 电线电缆
      ['BOLT', '螺栓', 'FASTENER', 11],
      ['NUT', '螺母', 'FASTENER', 12],
      ['WASHER', '垫圈', 'FASTENER', 13],
      ['CABLE', '电线电缆', 'ELECTRIC', 14],
      // 三级：螺栓 → 六角螺栓 / 内六角螺栓
      ['HEX_BOLT', '六角螺栓', 'BOLT', 21],
      ['INNER_HEX_BOLT', '内六角螺栓', 'BOLT', 22],
    ];
    for (const [value, label, parent, sort] of treeItems) {
      db.prepare(
        "INSERT OR IGNORE INTO md_dict_item (dict_code, value, label, parent_value, sort, status) VALUES ('material_category', ?, ?, ?, ?, 'ACTIVE')",
      ).run(value, label, parent, sort);
    }
  }

  // ---------- 层级模型：物料模型增加上级物料字段并配置 parent_field ----------
  const materialModel = db.prepare("SELECT id FROM md_model WHERE code = 'material'").get() as any;
  if (materialModel?.id) {
    db.prepare(
      "INSERT OR IGNORE INTO md_field (model_id, field_key, label, type, required, unique_flag, query_flag, dict_code, ref_domain, sort) VALUES (?, 'parentMaterial', '上级物料', 'REF', 0, 0, 0, NULL, 'material', 8)",
    ).run(materialModel.id);
    db.prepare("UPDATE md_model SET parent_field = 'parentMaterial' WHERE code = 'material' AND parent_field IS NULL").run();

    // ---------- 层级演示数据：三级物料组（root → 子组 → 系列） ----------
    const hasHierarchy = db
      .prepare("SELECT COUNT(*) AS n FROM md_master_data WHERE domain_code = 'material' AND json_extract(data, '$.parentMaterial') IS NOT NULL")
      .get() as any;
    if (!hasHierarchy.n) {
      const steward = db.prepare("SELECT id FROM sys_user WHERE username = 'steward'").get() as any;
      const groups: Array<[string, string, string | null]> = [
        ['WL-GROUP-0001', '紧固件物料组（层级演示）', null],
        ['WL-GROUP-0002', '螺栓类物料组（层级演示）', 'WL-GROUP-0001'],
        ['WL-GROUP-0003', '内六角螺栓系列（层级演示）', 'WL-GROUP-0002'],
      ];
      for (const [code, name, parent] of groups) {
        const data = {
          materialName: name, spec: '—', unit: 'EA', category: 'FASTENER',
          brand: '演示', price: 0, remark: parent ? `上级物料：${parent}` : '层级演示根节点',
          parentMaterial: parent,
        };
        const r = db.prepare(
          "INSERT OR IGNORE INTO md_master_data (model_id, domain_code, master_code, name, status, version, data, fingerprint, created_by, created_at, updated_by, updated_at, deleted) VALUES (?, 'material', ?, ?, 'PUBLISHED', 1, ?, ?, ?, ?, ?, ?, 0)",
        ).run(materialModel.id, code, name, JSON.stringify(data), fingerprintOf(data), steward?.id ?? null, ts, steward?.id ?? null, ts);
        if (r.changes > 0) {
          const rid = Number(r.lastInsertRowid);
          db.prepare(
            "INSERT INTO md_data_version (record_id, domain_code, version, data, diff, action, operator, created_at) VALUES (?, 'material', 1, ?, NULL, 'CREATE', '林治理', ?)",
          ).run(rid, JSON.stringify(data), ts);
        }
      }
    }
  }
}
