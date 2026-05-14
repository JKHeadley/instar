/**
 * Unit tests for the F-7 `announceOnce` primitive on
 * `AnnouncementManager`.
 *
 * Spec: docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md §R1 (Upgrade
 * invariants) + §A35 + §A57 Tier-2 — "primitive for show this message
 * once to the user, then never again".
 *
 * Covers:
 *   1. announceOnce returns true on the first call, false on subsequent.
 *   2. Different announcementIds are independent.
 *   3. State persists across AnnouncementManager instances (ledger on
 *      disk at `<stateDir>/announcements-shown.json`).
 *
 * Cleanup uses `SafeFsExecutor.safeRmSync` per the F-7 brief.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AnnouncementManager } from '../../src/core/MigratorStepEngine.js';
import type { AnnouncementChannel } from '../../src/core/MigratorStepEngine.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('AnnouncementManager.announceOnce (F-7 primitive)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-f7-announce-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/AnnouncementManager.test.ts:afterEach',
    });
  });

  it('1. returns true on first call, false on subsequent', async () => {
    const sinkCalls: Array<{ id: string; msg: string; channel: AnnouncementChannel }> = [];
    const manager = new AnnouncementManager(stateDir, (id, msg, channel) => {
      sinkCalls.push({ id, msg, channel });
    });

    const first = await manager.announceOnce('migration-complete-1.2.3', 'Upgrade applied', 'log');
    expect(first).toBe(true);
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0]).toEqual({
      id: 'migration-complete-1.2.3',
      msg: 'Upgrade applied',
      channel: 'log',
    });

    const second = await manager.announceOnce(
      'migration-complete-1.2.3',
      'Upgrade applied',
      'log',
    );
    expect(second).toBe(false);
    // Sink must not be called again.
    expect(sinkCalls).toHaveLength(1);

    // hasBeenShown() reflects the same state.
    expect(manager.hasBeenShown('migration-complete-1.2.3')).toBe(true);
    expect(manager.hasBeenShown('something-else')).toBe(false);
  });

  it('2. different announcementIds are independent', async () => {
    const sinkCalls: string[] = [];
    const manager = new AnnouncementManager(stateDir, (id) => {
      sinkCalls.push(id);
    });

    expect(await manager.announceOnce('alpha', 'A', 'log')).toBe(true);
    expect(await manager.announceOnce('beta', 'B', 'log')).toBe(true);
    expect(await manager.announceOnce('gamma', 'C', 'log')).toBe(true);

    // Re-call each — all must return false.
    expect(await manager.announceOnce('alpha', 'A', 'log')).toBe(false);
    expect(await manager.announceOnce('beta', 'B', 'log')).toBe(false);
    expect(await manager.announceOnce('gamma', 'C', 'log')).toBe(false);

    expect(sinkCalls).toEqual(['alpha', 'beta', 'gamma']);

    // Channel-specific announcements with different channels but same id
    // still collapse — id is the dedup key, not (id, channel).
    expect(await manager.announceOnce('alpha', 'A', 'telegram')).toBe(false);
  });

  it('3. state persists across AnnouncementManager instances', async () => {
    const manager1 = new AnnouncementManager(stateDir);
    expect(await manager1.announceOnce('persisted-id', 'message', 'log')).toBe(true);

    // Ledger written to disk.
    const ledgerPath = path.join(stateDir, 'announcements-shown.json');
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    expect(ledger['persisted-id']).toMatchObject({ channel: 'log' });
    expect(ledger['persisted-id'].shownAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Brand-new instance — announceOnce must return false.
    const manager2 = new AnnouncementManager(stateDir);
    expect(await manager2.announceOnce('persisted-id', 'message', 'log')).toBe(false);
    expect(manager2.hasBeenShown('persisted-id')).toBe(true);
  });

  it('records the announcement even if the sink throws (no duplicate emission)', async () => {
    const sinkCalls: string[] = [];
    const manager = new AnnouncementManager(stateDir, (id) => {
      sinkCalls.push(id);
      throw new Error('sink down');
    });

    // First call: sink throws but we still ledger and return true (the
    // emission was attempted; we cannot guarantee delivery to a broken
    // sink). Subsequent calls return false — we do NOT retry, because
    // the brittle / no-context sink layer does not have authority over
    // the ledger.
    const first = await manager.announceOnce('flaky-sink', 'message', 'log');
    expect(first).toBe(true);
    expect(sinkCalls).toEqual(['flaky-sink']);

    const second = await manager.announceOnce('flaky-sink', 'message', 'log');
    expect(second).toBe(false);
    expect(sinkCalls).toEqual(['flaky-sink']); // sink not re-invoked
  });

  it('rejects invalid channel/id/message inputs', async () => {
    const manager = new AnnouncementManager(stateDir);
    await expect(
      manager.announceOnce('', 'msg', 'log'),
    ).rejects.toThrow(/announcementId is required/);
    await expect(
      manager.announceOnce('id', 'msg', 'invalid' as AnnouncementChannel),
    ).rejects.toThrow(/invalid channel/);
  });
});
