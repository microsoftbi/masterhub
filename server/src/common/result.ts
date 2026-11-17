import {
  CallHandler,
  ExecutionContext,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  Injectable,
  NestInterceptor,
  Catch,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { randomUUID } from 'crypto';

/** 统一响应包装：{ code, msg, data, traceId } */
@Injectable()
export class ResultInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const traceId = req.headers['x-trace-id'] || randomUUID().slice(0, 12);
    (req as any).traceId = traceId;
    return next.handle().pipe(
      map((data) => {
        // 文件/CSV 等原始响应直接透传
        if (req.__rawResponse) return data;
        return { code: 0, msg: 'ok', data: data === undefined ? null : data, traceId };
      }),
    );
  }
}

@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const traceId = req.traceId || randomUUID().slice(0, 12);

    let status = 500;
    let code = 5000;
    let msg = '系统异常';
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body: any = exception.getResponse();
      if (typeof body === 'object' && body) {
        code = body.code ?? (status === 401 ? 2001 : status === 403 ? 2003 : 3001);
        msg = body.msg || body.message || '请求失败';
        if (Array.isArray(body.message)) msg = body.message.join('；');
      } else {
        msg = String(body);
      }
    } else if (exception?.message) {
      msg = exception.message;
    }
    if (status === 500 && !(exception instanceof HttpException)) {
      // eslint-disable-next-line no-console
      console.error('[MasterHub] 未捕获异常', exception);
    }
    res.status(status).json({ code, msg, data: null, traceId });
  }
}
