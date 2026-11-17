import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { AuthUser, CurrentUser, Perm } from '../../common/decorators';

@Controller('api/v1/approvals')
export class ApprovalController {
  constructor(private svc: ApprovalService) {}

  @Get('processes')
  @Perm('approval.view')
  processes() {
    return this.svc.processes();
  }

  @Get('handlers')
  @Perm('approval.handle')
  handlers() {
    return this.svc.handlers();
  }

  @Get('cc-users')
  @Perm('master.submit')
  ccUsers() {
    return this.svc.ccUsers();
  }

  @Get('ccd')
  @Perm('approval.view')
  ccd(@CurrentUser() user: AuthUser) {
    return this.svc.ccd(user);
  }

  @Get('designer-options')
  @Perm('approval.manage')
  designerOptions() {
    return this.svc.designerOptions();
  }

  @Post('processes')
  @Perm('approval.manage')
  saveProcess(@Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.saveProcess(user, dto);
  }

  @Post('processes/:code/toggle')
  @Perm('approval.manage')
  toggleProcess(@Param('code') code: string, @CurrentUser() user: AuthUser) {
    return this.svc.toggleProcess(user, code);
  }

  @Get('todo')
  @Perm('approval.view')
  todo(@CurrentUser() user: AuthUser) {
    return this.svc.todo(user);
  }

  @Get('instances')
  @Perm('approval.view')
  instances(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.svc.instances(user, query);
  }

  @Get(':id')
  @Perm('approval.view')
  detail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.svc.detail(id, user);
  }

  @Post(':id/pass')
  @Perm('approval.handle')
  pass(@Param('id', ParseIntPipe) id: number, @Body('comment') comment: string, @CurrentUser() user: AuthUser) {
    return this.svc.pass(id, user, comment);
  }

  @Post(':id/reject')
  @Perm('approval.handle')
  reject(@Param('id', ParseIntPipe) id: number, @Body('comment') comment: string, @CurrentUser() user: AuthUser) {
    return this.svc.reject(id, user, comment);
  }

  @Post(':id/transfer')
  @Perm('approval.handle')
  transfer(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.transfer(user, id, dto);
  }

  @Post(':id/add-sign')
  @Perm('approval.handle')
  addSign(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.addSign(user, id, dto);
  }
}
