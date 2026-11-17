import { Module } from '@nestjs/common';
import { MasterModule } from '../master/master.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

@Module({
  imports: [MasterModule],
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
