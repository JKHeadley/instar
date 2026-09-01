import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PhysicalEffectLock } from '../../src/core/PhysicalEffectLock.js';
import { verifyStageBStartupReadiness } from '../../src/core/StageBStartupReadiness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-b-ready-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'StageBStartupReadiness test' }); });

describe('StageBStartupReadiness', () => {
  it('verifies the real FULL/WAL schema and lock owner epoch before writing the runtime lease', () => {
    const stateDir = temp();
    expect(verifyStageBStartupReadiness(stateDir, 41, () => 'start-41')).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'codex-stage-b-runtime-lease.json'), 'utf8')))
      .toMatchObject({ pid: 41, processStartToken: 'start-41' });
  });

  it('refuses a still-live old callback lease', () => {
    const stateDir = temp();
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'codex-stage-b-runtime-lease.json'),
      JSON.stringify({ pid: 40, processStartToken: 'old-live' }));
    expect(verifyStageBStartupReadiness(stateDir, 41, (pid) => pid === 40 ? 'old-live' : 'new'))
      .toBe('startup-old-callback-live');
  });

  it('refuses a second callback owner in the same live process', () => {
    const stateDir = temp();
    expect(verifyStageBStartupReadiness(stateDir, 41, () => 'same-live-process')).toBeNull();
    expect(verifyStageBStartupReadiness(stateDir, 41, () => 'same-live-process'))
      .toBe('startup-old-callback-live');
  });

  it.each([
    ['schema', { schema: false, journalMode: 'wal', synchronous: 2 }, 'startup-schema-failed'],
    ['journal', { schema: true, journalMode: 'delete', synchronous: 2 }, 'startup-schema-failed'],
    ['FULL', { schema: true, journalMode: 'wal', synchronous: 1 }, 'startup-full-failed'],
  ] as const)('refuses failed %s verification', (_label, readiness, reason) => {
    expect(verifyStageBStartupReadiness(temp(), 41, () => 'new', {
      openStore: () => ({ startupReadiness: () => readiness, close: () => undefined }),
    })).toBe(reason);
  });

  it('refuses unavailable lock providers and non-monotonic attempt ownership', () => {
    const unavailable = new PhysicalEffectLock({
      name: 'none', available: false, acquire: async () => { throw new Error('no'); },
    });
    expect(verifyStageBStartupReadiness(temp(), 41, () => 'new', { createLock: () => unavailable }))
      .toBe('startup-lock-failed');

    const lease = { scope: 's', ownerId: 'o', epoch: 1, acquiredAt: 1, requiresReconciliation: false,
      assertHeld: () => undefined, release: () => undefined };
    const nonMonotonic = new PhysicalEffectLock({
      name: 'fake', available: true, acquire: async () => { throw new Error('unused'); }, acquireSync: () => lease,
    });
    expect(verifyStageBStartupReadiness(temp(), 41, () => 'new', { createLock: () => nonMonotonic }))
      .toBe('startup-attempt-owner-failed');
  });
});
