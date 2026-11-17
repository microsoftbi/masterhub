import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Perm } from '../../common/decorators';
import { MasterService } from './master.service';

@Controller('api/v1/master-data')
export class MasterController {
  constructor(private svc: MasterService) {}

  @Get(':domain')
  @Perm('master.view')
  list(@Param('domain') domain: string, @Query() query: any, @CurrentUser() user: AuthUser) {
    return this.svc.list(user, domain, query);
  }

  @Get(':domain/export')
  @Perm('master.export')
  exportCsv(@Param('domain') domain: string, @Query() query: any, @CurrentUser() user: AuthUser) {
    return this.svc.exportCsv(user, domain, query);
  }

  @Post(':domain')
  @Perm('master.create')
  create(@Param('domain') domain: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.create(user, domain, dto);
  }

  @Post(':domain/check-dup')
  @Perm('master.view')
  checkDup(@Param('domain') domain: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.checkDup(user, domain, dto);
  }

  @Post(':domain/merge')
  @Perm('master.merge')
  merge(@Param('domain') domain: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.merge(user, domain, dto);
  }

  /** M4：批量生命周期操作（冻结 / 解冻 / 归档） */
  @Post(':domain/batch-lifecycle')
  @Perm('master.lifecycle')
  batchLifecycle(@Param('domain') domain: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.batchLifecycle(user, domain, dto);
  }

  @Get(':domain/:key')
  @Perm('master.view')
  detail(@Param('domain') domain: string, @Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.svc.detail(user, domain, key);
  }

  @Put(':domain/:key')
  @Perm('master.edit')
  update(@Param('domain') domain: string, @Param('key') key: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.update(user, domain, key, dto);
  }

  @Get(':domain/:key/versions')
  @Perm('master.view')
  versions(@Param('domain') domain: string, @Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.svc.versions(user, domain, key);
  }

  @Post(':domain/:key/submit')
  @Perm('master.submit')
  submit(@Param('domain') domain: string, @Param('key') key: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.submit(user, domain, key, dto?.ccUserIds);
  }

  @Post(':domain/:key/freeze')
  @Perm('master.lifecycle')
  freeze(@Param('domain') domain: string, @Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.svc.lifecycle(user, domain, key, 'freeze');
  }

  @Post(':domain/:key/unfreeze')
  @Perm('master.lifecycle')
  unfreeze(@Param('domain') domain: string, @Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.svc.lifecycle(user, domain, key, 'unfreeze');
  }

  @Post(':domain/:key/archive')
  @Perm('master.lifecycle')
  archive(@Param('domain') domain: string, @Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.svc.lifecycle(user, domain, key, 'archive');
  }

  /** M4：回滚到历史版本 */
  @Post(':domain/:key/rollback')
  @Perm('master.edit')
  rollback(@Param('domain') domain: string, @Param('key') key: string, @Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.rollback(user, domain, key, dto);
  }
}
