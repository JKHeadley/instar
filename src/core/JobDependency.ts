/** Declared local prerequisites for scheduled jobs; paths never leave this machine. */
import fs from 'node:fs';
import path from 'node:path';

const SECRET_SEGMENT = /^(?:\.env(?:\..*)?|config(?:\.json)?|auth|secrets?|tokens?|credentials?|\.instar)$/i;
export function validJobDependencyPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || path.isAbsolute(value)
    || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..' && !SECRET_SEGMENT.test(part));
}

/** Reject symlinks at every component; a dependency is only an existence signal. */
export function jobDependencyExists(projectRoot: string, relativePath: string): boolean {
  if (!validJobDependencyPath(relativePath)) return false;
  let cursor = path.resolve(projectRoot);
  for (const part of relativePath.split('/')) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return false;
    } catch { /* @silent-fallback-ok — a missing or unreadable dependency refuses this job */ return false; }
  }
  return true;
}
