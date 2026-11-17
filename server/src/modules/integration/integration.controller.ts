import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IntegrationService } from './integration.service';
import { AuthUser, CurrentUser, Perm, Public } from '../../common/decorators';

@Controller('api/v1/integration')
export class IntegrationController {
  constructor(private svc: IntegrationService) {}

  @Get('summary')
  @Perm('integration.view')
  summary() {
    return this.svc.summary();
  }

  @Get('subscribers')
  @Perm('integration.view')
  subscribers() {
    return this.svc.subscribers();
  }

  @Post('subscribers')
  @Perm('integration.manage')
  saveSubscriber(@Body() dto: any, @CurrentUser() user: AuthUser) {
    return this.svc.saveSubscriber(dto, user);
  }

  @Get('push-events')
  @Perm('integration.view')
  events(@Query() query: any) {
    return this.svc.events(query);
  }

  @Get('push-events/:id')
  @Perm('integration.view')
  event(@Param('id', ParseIntPipe) id: number) {
    return this.svc.eventDetail(id);
  }

  @Post('push-events/:id/retry')
  @Perm('integration.manage')
  retry(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.svc.retry(id, user);
  }

  @Post('dispatch')
  @Perm('integration.manage')
  dispatch(@CurrentUser() user: AuthUser) {
    return this.svc.dispatchDue(50, user);
  }

  @Get('push-logs')
  @Perm('integration.view')
  logs(@Query() query: any) {
    return this.svc.logs(query);
  }

  /** 内置订阅方模拟器，用于本地验证 Outbox 推送闭环 */
  @Public()
  @Post('mock-webhook')
  mock(@Body() body: any) {
    return { received: true, eventNo: body?.eventNo, at: new Date().toISOString() };
  }
}

/** 开放 API（M1 最小实现）：下游增量拉取，M2 增补 API Key/OAuth 与限流 */
@Controller('open/v1')
export class OpenController {
  constructor(private svc: IntegrationService) {}

  @Public()
  @Get('master/:domain')
  pull(@Param('domain') domain: string, @Query('cursor') cursor: string) {
    return this.svc.openPull(domain, cursor);
  }
}
