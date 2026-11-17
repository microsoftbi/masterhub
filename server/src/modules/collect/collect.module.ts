import { Module } from '@nestjs/common';
import { ImportModule } from '../import/import.module';
import { CollectController } from './collect.controller';
import { CollectService } from './collect.service';

/** 数据采集接入（M4）：源系统注册、字段映射与执行采集 */
@Module({
  imports: [ImportModule],
  controllers: [CollectController],
  providers: [CollectService],
  exports: [CollectService],
})
export class CollectModule {}
