import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { AuditService } from '../../common/audit.service';
import { BizException, ErrCode } from '../../common/errors';
import { AuthUser } from '../../common/decorators';
import { nowStr, toInt } from '../../common/util';
import bcrypt from 'bcryptjs';

/** 权限矩阵分组（与前端矩阵列一致） */
const PERM_GROUPS: Array<{ module: string; label: string; perms: Array<[string, string]> }> = [
  { module: 'workbench', label: '工作台', perms: [['workbench.view', '查看']] },
  {
    module: 'master', label: '主数据',
    perms: [
      ['master.view', '查看'], ['master.create', '新增'], ['master.edit', '编辑'], ['master.submit', '提交审批'],
      ['master.import', '导入'], ['master.export', '导出'], ['master.merge', '合并'], ['master.lifecycle', '生命周期'],
    ],
  },
  { module: 'approval', label: '审批', perms: [['approval.view', '查看'], ['approval.handle', '审批处理']] },
  { module: 'model', label: '模型管理', perms: [['model.view', '查看'], ['model.manage', '维护']] },
  { module: 'dict', label: '码表', perms: [['dict.view', '查看'], ['dict.manage', '维护']] },
  { module: 'quality', label: '质量', perms: [['quality.view', '查看'], ['quality.manage', '维护']] },
  { module: 'integration', label: '集成', perms: [['integration.view', '查看'], ['integration.manage', '维护']] },
  { module: 'workflow', label: '工作流', perms: [['workflow.view', '查看'], ['workflow.manage', '维护']] },
  { module: 'dashboard', label: '仪表板', perms: [['dashboard.view', '查看']] },
  {
    module: 'system', label: '系统管理',
    perms: [['system.view', '查看'], ['system.user', '用户'], ['system.role', '角色'], ['system.audit', '审计']],
  },
];

@Injectable()
export class SystemService {
  constructor(
    private db: DbService,
    private audit: AuditService,
  ) {}

  // ---------------- 全局参数（M4） ----------------
  /** 参数配置列表 */
  configs() {
    return this.db.all<any>('SELECT * FROM sys_config ORDER BY key');
  }

  /** 保存参数（仅允许更新已登记的键） */
  saveConfigs(user: AuthUser, dto: any) {
    const items = Array.isArray(dto?.items) ? dto.items : [];
    if (!items.length) throw new BizException('没有需要保存的参数', ErrCode.PARAM);
    const known = new Set(this.db.all<any>('SELECT key FROM sys_config').map((r) => r.key));
    const changed: any = {};
    this.db.tx(() => {
      for (const it of items) {
        const key = String(it?.key || '').trim();
        if (!known.has(key)) throw new BizException(`未知参数：${key}`, ErrCode.PARAM);
        const value = it.value === undefined || it.value === null ? '' : String(it.value).slice(0, 500);
        const old = this.db.one<any>('SELECT value FROM sys_config WHERE key = ?', key)?.value;
        if (old !== value) {
          this.db.run('UPDATE sys_config SET value = ? WHERE key = ?', value, key);
          changed[key] = { old, new: value };
        }
      }
    });
    if (Object.keys(changed).length) {
      this.audit.log(user, 'system', 'CONFIG_UPDATE', `更新全局参数（${Object.keys(changed).length} 项）`, changed);
    }
    return this.configs();
  }

  // ---------------- 用户 ----------------
  users(query: any) {
    const keyword = String(query?.keyword || '').trim();
    const where: string[] = [];
    const params: any[] = [];
    if (keyword) {
      where.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.dept LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = this.db.all<any>(`SELECT u.* FROM sys_user u ${cond} ORDER BY u.id`, ...params);
    const links = this.db.all<any>(
      `SELECT ur.user_id, r.code, r.name FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id`,
    );
    const byUser = new Map<number, any[]>();
    for (const l of links) {
      if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
      byUser.get(l.user_id)!.push({ code: l.code, name: l.name });
    }
    return {
      list: rows.map((u) => ({
        id: u.id,
        username: u.username,
        display_name: u.display_name,
        dept: u.dept,
        status: u.status,
        statusLabel: u.status === 'ACTIVE' ? '启用' : '停用',
        roles: byUser.get(u.id) || [],
        created_at: u.created_at,
      })),
      total: rows.length,
      roleOptions: this.roles().list,
    };
  }

  createUser(dto: any, user: AuthUser) {
    const username = String(dto?.username || '').trim();
    const password = String(dto?.password || '');
    const displayName = String(dto?.display_name || dto?.displayName || '').trim();
    if (!username || !password || !displayName) throw new BizException('账号、密码、姓名均不能为空', ErrCode.PARAM);
    const pwdMin = Number(this.db.cfg('pwd.minLength', 6)) || 6;
    if (password.length < pwdMin) throw new BizException(`密码长度至少 ${pwdMin} 位`, ErrCode.PARAM);
    if (this.db.one('SELECT id FROM sys_user WHERE username = ?', username)) {
      throw new BizException('账号已存在', ErrCode.DUP);
    }
    const roleIds = this.resolveRoleIds(dto?.roles);
    const ts = nowStr();
    const id = this.db.tx(() => {
      const r = this.db.run(
        'INSERT INTO sys_user (username, password, display_name, dept, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        username, bcrypt.hashSync(password, 10), displayName, dto?.dept || null, 'ACTIVE', ts,
      );
      const uid = Number(r.lastInsertRowid);
      for (const rid of roleIds) this.db.run('INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)', uid, rid);
      return uid;
    });
    this.audit.log(user, 'system', 'USER_CREATE', `新增用户：${username}`, { roles: dto?.roles });
    return this.users({ keyword: username }).list[0] || { id };
  }

  updateUser(id: number, dto: any, user: AuthUser) {
    const target = this.db.one<any>('SELECT * FROM sys_user WHERE id = ?', id);
    if (!target) throw new BizException('用户不存在', ErrCode.NOT_FOUND);
    const fields: string[] = [];
    const params: any[] = [];
    if (dto?.display_name !== undefined) {
      fields.push('display_name = ?');
      params.push(String(dto.display_name));
    }
    if (dto?.dept !== undefined) {
      fields.push('dept = ?');
      params.push(dto.dept ? String(dto.dept) : null);
    }
    if (dto?.status !== undefined) {
      fields.push('status = ?');
      params.push(dto.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE');
    }
    if (dto?.password) {
      const pwdMin = Number(this.db.cfg('pwd.minLength', 6)) || 6;
      if (String(dto.password).length < pwdMin) throw new BizException(`密码长度至少 ${pwdMin} 位`, ErrCode.PARAM);
      fields.push('password = ?');
      params.push(bcrypt.hashSync(String(dto.password), 10));
    }
    const roleIds = dto?.roles !== undefined ? this.resolveRoleIds(dto.roles) : null;
    this.db.tx(() => {
      if (fields.length) this.db.run(`UPDATE sys_user SET ${fields.join(', ')} WHERE id = ?`, ...params, id);
      if (roleIds) {
        this.db.run('DELETE FROM sys_user_role WHERE user_id = ?', id);
        for (const rid of roleIds) this.db.run('INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)', id, rid);
      }
    });
    this.audit.log(user, 'system', 'USER_UPDATE', `更新用户：${target.username}`, dto);
    return this.users({ keyword: target.username }).list[0] || null;
  }

  private resolveRoleIds(codes: any): number[] {
    const list = Array.isArray(codes) ? codes.map(String) : [];
    if (!list.length) return [];
    const rows = this.db.all<any>(
      'SELECT id FROM sys_role WHERE code IN (' + list.map(() => '?').join(',') + ')', ...list,
    );
    return rows.map((r) => r.id);
  }

  // ---------------- 角色与权限矩阵 ----------------
  roles() {
    const roles = this.db.all<any>('SELECT * FROM sys_role ORDER BY id');
    const perms = this.db.all<any>('SELECT role_id, perm_code, allowed FROM sys_menu_perm');
    const byRole = new Map<number, string[]>();
    for (const p of perms.filter((x) => x.allowed)) {
      if (!byRole.has(p.role_id)) byRole.set(p.role_id, []);
      byRole.get(p.role_id)!.push(p.perm_code);
    }
    return {
      list: roles.map((r) => ({ ...r, perms: byRole.get(r.id) || [] })),
      groups: PERM_GROUPS,
    };
  }

  rolePerms(code: string) {
    const role = this.db.one<any>('SELECT * FROM sys_role WHERE code = ?', code);
    if (!role) throw new BizException('角色不存在', ErrCode.NOT_FOUND);
    const allowed = this.db
      .all<any>('SELECT perm_code FROM sys_menu_perm WHERE role_id = ? AND allowed = 1', role.id)
      .map((x) => x.perm_code);
    return { role: { code: role.code, name: role.name, remark: role.remark }, groups: PERM_GROUPS, allowed };
  }

  saveRolePerms(code: string, dto: { perms?: string[] }, user: AuthUser) {
    const role = this.db.one<any>('SELECT * FROM sys_role WHERE code = ?', code);
    if (!role) throw new BizException('角色不存在', ErrCode.NOT_FOUND);
    if (role.code === 'SYS_ADMIN') throw new BizException('系统管理员权限固定，不可修改', ErrCode.STATE);
    const valid = new Set(PERM_GROUPS.flatMap((g) => g.perms.map(([p]) => p)));
    const perms = (dto?.perms || []).map(String).filter((p) => valid.has(p));
    this.db.tx(() => {
      this.db.run('DELETE FROM sys_menu_perm WHERE role_id = ?', role.id);
      for (const p of perms) this.db.run('INSERT INTO sys_menu_perm (role_id, perm_code, allowed) VALUES (?, ?, 1)', role.id, p);
    });
    this.audit.log(user, 'system', 'ROLE_PERM', `调整角色权限：${role.name}`, { perms });
    return this.rolePerms(code);
  }

  // ---------------- 审计 ----------------
  auditLogs(query: any) {
    const page = Math.max(1, toInt(query?.page, 1));
    const size = Math.min(200, Math.max(1, toInt(query?.size, 20)));
    const where: string[] = [];
    const params: any[] = [];
    if (query?.module) {
      where.push('module = ?');
      params.push(String(query.module));
    }
    if (query?.username) {
      where.push('username = ?');
      params.push(String(query.username));
    }
    const keyword = String(query?.keyword || '').trim();
    if (keyword) {
      where.push('(target LIKE ? OR detail LIKE ? OR action LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (query?.start) {
      where.push('created_at >= ?');
      params.push(String(query.start));
    }
    if (query?.end) {
      where.push('created_at <= ?');
      params.push(String(query.end));
    }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM sys_audit_log ${cond}`, ...params)?.n || 0;
    const rows = this.db.all<any>(
      `SELECT * FROM sys_audit_log ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, size, (page - 1) * size,
    );
    const modules = this.db.all<any>('SELECT DISTINCT module FROM sys_audit_log ORDER BY module').map((r) => r.module);
    return { list: rows, total, page, size, modules };
  }
}
