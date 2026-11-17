import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DbService } from './db/db.service';
import { AuditService } from './common/audit.service';
import { ProcessHooks } from './common/hooks';
import { AuthGuard } from './common/auth.guard';
import { NoticeService } from './common/notice.service';

/** 全局基础设施：数据库、审计、流程回调、站内通知、JWT 与鉴权守卫 */
@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'masterhub-m1-secret',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES || '8h') as any },
    }),
  ],
  providers: [DbService, AuditService, ProcessHooks, NoticeService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [DbService, AuditService, ProcessHooks, NoticeService, JwtModule],
})
export class CoreModule {}
