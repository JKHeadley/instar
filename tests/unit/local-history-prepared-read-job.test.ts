import { afterEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLocalHistoryChild } from '../../dist/import/LocalHistoryChildCustody.js';
import { runLocalHistoryPreparedReadJob, type LocalHistoryPreparedReadJobOptions } from '../../dist/import/LocalHistoryPreparedReadJob.js';
import { parseLocalSessionLines } from '../../src/import/localSessionParsers.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'prepared read worker fixtures',
}); });
function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-read-job-')); dirs.push(stateDir);
  const syntheticSecret = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(12);
  const proposal = parseLocalSessionLines('codex', [
    JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session', cwd: '/synthetic/project' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'synthetic-user', role: 'user',
      content: [{ type: 'input_text', text: 'Synthetic secret message ' + syntheticSecret }] } }),
  ]);
  const bytes = Buffer.from(JSON.stringify(proposal));
  let released = 0, pid = 0, authorized = true;
  const opts: LocalHistoryPreparedReadJobOptions = {
    input: { stateDir, ownerUserId: 'synthetic-owner', maxArtifactBytes: 1024 * 1024,
      descriptors: [{ fileId: 'one', source: 'codex', expectedSessionId: 'synthetic-session', projectPath: '/synthetic/project',
        representation: proposal.representation, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] },
    async acquireChild() {
      const actual = acquireLocalHistoryChild(stateDir)!;
      return { custody: actual.custody, async registerChild(value) { pid = value; await actual.registerChild(value); },
        release() { if (pid) expect(() => process.kill(pid, 0)).toThrow(); actual.release(); released++; } };
    },
    authorized: () => authorized,
    async *chunks() { yield bytes; }, heapMiB: 128, perFileDeadlineMs: 10_000, rssBytes: 768 * 1024 * 1024,
  };
  return { opts, bytes, syntheticSecret, released: () => released, pid: () => pid, revoke: () => { authorized = false; } };
}
it('runs the actual fixed child and returns counts without message bodies or copied history', async () => {
  const f = fixture(); const result = await runLocalHistoryPreparedReadJob(f.opts);
  expect(result.preview.messages).toBe(1); expect(result.preview.newMessages).toBe(1);
  expect(result.preview.files[0].redactions).toBe(1);
  expect(JSON.stringify(result)).not.toContain('Synthetic secret message');
  expect(JSON.stringify(result)).not.toContain(f.syntheticSecret);
  expect(f.released()).toBe(1); expect(fs.existsSync(path.join(f.opts.input.stateDir, 'imported-history'))).toBe(false);
});
it('refuses invalid artifact bytes and releases only after the child closes', async () => {
  const f = fixture(); f.opts.input.descriptors[0] = { ...f.opts.input.descriptors[0], sha256: '0'.repeat(64) };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview');
  expect(f.released()).toBe(1);
});
it('aborts a waiting input producer after actual child death', async () => {
  const f = fixture();
  f.opts.chunks = async function* (signal) {
    process.kill(f.pid(), 'SIGKILL');
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
  };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview');
  expect(f.released()).toBe(1);
});
it('refuses copying a preview after owner access is revoked during input', async () => {
  const f = fixture();
  f.opts.chunks = async function* () { f.revoke(); yield f.bytes; };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-not-authorized');
  expect(f.released()).toBe(1);
});
it('uses a deadline to abort an input producer that honors cancellation', async () => {
  const f = fixture(); f.opts.perFileDeadlineMs = 1200;
  f.opts.chunks = async function* (signal) {
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
  };
  await expect(runLocalHistoryPreparedReadJob(f.opts)).rejects.toThrow('local-history-preview-timeout');
  expect(f.released()).toBe(1);
});
