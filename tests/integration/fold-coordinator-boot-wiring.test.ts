// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.

/**
 * context-budget-layered-summaries §9.3 — the fold coordinator wired the way
 * server.ts wires it (buildFoldCoordinator): the REAL keyed fold lock (local
 * fold key, no machine identity), the REAL fold record store, and the REAL
 * carriers (clear-seed pointer, keep-instructions, PendingInjectStore record
 * tagged with the fold). A "crash" is simulated by dropping the coordinator
 * and building a fresh one on the same state directory, which is exactly what
 * a server restart does.
 *
 *  - crash at or before `staged` ⇒ the boot sweep aborts the record, releases
 *    every carrier, and the lock is free again (a new fold can begin);
 *  - crash past the point of no return ⇒ quarantined; containment carriers
 *    stay in force for the sentinel's rollback;
 *  - a carrier whose foldId has no record ⇒ released loudly (orphan);
 *  - the generic PendingInjectStore sweep never redelivers a fold's inject.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFoldCoordinator, type FoldBootDeps } from '../../src/monitoring/foldCoordinatorBoot.js';
import { writeClearSeedPointer, listClearSeedPointers, contextLayersRoot } from '../../src/monitoring/clearSeedPointer.js';
import { writeKeepInstructions, readKeepInstructionsPointer } from '../../src/monitoring/keepInstructions.js';
import { foldKeepSource } from '../../src/monitoring/foldCarriers.js';
import { PendingInjectStore, sweepPendingInjects } from '../../src/core/PendingInjectStore.js';
import { LOCAL_FOLD_HOLDER } from '../../src/core/foldLeaseFactory.js';
import type { FoldRecord } from '../../src/monitoring/FoldCoordinator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/fold-coordinator-boot-wiring.test.ts';
const TOPIC = '141133';
const IID = 'inst_abc123';

describe('FoldCoordinator boot wiring × real lock × real carriers', () => {
  let stateDir: string;
  let sessions: Array<{ topicKey: string }>;

  const deps = (over: Partial<FoldBootDeps> = {}): FoldBootDeps => ({
    stateDir,
    runningTopicSessions: () => sessions,
    poolPlacementLive: () => false,
    inboundQueueLive: () => true,
    topicRowsPresent: () => true,
    sentinelHeartbeatFresh: () => true,
    layerKindPresent: () => true,
    ...over,
  });

  const stageCarriers = (foldId: string) => {
    const packetDir = path.join(contextLayersRoot(stateDir), TOPIC);
    fs.mkdirSync(packetDir, { recursive: true, mode: 0o700 });
    const packetFile = path.join(packetDir, `${foldId}.packet.md`);
    fs.writeFileSync(packetFile, 'packet');
    expect(writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: 'c-1', foldId, packetFile, leaseExpiresAt: Date.now() + 60_000, topicKey: TOPIC })).not.toBeNull();
    expect(writeKeepInstructions(stateDir, { instarSessionId: IID, text: 'keep the topic purpose', source: foldKeepSource(TOPIC, foldId) }).written).toBe(true);
    new PendingInjectStore(path.join(stateDir, 'state')).record({ tmuxSession: 'echo-141133', initialMessage: 'probe turn', fold: { foldId, topicKey: TOPIC } } as never);
  };
  const carriersPresent = () => ({
    clearSeed: listClearSeedPointers(stateDir).length,
    keep: readKeepInstructionsPointer(stateDir, IID) !== null,
    inject: new PendingInjectStore(path.join(stateDir, 'state')).list().records.filter((r) => r.fold).length,
  });
  const step = (c: ReturnType<typeof buildFoldCoordinator>['coordinator'], rec: FoldRecord, to: FoldRecord['state']) => {
    const r = c.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r.record;
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-boot-int-'));
    sessions = [{ topicKey: TOPIC }];
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('signs with the local fold key on a machine with no identity, files 0600', () => {
    const { coordinator, holderId } = buildFoldCoordinator(deps());
    expect(holderId).toBe(LOCAL_FOLD_HOLDER);
    const r = coordinator.begin(TOPIC);
    expect(r.ok).toBe(true);
    const key = path.join(stateDir, 'state', 'fold-leases', '.local-key.pem');
    expect(fs.statSync(key).mode & 0o777).toBe(0o600);
  });

  it('Phase 0 posture: with no sentinel heartbeat and no layer kind, no fold begins', () => {
    const { coordinator } = buildFoldCoordinator(deps({ sentinelHeartbeatFresh: undefined, layerKindPresent: undefined }));
    expect(coordinator.begin(TOPIC)).toEqual({ ok: false, reason: 'no-sentinel' });
  });

  it('a live pool placement makes the owner unknown: never acts', () => {
    const { coordinator } = buildFoldCoordinator(deps({ poolPlacementLive: () => true }));
    expect(coordinator.begin(TOPIC)).toEqual({ ok: false, reason: 'owner-unknown' });
  });

  it('crash at staged ⇒ boot sweep aborts, releases every carrier and the lock', () => {
    const a = buildFoldCoordinator(deps()).coordinator;
    const b0 = a.begin(TOPIC);
    if (!b0.ok) throw new Error(b0.reason);
    stageCarriers(b0.record.foldId);
    step(a, step(a, b0.record, 'snapshotted'), 'staged');
    expect(carriersPresent()).toEqual({ clearSeed: 1, keep: true, inject: 1 });

    // restart: a fresh coordinator on the same state directory
    const b = buildFoldCoordinator(deps()).coordinator;
    expect(b.begin(TOPIC)).toEqual({ ok: false, reason: 'fold-in-progress' });
    const swept = b.recoverPendingFolds();
    expect(swept.aborted.map((r) => r.foldId)).toEqual([b0.record.foldId]);
    expect(swept.quarantined).toEqual([]);
    expect(carriersPresent()).toEqual({ clearSeed: 0, keep: false, inject: 0 });
    expect(fs.existsSync(path.join(contextLayersRoot(stateDir), TOPIC, `${b0.record.foldId}.packet.md`))).toBe(false); // §9.3 "delete the packet"
    expect(b.begin(TOPIC).ok).toBe(true); // lock released by the terminal transition
  });

  it('crash past the point of no return ⇒ quarantined, containment kept', () => {
    const a = buildFoldCoordinator(deps()).coordinator;
    const b0 = a.begin(TOPIC);
    if (!b0.ok) throw new Error(b0.reason);
    stageCarriers(b0.record.foldId);
    step(a, step(a, step(a, b0.record, 'snapshotted'), 'staged'), 'replacing');

    const b = buildFoldCoordinator(deps()).coordinator;
    const swept = b.recoverPendingFolds();
    expect(swept.quarantined.map((r) => [r.foldId, r.state, r.role])).toEqual([[b0.record.foldId, 'quarantined', 'sentinel']]);
    expect(carriersPresent()).toEqual({ clearSeed: 1, keep: true, inject: 1 });
    expect(fs.existsSync(path.join(contextLayersRoot(stateDir), TOPIC, `${b0.record.foldId}.packet.md`))).toBe(true);
    expect(b.begin(TOPIC)).toEqual({ ok: false, reason: 'fold-in-progress' });
    // a second boot is idempotent: still one quarantined record, nothing new
    const again = buildFoldCoordinator(deps()).coordinator.recoverPendingFolds();
    expect(again.quarantined.map((r) => r.foldId)).toEqual([b0.record.foldId]);
    expect(again.orphans).toEqual([]);
  });

  it('the session died with the crash: the host still resolves its own fold at boot', () => {
    const a = buildFoldCoordinator(deps()).coordinator;
    const b0 = a.begin(TOPIC);
    if (!b0.ok) throw new Error(b0.reason);
    sessions = []; // no live session after the restart
    const swept = buildFoldCoordinator(deps()).coordinator.recoverPendingFolds();
    expect(swept.aborted.map((r) => r.foldId)).toEqual([b0.record.foldId]);
  });

  it('carriers with no fold record are released loudly as orphans', () => {
    stageCarriers('fghost1');
    const events: string[] = [];
    const { coordinator } = buildFoldCoordinator(deps({ onEvent: (e) => events.push(e.type) }));
    const swept = coordinator.recoverPendingFolds();
    expect(swept.orphans.map((o) => o.kind).sort()).toEqual(['clear-seed-pointer', 'keep-instructions', 'pending-inject']);
    expect(events.filter((t) => t === 'orphan-carrier')).toHaveLength(3);
    expect(carriersPresent()).toEqual({ clearSeed: 0, keep: false, inject: 0 });
  });

  it('a standing (non-fold) keep-instructions file is never treated as a fold carrier', () => {
    expect(writeKeepInstructions(stateDir, { instarSessionId: IID, text: 'standing packet', source: 'standing' }).written).toBe(true);
    const swept = buildFoldCoordinator(deps()).coordinator.recoverPendingFolds();
    expect(swept.orphans).toEqual([]);
    expect(readKeepInstructionsPointer(stateDir, IID)).not.toBeNull();
  });

  it('an orphan pointer naming a non-packet file outside its topic or inside fold-records never deletes it', () => {
    const layers = contextLayersRoot(stateDir);
    const other = path.join(layers, '999', 'summary.md');
    fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, 'keep');
    const rec = path.join(layers, TOPIC, 'fold-records', 'fx.json');
    fs.mkdirSync(path.dirname(rec), { recursive: true }); fs.writeFileSync(rec, '{}');
    const dir = path.join(layers, '_clear-seed');
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, target] of [['a', other], ['b', rec]] as const) {
      fs.writeFileSync(path.join(dir, `inst_${i}.json`), JSON.stringify({ instarSessionId: `inst_${i}`, claudeSessionId: 'c', foldId: `fghost${i}`, packetPath: path.relative(layers, target), sha256: 'x', leaseExpiresAt: Date.now() + 1000, writtenAt: Date.now(), topicKey: TOPIC }));
    }
    const swept = buildFoldCoordinator(deps()).coordinator.recoverPendingFolds();
    expect(swept.orphans.filter((o) => o.kind === 'clear-seed-pointer')).toHaveLength(2);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(rec)).toBe(true);
  });

  it("slice 6's staged compaction fallback (no fold tag) survives the fold sweep", () => {
    const store = new PendingInjectStore(path.join(stateDir, 'state'));
    store.record({ tmuxSession: 'echo-141133#compaction-fallback', initialMessage: 'briefing', doNotReplay: true,
      compactionFallback: { tmuxSession: 'echo-141133', epoch: 'e1', trigger: 'auto' } } as never);
    const swept = buildFoldCoordinator(deps()).coordinator.recoverPendingFolds();
    expect(swept.orphans).toEqual([]);
    expect(store.list().records.filter((r) => r.compactionFallback)).toHaveLength(1);
  });

  it('a torn fold record is not acted on and its carriers are KEPT (never released on an unknown; the sentinel raises it)', () => {
    stageCarriers('ftorn1');
    const dir = path.join(contextLayersRoot(stateDir), TOPIC, 'fold-records');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ftorn1.json'), '{"state":"repl');
    const swept = buildFoldCoordinator(deps()).coordinator.recoverPendingFolds();
    expect(swept.aborted).toEqual([]);
    expect(swept.quarantined).toEqual([]);
    expect(swept.orphans).toEqual([]);
    expect(swept.torn).toEqual([{ topicKey: TOPIC, foldId: 'ftorn1' }]);
    expect(carriersPresent()).toEqual({ clearSeed: 1, keep: true, inject: 1 });
  });

  it('when the quarantine handover fails (lock file gone), the record is still marked quarantined and containment stays', () => {
    const a = buildFoldCoordinator(deps()).coordinator;
    const b0 = a.begin(TOPIC);
    if (!b0.ok) throw new Error(b0.reason);
    stageCarriers(b0.record.foldId);
    step(a, step(a, step(a, b0.record, 'snapshotted'), 'staged'), 'replacing');
    for (const f of fs.readdirSync(path.join(stateDir, 'state', 'fold-leases'))) {
      if (f.startsWith(TOPIC)) SafeFsExecutor.safeRmSync(path.join(stateDir, 'state', 'fold-leases', f), { force: true, operation: OP });
    }
    const swept = buildFoldCoordinator(deps()).coordinator.recoverPendingFolds();
    expect(swept.quarantined.map((r) => [r.state, r.role])).toEqual([['quarantined', 'coordinator']]);
    expect(swept.quarantined[0].reason).toMatch(/handover failed/);
    expect(carriersPresent()).toEqual({ clearSeed: 1, keep: true, inject: 1 });
  });

  it('the generic inject sweep never redelivers or expires a fold-tagged record', async () => {
    const store = new PendingInjectStore(path.join(stateDir, 'state'));
    store.record({ tmuxSession: 'echo-141133', initialMessage: 'probe turn', fold: { foldId: 'f1', topicKey: TOPIC }, createdAt: new Date(0).toISOString() } as never);
    const redelivered: string[] = [];
    const lost: string[] = [];
    const res = await sweepPendingInjects(store, {
      sessionAlive: () => true,
      redeliver: async (r) => { redelivered.push(r.tmuxSession); },
      reportLoss: (r) => { lost.push(r.tmuxSession); },
    });
    expect(redelivered).toEqual([]);
    expect(lost).toEqual([]);
    expect(res.expired).toEqual([]);
    expect(store.list().records.filter((r) => r.fold)).toHaveLength(1);
  });
});
