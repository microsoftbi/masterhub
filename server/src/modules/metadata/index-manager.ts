import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../db/db.service';

/**
 * 动态字段索引管理器：模型发布时按查询字段维护 SQLite 生成列与复合索引。
 * PostgreSQL 迁移后只需替换本类中的 DDL 生成策略（VIRTUAL → STORED）。
 */
@Injectable()
export class IndexManager implements OnModuleInit {
  constructor(private db: DbService) {}

  onModuleInit() {
    // 启动时校正：确保已发布模型的查询字段均有生成列
    const models = this.db.all<any>("SELECT id FROM md_model WHERE status = 'PUBLISHED'");
    for (const m of models) {
      const fields = this.db.all<any>('SELECT * FROM md_field WHERE model_id = ? AND query_flag = 1', m.id);
      for (const f of fields) this.ensureColumn(f.field_key);
    }
  }

  private columnName(fieldKey: string) {
    return 'g_' + fieldKey;
  }

  hasColumn(fieldKey: string): boolean {
    const cols = this.db.all<any>('PRAGMA table_info(md_master_data)');
    return cols.some((c) => c.name === this.columnName(fieldKey));
  }

  ensureColumn(fieldKey: string) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(fieldKey)) return;
    const col = this.columnName(fieldKey);
    if (!this.hasColumn(fieldKey)) {
      try {
        this.db.raw.exec(
          `ALTER TABLE md_master_data ADD COLUMN ${col} TEXT GENERATED ALWAYS AS (json_extract(data, '$.${fieldKey}')) VIRTUAL`,
        );
      } catch {
        return;
      }
    }
    this.db.raw.exec(
      `CREATE INDEX IF NOT EXISTS idx_md_master_data_dom_${col} ON md_master_data(domain_code, ${col})`,
    );
  }

  sync(modelId: number) {
    const fields = this.db.all<any>('SELECT * FROM md_field WHERE model_id = ?', modelId);
    const created: string[] = [];
    for (const f of fields.filter((x) => x.query_flag === 1)) {
      const existed = this.hasColumn(f.field_key);
      this.ensureColumn(f.field_key);
      if (!existed) created.push(f.field_key);
    }
    return { indexed: fields.filter((x) => x.query_flag === 1).map((f) => f.field_key), created };
  }
}
