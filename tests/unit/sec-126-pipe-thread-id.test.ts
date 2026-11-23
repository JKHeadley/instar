/**
 * SEC-126: a peer-supplied thread id must never reach the pipe spawner's tmux
 * shell commands or its prompt file path unless it is in the canonical format.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PipeSessionSpawner, isPipeSafeThreadId } from '../../src/threadline/PipeSessionSpawner.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOSTILE = [
  'x";touch /tmp/sec126-pwned;"',
  "x';id;'",
  'x$(id)',
  'x`id`',
  '../../etc/evil',
  'thread-a b',
  'thread-a\nb',
  'THREAD-UPPER',
  '',
];

describe('SEC-126 pipe thread id allowlist', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec126-'));
    SafeFsExecutor.safeRmSync('/tmp/sec126-pwned', { force: true, operation: 'tests/unit/sec-126-pipe-thread-id.test.ts' });
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/sec-126-pipe-thread-id.test.ts' }); });

  const base = { messageText: 'hi', fromFingerprint: 'abc', fromName: 'peer', trustLevel: 'trusted' as const, iqsBand: 80 };

  it('accepts the canonical minted shapes', () => {
    for (const id of ['3f2b8c1e-0d4a-4c6e-9a7b-1e2f3a4b5c6d', 'msg-abc123', 'thread-abc-123']) {
      expect(isPipeSafeThreadId(id)).toBe(true);
    }
  });

  it('refuses ids carrying shell syntax, paths, whitespace or non-strings', () => {
    for (const id of [...HOSTILE, undefined, null, 42]) expect(isPipeSafeThreadId(id)).toBe(false);
  });

  it('shouldUsePipeMode refuses a hostile id even from a trusted peer', () => {
    const spawner = new PipeSessionSpawner({ stateDir: tmpDir, tmpDir });
    for (const threadId of HOSTILE) {
      const r = spawner.shouldUsePipeMode({ ...base, threadId });
      expect(r.eligible).toBe(false);
      expect(r.reason).toContain('canonical thread-id format');
    }
  });

  it('spawn refuses a hostile id before any shell command or prompt file', async () => {
    const spawner = new PipeSessionSpawner({ stateDir: tmpDir, tmpDir });
    for (const threadId of HOSTILE) {
      const r = await spawner.spawn({ ...base, threadId });
      expect(r.spawned).toBe(false);
      expect(r.reason).toContain('canonical thread-id format');
    }
    expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith('prompt-'))).toHaveLength(0);
    expect(fs.existsSync('/tmp/sec126-pwned')).toBe(false);
  });
});
