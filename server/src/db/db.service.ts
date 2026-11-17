import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { SCHEMA_SQL, SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_V6_SQL, SCHEMA_V7_SQL } from './schema';
import { runSeed, runSeedCollect, runSeedConfigs, runSeedExtras, runSeedSchedule, runSeedTree, seedApprovalManagePerm, seedSystemManagePerm } from './seed';
import { nowStr } from '../common/util';

/**
 * SQLite 访问层：单写连接 + WAL。
 * 迁移 PostgreSQL 时仅替换本文件实现（连接池 / 方言）与 schema，服务层 SQL 标准部分不变。
 */
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private db!: Database.Database;

  onModuleInit() {
    const file = resolve(process.env.DB_PATH || 'data/masterhub.db');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    runSeed(this.db);
    seedSystemManagePerm(this.db);
    runSeedConfigs(this.db);
    runSeedExtras(this.db);
    runSeedSchedule(this.db);
    runSeedCollect(this.db);
    runSeedTree(this.db);
    seedApprovalManagePerm(this.db);
  }

  onModuleDestroy() {
    this.db?.close();
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS mh_migration (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = this.db.prepare('SELECT version FROM mh_migration WHERE version = 1').get();
    if (!applied) {
      this.db.exec(SCHEMA_SQL);
      this.db
        .prepare('INSERT INTO mh_migration (version, name, applied_at) VALUES (?, ?, ?)')
        .run(1, 'init-m1-sqlite', nowStr());
    }
    const applied2 = this.db.prepare('SELECT version FROM mh_migration WHERE version = 2').get();
    if (!applied2) {
      this.db.exec(SCHEMA_V2_SQL);
      this.db
        .prepare('INSERT INTO mh_migration (version, name, applied_at) VALUES (?, ?, ?)')
        .run(2, 'm2-quality-workflow', nowStr());
    }
    const applied3 = this.db.prepare('SELECT version FROM mh_migration WHERE version = 3').get();
    if (!applied3) {
      this.db.exec(SCHEMA_V3_SQL);
      this.db
        .prepare('INSERT INTO mh_migration (version, name, applied_at) VALUES (?, ?, ?)')
        .run(3, 'm3-schedule-assignee', nowStr());
    }
    const applied4 = this.db.prepare('SELECT version FROM mh_migration WHERE version = 4').get();
    if (!applied4) {
      this.db.exec(SCHEMA_V4_SQL);
      this.db
        .prepare('INSERT INTO mh_migration (version, name, applied_at) VALUES (?, ?, ?)')
        .run(4, 'm4-collect-notice', nowStr());
    }
    const applied5 = this.db.prepare('SELECT version FROM mh_migration WHERE version = 5').get();
    if (!applied5) {
      this.db.exec(SCHEMA_V5_SQL);
      this.db
        .prepare('INSERT INTO mh_migration (version, name, applied_at) VALUES (?, ?, ?)')
        .run(5, 'm5-tree-dict-hierarchy', nowStr());
    }
    const applied6 = this.db.prepare('SELECT version FROM mh_migration WHERE version = 6').get();
    if (!applied6) {
      this.db.exec(SCHEMA_V6_SQL);
      this.db
        .prepare('INSERT INTO mh_migration (version, name, applied_at) VALUES (?, ?, ?)')
        .run(6, 'm6-approval-cc-designer', nowStr());
    }
    const applied7 = this.db.prepare('SELECT version FROM mh_migration WHERE version = 7').get();
    if (!applied7) {
      this.db.exec(SCHEMA_V7_SQL);
      this.db
        .prepare('INSERT INTO mh_migration (version, name, applied_at) VALUES (?, ?, ?)')
        .run(7, 'm7-collect-db-incremental', nowStr());
    }
  }

  get raw(): Database.Database {
    return this.db;
  }

  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  one<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }

  /** 事务：同步执行，异常自动回滚 */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** 读取全局参数（sys_config），不存在或为空时返回 fallback */
  cfg(key: string, fallback: any): any {
    try {
      const row = this.db.prepare('SELECT value FROM sys_config WHERE key = ?').get(key) as any;
      const v = row?.value;
      return v === undefined || v === null || v === '' ? fallback : v;
    } catch {
      return fallback;
    }
  }
}
