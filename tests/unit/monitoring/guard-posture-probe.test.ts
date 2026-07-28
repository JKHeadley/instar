/**
 * Tier-1 — GuardPostureProbe (GUARD-POSTURE-ENDPOINT-SPEC §2.4, the
 * structural consumer).
 *
 * Pins: the ≥2-consecutive-ticks persistence rule, ONE aggregated emit per
 * episode (P17), no re-emit while an episode is open, cleared-then-recurring
 * = NEW episode (same healthKey, new id), dark-default quiet, flapping
 * detection, the offline-peer/deep-read boundary, and corrupt-state
 * re-baselining.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGuardPostureProbes,
  GUARD_POSTURE_HEALTH_KEY,
  STALE_POSTURE_AGE_MS,
  type GuardPostureAttentionItem,
  type GuardPostureProbeDeps,
  type PeerPostureRead,
} from '../../../src/monitoring/probes/GuardPostureProbe.js';
import { __verifyScope } from '../../../src/monitoring/probes/GuardPostureProbe.js';
import type {
  GuardInventoryResult,
  GuardRow,
} from '../../../src/monitoring/guardPostureView.js';
import type { HeartbeatGuardPosture } from '../../../src/monitoring/guardPostureView.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const NOW = 1_781_300_000_000;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-posture-probe-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'guard-posture-probe.test:cleanup',
  });
});

// ───────────────────────────── fixture helpers ─────────────────────────────

function row(
  key: string,
  effective: GuardRow['effective'],
  offClass: GuardRow['offClass'] = null,
): GuardRow {
  return {
    key,
    configEnabled: effective !== 'off',
    defaultEnabled: offClass === 'dark-default' ? false : true,
    effective,
    offClass,
    divergence: 'none',
    runtime: null,
    process: 'server',
  };
}

function invOf(rows: GuardRow[]): GuardInventoryResult {
  return {
    guards: rows,
    summary: {
      onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
      off: 0, offDeviant: 0, offDarkDefault: 0,
      divergedPendingRestart: 0, errored: 0, missing: 0, offRuntimeDivergent: 0,
      runtimeEnriched: `0/${rows.length}`,
    },
  };
}

function hb(partial: Partial<HeartbeatGuardPosture> = {}): HeartbeatGuardPosture {
  return {
    onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
    offDeviant: 0, offDeviantKeys: [],
    offRuntimeDivergent: 0, offRuntimeDivergentKeys: [],
    divergedPendingRestart: 0, errored: 0, missing: 0,
    generatedAt: new Date(NOW).toISOString(),
    ...partial,
  };
}

function makeProbe(opts: {
  local?: () => GuardInventoryResult | null;
  peers?: () => PeerPostureRead[];
  deepReadPeer?: GuardPostureProbeDeps['deepReadPeer'];
  emitAttention?: GuardPostureProbeDeps['emitAttention'];
}) {
  const emitted: GuardPostureAttentionItem[] = [];
  const probes = createGuardPostureProbes({
    getLocalPosture: opts.local ?? (() => null),
    getPeerPostures: opts.peers ?? (() => []),
    deepReadPeer: opts.deepReadPeer,
    emitAttention:
      opts.emitAttention ??
      (async (item) => {
        emitted.push(item);
      }),
    stateDir: dir,
    now: () => NOW,
  });
  expect(probes).toHaveLength(1);
  return { probe: probes[0], emitted };
}

const DEVIANT_INV = invOf([
  row('monitoring.sessionReaper.enabled', 'off', 'diverged-from-default'),
  row('scheduler.enabled', 'on-confirmed'),
]);
const CLEAN_INV = invOf([
  row('monitoring.sessionReaper.enabled', 'on-confirmed'),
  row('scheduler.enabled', 'on-confirmed'),
]);

// ─────────────────────────────────── tests ─────────────────────────────────

describe('GuardPostureProbe — probe family conventions', () => {
  it('exports a verify-scope and a single well-formed probe', async () => {
    expect(__verifyScope).toEqual(['guard-posture']);
    const { probe } = makeProbe({ local: () => CLEAN_INV });
    expect(probe.id).toBe('instar.guard-posture.anomalies');
    expect(probe.prerequisites()).toBe(true);
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('No guard-posture anomalies');
  });
});

describe('GuardPostureProbe — persistence rule (≥2 consecutive ticks)', () => {
  it('does not alert or emit on a single sighting', async () => {
    const { probe, emitted } = makeProbe({ local: () => DEVIANT_INV });
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(result.description).toContain('awaiting persistence');
    expect(emitted).toHaveLength(0);
  });

  it('alerts and emits exactly once after the second consecutive sighting', async () => {
    const { probe, emitted } = makeProbe({ local: () => DEVIANT_INV });
    await probe.run();
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.description).toContain('monitoring.sessionReaper.enabled');
    expect(result.description).toContain('diverged-from-default');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].healthKey).toBe(GUARD_POSTURE_HEALTH_KEY);
    expect(emitted[0].id).toBe('guard-posture:ep-1');
    expect(emitted[0].summary).toContain('monitoring.sessionReaper.enabled');
  });

  it('a non-consecutive recurrence restarts persistence counting', async () => {
    let tickInv = DEVIANT_INV;
    const { probe, emitted } = makeProbe({ local: () => tickInv });
    await probe.run(); // seen once
    tickInv = CLEAN_INV;
    await probe.run(); // cleared
    tickInv = DEVIANT_INV;
    const result = await probe.run(); // first-seen again — no alert
    expect(result.passed).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});

describe('GuardPostureProbe — episode semantics (P17/P19)', () => {
  it('aggregates anomalies across machines into ONE item', async () => {
    const { probe, emitted } = makeProbe({
      local: () => DEVIANT_INV,
      peers: () => [
        {
          machineId: 'm_mini',
          nickname: 'Mac Mini',
          online: true,
          posture: hb({
            offRuntimeDivergent: 1,
            offRuntimeDivergentKeys: ['monitoring.watchdog.enabled'],
          }),
          postureAgeMs: 30_000,
        },
      ],
    });
    await probe.run();
    await probe.run();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].summary).toContain('[local] monitoring.sessionReaper.enabled');
    expect(emitted[0].summary).toContain('[Mac Mini] monitoring.watchdog.enabled');
    expect(emitted[0].title).toContain('2');
  });

  it('does not re-emit while the episode is open', async () => {
    const { probe, emitted } = makeProbe({ local: () => DEVIANT_INV });
    for (let i = 0; i < 5; i++) await probe.run();
    expect(emitted).toHaveLength(1);
  });

  it('cleared-then-recurring is a NEW episode: new id suffix, same healthKey', async () => {
    let tickInv = DEVIANT_INV;
    const { probe, emitted } = makeProbe({ local: () => tickInv });
    await probe.run();
    await probe.run(); // ep-1 emitted
    tickInv = CLEAN_INV;
    const cleared = await probe.run(); // ALL anomalies clear → episode ends
    expect(cleared.passed).toBe(true);
    tickInv = DEVIANT_INV;
    await probe.run();
    await probe.run(); // persists again → ep-2
    expect(emitted).toHaveLength(2);
    expect(emitted[0].id).toBe('guard-posture:ep-1');
    expect(emitted[1].id).toBe('guard-posture:ep-2');
    expect(emitted[0].healthKey).toBe(GUARD_POSTURE_HEALTH_KEY);
    expect(emitted[1].healthKey).toBe(GUARD_POSTURE_HEALTH_KEY);
  });

  it('retries the emit on the next tick when emitAttention throws', async () => {
    const emitted: GuardPostureAttentionItem[] = [];
    let fail = true;
    const { probe } = makeProbe({
      local: () => DEVIANT_INV,
      emitAttention: async (item) => {
        if (fail) throw new Error('telegram down');
        emitted.push(item);
      },
    });
    await probe.run();
    await probe.run(); // emit attempt fails — episode open, not emitted
    fail = false;
    await probe.run(); // retry succeeds, SAME episode id
    await probe.run(); // no further emits
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe('guard-posture:ep-1');
  });
});

describe('GuardPostureProbe — quiet classes', () => {
  it('dark-default offs are never anomalies', async () => {
    const darkInv = invOf([
      row('monitoring.failureLearning.enabled', 'off', 'dark-default'),
      row('monitoring.correctionLearning.enabled', 'off', 'dark-default'),
      row('scheduler.enabled', 'on-confirmed'),
    ]);
    const { probe, emitted } = makeProbe({ local: () => darkInv });
    for (let i = 0; i < 3; i++) {
      const result = await probe.run();
      expect(result.passed).toBe(true);
      expect(result.description).toContain('No guard-posture anomalies');
    }
    expect(emitted).toHaveLength(0);
  });

  it('on-unverified and on-confirmed are never anomalies', async () => {
    const inv = invOf([
      row('monitoring.watchdog.enabled', 'on-unverified'),
      row('scheduler.enabled', 'on-confirmed'),
    ]);
    const { probe, emitted } = makeProbe({ local: () => inv });
    await probe.run();
    const result = await probe.run();
    expect(result.passed).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});

describe('GuardPostureProbe — flapping (sub-cadence toggling)', () => {
  it('raises flapping for a guard flipping between QUIET postures (>K flips)', async () => {
    // Alternates between on-confirmed and dark-default off — each individual
    // sighting is quiet (no anomaly class), but the posture is toggling under
    // the probe's cadence. Flips land at ticks 2,3,4,5 → >K=3 at tick 5.
    let tick = 0;
    const { probe, emitted } = makeProbe({
      local: () => {
        tick += 1;
        return invOf([
          tick % 2 === 1
            ? row('monitoring.burnDetection.enabled', 'on-confirmed')
            : row('monitoring.burnDetection.enabled', 'off', 'dark-default'),
        ]);
      },
    });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await probe.run());
    // Ticks 1–4: no flapping yet (≤K flips), each sighting individually quiet.
    for (let i = 0; i < 4; i++) expect(results[i].passed).toBe(true);
    // Tick 5: 4 flips within the window → flapping, alertable on sight.
    expect(results[4].passed).toBe(false);
    expect(results[4].description).toContain('flapping');
    expect(results[4].description).toContain('monitoring.burnDetection.enabled');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].summary).toContain('flapping');
  });
});

describe('GuardPostureProbe — peer data-source rule', () => {
  it('evaluates an OFFLINE peer from durable last-known posture without calling deepReadPeer', async () => {
    const deepRead = vi.fn(async () => hb());
    const { probe, emitted } = makeProbe({
      peers: () => [
        {
          machineId: 'm_mini',
          nickname: 'Mac Mini',
          online: false, // dark peer — a doomed fan-out must never fire
          posture: hb({ offDeviant: 1, offDeviantKeys: ['monitoring.sessionReaper.enabled'] }),
          postureAgeMs: 2 * 24 * 60 * 60_000, // stale ("as of 2d ago") — still evaluated
        },
      ],
      deepReadPeer: deepRead,
    });
    await probe.run();
    const result = await probe.run();
    expect(deepRead).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].summary).toContain('[Mac Mini] monitoring.sessionReaper.enabled');
  });

  it('calls deepReadPeer for an ONLINE peer with a stale heartbeat block and prefers its result', async () => {
    const deepRead = vi.fn(async (_machineId: string) => hb()); // live deep read: clean
    const { probe, emitted } = makeProbe({
      peers: () => [
        {
          machineId: 'm_mini',
          online: true,
          posture: hb({ offDeviant: 1, offDeviantKeys: ['monitoring.sessionReaper.enabled'] }),
          postureAgeMs: STALE_POSTURE_AGE_MS + 1, // stale → deep read fires
        },
      ],
      deepReadPeer: deepRead,
    });
    await probe.run();
    const result = await probe.run();
    expect(deepRead).toHaveBeenCalledWith('m_mini');
    expect(result.passed).toBe(true); // the fresh deep read wins over the stale block
    expect(emitted).toHaveLength(0);
  });

  it('does NOT deep-read an online peer whose heartbeat block is fresh', async () => {
    const deepRead = vi.fn(async () => hb());
    const { probe } = makeProbe({
      peers: () => [
        { machineId: 'm_mini', online: true, posture: hb(), postureAgeMs: 5_000 },
      ],
      deepReadPeer: deepRead,
    });
    await probe.run();
    expect(deepRead).not.toHaveBeenCalled();
  });

  it('renders count-only detail for heartbeat-sourced non-key classes', async () => {
    const { probe, emitted } = makeProbe({
      peers: () => [
        {
          machineId: 'm_mini',
          nickname: 'Mac Mini',
          online: false,
          posture: hb({ onStale: 2, errored: 1 }),
          postureAgeMs: 60_000,
        },
      ],
    });
    await probe.run();
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].summary).toContain('[Mac Mini] 2 guard(s) on-stale (count-only via heartbeat)');
    expect(emitted[0].summary).toContain('[Mac Mini] 1 guard(s) errored (count-only via heartbeat)');
  });
});

describe('GuardPostureProbe — durable episode state', () => {
  const stateFile = () => path.join(dir, 'state', 'guard-posture-episodes.json');

  it('persists episode state across probe instances (restart survival)', async () => {
    const first = makeProbe({ local: () => DEVIANT_INV });
    await first.probe.run(); // tick 1 — seen once
    // New instance over the same stateDir (server restart).
    const second = makeProbe({ local: () => DEVIANT_INV });
    const result = await second.probe.run(); // tick 2 — consecutive → alert
    expect(result.passed).toBe(false);
    expect(second.emitted).toHaveLength(1);
    expect(fs.existsSync(stateFile())).toBe(true);
  });

  it('re-baselines on a corrupt state file without crashing', async () => {
    const { probe, emitted } = makeProbe({ local: () => DEVIANT_INV });
    await probe.run();
    await probe.run();
    expect(emitted).toHaveLength(1);
    fs.writeFileSync(stateFile(), '{not json!!', 'utf-8');
    const result = await probe.run(); // fresh baseline — anomaly is first-seen
    expect(result.passed).toBe(true);
    expect(result.description).toContain('awaiting persistence');
    expect(emitted).toHaveLength(1); // no duplicate emit off corrupt state
    // And the file is healthy again afterwards.
    const reread = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
    expect(reread.version).toBe(1);
    expect(reread.tick).toBe(1);
  });

  it('handles a dependency throwing by returning a failed result, not crashing', async () => {
    const { probe, emitted } = makeProbe({
      local: () => {
        throw new Error('config unreadable');
      },
    });
    const result = await probe.run();
    expect(result.passed).toBe(false);
    expect(result.error).toContain('config unreadable');
    expect(emitted).toHaveLength(0);
  });
});
