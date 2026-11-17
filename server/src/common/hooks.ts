import { Injectable, Logger } from '@nestjs/common';

/**
 * 流程回调注册表：审批引擎与主数据模块解耦。
 * 主数据服务启动时注册 publishWithCode / applyChange 等处理器，审批引擎在终态调用。
 */
@Injectable()
export class ProcessHooks {
  private logger = new Logger('ProcessHooks');
  private handlers = new Map<string, (instance: any) => any>();

  register(name: string, fn: (instance: any) => any) {
    this.handlers.set(name, fn);
  }

  async run(name: string, instance: any) {
    const fn = this.handlers.get(name);
    if (!fn) {
      this.logger.warn(`未注册流程处理器：${name}`);
      return;
    }
    await fn(instance);
  }
}
