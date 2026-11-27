// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — ContextBudgetSentinel quarantine reconciliation on the real
 * stack (context-budget-layered-summaries §9.3): the coordinator built the way
 * server.ts builds it (buildFoldCoordinator + the default carriers), a real
 * engine checkpoint, a real clear-seed pointer and fold-tagged inject, the
 * real self-action governor with the registered policy, and the sentinel's
 * real SQLite episode store. A fold quarantined past the point of no return is
 * force-ended past the bound, its termination verified, and rolled back
 * (`rollback-degraded`): containment carriers are released, the engine
 * checkpoint is KEPT for its grace period, and one notice goes out.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { ContextBudgetSentinel, QUARANTINE_RECONCILE_BOUND_MS, CONTEXT_BUDGET_SENTINEL_TICK_MS, type AttentionNotice } from '../../src/monitoring/ContextBudgetSentinel.js';
import { writeClearSeedPointer, listClearSeedPointers, contextLayersRoot } from '../../src/monitoring/clearSeedPointer.js';
import { PendingInjectStore } from '../../src/core/PendingInjectStore.js';
import { takeEngineCheckpoint, readEngineCheckpoint } from '../../src/monitoring/engineCheckpoint.js';
import { initSelfActionGovernor, governor, consumeAdmissionToken } from '../../src/monitoring/selfaction/governor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/context-budget-sentinel-quarantine.test.ts';
const T = '141133';
const SID = '11111111-2222-3333-4444-555555555555';

describe('ContextBudgetSentinel reconciles a quarantined fold on the real stack', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('force-end, verified termination, rollback-degraded: carriers released, checkpoint kept, one notice', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sentinel-int-')); dirs.push(stateDir);
    const { coordinator, holderId } = buildFoldCoordinator({
      stateDir, runningTopicSessions: () => [{ topicKey: T }], poolPlacementLive: () => false,
      inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
    });
    const b = coordinator.begin(T); if (!b.ok) throw new Error(b.reason);
    let rec = b.record;
    // Real carriers: the clear-seed pointer, a fold-tagged inject, and the engine checkpoint.
    const dir = path.join(contextLayersRoot(stateDir), T); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const packet = path.join(dir, `${rec.foldId}.packet.md`); fs.writeFileSync(packet, 'packet');
    writeClearSeedPointer(stateDir, { instarSessionId: 'inst_int', claudeSessionId: 'c', foldId: rec.foldId, packetFile: packet, leaseExpiresAt: Date.now() + 600_000, topicKey: T });
    new PendingInjectStore(path.join(stateDir, 'state')).record({ tmuxSession: `echo-${T}`, initialMessage: 'probe', fold: { foldId: rec.foldId, topicKey: T } });
    const transcript = path.join(stateDir, 'engine', `${SID}.jsonl`); fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID })}\n`);
    expect(takeEngineCheckpoint(stateDir, { topicKey: T, foldId: rec.foldId, sessionId: SID, transcriptPath: transcript }).ok).toBe(true);
    for (const to of ['snapshotted', 'staged', 'replacing'] as const) {
      const r = coordinator.transition(T, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to); if (!r.ok) throw new Error(r.reason); rec = r.record;
    }
    const q = coordinator.quarantine(T, rec.foldId, 'step bound passed'); if (!q.ok) throw new Error(q.reason);

    initSelfActionGovernor({ stateDir, readEmergencyDisable: () => false, readClassesConfig: () => ({}), now: () => Date.now(), flushIntervalMs: 60_000 });
    const handle = governor.for('context-budget-quarantine-reconcile');
    let offset = 0; const alive = new Set([`echo-${T}`]); const notices: AttentionNotice[] = [];
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: holderId, coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: (r) => r.machineId === holderId, ownsTopic: () => true,
      candidates: () => (alive.has(`echo-${T}`) ? [{ tmuxSession: `echo-${T}`, transcriptPath: transcript }] : []),
      tmuxAlive: (t) => alive.has(t), kill: (t) => { alive.delete(t); },
      fileBytes: (p) => { try { return fs.statSync(p).size; } catch { return null; } },
      attention: (n) => { notices.push(n); },
      admit: (target, opts) => handle.admit(target, opts), consumeToken: consumeAdmissionToken,
      now: () => Date.now() + offset,
    });
    const tick = async (ms: number) => { offset += ms; await sentinel.tick(); };

    await tick(0);
    expect(sentinel.heartbeatFresh()).toBe(true);
    expect(new FoldRecordStore(stateDir).get(T, rec.foldId)?.state).toBe('quarantined'); // within the bound, no runner: waits
    await tick(QUARANTINE_RECONCILE_BOUND_MS); // force-end
    expect(alive.size).toBe(0);
    expect(listClearSeedPointers(stateDir)).toHaveLength(1); // containment still in force
    await tick(CONTEXT_BUDGET_SENTINEL_TICK_MS); // verify + rollback-degraded

    const after = new FoldRecordStore(stateDir).get(T, rec.foldId)!;
    expect(after.state).toBe('rolled-back');
    expect(after.reason).toMatch(/^rollback-degraded/);
    expect(listClearSeedPointers(stateDir)).toHaveLength(0);
    expect(new PendingInjectStore(path.join(stateDir, 'state')).list().records.filter((r) => r.fold)).toHaveLength(0);
    expect(readEngineCheckpoint(stateDir, T, rec.foldId)?.settledAt).toBeTypeOf('number'); // kept for the grace period
    expect(notices.filter((n) => n.id === `context-budget-rollback-degraded-${T}-${rec.foldId}`)).toHaveLength(1);
    expect(fs.existsSync(path.join(stateDir, 'state', 'context-budget', 'self-heal-episodes.db'))).toBe(true); // its OWN store file
  });
});
