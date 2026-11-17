import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ResultInterceptor, AllExceptionFilter } from './common/result';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: false, transform: true }));
  app.useGlobalInterceptors(new ResultInterceptor());
  app.useGlobalFilters(new AllExceptionFilter());
  app.enableCors({ origin: true, credentials: true });
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[MasterHub] 服务已启动：http://127.0.0.1:${port}`);
}

bootstrap();
