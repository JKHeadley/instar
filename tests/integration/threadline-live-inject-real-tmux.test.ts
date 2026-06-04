/**
 * Integration proof for the A2A live-inject fix (Layer 2 warm-inject) against a
 * REAL tmux session — no stubbed liveness. Demonstrates the exact before/after:
 *
 *   Before the fix: ThreadResumeMap.get() nulled a non-topic entry whose uuid had
 *   no transcript JSONL — even while its tmux session was alive — so every A2A
 *   follow-up cold-spawned a memoryless session.
 *
 *   After the fix: get() returns the entry while the session is alive (so
 *   ThreadlineRouter.tryInjectIntoLiveSession can deliver into it), and still
 *   nulls it once the session is gone (resume guard intact).
 *
 * Skips automatically if tmux is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ThreadResumeMap } from '../../src/threadline/ThreadResumeMap.js';
import type { ThreadResumeEntry } from '../../src/threadline/ThreadResumeMap.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmuxOk = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const SESSION = `livetest-${process.pid}-${Math.floor(process.hrtime()[1] % 100000)}`;

function makeEntry(over: Partial<ThreadResumeEntry> = {}): ThreadResumeEntry {
  return {
    uuid: 'placeholder-uuid-no-transcript-000000',
    sessionName: SESSION,
    remoteAgent: 'dawn',
    subject: 'continuity proof',
    messageCount: 1,
    state: 'active',
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    ...over,
  } as ThreadResumeEntry;
}

describe.skipIf(!tmuxOk)('A2A live-inject vs real tmux', () => {
  let dir: string;
  let stateDir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-inject-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    spawnSync('tmux', ['new-session', '-d', '-s', SESSION, 'sleep 600'], { stdio: 'ignore' });
  });

  afterAll(() => {
    spawnSync('tmux', ['kill-session', '-t', `=${SESSION}`], { stdio: 'ignore' });
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/threadline-live-inject-real-tmux.test.ts:afterAll',
      });
    } catch { /* best-effort */ }
  });

  it('RETURNS the placeholder-uuid entry while its real tmux session is alive (live-inject enabled)', () => {
    const map = new ThreadResumeMap(stateDir, dir);
    map.save('t-live', makeEntry());
    const entry = map.get('t-live');
    expect(entry).not.toBeNull();
    expect(entry!.sessionName).toBe(SESSION);
  });

  it('NULLS the same entry once the tmux session is killed (resume guard intact)', () => {
    const map = new ThreadResumeMap(stateDir, dir);
    map.save('t-dead', makeEntry());
    spawnSync('tmux', ['kill-session', '-t', `=${SESSION}`], { stdio: 'ignore' });
    const entry = map.get('t-dead');
    expect(entry).toBeNull();
  });
});
