import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

export interface FeedbackFactoryGeneratedDefaults {
  schemaVersion: 1;
  feedbackFactory: { processing: { enabled: true }; drain: { enabled: true } };
}

const EXPECTED: FeedbackFactoryGeneratedDefaults = { schemaVersion: 1, feedbackFactory: { processing: { enabled: true }, drain: { enabled: true } } };
export type GeneratedDefaultsInspection =
  | { posture: 'fleet-dark' | 'healthy'; reason: 'fleet-dark' | 'healthy' }
  | { posture: 'repair-needed'; reason: 'source-absent' | 'schema-stale' }
  | { posture: 'unsafe'; reason: 'malformed-json' | 'access-denied' | 'io-error' | 'symlink-refused' | 'non-regular-refused' };

function targetPath(stateDir: string): string { return path.join(stateDir, 'state', 'generated-feature-defaults.json'); }
function classifyError(error: unknown): GeneratedDefaultsInspection['reason'] {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied';
  return 'io-error';
}
function isExpected(parsed: Record<string, unknown>): boolean {
  const ff = parsed.feedbackFactory as Record<string, unknown> | undefined;
  const processing = ff?.processing as Record<string, unknown> | undefined;
  const drain = ff?.drain as Record<string, unknown> | undefined;
  return parsed.schemaVersion === 1 && processing?.enabled === true && drain?.enabled === true;
}

export function inspectFeedbackFactoryGeneratedDefaults(stateDir: string, developmentAgent: boolean): GeneratedDefaultsInspection {
  if (!developmentAgent) return { posture: 'fleet-dark', reason: 'fleet-dark' };
  const filePath = targetPath(stateDir);
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink()) return { posture: 'unsafe', reason: 'symlink-refused' };
    if (!st.isFile()) return { posture: 'unsafe', reason: 'non-regular-refused' };
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>; }
    catch (error) { return (error as NodeJS.ErrnoException).code ? { posture: 'unsafe', reason: classifyError(error) as 'access-denied' | 'io-error' } : { posture: 'unsafe', reason: 'malformed-json' }; }
    return isExpected(parsed) ? { posture: 'healthy', reason: 'healthy' } : { posture: 'repair-needed', reason: 'schema-stale' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { posture: 'repair-needed', reason: 'source-absent' };
    return { posture: 'unsafe', reason: classifyError(error) as 'access-denied' | 'io-error' };
  }
}

export function ensureFeedbackFactoryGeneratedDefaults(stateDir: string, developmentAgent: boolean): {
  posture: 'fleet-dark' | 'healthy' | 'repaired'; changed: boolean; path: string;
  diff: { schemaVersion?: { before: unknown; after: 1 }; processingEnabled?: { before: unknown; after: true }; drainEnabled?: { before: unknown; after: true } };
} {
  const filePath = targetPath(stateDir);
  if (!developmentAgent) return { posture: 'fleet-dark', changed: false, path: filePath, diff: {} };
  const inspection = inspectFeedbackFactoryGeneratedDefaults(stateDir, true);
  if (inspection.posture === 'unsafe') throw new Error(`generated defaults repair refused: ${inspection.reason}`);
  if (inspection.posture === 'healthy') return { posture: 'healthy', changed: false, path: filePath, diff: {} };
  const root = fs.realpathSync(stateDir);
  if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) throw new Error('generated defaults state root is unsafe');
  const dir = path.join(root, 'state');
  if (fs.existsSync(dir)) { const st = fs.lstatSync(dir); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('generated defaults parent is unsafe'); }
  else fs.mkdirSync(dir, { mode: 0o700 });
  const anchored = path.join(dir, 'generated-feature-defaults.json');
  const rel = path.relative(root, anchored); if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('generated defaults path escaped state root');
  let before: Record<string, unknown> | null = null;
  if (inspection.reason === 'schema-stale') before = JSON.parse(fs.readFileSync(anchored, 'utf8')) as Record<string, unknown>;
  const ff = before?.feedbackFactory as Record<string, unknown> | undefined;
  const processing = ff?.processing as Record<string, unknown> | undefined;
  const drain = ff?.drain as Record<string, unknown> | undefined;
  const diff = {
    ...(before?.schemaVersion === 1 ? {} : { schemaVersion: { before: before?.schemaVersion, after: 1 as const } }),
    ...(processing?.enabled === true ? {} : { processingEnabled: { before: processing?.enabled, after: true as const } }),
    ...(drain?.enabled === true ? {} : { drainEnabled: { before: drain?.enabled, after: true as const } }),
  };
  const tmp = path.join(dir, `.generated-feature-defaults.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(EXPECTED, null, 2)}\n`); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, anchored);
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
    if (fs.existsSync(tmp)) try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'generated defaults exclusive temp cleanup' }); } catch { /* cleanup best effort */ }
  }
  return { posture: 'repaired', changed: true, path: anchored, diff };
}
