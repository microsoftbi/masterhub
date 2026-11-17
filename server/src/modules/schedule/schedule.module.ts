import { Module } from '@nestjs/common';
import { IntegrationModule } from '../integration/integration.module';
import { MasterModule } from '../master/master.module';
import { QualityModule } from '../quality/quality.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';

/** 任务调度中心：统一编排质量巡检 / 工作流 / 分发的手动与定时执行 */
@Module({
  imports: [QualityModule, WorkflowModule, IntegrationModule, MasterModule],
  controllers: [ScheduleController],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
