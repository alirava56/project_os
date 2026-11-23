import type { DatabaseSync } from 'node:sqlite';

export type SqlParam = string | number | null;
export type IdentityScope =
  | { purpose: 'bootstrap'; userId: string; workspaceId: string }
  | { purpose: 'login'; email: string }
  | { purpose: 'identity' | 'mfa' | 'session-list'; userId: string }
  | { purpose: 'session'; digest: string }
  | { purpose: 'invite'; email: string; digest: string }
  | { purpose: 'rate'; scope: string; bucket: string };
export interface SqlExecutor {
  readonly dialect: 'sqlite' | 'postgres';
  scopeIdentity?(scope: IdentityScope): Promise<void>;
  scopeWorkspace?(workspaceId: string, claims?: {
    role:'owner'|'editor'|'viewer'|'invitation'|'github'|'agent'; projects:string[]|null;
    resources?:string[]; actor?:string; repository?:string;
  }): Promise<void>;
  all<Row>(statement: string, ...params: SqlParam[]): Promise<Row[]>;
  one<Row>(statement: string, ...params: SqlParam[]): Promise<Row | undefined>;
  run(statement: string, ...params: SqlParam[]): Promise<number>;
}
export function getDb(): DatabaseSync;
export function postgresConfigured(): boolean;
export function closeDatabase(): Promise<void>;
export const sql: SqlExecutor;
export function transaction<T>(action: (db: SqlExecutor) => Promise<T>): Promise<T>;
export function readTransaction<T>(action: (db: SqlExecutor) => Promise<T>): Promise<T>;
export function lockWorkspace(db: SqlExecutor, workspaceId: string): Promise<{version: number; name: string} | undefined>;
export function lockBootstrap(db: SqlExecutor): Promise<void>;
export function requireWebRuntime(options?: {verifyKey?:boolean}): Promise<void>;
