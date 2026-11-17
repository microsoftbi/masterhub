import { Module } from '@nestjs/common';
import { IntegrationController, OpenController } from './integration.controller';
import { IntegrationService, OutboxService } from './integration.service';

@Module({
  controllers: [IntegrationController, OpenController],
  providers: [IntegrationService, OutboxService],
  exports: [IntegrationService, OutboxService],
})
export class IntegrationModule {}
