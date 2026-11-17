import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { AuditService } from '../../common/audit.service';
import { NoticeService } from '../../common/notice.service';
import { ProcessHooks } from '../../common/hooks';
import { BizException, ErrCode } from '../../common/errors';
import { diffJson, nowStr, parseJson } from '../../common/util';
import { AuthUser } from '../../common/decorators';

/**
 * 自研轻量审批引擎（M1）：JSON 流程定义、会签 AND / 或签 OR、AUTO 回调、驳回回退。
 * 流程终态通过 ProcessHooks 调用主数据模块的发布/变更处理器，保证流程与数据状态一致。
 * M4 增强：转办、加签、站内通知触达。
 */
@Injectable()
export class ApprovalService {
  constructor(
    private db: DbService,
    private audit: AuditService,
    private hooks: ProcessHooks,
    private notice: NoticeService,
  ) {}

  processes() {
    const defs = this.db.all<any>('SELECT * FROM ap_process_def ORDER BY id');
    return defs.map((d) => {
      const definition = parseJson<any>(d.definition, {});
      return {
        ...d,
        definition,
        bind: definition.bind,
        nodes: definition.nodes,
        flows: definition.flows,
        runningCount: this.db.one<any>("SELECT COUNT(*) AS n FROM ap_instance WHERE process_code = ? AND status = 'RUNNING'", d.code)?.n || 0,
      };
    });
  }

  instances(user: AuthUser, query: any) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const size = Math.min(100, Math.max(1, parseInt(query.size || '20', 10)));
    const where: string[] = [];
    const params: any[] = [];
    if (query.status) {
      where.push('i.status = ?');
      params.push(query.status);
    }
    if (query.domain) {
      where.push('i.domain_code = ?');
      params.push(query.domain);
    }
    if (query.onlyMine === '1' || query.onlyMine === 'true') {
      where.push('i.applicant_id = ?');
      params.push(user.id);
    }
    if (query.onlyTodo === '1' || query.onlyTodo === 'true') {
      where.push("EXISTS (SELECT 1 FROM ap_task t WHERE t.instance_id = i.id AND t.assignee_id = ? AND t.status = 'PENDING')");
      params.push(user.id);
    }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM ap_instance i ${cond}`, ...params)?.n || 0;
    const list = this.db.all<any>(
      `SELECT i.*, p.name AS process_name
       FROM ap_instance i LEFT JOIN ap_process_def p ON p.code = i.process_code
       ${cond} ORDER BY i.updated_at DESC LIMIT ? OFFSET ?`,
      ...params, size, (page - 1) * size,
    );
    return {
      list: list.map((i) => ({
        ...i,
        data_snapshot: undefined,
        myTask: this.db.one<any>(
          "SELECT id, node_name, status FROM ap_task WHERE instance_id = ? AND assignee_id = ? AND status = 'PENDING'",
          i.id, user.id,
        ) || null,
        taskSummary: this.db.all<any>('SELECT node_name, assignee_name, status FROM ap_task WHERE instance_id = ? ORDER BY id', i.id),
      })),
      total, page, size,
    };
  }

  todo(user: AuthUser) {
    const rows = this.db.all<any>(
      `SELECT t.*, i.domain_code, i.action, i.title, i.status AS instance_status, i.updated_at AS instance_updated_at,
        p.name AS process_name
       FROM ap_task t JOIN ap_instance i ON i.id = t.instance_id
       LEFT JOIN ap_process_def p ON p.code = i.process_code
       WHERE t.assignee_id = ? AND t.status = 'PENDING' AND i.status = 'RUNNING'
       ORDER BY t.created_at DESC`,
      user.id,
    );
    return rows;
  }

  detail(id: number, user: AuthUser) {
    const instance = this.db.one<any>(
      'SELECT i.*, p.name AS process_name, p.definition FROM ap_instance i LEFT JOIN ap_process_def p ON p.code = i.process_code WHERE i.id = ?',
      id,
    );
    if (!instance) throw new BizException('审批实例不存在', ErrCode.NOT_FOUND);
    const def = parseJson<any>(instance.definition, { nodes: [], flows: [] });
    const tasks = this.db.all<any>(
      `SELECT t.*, u.dept FROM ap_task t LEFT JOIN sys_user u ON u.id = t.assignee_id WHERE t.instance_id = ? ORDER BY t.id`,
      id,
    );
    const record = this.db.one<any>('SELECT * FROM md_master_data WHERE id = ?', instance.biz_id);
    const model = this.db.one<any>('SELECT * FROM md_model WHERE domain_code = ?', instance.domain_code);
    const fields = model ? this.db.all<any>('SELECT * FROM md_field WHERE model_id = ? ORDER BY sort', model.id) : [];
    const currentData = record ? parseJson(record.data, {}) : {};
    const pendingData = parseJson(instance.data_snapshot, null);
    const diff = pendingData ? diffJson(currentData, pendingData) : null;
    const domain = this.db.one<any>('SELECT name FROM md_domain WHERE code = ?', instance.domain_code);
    // 当前用户阅读回执（打开详情即视为已读）+ 抄送列表
    this.db.run(
      'UPDATE ap_cc SET read_at = ? WHERE instance_id = ? AND user_id = ? AND read_at IS NULL',
      nowStr(), id, user.id,
    );
    const ccList = this.db.all<any>(
      'SELECT id, node_id, user_id, user_name, read_at, created_at FROM ap_cc WHERE instance_id = ? ORDER BY id', id,
    );
    return {
      ...instance,
      definition: def,
      tasks,
      ccList,
      record: record
        ? {
            id: record.id,
            master_code: record.master_code,
            name: record.name,
            status: record.status,
            version: record.version,
            data: currentData,
          }
        : null,
      pendingData,
      diff,
      fields: fields.map((f) => ({ key: f.field_key, label: f.label, type: f.type, dictCode: f.dict_code })),
      domainName: domain?.name || instance.domain_code,
      canHandle:
        instance.status === 'RUNNING' &&
        !!this.db.one("SELECT id FROM ap_task WHERE instance_id = ? AND assignee_id = ? AND status = 'PENDING'", id, user.id),
    };
  }

  /** 发起审批：返回 { auto:true } 表示该域/动作未配置流程，由主数据模块直接生效 */
  start(params: {
    domain: string;
    action: string;
    bizId: number;
    title: string;
    prevStatus: string;
    applicant: AuthUser;
    dataSnapshot?: any;
    ccUserIds?: number[];
  }) {
    const def = this.findDefinition(params.domain, params.action);
    if (!def) return { auto: true, instanceId: null as number | null };
    const definition = parseJson<any>(def.definition, { nodes: [], flows: [] });
    const ts = nowStr();
    const r = this.db.run(
      `INSERT INTO ap_instance (process_code, biz_type, biz_id, domain_code, action, title, status, current_node, prev_status, data_snapshot, applicant_id, applicant_name, created_at, updated_at)
       VALUES (?, 'MASTER_DATA', ?, ?, ?, ?, 'RUNNING', NULL, ?, ?, ?, ?, ?, ?)`,
      def.code, params.bizId, params.domain, params.action, params.title, params.prevStatus,
      params.dataSnapshot ? JSON.stringify(params.dataSnapshot) : null,
      params.applicant.id, params.applicant.displayName, ts, ts,
    );
    const instanceId = Number(r.lastInsertRowid);
    if (params.ccUserIds?.length) this.addCc(instanceId, 'start', params.ccUserIds);
    const firstId = this.flowTarget(definition, 'start');
    if (!firstId || firstId === 'end') {
      this.complete(instanceId, definition);
      return { auto: false, instanceId, completed: true };
    }
    this.enterNode(instanceId, definition, firstId);
    this.audit.log(params.applicant, 'approval', 'SUBMIT', params.title, `流程 ${def.code}`, undefined);
    return { auto: false, instanceId };
  }

  // ---------------- M6：审批抄送 ----------------
  /** 写入抄送记录并向抄送人发站内通知（userIds 去重、过滤无效用户） */
  private addCc(instanceId: number, nodeId: string, userIds: number[]) {
    const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return;
    const ph = ids.map(() => '?').join(',');
    const users = this.db.all<any>(`SELECT id, display_name FROM sys_user WHERE id IN (${ph}) AND status = 'ACTIVE'`, ...ids);
    if (!users.length) return;
    const inst = this.db.one<any>('SELECT title, applicant_name FROM ap_instance WHERE id = ?', instanceId);
    const ts = nowStr();
    for (const u of users) {
      this.db.run(
        'INSERT INTO ap_cc (instance_id, node_id, user_id, user_name, created_at) VALUES (?, ?, ?, ?, ?)',
        instanceId, nodeId, u.id, u.display_name, ts,
      );
    }
    this.notice.send(
      users.map((u) => u.id), 'APPROVAL_CC', `审批抄送：${inst?.title || ''}`,
      `由 ${inst?.applicant_name || ''} 提交，您被抄送该审批`, '/approval',
    );
  }

  /** 抄送节点：严格按节点配置解析抄送人（不兜底管理员），无有效人员则静默跳过 */
  private resolveCcUsers(node: any) {
    if (node.assigneeType === 'ROLE' && node.role) {
      return this.db.all<any>(
        `SELECT u.id, u.display_name FROM sys_user u
         JOIN sys_user_role ur ON ur.user_id = u.id JOIN sys_role r ON r.id = ur.role_id
         WHERE r.code = ? AND u.status = 'ACTIVE'`,
        node.role,
      );
    }
    if (node.assigneeType === 'USER' && node.username) {
      const u = this.db.one<any>("SELECT id, display_name FROM sys_user WHERE username = ? AND status = 'ACTIVE'", node.username);
      return u ? [u] : [];
    }
    return [];
  }

  /** 抄送我的：全部抄送记录（含发起时抄送与 CC 节点抄送） */
  ccd(user: AuthUser) {
    return this.db.all<any>(
      `SELECT c.id AS cc_id, c.node_id, c.read_at, c.created_at AS cc_time,
        i.id AS instance_id, i.title, i.status, i.domain_code, i.action, i.current_node,
        i.applicant_name, i.updated_at, p.name AS process_name
       FROM ap_cc c JOIN ap_instance i ON i.id = c.instance_id
       LEFT JOIN ap_process_def p ON p.code = i.process_code
       WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 100`,
      user.id,
    );
  }

  /** 提交审批时的抄送人候选（master.submit 权限即可用） */
  ccUsers() {
    return this.db.all<any>("SELECT id, display_name, dept FROM sys_user WHERE status = 'ACTIVE' ORDER BY id");
  }

  private findDefinition(domain: string, action: string) {
    const defs = this.db.all<any>("SELECT * FROM ap_process_def WHERE status = 'ACTIVE'");
    const matched = defs.map((d) => ({ d, def: parseJson<any>(d.definition, {}) }));
    return (
      matched.find((x) => x.def?.bind?.domain === domain && x.def?.bind?.action === action) ||
      matched.find((x) => x.def?.bind?.domain === '*' && x.def?.bind?.action === action)
    )?.d || null;
  }

  private flowTarget(definition: any, from: string, when = 'approved') {
    const flow = (definition.flows || []).find((f: any) => f.from === from && (f.when || 'approved') === when);
    return flow?.to || null;
  }

  private nodeOf(definition: any, id: string) {
    return (definition.nodes || []).find((n: any) => n.id === id);
  }

  private enterNode(instanceId: number, definition: any, nodeId: string) {
    const node = this.nodeOf(definition, nodeId);
    if (!node) throw new BizException(`流程节点不存在：${nodeId}`, ErrCode.BUSINESS);
    if (node.type === 'END') {
      this.complete(instanceId, definition);
      return;
    }
    if (node.type === 'AUTO') {
      this.runAuto(instanceId, definition, node);
      return;
    }
    if (node.type === 'APPROVAL') {
      const assignees = this.resolveAssignees(node);
      if (!assignees.length) throw new BizException(`审批节点「${node.name}」未找到审批人`, ErrCode.BUSINESS);
      const ts = nowStr();
      const inst = this.db.one<any>('SELECT title, applicant_name FROM ap_instance WHERE id = ?', instanceId);
      for (const a of assignees) {
        this.db.run(
          'INSERT INTO ap_task (instance_id, node_id, node_name, assignee_id, assignee_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          instanceId, node.id, node.name, a.id, a.display_name, 'PENDING', ts,
        );
      }
      this.db.run('UPDATE ap_instance SET current_node = ?, updated_at = ? WHERE id = ?', node.id, ts, instanceId);
      this.notice.send(
        assignees.map((a) => a.id), 'APPROVAL', `您有新的审批待办：${inst?.title || ''}`,
        `节点「${node.name}」 · 由 ${inst?.applicant_name || ''} 提交`, '/approval',
      );
      return;
    }
    if (node.type === 'CC') {
      this.addCc(instanceId, node.id, this.resolveCcUsers(node).map((u) => u.id));
      const next = this.flowTarget(definition, node.id);
      if (next) this.enterNode(instanceId, definition, next);
      else this.complete(instanceId, definition);
      return;
    }
    // CONDITION：M1 简化处理，按 approved 分支继续
    const next = this.flowTarget(definition, node.id);
    if (next) this.enterNode(instanceId, definition, next);
    else this.complete(instanceId, definition);
  }

  private resolveAssignees(node: any) {
    if (node.assigneeType === 'ROLE' && node.role) {
      const users = this.db.all<any>(
        `SELECT u.* FROM sys_user u JOIN sys_user_role ur ON ur.user_id = u.id JOIN sys_role r ON r.id = ur.role_id
         WHERE r.code = ? AND u.status = 'ACTIVE'`,
        node.role,
      );
      if (users.length) return users;
    }
    if (node.assigneeType === 'USER' && node.username) {
      const u = this.db.one<any>("SELECT * FROM sys_user WHERE username = ? AND status = 'ACTIVE'", node.username);
      if (u) return [u];
    }
    // 兜底：系统管理员
    return this.db.all<any>("SELECT u.* FROM sys_user u JOIN sys_user_role ur ON ur.user_id = u.id JOIN sys_role r ON r.id = ur.role_id WHERE r.code = 'SYS_ADMIN'");
  }

  private nodeNext(definition: any, current: string) {
    return this.flowTarget(definition, current);
  }

  pass(instanceId: number, user: AuthUser, comment?: string) {
    const instance = this.db.one<any>('SELECT * FROM ap_instance WHERE id = ?', instanceId);
    if (!instance) throw new BizException('审批实例不存在', ErrCode.NOT_FOUND);
    if (instance.status !== 'RUNNING') throw new BizException('该审批已结束，无法重复处理', ErrCode.STATE);
    const task = this.db.one<any>(
      "SELECT * FROM ap_task WHERE instance_id = ? AND assignee_id = ? AND status = 'PENDING'",
      instanceId, user.id,
    );
    if (!task) throw new BizException('您不是当前节点的待办人，无法审批', ErrCode.FORBIDDEN);
    const defRow = this.db.one<any>('SELECT * FROM ap_process_def WHERE code = ?', instance.process_code);
    const definition = parseJson<any>(defRow?.definition, { nodes: [], flows: [] });
    const node = this.nodeOf(definition, instance.current_node) || {};

    this.db.run('UPDATE ap_task SET status = ?, comment = ?, handled_at = ? WHERE id = ?', 'APPROVED', comment || null, nowStr(), task.id);

    const pendingOthers = this.db.all<any>(
      "SELECT * FROM ap_task WHERE instance_id = ? AND node_id = ? AND status = 'PENDING'",
      instanceId, instance.current_node,
    );
    if (node.multi === 'AND' && pendingOthers.length) {
      this.db.run('UPDATE ap_instance SET updated_at = ? WHERE id = ?', nowStr(), instanceId);
      this.audit.log(user, 'approval', 'APPROVE', instance.title, `节点「${node.name}」会签通过，待其余审批人`, undefined);
      return { status: 'RUNNING', waiting: pendingOthers.length };
    }
    // 或签 / 会签最后一人：关闭同节点其他待办
    for (const p of pendingOthers) {
      this.db.run('UPDATE ap_task SET status = ?, handled_at = ? WHERE id = ?', 'CANCELLED', nowStr(), p.id);
    }
    this.audit.log(user, 'approval', 'APPROVE', instance.title, `节点「${node.name}」通过`, undefined);

    const next = this.nodeNext(definition, instance.current_node);
    if (!next) {
      this.complete(instanceId, definition);
    } else {
      try {
        this.enterNode(instanceId, definition, next);
      } catch (e: any) {
        this.db.run("UPDATE ap_instance SET status = 'ERROR', updated_at = ? WHERE id = ?", nowStr(), instanceId);
        throw e;
      }
    }
    return { status: this.db.one<any>('SELECT status FROM ap_instance WHERE id = ?', instanceId)?.status, next };
  }

  reject(instanceId: number, user: AuthUser, comment?: string) {
    const instance = this.db.one<any>('SELECT * FROM ap_instance WHERE id = ?', instanceId);
    if (!instance) throw new BizException('审批实例不存在', ErrCode.NOT_FOUND);
    if (instance.status !== 'RUNNING') throw new BizException('该审批已结束', ErrCode.STATE);
    const task = this.db.one<any>(
      "SELECT * FROM ap_task WHERE instance_id = ? AND assignee_id = ? AND status = 'PENDING'",
      instanceId, user.id,
    );
    if (!task) throw new BizException('您不是当前节点的待办人，无法驳回', ErrCode.FORBIDDEN);
    this.db.run('UPDATE ap_task SET status = ?, comment = ?, handled_at = ? WHERE id = ?', 'REJECTED', comment || null, nowStr(), task.id);
    this.db.run(
      "UPDATE ap_task SET status = 'CANCELLED', handled_at = ? WHERE instance_id = ? AND status = 'PENDING'",
      nowStr(), instanceId,
    );
    this.db.run("UPDATE ap_instance SET status = 'REJECTED', updated_at = ? WHERE id = ?", nowStr(), instanceId);
    this.hooks.run('rejectInstance', instance);
    this.audit.log(user, 'approval', 'REJECT', instance.title, comment || '驳回', undefined);
    this.notice.send(
      [instance.applicant_id], 'APPROVAL_RESULT', `您的申请被驳回：${instance.title}`,
      `${user.displayName} 在节点「${instance.current_node || ''}」驳回${comment ? '：' + comment : ''}`, '/approval',
    );
    return { status: 'REJECTED' };
  }

  // ---------------- M4：转办 / 加签 ----------------
  /** 候选处理人（转办 / 加签对象） */
  handlers() {
    return this.db.all<any>("SELECT id, display_name, dept FROM sys_user WHERE status = 'ACTIVE' ORDER BY id");
  }

  /** 校验当前用户是实例待办人，返回任务与实例 */
  private myPendingTask(instanceId: number, user: AuthUser) {
    const instance = this.db.one<any>('SELECT * FROM ap_instance WHERE id = ?', instanceId);
    if (!instance) throw new BizException('审批实例不存在', ErrCode.NOT_FOUND);
    if (instance.status !== 'RUNNING') throw new BizException('该审批已结束，无法操作', ErrCode.STATE);
    const task = this.db.one<any>(
      "SELECT * FROM ap_task WHERE instance_id = ? AND assignee_id = ? AND status = 'PENDING'",
      instanceId, user.id,
    );
    if (!task) throw new BizException('您不是当前节点的待办人', ErrCode.FORBIDDEN);
    return { instance, task };
  }

  private assertTarget(userId: any, selfId: number) {
    const target = this.db.one<any>("SELECT * FROM sys_user WHERE id = ? AND status = 'ACTIVE'", Number(userId || 0));
    if (!target) throw new BizException('目标用户不存在或已停用', ErrCode.PARAM);
    if (target.id === selfId) throw new BizException('目标用户不能是自己', ErrCode.PARAM);
    return target;
  }

  /** 转办：将当前待办任务转给他人处理 */
  transfer(user: AuthUser, instanceId: number, dto: any) {
    const { instance, task } = this.myPendingTask(instanceId, user);
    const target = this.assertTarget(dto?.userId, user.id);
    const comment = String(dto?.comment || '').trim();
    const merged = `${task.comment ? task.comment + '；' : ''}转办自 ${user.displayName}${comment ? '：' + comment : ''}`;
    this.db.run(
      'UPDATE ap_task SET assignee_id = ?, assignee_name = ?, comment = ? WHERE id = ?',
      target.id, target.display_name, merged.slice(0, 500), task.id,
    );
    this.audit.log(user, 'approval', 'TRANSFER', instance.title, `转办给 ${target.display_name}${comment ? '：' + comment : ''}`);
    this.notice.send(
      [target.id], 'APPROVAL', `您收到一条转办待办：${instance.title}`,
      `${user.displayName} 将「${task.node_name}」转办给您${comment ? '：' + comment : ''}`, '/approval',
    );
    return { taskId: task.id, assignee_name: target.display_name };
  }

  /** 加签：在当前节点追加一名会签人（会签节点需其通过；或签节点任一通过即结束） */
  addSign(user: AuthUser, instanceId: number, dto: any) {
    const { instance, task } = this.myPendingTask(instanceId, user);
    const target = this.assertTarget(dto?.userId, user.id);
    const exists = this.db.one<any>(
      "SELECT id FROM ap_task WHERE instance_id = ? AND assignee_id = ? AND status = 'PENDING'",
      instanceId, target.id,
    );
    if (exists) throw new BizException('该用户已是当前节点的待办人', ErrCode.STATE);
    const comment = String(dto?.comment || '').trim();
    this.db.run(
      'INSERT INTO ap_task (instance_id, node_id, node_name, assignee_id, assignee_name, status, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      instanceId, task.node_id, task.node_name, target.id, target.display_name, 'PENDING',
      `${comment ? comment + '；' : ''}由 ${user.displayName} 加签`.slice(0, 500), nowStr(),
    );
    this.audit.log(user, 'approval', 'ADD_SIGN', instance.title, `节点「${task.node_name}」加签 ${target.display_name}`);
    this.notice.send(
      [target.id], 'APPROVAL', `您被加签至审批节点：${instance.title}`,
      `${user.displayName} 将您加入「${task.node_name}」节点${comment ? '：' + comment : ''}`, '/approval',
    );
    return { instanceId, added: target.display_name };
  }

  private complete(instanceId: number, definition: any) {
    this.db.run("UPDATE ap_instance SET status = 'COMPLETED', current_node = 'end', updated_at = ? WHERE id = ?", nowStr(), instanceId);
    const inst = this.db.one<any>('SELECT * FROM ap_instance WHERE id = ?', instanceId);
    this.audit.log({ id: inst.applicant_id, username: inst.applicant_name }, 'approval', 'COMPLETE', inst.title, '审批通过并生效', undefined);
    this.notice.send(
      [inst.applicant_id], 'APPROVAL_RESULT', `您的申请已通过并生效：${inst.title}`,
      '审批流程已全部完成，主数据变更已生效', '/approval',
    );
  }

  private runAuto(instanceId: number, definition: any, node: any) {
    const inst = this.db.one<any>('SELECT * FROM ap_instance WHERE id = ?', instanceId);
    try {
      this.hooks.run(node.handler, inst);
    } catch (e: any) {
      this.db.run("UPDATE ap_instance SET status = 'ERROR', updated_at = ? WHERE id = ?", nowStr(), instanceId);
      throw new BizException('流程自动节点执行失败：' + (e?.message || e), ErrCode.BUSINESS);
    }
    const next = this.nodeNext(definition, node.id);
    if (next) this.enterNode(instanceId, definition, next);
    else this.db.run("UPDATE ap_instance SET status = 'COMPLETED', updated_at = ? WHERE id = ?", nowStr(), instanceId);
  }

  // ---------------- M6：可视化流程设计器 ----------------
  /** 设计器下拉选项（用户 / 角色 / 数据域），供流程绑定与节点配置 */
  designerOptions() {
    return {
      users: this.db.all<any>("SELECT id, username, display_name, dept FROM sys_user WHERE status = 'ACTIVE' ORDER BY id"),
      roles: this.db.all<any>('SELECT code, name FROM sys_role ORDER BY id'),
      domains: this.db.all<any>('SELECT code, name FROM md_domain ORDER BY sort'),
    };
  }

  /** 保存流程定义：新建或覆盖同 code 定义（进行中实例按实例内解析继续流转，不受影响） */
  saveProcess(user: AuthUser, dto: any) {
    const code = String(dto?.code || '').trim().toUpperCase();
    const name = String(dto?.name || '').trim();
    const bind = dto?.bind || {};
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) throw new BizException('流程编码需以字母开头，2-40 位大写字母/数字/下划线', ErrCode.PARAM);
    if (!name) throw new BizException('流程名称不能为空', ErrCode.PARAM);
    if (!['CREATE', 'CHANGE'].includes(bind.action)) throw new BizException('绑定动作需为 CREATE（新增）或 CHANGE（变更）', ErrCode.PARAM);
    const domain = String(bind.domain || '').trim();
    if (!domain) throw new BizException('绑定主数据域不能为空（可填 * 表示全部）', ErrCode.PARAM);
    if (domain !== '*' && !this.db.one('SELECT code FROM md_domain WHERE code = ?', domain)) {
      throw new BizException(`主数据域不存在：${domain}`, ErrCode.PARAM);
    }
    const nodes = Array.isArray(dto?.nodes) ? dto.nodes : [];
    const flows = Array.isArray(dto?.flows) ? dto.flows : [];
    this.validateDefinition(nodes, flows);
    const definition = JSON.stringify({ code, bind: { domain, action: bind.action }, nodes, flows });
    const exists = this.db.one<any>('SELECT id FROM ap_process_def WHERE code = ?', code);
    if (exists) {
      this.db.run('UPDATE ap_process_def SET name = ?, definition = ? WHERE code = ?', name, definition, code);
    } else {
      this.db.run(
        'INSERT INTO ap_process_def (code, name, definition, status, created_at) VALUES (?, ?, ?, ?, ?)',
        code, name, definition, 'ACTIVE', nowStr(),
      );
    }
    this.audit.log(user, 'approval', 'SAVE_PROCESS', name, `流程 ${code} · ${nodes.length} 节点${exists ? '（更新）' : '（新建）'}`, undefined);
    return { code, name };
  }

  /** 启用 / 停用流程定义（停用后不再匹配新发起的审批，进行中实例不受影响） */
  toggleProcess(user: AuthUser, code: string) {
    const row = this.db.one<any>('SELECT * FROM ap_process_def WHERE code = ?', code);
    if (!row) throw new BizException('流程定义不存在', ErrCode.NOT_FOUND);
    const status = row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    this.db.run('UPDATE ap_process_def SET status = ? WHERE code = ?', status, code);
    this.audit.log(user, 'approval', 'TOGGLE_PROCESS', row.name, `${code} → ${status === 'ACTIVE' ? '启用' : '停用'}`, undefined);
    return { code, status };
  }

  /** 定义校验：单一 START/END、连线端点有效、审批/抄送节点人员配置齐全、链路无环且可达 END */
  private validateDefinition(nodes: any[], flows: any[]) {
    if (!nodes.length) throw new BizException('流程节点不能为空', ErrCode.PARAM);
    const starts = nodes.filter((n) => n.type === 'START');
    const ends = nodes.filter((n) => n.type === 'END');
    if (starts.length !== 1 || ends.length !== 1) throw new BizException('流程必须有且仅有一个开始与一个结束节点', ErrCode.PARAM);
    if (new Set(nodes.map((n) => n.id)).size !== nodes.length) throw new BizException('节点标识重复', ErrCode.PARAM);
    for (const n of nodes) {
      if (!n.id || !n.type) throw new BizException('节点缺少 id 或类型', ErrCode.PARAM);
      if (n.type === 'APPROVAL' || n.type === 'CC') {
        const label = n.type === 'CC' ? '抄送' : '审批';
        if (!String(n.name || '').trim()) throw new BizException(`${label}节点缺少名称`, ErrCode.PARAM);
        if (n.assigneeType === 'ROLE') {
          if (!n.role) throw new BizException(`「${n.name}」缺少角色配置`, ErrCode.PARAM);
          if (!this.db.one('SELECT id FROM sys_role WHERE code = ?', n.role)) throw new BizException(`角色不存在：${n.role}`, ErrCode.PARAM);
        } else if (n.assigneeType === 'USER') {
          if (!n.username) throw new BizException(`「${n.name}」缺少用户配置`, ErrCode.PARAM);
          if (!this.db.one("SELECT id FROM sys_user WHERE username = ? AND status = 'ACTIVE'", n.username)) {
            throw new BizException(`用户不存在或已停用：${n.username}`, ErrCode.PARAM);
          }
        } else {
          throw new BizException(`「${n.name}」缺少处理人配置（角色或用户）`, ErrCode.PARAM);
        }
        if (n.type === 'APPROVAL') n.multi = n.multi === 'AND' ? 'AND' : 'OR';
        else delete n.multi;
      }
      if (n.type === 'AUTO' && !String(n.handler || '').trim()) {
        throw new BizException('自动节点缺少处理器（handler）配置', ErrCode.PARAM);
      }
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const f of flows) {
      if (!byId.has(f.from) || !byId.has(f.to)) throw new BizException(`连线引用了不存在的节点：${f.from} → ${f.to}`, ErrCode.PARAM);
    }
    for (const n of nodes) {
      if (n.type !== 'END' && !flows.some((f) => f.from === n.id && (f.when || 'approved') === 'approved')) {
        throw new BizException(`节点「${n.name || n.id}」缺少向下连线`, ErrCode.PARAM);
      }
    }
    // 沿 approved 连线自 START 走到 END：每个节点恰好一条出线，有环或不可达即拒绝
    const seen = new Set<string>();
    let cur = starts[0].id;
    while (cur && byId.get(cur)?.type !== 'END') {
      if (seen.has(cur)) throw new BizException('审批链路存在环路', ErrCode.PARAM);
      seen.add(cur);
      const outs = flows.filter((f) => f.from === cur && (f.when || 'approved') === 'approved');
      if (outs.length !== 1) throw new BizException(`节点「${byId.get(cur)?.name || cur}」必须恰好有一条向下连线`, ErrCode.PARAM);
      cur = outs[0].to;
    }
    if (!cur || byId.get(cur)?.type !== 'END') throw new BizException('审批链路无法到达结束节点', ErrCode.PARAM);
  }

  /** 待处理任务数（工作台） */
  myPendingCount(userId: number) {
    return this.db.one<any>("SELECT COUNT(*) AS n FROM ap_task WHERE assignee_id = ? AND status = 'PENDING'", userId)?.n || 0;
  }
}
