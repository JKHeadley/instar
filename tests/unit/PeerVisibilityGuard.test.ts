// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for PeerVisibilityGuard (P2.2 rider) —
 * WORKING-SET-HANDOFF-SPEC §3.6.
 *
 * Covers: detectImproperRevocations purity (improper flagged with named
 * missing fields; proper revocation NOT flagged; un-revoked entries ignored);
 * cross-boot dedupe keyed on revokedAt (a NEW instance over the same stateDir
 * does not re-surface — the crash-loop case); disappearance notice fires once
 * per episode after grace, names stranded topics, clears SILENTLY on
 * re-peer; flap bound (>3 episodes/24h collapses to one flapping notice and
 * stops re-notifying).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectImproperRevocations,
  PeerVisibilityGuard,
  type GuardNotice,
} from '../../src/core/PeerVisibilityGuard.js';
import type { MachineRegistry } from '../../src/core/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-vis-guard-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function registry(machines: Record<string, Partial<MachineRegistry['machines'][string]>>): MachineRegistry {
  return {
    version: 1,
    machines: Object.fromEntries(
      Object.entries(machines).map(([id, m]) => [
        id,
        {
          name: id,
          status: 'active',
          role: 'standby',
          pairedAt: '2026-06-01T00:00:00Z',
          lastSeen: '2026-06-06T00:00:00Z',
          ...m,
        },
      ]),
    ) as MachineRegistry['machines'],
  } as MachineRegistry;
}

describe('detectImproperRevocations (pure, §3.6.1)', () => {
  it('flags revokedAt without revokedBy/revokeReason, naming the missing fields', () => {
    const found = detectImproperRevocations(
      registry({
        m_mini: { revokedAt: '2026-06-06T01:00:00Z', nickname: 'the mini' },
        m_ok: { revokedAt: '2026-06-06T02:00:00Z', revokedBy: 'm_laptop', revokeReason: 'decommissioned' },
        m_live: {},
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      machineId: 'm_mini',
      nickname: 'the mini',
      missing: ['revokedBy', 'revokeReason'],
    });
  });

  it('flags a partially-attributed revocation with only the absent field', () => {
    const found = detectImproperRevocations(
      registry({ m_x: { revokedAt: '2026-06-06T01:00:00Z', revokedBy: 'm_y' } }),
    );
    expect(found[0].missing).toEqual(['revokeReason']);
  });
});

describe('PeerVisibilityGuard — cross-boot dedupe (§3.6.1)', () => {
  it('surfaces an improper revocation ONCE across instances (crash-loop cannot re-spam)', () => {
    const reg = registry({ m_mini: { revokedAt: '2026-06-06T01:00:00Z' } });
    const notices: GuardNotice[] = [];
    const make = () =>
      new PeerVisibilityGuard({
        stateDir: tmpDir,
        selfMachineId: 'm_self',
        notify: (n) => notices.push(n),
      });
    make().checkRevocations(reg);
    make().checkRevocations(reg); // "reboot"
    make().checkRevocations(reg); // "reboot" again
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('improper-revocation');
    // A NEW improper revocation (different revokedAt) still surfaces.
    make().checkRevocations(registry({ m_mini: { revokedAt: '2026-06-06T09:00:00Z' } }));
    expect(notices).toHaveLength(2);
  });
});

describe('PeerVisibilityGuard — disappearance + flap bound (§3.6.2)', () => {
  it('notices a missing peer once per episode after grace, naming stranded topics; clears silently on re-peer', async () => {
    let nowMs = Date.parse('2026-06-06T00:00:00Z');
    const notices: GuardNotice[] = [];
    const guard = new PeerVisibilityGuard({
      stateDir: tmpDir,
      selfMachineId: 'm_self',
      notify: (n) => notices.push(n),
      strandedTopicsFor: async () => [13481],
      graceMs: 30 * 60 * 1000,
      now: () => new Date(nowMs),
    });
    const expected = ['m_mini'];
    await guard.checkDisappearances(expected, new Set()); // missing, inside grace
    expect(notices).toHaveLength(0);
    nowMs += 31 * 60 * 1000;
    await guard.checkDisappearances(expected, new Set()); // past grace → notice
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('peer-missing');
    expect(notices[0].body).toContain('13481'); // stranded topics named
    await guard.checkDisappearances(expected, new Set()); // same episode → no repeat
    expect(notices).toHaveLength(1);
    await guard.checkDisappearances(expected, new Set(['m_mini'])); // re-peer → SILENT clear
    expect(notices).toHaveLength(1);
  });

  it('collapses to ONE flapping notice past 3 episodes in 24h', async () => {
    let nowMs = Date.parse('2026-06-06T00:00:00Z');
    const notices: GuardNotice[] = [];
    const guard = new PeerVisibilityGuard({
      stateDir: tmpDir,
      selfMachineId: 'm_self',
      notify: (n) => notices.push(n),
      graceMs: 1000,
      now: () => new Date(nowMs),
    });
    const expected = ['m_flappy'];
    for (let i = 0; i < 5; i++) {
      await guard.checkDisappearances(expected, new Set()); // goes missing
      nowMs += 2000; // past grace
      await guard.checkDisappearances(expected, new Set()); // episode notice
      await guard.checkDisappearances(expected, new Set(['m_flappy'])); // re-peers
      nowMs += 60_000;
    }
    const missing = notices.filter((n) => n.kind === 'peer-missing');
    const flapping = notices.filter((n) => n.kind === 'peer-flapping');
    expect(missing).toHaveLength(3); // the first 3 episodes
    expect(flapping).toHaveLength(1); // then ONE collapse, never more
  });
});
