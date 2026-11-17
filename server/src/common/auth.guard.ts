import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC, PERM_KEY } from './decorators';
import { ErrCode } from './errors';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw new UnauthorizedException({ code: ErrCode.UNAUTH, msg: '未登录或登录已过期' });
    try {
      req.user = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException({ code: ErrCode.UNAUTH, msg: '登录凭证无效或已过期' });
    }

    const perms = this.reflector.getAllAndOverride<string[]>(PERM_KEY, [context.getHandler(), context.getClass()]);
    if (perms && perms.length) {
      const userPerms: string[] = req.user?.perms || [];
      const missing = perms.filter((p) => !userPerms.includes(p));
      if (missing.length) {
        throw new ForbiddenException({ code: ErrCode.FORBIDDEN, msg: `无操作权限：${missing.join(', ')}` });
      }
    }
    return true;
  }
}
