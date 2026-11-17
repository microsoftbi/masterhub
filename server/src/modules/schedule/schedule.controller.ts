import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Perm } from '../../common/decorators';
import { ScheduleService } from './schedule.service';

@Controller('api/v1/schedule')
export class ScheduleController {
  constructor(private service: ScheduleService) {}

  @Get('meta')
  @Perm('system.view')
  meta(@CurrentUser() user: AuthUser) {
    return this.service.meta();
  }

  @Get('jobs')
  @Perm('system.view')
  jobs(@CurrentUser() user: AuthUser) {
    return this.service.jobs();
  }

  @Post('jobs')
  @Perm('system.manage')
  save(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.service.saveJob(user, dto);
  }

  @Post('jobs/:id/toggle')
  @Perm('system.manage')
  toggle(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    return this.service.toggle(user, id, !!dto?.enabled);
  }

  @Post('jobs/:id/run')
  @Perm('system.manage')
  runNow(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.runNow(user, id);
  }

  @Get('runs')
  @Perm('system.view')
  runs(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.service.runs(user, query);
  }
}
