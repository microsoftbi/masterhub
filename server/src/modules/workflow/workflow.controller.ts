import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Perm } from '../../common/decorators';
import { WorkflowService } from './workflow.service';

@Controller('api/v1/workflow')
export class WorkflowController {
  constructor(private service: WorkflowService) {}

  @Get('meta')
  @Perm('workflow.view')
  meta(@CurrentUser() user: AuthUser) {
    return this.service.meta(user);
  }

  @Get('definitions')
  @Perm('workflow.view')
  definitions(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.service.definitions(user, query);
  }

  @Get('definitions/:id')
  @Perm('workflow.view')
  definition(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.definition(user, Number(id));
  }

  @Post('definitions')
  @Perm('workflow.manage')
  save(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.service.saveDefinition(user, dto);
  }

  @Post('definitions/:id/run')
  @Perm('workflow.manage')
  run(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.run(user, Number(id));
  }

  @Get('runs')
  @Perm('workflow.view')
  runs(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.service.runs(user, query);
  }

  @Get('runs/:id')
  @Perm('workflow.view')
  runDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.runDetail(user, Number(id));
  }
}
