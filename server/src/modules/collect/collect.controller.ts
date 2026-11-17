import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, Perm, Public } from '../../common/decorators';
import { CollectService } from './collect.service';

@Controller('api/v1/collect')
export class CollectController {
  constructor(private service: CollectService) {}

  @Get('systems')
  @Perm('integration.view')
  systems(@CurrentUser() user: AuthUser) {
    return this.service.systems(user);
  }

  /** M7：采集执行历史（留痕，含增量水位） */
  @Get('logs')
  @Perm('integration.view')
  logs(@Query() query: any) {
    return this.service.logs(query);
  }

  @Post('systems')
  @Perm('integration.manage')
  save(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.service.saveSystem(user, dto);
  }

  @Post('systems/:id/run')
  @Perm('integration.manage')
  run(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.run(user, id);
  }

  /** 演示用 Mock 源接口（免登录，按注册的 API Key 鉴权） */
  @Public()
  @Get('mock/:code')
  mock(@Param('code') code: string, @Headers('x-api-key') apiKey?: string) {
    return this.service.mock(code, apiKey);
  }
}
