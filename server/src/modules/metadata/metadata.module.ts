import { Module } from '@nestjs/common';
import { MetadataController } from './metadata.controller';
import { MetadataService } from './metadata.service';
import { IndexManager } from './index-manager';
import { CodeEngine } from './code-engine.service';

@Module({
  controllers: [MetadataController],
  providers: [MetadataService, IndexManager, CodeEngine],
  exports: [MetadataService, IndexManager, CodeEngine],
})
export class MetadataModule {}
