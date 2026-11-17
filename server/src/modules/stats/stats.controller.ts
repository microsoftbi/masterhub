import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser, Perm } from '../../common/decorators';
import { StatsService } from './stats.service';

@Controller('api/v1/stats')
export class StatsController {
  constructor(private svc: StatsService) {}

  @Get('overview')
  @Perm('dashboard.view')
  overview(@CurrentUser() user: AuthUser) {
    return this.svc.overview(user);
  }

  @Get('workbench')
  @Perm('workbench.view')
  workbench(@CurrentUser() user: AuthUser) {
    return this.svc.workbench(user);
  }

  @Get('dashboard')
  @Perm('dashboard.view')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.svc.dashboard(user);
  }
}
