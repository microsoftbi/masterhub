import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Perm } from '../../common/decorators';
import { NoticeService } from '../../common/notice.service';
import { SystemService } from './system.service';

@Controller('api/v1')
export class SystemController {
  constructor(
    private svc: SystemService,
    private notice: NoticeService,
  ) {}

  @Get('users')
  @Perm('system.user')
  users(@Query() query: any) {
    return this.svc.users(query);
  }

  @Post('users')
  @Perm('system.user')
  createUser(@Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.createUser(dto, user);
  }

  @Put('users/:id')
  @Perm('system.user')
  updateUser(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.updateUser(id, dto, user);
  }

  @Get('roles')
  @Perm('system.role')
  roles() {
    return this.svc.roles();
  }

  @Get('roles/:code/perms')
  @Perm('system.role')
  rolePerms(@Param('code') code: string) {
    return this.svc.rolePerms(code);
  }

  @Put('roles/:code/perms')
  @Perm('system.role')
  saveRolePerms(@Param('code') code: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.saveRolePerms(code, dto, user);
  }

  @Get('audit')
  @Perm('system.audit')
  auditLogs(@Query() query: any) {
    return this.svc.auditLogs(query);
  }

  // ---------------- 全局参数（M4） ----------------
  @Get('configs')
  @Perm('system.view')
  configs() {
    return this.svc.configs();
  }

  @Put('configs')
  @Perm('system.manage')
  saveConfigs(@Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.saveConfigs(user, dto);
  }

  // ---------------- 站内通知（M4，本人数据，登录即可） ----------------
  @Get('notices')
  myNotices(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.notice.mine(user, query);
  }

  @Get('notices/unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return { count: this.notice.unreadCount(user) };
  }

  @Post('notices/read')
  markRead(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.notice.markRead(user, dto);
  }
}
