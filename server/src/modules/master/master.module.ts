import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { IntegrationModule } from '../integration/integration.module';
import { MetadataModule } from '../metadata/metadata.module';
import { MasterController } from './master.controller';
import { MasterService } from './master.service';

@Module({
  imports: [ApprovalModule, MetadataModule, IntegrationModule],
  controllers: [MasterController],
  providers: [MasterService],
  exports: [MasterService],
})
export class MasterModule {}
