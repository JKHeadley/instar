// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * Tier-1/2 — G3 GuardPostureProbe: the SEPARATE EPISODE TRACK
 * (g3-dark-but-load-bearing-guards §2.3/§2.5), driven against the REAL
 * TelegramAdapter.createAttentionItem funnel (apiCall stubbed).
 *
 * The load-bearing-gap track (`guard-posture-loadbearing:ep-N`) is DESIGNED to
 * be long-lived; the regression proves an ACUTE load-shed on guard Y surfaces
 * even while a load-bearing-gap episode has been open — because the two tracks
 * run independent openEpisodeId/episodeEmitted lifecycles with distinct item-id
 * namespaces. The inert-lever guard proves the funnel dedups by ID, so a
 * healthKey split alone would leave masking intact.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGuardPostureProbes, type PeerPostureRead } from '../../../src/monitoring/probes/GuardPostureProbe.js';
import type { GuardInventoryResult, GuardRow } from '../../../src/monitoring/guardPostureView.js';
import type { GuardPostureSummary } from '../../../src/core/types.js';
import { TelegramAdapter } from '../../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const LB_KEY = 'multiMachine.sessionPool.inboundQueue.enabled';

function installApiStub(adapter: TelegramAdapter): void {
  let threadSeq = 1000;
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method: string) => {
      if (method === 'createForumTopic') return { message_thread_id: ++threadSeq };
      if (method === 'sendMessage') return { message_id: ++threadSeq };
      return { ok: true };
    });
}

function row(partial: Partial<GuardRow> & { key: string; effective: GuardRow['effective'] }): GuardRow {
  return {
    configEnabled: false, defaultEnabled: false, offClass: null,
    divergence: 'none', runtime: null, process: 'server',
    ...partial,
  };
}

function inventory(guards: GuardRow[]): GuardInventoryResult {
  return {
    guards,
    summary: {
      onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
      off: 0, offDeviant: 0, offDarkDefault: 0,
      divergedPendingRestart: 0, errored: 0, missing: 0, offRuntimeDivergent: 0,
      runtimeEnriched: `0/${guards.length}`,
      loadBearingGapKeys: [], loadBearingSoakingKeys: [], loadBearingAcceptedKeys: [],
    },
  };
}

const lbGapRow = row({
  key: LB_KEY, effective: 'off', offClass: 'dark-default',
  loadBearing: true, criticalPath: 'operator inbound message delivery', loadBearingGap: true,
});
const acuteRow = row({
  key: 'monitoring.watchdog.enabled', effective: 'off-runtime-divergent',
});

describe('GuardPostureProbe — G3 separate episode track (real createAttentionItem funnel)', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3-probe-'));
    adapter = new TelegramAdapter({ token: 't', chatId: '-100123', pollIntervalMs: 100 }, tmpDir);
    installApiStub(adapter);
  });
  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'g3-probe cleanup' });
  });

  function makeProbe(getLocal: () => GuardInventoryResult | null, peers: PeerPostureRead[] = [], opts?: { alertLoadBearingGaps?: boolean }) {
    return createGuardPostureProbes({
      getLocalPosture: getLocal,
      getPeerPostures: () => peers,
      emitAttention: async (item) => { await adapter.createAttentionItem(item); },
      stateDir: tmpDir,
      alertLoadBearingGaps: opts?.alertLoadBearingGaps,
    })[0];
  }

  it('load-bearing-gap runs a SEPARATE episode track (its own item-id namespace)', async () => {
    const probe = makeProbe(() => inventory([lbGapRow]));
    await probe.run(); // tick 1 — seen once
    await probe.run(); // tick 2 — persisted → emit
    const lb = adapter.getAttentionItem('guard-posture-loadbearing:ep-1');
    expect(lb).toBeDefined();
    expect(lb!.summary).toContain('operator inbound message delivery');
    // NOT under the acute namespace:
    expect(adapter.getAttentionItem('guard-posture:ep-1')).toBeUndefined();
  });

  it('an ACUTE off-runtime-divergent SURFACES while a load-bearing-gap episode is open (masking fix)', async () => {
    // Ticks 1-2: only the long-lived load-bearing gap → its episode opens+emits.
    const probe1 = makeProbe(() => inventory([lbGapRow]));
    await probe1.run();
    await probe1.run();
    expect(adapter.getAttentionItem('guard-posture-loadbearing:ep-1')).toBeDefined();

    // Ticks 3-4: the gap PERSISTS (its episode stays open) AND an acute anomaly
    // appears. The acute track opens independently → the acute item surfaces.
    const probe2 = makeProbe(() => inventory([lbGapRow, acuteRow]));
    await probe2.run(); // tick 3 — acute seen once
    await probe2.run(); // tick 4 — acute persisted → acute episode emits
    expect(adapter.getAttentionItem('guard-posture:ep-1')).toBeDefined();
    // The lb episode was NOT reopened (still ep-1, one item).
    expect(adapter.getAttentionItem('guard-posture-loadbearing:ep-2')).toBeUndefined();
  });

  it('masking PERSISTS if only the healthKey is split without splitting the episode id (inert-lever guard)', async () => {
    // The REAL funnel dedups by ITEM ID. A second emit with the SAME id but a
    // DIFFERENT healthKey is dropped — proving the healthKey is NOT the de-masking
    // lever; the separate item-id (episode track) is.
    await adapter.createAttentionItem({
      id: 'guard-posture:ep-1', title: 'first', summary: 'acute A',
      category: 'guard-posture', priority: 'HIGH', healthKey: 'key-A',
    });
    await adapter.createAttentionItem({
      id: 'guard-posture:ep-1', title: 'second', summary: 'acute B (masked)',
      category: 'guard-posture', priority: 'HIGH', healthKey: 'key-B',
    });
    const stored = adapter.getAttentionItem('guard-posture:ep-1')!;
    expect(stored.summary).toBe('acute A'); // the SECOND was masked despite a new healthKey
    // The fix would use a DIFFERENT id (a separate track) — which does surface:
    await adapter.createAttentionItem({
      id: 'guard-posture-loadbearing:ep-1', title: 'lb', summary: 'lb gap',
      category: 'guard-posture', priority: 'HIGH', healthKey: 'key-A',
    });
    expect(adapter.getAttentionItem('guard-posture-loadbearing:ep-1')).toBeDefined();
  });

  it('soaking pushes NO attention item (only /guards + log)', async () => {
    const soakingRow = row({
      key: LB_KEY, effective: 'on-dry-run',
      loadBearing: true, criticalPath: 'operator inbound message delivery', loadBearingSoaking: true,
    });
    const probe = makeProbe(() => inventory([soakingRow]));
    await probe.run();
    await probe.run();
    await probe.run();
    expect(adapter.getAttentionItems().filter((i) => i.category === 'guard-posture')).toEqual([]);
  });

  it('criticalPath label travels on an off-runtime-divergent load-bearing guard (loud class)', async () => {
    const lbOffRuntime = row({
      key: LB_KEY, effective: 'off-runtime-divergent',
      loadBearing: true, criticalPath: 'operator inbound message delivery',
    });
    const probe = makeProbe(() => inventory([lbOffRuntime]));
    await probe.run();
    await probe.run();
    const acute = adapter.getAttentionItem('guard-posture:ep-1')!;
    expect(acute).toBeDefined();
    expect(acute.summary).toContain('LOAD-BEARING critical path: operator inbound message delivery');
    // No double-alarm on the lb track for a loud class.
    expect(adapter.getAttentionItem('guard-posture-loadbearing:ep-1')).toBeUndefined();
  });

  it('alertLoadBearingGaps:false suppresses the lb ATTENTION alert (rollback lever)', async () => {
    const probe = makeProbe(() => inventory([lbGapRow]), [], { alertLoadBearingGaps: false });
    await probe.run();
    await probe.run();
    await probe.run();
    expect(adapter.getAttentionItem('guard-posture-loadbearing:ep-1')).toBeUndefined();
    expect(adapter.getAttentionItems().filter((i) => i.category === 'guard-posture')).toEqual([]);
  });

  it('evaluateHeartbeat reads a peer loadBearingGapKeys (Array.isArray-guarded) → surfaces in the pool view', async () => {
    const peerPosture: GuardPostureSummary = {
      onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
      offDeviant: 0, offDeviantKeys: [], offRuntimeDivergent: 0, offRuntimeDivergentKeys: [],
      divergedPendingRestart: 0, errored: 0, missing: 0,
      loadBearingGapKeys: [LB_KEY],
      generatedAt: new Date().toISOString(),
    };
    const peers: PeerPostureRead[] = [{ machineId: 'm-mini', nickname: 'the mini', online: true, posture: peerPosture, postureAgeMs: 1_000 }];
    const probe = makeProbe(() => inventory([]), peers);
    await probe.run();
    await probe.run();
    const lb = adapter.getAttentionItem('guard-posture-loadbearing:ep-1')!;
    expect(lb).toBeDefined();
    expect(lb.summary).toContain('the mini');
    expect(lb.summary).toContain(LB_KEY);
    // criticalPath looked up from the LOCAL fleet-uniform manifest:
    expect(lb.summary).toContain('LOAD-BEARING critical path');
  });

  it('a peer with NO loadBearingGapKeys field does not crash (Array.isArray guard) — no lb anomaly', async () => {
    const peerPosture = {
      onConfirmed: 1, onUnverified: 0, onStale: 0, onDryRun: 0,
      offDeviant: 0, offDeviantKeys: [], offRuntimeDivergent: 0, offRuntimeDivergentKeys: [],
      divergedPendingRestart: 0, errored: 0, missing: 0,
      generatedAt: new Date().toISOString(),
      // loadBearingGapKeys intentionally ABSENT (un-upgraded peer)
    } as GuardPostureSummary;
    const peers: PeerPostureRead[] = [{ machineId: 'm-old', online: true, posture: peerPosture, postureAgeMs: 1_000 }];
    const probe = makeProbe(() => inventory([]), peers);
    const r1 = await probe.run();
    const r2 = await probe.run();
    expect(r1.passed).toBe(true);
    expect(r2.passed).toBe(true);
    expect(adapter.getAttentionItems().filter((i) => i.category === 'guard-posture')).toEqual([]);
  });

  it('operator-accept on THIS machine does NOT silence a peer gap (per-machine independence)', async () => {
    // Local guard is ACCEPTED (loadBearingAccepted, no gap) — but the peer's
    // heartbeat still reports it as a gap → the peer gap surfaces.
    const localAccepted = row({
      key: LB_KEY, effective: 'off', offClass: 'dark-default',
      loadBearing: true, criticalPath: 'operator inbound message delivery',
      loadBearingAccepted: true, acceptedFallbackReason: 'owned locally',
    });
    const peerPosture: GuardPostureSummary = {
      onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
      offDeviant: 0, offDeviantKeys: [], offRuntimeDivergent: 0, offRuntimeDivergentKeys: [],
      divergedPendingRestart: 0, errored: 0, missing: 0,
      loadBearingGapKeys: [LB_KEY],
      generatedAt: new Date().toISOString(),
    };
    const peers: PeerPostureRead[] = [{ machineId: 'm-peer', nickname: 'peer', online: true, posture: peerPosture, postureAgeMs: 1_000 }];
    const probe = makeProbe(() => inventory([localAccepted]), peers);
    await probe.run();
    await probe.run();
    const lb = adapter.getAttentionItem('guard-posture-loadbearing:ep-1')!;
    expect(lb).toBeDefined();
    expect(lb.summary).toContain('peer'); // the PEER's gap, not the local accepted guard
  });
});
