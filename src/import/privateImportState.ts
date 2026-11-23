import fs from 'node:fs';
import path from 'node:path';

/** lstat rejects a symlink, even when its target is itself a private directory. */
export function verifyPrivateImportDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || !process.getuid || stat.uid !== process.getuid()))) {
    throw new Error('The import state directory is not private.');
  }
}

export function privateAcquisitionStateDir(stateDir: string): string {
  if (!process.getuid || process.platform === 'win32') throw new Error('Private acquisition storage is unavailable.');
  const directory = path.resolve(stateDir, 'history-acquisition');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  verifyPrivateImportDirectory(directory);
  return directory;
}

/** Fixed database names and their SQLite sidecars must not redirect writes outside the private root. */
export function privateAcquisitionDatabasePath(stateDir: string, name: 'jobs.sqlite' | 'worker-lock.sqlite'): string {
  return privateImportDatabasePath(privateAcquisitionStateDir(stateDir), name);
}

export function privateImportDatabasePath(directory: string, name: 'jobs.sqlite' | 'worker-lock.sqlite' | 'write-lock.sqlite' | 'exchange-lock.sqlite'): string {
  verifyPrivateImportDirectory(directory);
  const file = path.join(directory, name);
  try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = file + suffix;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(candidate); }
    catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('The import database is not a private local file.');
    }
    // Older versions created the database under a private directory using SQLite's default file mode.
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      try { fs.chmodSync(candidate, 0o600); }
      catch (error) {
        if (!suffix || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return file;
}
