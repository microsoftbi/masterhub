import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Perm, AuthUser } from '../../common/decorators';
import { QualityService } from './quality.service';

@Controller('api/v1/quality')
export class QualityController {
  constructor(private service: QualityService) {}

  @Get('overview')
  @Perm('quality.view')
  overview(@CurrentUser() user: AuthUser) {
    return this.service.overview(user);
  }

  @Get('meta')
  @Perm('quality.view')
  meta(@CurrentUser() user: AuthUser) {
    return this.service.meta(user);
  }

  @Get('rules')
  @Perm('quality.view')
  rules(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.service.rules(user, query);
  }

  @Post('rules')
  @Perm('quality.manage')
  saveRule(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.service.saveRule(user, dto);
  }

  @Get('tasks')
  @Perm('quality.view')
  tasks(@CurrentUser() user: AuthUser) {
    return this.service.tasks(user);
  }

  @Post('tasks')
  @Perm('quality.manage')
  saveTask(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.service.saveTask(user, dto);
  }

  @Post('tasks/:id/run')
  @Perm('quality.manage')
  runTask(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.runTask(user, Number(id));
  }

  /** 手动全量巡检（不绑定任务） */
  @Post('scan')
  @Perm('quality.manage')
  scan(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.service.scan(user, null, dto?.domain || null);
  }

  @Get('runs')
  @Perm('quality.view')
  runs(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.service.runs(user, query);
  }

  @Get('runs/:id/report')
  @Perm('quality.view')
  runReport(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.exportRunReport(user, Number(id));
  }

  @Get('issues')
  @Perm('quality.view')
  issues(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.service.issues(user, query);
  }

  @Get('issues/candidates')
  @Perm('quality.view')
  assignees(@CurrentUser() user: AuthUser) {
    return this.service.assignees();
  }

  @Get('issues/:id')
  @Perm('quality.view')
  issueDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.issueDetail(user, Number(id));
  }

  @Post('issues/:id/handle')
  @Perm('quality.manage')
  handle(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.service.handleIssue(user, Number(id), dto);
  }

  @Post('issues/:id/assign')
  @Perm('quality.manage')
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.service.assignIssue(user, Number(id), dto);
  }
}
