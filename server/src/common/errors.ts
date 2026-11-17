import { HttpException, HttpStatus } from '@nestjs/common';

/** 业务异常：code 遵循 1xxx 参数 / 2xxx 认证 / 3xxx 业务 / 5xxx 系统 */
export class BizException extends HttpException {
  constructor(message: string, code = 3001, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ code, msg: message }, status);
  }
}

export const ErrCode = {
  PARAM: 1001,
  UNAUTH: 2001,
  FORBIDDEN: 2003,
  BUSINESS: 3001,
  DUP: 3101,
  STATE: 3102,
  NOT_FOUND: 3104,
  SYSTEM: 5000,
};
