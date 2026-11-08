/** Read-only identity for errors produced on this machine. Never uses the lease holder's name. */
import os from 'node:os';
import path from 'node:path';
import { MachineIdentityManager } from './MachineIdentity.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';

export function storageMachineName(stateDir = process.env.INSTAR_STATE_DIR || path.resolve('.instar')): string {
  try {
    const manager = new MachineIdentityManager(stateDir);
    const { machineId } = manager.loadIdentity();
    const name = verifiedEntityName(machineId, manager.loadRegistry().machines[machineId]?.nickname);
    if (name) return name;
  } catch { /* @silent-fallback-ok — identity can be unreadable during the storage failure itself; hostname still identifies the failing host. */ }
  return os.hostname().replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim() || os.hostname();
}

/** Signals only: this changes error words, never admission or recovery decisions. */
export function isStorageError(message: string): boolean {
  return /\b(?:ENOSPC|EDQUOT|EIO|EROFS|EACCES|EPERM|SQLITE_(?:FULL|IOERR|CANTOPEN|CORRUPT)(?:_[A-Z]+)*|disk|storage|filesystem|file system|unwritable|no space left)\b/i.test(message);
}

export function nameStorageError(message: string, stateDir?: string): string {
  const name = storageMachineName(stateDir);
  return message.includes(name) ? message : `${name}: ${message}`;
}

/** Qualify a local storage response without changing machine-readable error codes. */
export function storageErrorResponse<T extends { error: string; detail?: string; message?: string }>(body: T, stateDir?: string): T & { detail: string } {
  const detail = nameStorageError(body.detail ?? body.error, stateDir);
  return { ...body, ...(typeof body.message === 'string' ? { message: nameStorageError(body.message, stateDir) } : {}), ...(body.error.includes(' ') ? { error: nameStorageError(body.error, stateDir) } : {}), detail };
}

/** Local caught exceptions rendered directly by routes, including raw OS/SQLite failures. */
export function operatorError(error: unknown, stateDir?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
  return isStorageError(message) || (typeof code === 'string' && isStorageError(code)) ? nameStorageError(message, stateDir) : message;
}
