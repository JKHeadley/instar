import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { LocalJobDefinitionPreviewSnapshot } from '../../src/scheduler/JobDefinitionPreview.js';
import { JobDefinitionPreviewCursor } from '../../src/scheduler/JobDefinitionPreviewCursor.js';
import { buildJobDefinitionPreviewPage, JobDefinitionPreviewWorker } from '../../src/scheduler/JobDefinitionPreviewWorker.js';

const fingerprint = 'a'.repeat(64);
const scope = { sessionId: 'owner-session', machineId: 'serving-machine' };
const position = { fingerprint, nextIndex: 250 };

function snapshot(count: number, slug = 'same-slug'): LocalJobDefinitionPreviewSnapshot {
  return {
    complete: true,
    fingerprint,
    coverage: { legacy: 'complete', 'portable-journal': 'complete', 'manifest-inventory': 'complete' },
    scheduler: 'unknown',
    pool: 'unchecked',
    rows: Array.from({ length: count }, (_, ordinal) => ({
      source: 'legacy', slug, disposition: 'loader-effective', enabled: ordinal % 2 === 1,
      executor: 'prompt', ownership: 'unresolved', mapping: 'unresolved', occurrence: { source: 'legacy', ordinal },
    })),
  };
}

describe('job definition preview cursor', () => {
  it('authenticates encrypted continuation to the current session and machine', () => {
    const cursor = new JobDefinitionPreviewCursor();
    const token = cursor.encode(scope, position);
    expect(token).not.toContain(fingerprint);
    expect(cursor.encode(scope, position)).not.toBe(token);
    expect(new JobDefinitionPreviewCursor().decode(scope, token)).toEqual(position);
    expect(cursor.decode({ ...scope, sessionId: 'other' }, token)).toBeNull();
    expect(cursor.decode({ ...scope, machineId: 'other' }, token)).toBeNull();
    expect(cursor.decode(scope, token + '=')).toBeNull();
    expect(cursor.decode(scope, 'x'.repeat(513))).toBeNull();
    const mutated = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(cursor.decode(scope, mutated)).toBeNull();
  });

  it('expires the cursor at its cutoff', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const cursor = new JobDefinitionPreviewCursor();
      const token = cursor.encode(scope, position);
      clock.mockReturnValue(1_299_999);
      expect(cursor.decode(scope, token)).toEqual(position);
      clock.mockReturnValue(1_300_000);
      expect(cursor.decode(scope, token)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('job definition preview paging', () => {
  it('continues after the last visible duplicate occurrence without disclosing coordinates or fingerprint', () => {
    const input = snapshot(251);
    const first = buildJobDefinitionPreviewPage(input);
    if (first.status !== 'ready') throw new Error('Expected a preview page');
    expect(first.page.rows).toHaveLength(250);
    expect(first.page.rows.at(-1)?.enabled).toBe(true);
    expect(first.page.truncated).toBe(true);
    expect(first.continuation).toEqual(position);
    expect(JSON.stringify(first.page)).not.toMatch(/occurrence|fingerprint/);
    const second = buildJobDefinitionPreviewPage(input, first.continuation);
    expect(second).toMatchObject({ status: 'ready', page: { truncated: false, rows: [{ enabled: false }] } });
    expect(second).not.toHaveProperty('continuation');
    expect(buildJobDefinitionPreviewPage({ ...input, fingerprint: 'b'.repeat(64) }, position)).toEqual({ status: 'restart' });
  });

  it('reserves the response budget using encoded byte length and continues past that boundary', () => {
    const input = snapshot(250, '雪'.repeat(850));
    const first = buildJobDefinitionPreviewPage(input);
    if (first.status !== 'ready') throw new Error('Expected a preview page');
    expect(first.page.rows.length).toBeLessThan(250);
    expect(Buffer.byteLength(JSON.stringify(first.page))).toBeLessThanOrEqual(512 * 1024 - 1024);
    expect(first.continuation?.nextIndex).toBe(first.page.rows.length);
    const next = buildJobDefinitionPreviewPage(input, first.continuation);
    expect(next).toMatchObject({ status: 'ready', page: { truncated: false } });
    if (next.status !== 'ready') throw new Error('Expected a preview continuation');
    expect(first.page.rows.length + next.page.rows.length).toBe(250);
  });

  it('provides no continuation for incomplete input and refuses a cursor into it', () => {
    const input = { ...snapshot(251), complete: false, fingerprint: null };
    expect(buildJobDefinitionPreviewPage(input)).toMatchObject({ status: 'ready', page: { complete: false, truncated: true } });
    expect(buildJobDefinitionPreviewPage(input)).not.toHaveProperty('continuation');
    expect(buildJobDefinitionPreviewPage(input, position)).toEqual({ status: 'restart' });
  });
});

describe('job definition preview worker admission', () => {
  it('reads through the compiled worker and rejects a continuation after local input changes', async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'preview-worker-'));
    try {
      const jobsFile = path.join(root, 'custom-jobs.json');
      const rows = Array.from({ length: 251 }, () => ({
        slug: 'same', name: 'secret-name', description: 'secret-description', schedule: '0 * * * *',
        enabled: true, priority: 'low', expectedDurationMinutes: 1, execute: { type: 'prompt', value: 'secret-body' },
      }));
      await fs.writeFile(jobsFile, JSON.stringify(rows));
      const worker = new JobDefinitionPreviewWorker(new URL('../../dist/scheduler/JobDefinitionPreviewWorker.worker.js', import.meta.url));
      const base = { jobsFile, signal: new AbortController().signal };
      const first = await worker.read(base);
      if (first.status !== 'ready') throw new Error('Expected a preview page');
      expect(first.page).toMatchObject({ complete: true, truncated: true });
      expect(first.page.rows).toHaveLength(250);
      expect(JSON.stringify(first.page)).not.toMatch(/secret|custom-jobs|occurrence|fingerprint/);
      expect(first.continuation?.nextIndex).toBe(250);
      expect(await worker.read({ ...base, continuation: first.continuation })).toMatchObject({
        status: 'ready', page: { truncated: false, rows: [{ slug: 'same' }] },
      });
      rows[250].enabled = false;
      await fs.writeFile(jobsFile, JSON.stringify(rows));
      expect(await worker.read({ ...base, continuation: first.continuation })).toEqual({ status: 'restart' });
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'job-preview-worker-test-cleanup' });
    }
  });
  it('holds one slot until the canceled worker exits and admits recovery afterward', async () => {
    const stalled = new URL('data:text/javascript,while(true){}');
    const done = new URL(`data:text/javascript,${encodeURIComponent(
      "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({status:'restart'});"
    )}`);
    const abort = new AbortController();
    const newRequest = { jobsFile: 'unused', signal: new AbortController().signal };
    const first = new JobDefinitionPreviewWorker(stalled).read({ jobsFile: 'unused', signal: abort.signal });
    const next = new JobDefinitionPreviewWorker(done);
    expect(await next.read(newRequest)).toEqual({ status: 'busy' });
    abort.abort();
    expect(await first).toEqual({ status: 'unavailable' });
    expect(await next.read(newRequest)).toEqual({ status: 'busy' });
    let retry = await next.read(newRequest);
    for (let waits = 0; retry.status === 'busy' && waits < 50; waits++) {
      await sleep(20);
      retry = await next.read(newRequest);
    }
    expect(retry).toEqual({ status: 'restart' });
  });
});
