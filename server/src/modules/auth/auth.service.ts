import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { DbService } from '../../db/db.service';
import { AuditService } from '../../common/audit.service';
import { parseJson } from '../../common/util';
import { ErrCode } from '../../common/errors';

@Injectable()
export class AuthService {
  constructor(private db: DbService, private jwt: JwtService, private audit: AuditService) {}

  private buildProfile(userId: number) {
    const user = this.db.one<any>('SELECT * FROM sys_user WHERE id = ? AND status = ?', userId, 'ACTIVE');
    if (!user) return null;
    const roles = this.db.all<any>(
      `SELECT r.code, r.name FROM sys_role r JOIN sys_user_role ur ON ur.role_id = r.id WHERE ur.user_id = ?`,
      userId,
    );
    const roleIds = this.db.all<any>('SELECT role_id FROM sys_user_role WHERE user_id = ?', userId).map((r) => r.role_id);
    const perms = roleIds.length
      ? this.db.all<any>(
          'SELECT DISTINCT perm_code FROM sys_menu_perm WHERE role_id IN (' +
            roleIds.map(() => '?').join(',') +
            ') AND allowed = 1',
          ...roleIds,
        ).map((p) => p.perm_code)
      : [];
    const domainRows = roleIds.length
      ? this.db.all<any>(
          'SELECT domain_code, field_masks FROM sys_data_perm WHERE role_id IN (' + roleIds.map(() => '?').join(',') + ')',
          ...roleIds,
        )
      : [];
    const domains = Array.from(new Set(domainRows.map((d) => d.domain_code)));
    const fieldMasks: Record<string, Record<string, string>> = {};
    for (const d of domainRows) {
      if (d.field_masks) fieldMasks[d.domain_code] = parseJson(d.field_masks, {});
    }
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      dept: user.dept,
      roles: roles.map((r) => r.code),
      roleNames: roles.map((r) => r.name),
      perms,
      domains,
      fieldMasks,
    };
  }

  async login(username: string, password: string, ip?: string) {
    const user = this.db.one<any>('SELECT * FROM sys_user WHERE username = ?', username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      throw new UnauthorizedException({ code: ErrCode.UNAUTH, msg: '用户名或密码错误' });
    }
    if (user.status !== 'ACTIVE') throw new UnauthorizedException({ code: ErrCode.UNAUTH, msg: '账号已停用' });
    const profile = this.buildProfile(user.id);
    // 全局参数：会话时长（小时）
    const hours = Number(this.db.cfg('session.timeoutHours', 8)) || 8;
    const token = await this.jwt.signAsync(profile, { expiresIn: `${hours}h` });
    this.audit.log(profile, 'auth', 'LOGIN', '用户登录', `${profile.displayName}（${profile.username}）`, ip);
    return { token, user: profile };
  }

  async refresh(token: string) {
    try {
      const payload = await this.jwt.verifyAsync(token, { ignoreExpiration: true });
      const profile = this.buildProfile(payload.id);
      if (!profile) throw new UnauthorizedException({ code: ErrCode.UNAUTH, msg: '用户不存在' });
      const newToken = await this.jwt.signAsync(profile);
      return { token: newToken, user: profile };
    } catch {
      throw new UnauthorizedException({ code: ErrCode.UNAUTH, msg: '登录凭证无效' });
    }
  }

  profile(userId: number) {
    const profile = this.buildProfile(userId);
    if (!profile) throw new UnauthorizedException({ code: ErrCode.UNAUTH, msg: '用户不存在' });
    return profile;
  }
}
