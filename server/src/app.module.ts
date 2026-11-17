import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { ApprovalModule } from './modules/approval/approval.module';
import { AuthModule } from './modules/auth/auth.module';
import { CollectModule } from './modules/collect/collect.module';
import { ImportModule } from './modules/import/import.module';
import { IntegrationModule } from './modules/integration/integration.module';
import { MasterModule } from './modules/master/master.module';
import { MetadataModule } from './modules/metadata/metadata.module';
import { QualityModule } from './modules/quality/quality.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { StatsModule } from './modules/stats/stats.module';
import { SystemModule } from './modules/system/system.module';
import { WorkflowModule } from './modules/workflow/workflow.module';

@Module({
  imports: [
    CoreModule,
    AuthModule,
    MetadataModule,
    ApprovalModule,
    MasterModule,
    ImportModule,
    IntegrationModule,
    CollectModule,
    SystemModule,
    StatsModule,
    QualityModule,
    WorkflowModule,
    ScheduleModule,
  ],
})
export class AppModule {}
