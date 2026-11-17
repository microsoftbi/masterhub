import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'mh:public';
export const PERM_KEY = 'mh:perms';

/** 免鉴权接口（登录、开放 API、Webhook 回调） */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** 功能权限点，例如 @Perm('master.create') */
export const Perm = (...perms: string[]) => SetMetadata(PERM_KEY, perms);

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  dept: string;
  roles: string[];
  perms: string[];
  domains: string[];
  fieldMasks: Record<string, Record<string, string>>;
}

/** 当前登录用户 */
export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
