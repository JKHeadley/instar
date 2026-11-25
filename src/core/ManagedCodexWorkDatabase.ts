import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { assertGraphLocalPath, ensureGraphLocalDirectory } from './GraphLocalFiles.js';
import { ManagedCodexStopStore } from './ManagedCodexStopStore.js';

/** Managed and ordinary launch paths use one local database. */
export function openManagedCodexWorkDatabase(
  stateDir: string, create = false,
): { store: ManagedCodexStopStore; close(): void } | undefined {
  const root = fs.realpathSync(stateDir);
  const directory = path.join(root, 'local', 'managed-codex-continuation');
  const file = path.join(directory, 'work.sqlite');

  assertGraphLocalPath(root, file);
  const provisioned = fs.existsSync(directory);
  let fileExists = false;
  let sidecarExists = false;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = file + suffix;
    assertGraphLocalPath(root, target);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('managed project work database path is invalid');
      if (suffix) sidecarExists = true;
      else fileExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  if (!fileExists && sidecarExists) throw new Error('managed project work database is missing but a sidecar remains');
  if (!fileExists && provisioned) throw new Error('provisioned managed project work database is missing');
  if (!fileExists && !create) return undefined;
  if (!fileExists) ensureGraphLocalDirectory(root, directory);

  const db = new Database(file, { fileMustExist: fileExists });
  try {
    if (fileExists) {
      const authority = db.prepare(`
        SELECT count(*) AS found FROM sqlite_schema WHERE type = 'table'
          AND name IN ('managed_codex_work_claims', 'ordinary_project_work_fences', 'managed_codex_native_bindings')
      `).get() as { found: number };
      if (authority.found !== 3) throw new Error('managed project work database has no established authority schema');
    }
    return { store: new ManagedCodexStopStore(db), close: () => { db.close(); } };
  } catch (error) {
    db.close();
    throw error;
  }
}
