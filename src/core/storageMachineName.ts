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
  return /\b(?:ENOSPC|EDQUOT|EIO|EROFS|EACCES|EPERM|ENOENT|ENOTDIR|EISDIR|EFBIG|EMFILE|ENFILE|ENOTEMPTY|EXDEV|SQLITE_[A-Z0-9_]+|database|sqlite|disk|storage|filesystem|file system|unwritable|no space left)\b/i.test(message);
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

/** OS filesystem context also catches uncommon errno values without treating process/network errors as storage. */
export function isStorageFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (isStorageError(message)) return true;
  if (!error || typeof error !== 'object') return false;
  const system = error as NodeJS.ErrnoException;
  if (typeof system.code === 'string' && isStorageError(system.code)) return true;
  if (typeof (error as { path?: unknown }).path === 'string') return true;
  return typeof system.syscall === 'string' && /^(?:open|read|write|stat|lstat|fstat|statfs|fstatfs|access|chmod|fchmod|chown|fchown|lchown|link|symlink|readlink|realpath|rename|unlink|mkdir|rmdir|readdir|scandir|opendir|copyfile|sendfile|truncate|ftruncate|fsync|fdatasync|utimes|futimes|lutimes|close)$/i.test(system.syscall);
}

/** Local caught exceptions rendered directly by routes, including raw OS/SQLite failures. */
export function operatorError(error: unknown, stateDir?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return isStorageFailure(error) ? nameStorageError(message, stateDir) : message;
}
