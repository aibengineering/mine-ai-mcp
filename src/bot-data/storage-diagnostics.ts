import { threadId } from "node:worker_threads";

export type StoragePhase =
  "configure" | "enable-write" | "begin" | "operation" | "commit" | "rollback" | "restore-read-only";

export interface StorageOperation {
  readonly name: string;
  readonly requestId?: number;
}

export interface StorageConnection {
  readonly connectionId: string;
  readonly pid: number;
  readonly threadId: number;
  readonly file: string;
}

export interface StorageLockFailure extends StorageConnection {
  readonly observedAt: string;
  readonly operation: StorageOperation;
  readonly phase: StoragePhase;
  readonly elapsedMs: number;
  readonly transactionActive: boolean;
  readonly nativeCode: string | null;
  readonly sqliteCode: number | null;
  readonly message: string;
  readonly stack: string | null;
}

let nextConnection = 0;

export function storageConnection(file: string): StorageConnection {
  return Object.freeze({
    connectionId: `${process.pid}:${threadId}:${++nextConnection}`,
    pid: process.pid,
    threadId,
    file,
  });
}

/** SQLite exposes the failing connection, not the process holding its conflicting lock. */
export class BotDataLockError extends Error {
  readonly code = "BOT_DATA_LOCKED";

  constructor(
    readonly details: StorageLockFailure,
    cause: unknown,
  ) {
    super(
      `[BOT_DATA_LOCKED] ${details.operation.name}${details.operation.requestId === undefined ? "" : ` request=${details.operation.requestId}`} phase=${details.phase} connection=${details.connectionId} file=${details.file} sqlite=${details.sqliteCode ?? details.nativeCode ?? "unknown"}: ${details.message}`,
      { cause },
    );
    this.name = "BotDataLockError";
  }
}

/** Node reports errcode; Bun's node:sqlite reports errno. Preserve extended codes such as 517 (BUSY_SNAPSHOT). */
export function sqliteLock(
  cause: unknown,
): { nativeCode: string | null; sqliteCode: number | null; message: string; stack: string | null } | null {
  if (!(cause instanceof Error) || cause instanceof BotDataLockError) return null;
  const code: unknown = Reflect.get(cause, "code");
  const number: unknown = Reflect.get(cause, "errcode") ?? Reflect.get(cause, "errno");
  const sqliteCode = typeof number === "number" ? number : null;
  const nativeCode = typeof code === "string" ? code : null;
  const primary = sqliteCode === null ? null : sqliteCode & 0xff;
  if (
    primary !== 5 &&
    primary !== 6 &&
    !/^SQLITE_(BUSY|LOCKED)/.test(nativeCode ?? "") &&
    !/database (?:table |schema )?is locked/i.test(cause.message)
  )
    return null;
  return { nativeCode, sqliteCode, message: cause.message, stack: cause.stack ?? null };
}
