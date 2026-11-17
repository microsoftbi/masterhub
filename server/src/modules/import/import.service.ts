import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { AuditService } from '../../common/audit.service';
import { BizException, ErrCode } from '../../common/errors';
import { AuthUser } from '../../common/decorators';
import { nowStr, parseJson, toInt } from '../../common/util';
import { MasterService } from '../master/master.service';

/** 解析 CSV（支持引号包裹、双引号转义、CRLF） */
function parseCsv(content: string): string[][] {
  const text = content.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\r') {
      // 忽略，等待 \n
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

@Injectable()
export class ImportService {
  constructor(
    private db: DbService,
    private audit: AuditService,
    private master: MasterService,
  ) {}

  template(user: AuthUser, domain: string) {
    const { domain: d, fields } = this.master.fieldsFor(user, domain);
    const header = fields.map((f) => f.label).join(',');
    const hint = fields.map((f) => f.field_key).join(',');
    return {
      filename: `${domain}-导入模板.csv`,
      content: `${header}\r\n${hint}\r\n`,
      domain: { code: d.code, name: d.name },
      fields: fields.map((f) => ({
        key: f.field_key,
        label: f.label,
        type: f.type,
        required: !!f.required,
        dictCode: f.dict_code,
        refDomain: f.ref_domain,
      })),
    };
  }

  validate(user: AuthUser, domain: string, body: { filename?: string; content?: string }) {
    const { fields } = this.master.fieldsFor(user, domain);
    const content = String(body?.content || '');
    if (!content.trim()) throw new BizException('导入内容为空', ErrCode.PARAM);
    const table = parseCsv(content);
    if (table.length < 2) throw new BizException('导入文件至少包含表头与一行数据', ErrCode.PARAM);
    // 全局参数：单次导入最大行数
    const maxRows = Number(this.db.cfg('import.maxRows', 5000)) || 5000;
    const dataRowCount = table.length - 1;
    if (dataRowCount > maxRows) throw new BizException(`导入行数 ${dataRowCount} 超过上限 ${maxRows}，请分批导入`, ErrCode.PARAM);

    const header = table[0].map((h) => h.trim());
    const byLabel = new Map(fields.map((f) => [f.label, f.field_key]));
    const byKey = new Map(fields.map((f) => [f.field_key, f.field_key]));
    const columns = header.map((h) => byLabel.get(h) || byKey.get(h) || null);
    if (!columns.some((c) => c)) throw new BizException('表头未匹配到任何字段，请使用下载的模板', ErrCode.PARAM);

    const dataRows = table.slice(1).map((cells) => {
      const obj: any = {};
      columns.forEach((key, i) => {
        if (key) obj[key] = cells[i] ?? '';
      });
      return obj;
    });
    const results = this.master.precheck(user, domain, dataRows);
    const created = nowStr();
    const batchId = this.db.tx(() => {
      const r = this.db.run(
        'INSERT INTO md_import_batch (domain_code, filename, total, valid, invalid, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        domain, body?.filename || '手动粘贴.csv', results.length,
        results.filter((x) => x.valid).length, results.filter((x) => !x.valid).length,
        'VALIDATED', user.username, created,
      );
      const id = Number(r.lastInsertRowid);
      for (const row of results) {
        this.db.run(
          'INSERT INTO md_import_row (batch_id, row_no, raw, valid, errors) VALUES (?, ?, ?, ?, ?)',
          id, row.rowNo, JSON.stringify(row.data), row.valid ? 1 : 0, row.errors.length ? row.errors.join('；') : null,
        );
      }
      return id;
    });
    this.audit.log(user, 'import', 'VALIDATE', `${domain} 导入预校验：${results.length} 行`, {
      batchId, valid: results.filter((x) => x.valid).length,
    });
    return this.batch(batchId);
  }

  commit(user: AuthUser, batchId: number, body: { autoPublish?: boolean }) {
    const batch = this.db.one<any>('SELECT * FROM md_import_batch WHERE id = ?', batchId);
    if (!batch) throw new BizException('导入批次不存在', ErrCode.NOT_FOUND);
    if (batch.status === 'COMMITTED') throw new BizException('该批次已提交，不可重复操作', ErrCode.STATE);
    if (!user.roles.includes('SYS_ADMIN') && batch.created_by !== user.username) {
      throw new BizException('仅批次创建人可提交', ErrCode.FORBIDDEN);
    }
    const rows = this.db.all<any>('SELECT * FROM md_import_row WHERE batch_id = ? AND valid = 1 AND record_id IS NULL ORDER BY row_no', batchId);
    let success = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const rec = this.master.create(user, batch.domain_code, {
          data: parseJson(row.raw, {}),
          submit: !!body?.autoPublish,
        });
        this.db.run('UPDATE md_import_row SET record_id = ? WHERE id = ?', rec.id, row.id);
        success++;
      } catch (e: any) {
        failed++;
        const raw = e?.getResponse?.();
        const msg = (typeof raw === 'object' && raw?.msg) || e?.message || '导入失败';
        this.db.run('UPDATE md_import_row SET valid = 0, errors = ? WHERE id = ?', String(msg), row.id);
      }
    }
    const ts = nowStr();
    this.db.run("UPDATE md_import_batch SET status = 'COMMITTED', valid = ?, invalid = ?, committed_at = ? WHERE id = ?",
      success, batch.invalid + failed, ts, batchId);
    this.audit.log(user, 'import', 'COMMIT', `${batch.domain_code} 导入提交：成功 ${success} 条`, {
      batchId, success, failed, autoPublish: !!body?.autoPublish,
    });
    return this.batch(batchId);
  }

  batch(batchId: number) {
    const batch = this.db.one<any>('SELECT * FROM md_import_batch WHERE id = ?', batchId);
    if (!batch) throw new BizException('导入批次不存在', ErrCode.NOT_FOUND);
    const rows = this.db.all<any>('SELECT * FROM md_import_row WHERE batch_id = ? ORDER BY row_no', batchId);
    return {
      ...batch,
      statusLabel: batch.status === 'COMMITTED' ? '已提交' : '待提交',
      rows: rows.map((r) => ({
        id: r.id,
        row_no: r.row_no,
        valid: !!r.valid,
        errors: r.errors ? String(r.errors).split('；') : [],
        record_id: r.record_id,
        data: parseJson(r.raw, {}),
      })),
    };
  }

  list(query: any) {
    const page = Math.max(1, toInt(query?.page, 1));
    const size = Math.min(100, Math.max(1, toInt(query?.size, 20)));
    const where: string[] = [];
    const params: any[] = [];
    if (query?.domain) {
      where.push('domain_code = ?');
      params.push(String(query.domain));
    }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = this.db.one<any>(`SELECT COUNT(*) AS n FROM md_import_batch ${cond}`, ...params)?.n || 0;
    const rows = this.db.all<any>(
      `SELECT * FROM md_import_batch ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params, size, (page - 1) * size,
    );
    return {
      list: rows.map((r) => ({
        ...r,
        statusLabel: r.status === 'COMMITTED' ? '已提交' : '待提交',
      })),
      total, page, size,
    };
  }
}
