/** Descriptor-relative, no-follow file operations for private portable jobs. */
// RULE 3: EXEMPT — JSON.parse decodes a fixed schema from our bundled helper process; it does not infer external provider or machine state.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSyncOp } from './InFlightSyncOpMarker.js';

const helper = fileURLToPath(new URL('../../scripts/job-portable-fs.py', import.meta.url));
const MAX_OUTPUT = 1024 * 1024;
function run(mode: string, root: string, relative: string, input?: string, extra?: string): Buffer {
  const result = withSyncOp(() => spawnSync('python3', [helper, mode, root, relative, ...(extra ? [extra] : [])], {
    input, maxBuffer: MAX_OUTPUT, timeout: 3000,
  }));
  if (result.error || result.status !== 0) {
    const reason = result.stderr?.toString('utf8').trim() || result.error?.message || 'helper-failed';
    throw new Error(`portable-filesystem-refused: ${reason}`);
  }
  return result.stdout;
}
export function portableQuarantineIfHash(root: string, source: string, target: string, expected: string): boolean {
  const result = withSyncOp(() => spawnSync('python3', [helper, 'quarantine', root, source, target, expected],
    { maxBuffer: MAX_OUTPUT, timeout: 3000 }));
  if (result.error || result.status !== 0) throw new Error(result.stderr?.toString('utf8').trim() || 'quarantine-refused');
  return result.stdout.toString('utf8').trim() === 'moved';
}
export function portableList(root: string, relative: string): Array<{ name: string; kind: 'file' | 'dir' }> {
  const rows = JSON.parse(run('list', root, relative).toString('utf8'));
  if (!Array.isArray(rows) || rows.some(row => typeof row.name !== 'string' || !['file', 'dir'].includes(row.kind)))
    throw new Error('invalid-helper-list');
  return rows;
}
export function portableVerify(root: string, expected: Record<string, string>): void {
  if (Object.keys(expected).length === 0) return;
  const result = withSyncOp(() => spawnSync('python3', [helper, 'verify', root, '.'], {
    input: JSON.stringify(expected), maxBuffer: 1024, timeout: 1800,
  }));
  if (result.error || result.status !== 0 || result.stdout.toString('utf8').trim() !== 'verified')
    throw new Error(result.stderr?.toString('utf8').trim() || result.error?.message || 'imported-file-changed');
}
export function portableCollect(root: string, dependencies: string[]): Array<{ path: string; sha256: string; content: string }> {
  if (dependencies.length === 0) return [];
  const result = withSyncOp(() => spawnSync('python3', [helper, 'collect', root, '.'], {
    input: JSON.stringify(dependencies), maxBuffer: 3 * 1024 * 1024, timeout: 1800,
  }));
  if (result.error || result.status !== 0) throw new Error(result.stderr?.toString('utf8').trim() || result.error?.message || 'collect-refused');
  const rows = JSON.parse(result.stdout.toString('utf8'));
  if (!Array.isArray(rows) || rows.length > 64) throw new Error('collect-output-invalid');
  return rows;
}
export function portableRead(root: string, relative: string): Buffer {
  return run('read', root, relative);
}
export function portableWrite(root: string, relative: string, content: Buffer, expectedOld?: string): {
  kind: 'same' | 'created' | 'updated'; old: Buffer;
} {
  const output = run('write', root, relative, JSON.stringify({ content: content.toString('hex'), expectedOld }));
  const row = JSON.parse(output.toString('utf8'));
  if (!['same', 'created', 'updated'].includes(row.kind) || typeof row.old !== 'string')
    throw new Error('invalid-helper-output');
  return { kind: row.kind, old: Buffer.from(row.old, 'hex') };
}
export function portableRemoveIfHash(root: string, relative: string, expected: string): void {
  run('remove', root, relative, undefined, expected);
}
