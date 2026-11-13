// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the ContextBudgetSentinel across a REAL process crash
 * (context-budget-layered-summaries §7.8, §9.3):
 *  1. A child process (vite-node, production modules) begins a fold, takes it
 *     past the point of no return with real carriers, and dies.
 *  2. This process boots like the server: buildFoldCoordinator, the boot sweep
 *     (the fold is quarantined, containment kept), then the sentinel exactly
 *     as server.ts constructs it (heartbeat fresh after its first tick).
 *  3. With no evidence the candidate ended (the crash left no session), the
 *     sentinel keeps containment and tells the operator once.
 *  4. With a REAL tmux candidate, the production closures end it, the real
 *     three-state probe confirms it is gone, and the fold rolls back.
 *  5. WIRED: server.ts ships the sentinel dark, builds it after the boot sweep,
 *     feeds the coordinator's heartbeat precondition from it lazily, and ticks it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { ContextBudgetSentinel, QUARANTINE_RECONCILE_BOUND_MS, CONTEXT_BUDGET_SENTINEL_TICK_MS } from '../../src/monitoring/ContextBudgetSentinel.js';
import { productionSentinelSessionDeps, tmuxHasSession } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { listClearSeedPointers } from '../../src/monitoring/clearSeedPointer.js';
import { PendingInjectStore } from '../../src/core/PendingInjectStore.js';
import { initSelfActionGovernor, governor, consumeAdmissionToken } from '../../src/monitoring/selfaction/governor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-budget-sentinel-lifecycle.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = '141133';

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
import { buildFoldCoordinator } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/foldCoordinatorBoot.ts'))};
import { writeClearSeedPointer, contextLayersRoot } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/clearSeedPointer.ts'))};
import { PendingInjectStore } from ${JSON.stringify(path.join(ROOT, 'src/core/PendingInjectStore.ts'))};
const stateDir = process.argv[process.argv.length - 1];
const { coordinator } = buildFoldCoordinator({
  stateDir, runningTopicSessions: () => [{ topicKey: '${TOPIC}' }], poolPlacementLive: () => false,
  inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
});
const b = coordinator.begin('${TOPIC}');
if (!b.ok) { console.error('begin refused', b.reason); process.exit(3); }
let rec = b.record;
const dir = path.join(contextLayersRoot(stateDir), '${TOPIC}');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const packet = path.join(dir, rec.foldId + '.packet.md');
fs.writeFileSync(packet, 'packet');
writeClearSeedPointer(stateDir, { instarSessionId: 'inst_e2e', claudeSessionId: 'c', foldId: rec.foldId, packetFile: packet, leaseExpiresAt: Date.now() + 600000, topicKey: '${TOPIC}' });
new PendingInjectStore(path.join(stateDir, 'state')).record({ tmuxSession: 'echo-${TOPIC}', initialMessage: 'probe', fold: { foldId: rec.foldId, topicKey: '${TOPIC}' } });
for (const to of ['snapshotted', 'staged', 'replacing']) {
  const r = coordinator.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
  if (!r.ok) { console.error('refused', r.reason); process.exit(4); }
  rec = r.record;
}
console.log(JSON.stringify({ foldId: rec.foldId }));
process.exit(0); // die past the point of no return
`;

describe('ContextBudgetSentinel across a real crash', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('boot sweep quarantines; with no evidence the candidate ended, containment stays and the operator is told once', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sentinel-e2e-')); dirs.push(stateDir);
    const script = path.join(stateDir, 'child.ts'); fs.writeFileSync(script, CHILD);
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/vite-node'), [script, stateDir], { cwd: ROOT, encoding: 'utf-8', timeout: 90_000 });
    expect(r.status, r.stderr).toBe(0);
    const { foldId } = JSON.parse(r.stdout.trim().split('\n').pop() as string) as { foldId: string };

    // Boot like server.ts.
    const built = buildFoldCoordinator({
      stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true,
      topicRowsPresent: () => false, layerKindPresent: () => true,
    });
    const swept = built.coordinator.recoverPendingFolds();
    expect(swept.quarantined.map((x) => x.foldId)).toEqual([foldId]);
    expect(listClearSeedPointers(stateDir)).toHaveLength(1);

    initSelfActionGovernor({ stateDir, readEmergencyDisable: () => false, readClassesConfig: () => ({}), now: () => Date.now(), flushIntervalMs: 60_000 });
    const handle = governor.for('context-budget-quarantine-reconcile');
    let offset = 0; const notices: string[] = [];
    // The production session closures, over a session source with NO live session (the crash took it).
    const sessionDeps = productionSentinelSessionDeps({ sessions: { listRunningSessions: () => [], killSessionByTmuxName: () => false }, projectDir: stateDir });
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: (rec) => rec.machineId === built.holderId, ownsTopic: () => true, ...sessionDeps,
      attention: (n) => { notices.push(`${n.priority}:${n.id}`); },
      admit: (target, opts) => handle.admit(target, opts), consumeToken: consumeAdmissionToken,
      now: () => Date.now() + offset,
    });
    await sentinel.tick();
    expect(sentinel.heartbeatFresh()).toBe(true);
    offset += QUARANTINE_RECONCILE_BOUND_MS;
    for (let i = 0; i < 12; i++) { await sentinel.tick(); offset += CONTEXT_BUDGET_SENTINEL_TICK_MS; }
    // No evidence of termination: containment stays and the operator is told, once.
    expect(new FoldRecordStore(stateDir).get(TOPIC, foldId)).toMatchObject({ state: 'quarantined' });
    expect(listClearSeedPointers(stateDir)).toHaveLength(1);
    expect(new PendingInjectStore(path.join(stateDir, 'state')).list().records.filter((x) => x.fold)).toHaveLength(1);
    expect(notices.filter((n) => n.startsWith('URGENT:'))).toHaveLength(1);
  }, 120_000);

  it('a REAL tmux candidate: force-ended through the production closures, verified dead by the real probe, rolled back', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sentinel-tmux-')); dirs.push(stateDir);
    const name = `cbsent-${process.pid}-${Date.now() % 100000}`;
    expect(spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 600']).status).toBe(0);
    try {
      expect(tmuxHasSession(name)).toBe(true);
      const built = buildFoldCoordinator({
        stateDir, runningTopicSessions: () => [{ topicKey: TOPIC }], poolPlacementLive: () => false, inboundQueueLive: () => true,
        topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
      });
      const b = built.coordinator.begin(TOPIC); if (!b.ok) throw new Error(b.reason);
      let rec = b.record;
      for (const to of ['snapshotted', 'staged', 'replacing'] as const) { const r = built.coordinator.transition(TOPIC, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to); if (!r.ok) throw new Error(r.reason); rec = r.record; }
      const q = built.coordinator.quarantine(TOPIC, rec.foldId, 'step bound'); if (!q.ok) throw new Error(q.reason);
      const transcript = path.join(stateDir, 't.jsonl'); fs.writeFileSync(transcript, 'x\n');
      let killedReal = false;
      const source = {
        listRunningSessions: () => (killedReal ? [] : [{ id: 's1', name, tmuxSession: name, telegramTopicId: Number(TOPIC), framework: 'claude-code' as const, claudeSessionId: 'abc' } as never]),
        killSessionByTmuxName: (t: string) => { killedReal = spawnSync('tmux', ['kill-session', '-t', `=${t}`]).status === 0; return killedReal; },
      };
      const sessionDeps = productionSentinelSessionDeps({ sessions: source, projectDir: stateDir });
      initSelfActionGovernor({ stateDir, readEmergencyDisable: () => false, readClassesConfig: () => ({}), now: () => Date.now(), flushIntervalMs: 60_000 });
      const handle = governor.for('context-budget-quarantine-reconcile');
      let offset = 0;
      const sentinel = new ContextBudgetSentinel({
        stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
        ownsFold: () => true, ownsTopic: () => true,
        ...sessionDeps,
        // The transcript the Claude Code resolver would find is not on disk in this rig; use the test's file for that one path.
        candidates: (t) => sessionDeps.candidates(t).map((c) => ({ ...c, transcriptPath: transcript })),
        attention: () => {}, admit: (target, opts) => handle.admit(target, opts), consumeToken: consumeAdmissionToken,
        now: () => Date.now() + offset,
      });
      offset += QUARANTINE_RECONCILE_BOUND_MS; await sentinel.tick();
      expect(tmuxHasSession(name)).toBe(false); // really ended
      offset += CONTEXT_BUDGET_SENTINEL_TICK_MS; await sentinel.tick();
      expect(new FoldRecordStore(stateDir).get(TOPIC, rec.foldId)).toMatchObject({ state: 'rolled-back' });
    } finally { spawnSync('tmux', ['kill-session', '-t', `=${name}`]); }
  }, 120_000);

  it('WIRED: server.ts ships the sentinel dark, builds it after the boot sweep, feeds the heartbeat lazily, and ticks it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const sweep = src.indexOf('const swept = built.coordinator.recoverPendingFolds();');
    const gate = src.indexOf("liveConfig.get<boolean>('contextBudget.sentinel.enabled', false) === true");
    const ctor = src.indexOf('_contextBudgetSentinel = new ContextBudgetSentinel({');
    expect(sweep).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(sweep);
    expect(ctor).toBeGreaterThan(gate);
    expect(src).toContain('sentinelHeartbeatFresh: () => _contextBudgetSentinel?.heartbeatFresh() ?? false');
    expect(src.slice(ctor, ctor + 6000)).toMatch(/setInterval\(\(\) => \{ void sentinelRef\.tick\(\); \}, 5 \* 60_000\)/);
    expect(src).toContain("sentinelGovernor.for('context-budget-quarantine-reconcile')");
    expect(src.slice(gate, ctor)).toContain('productionSentinelSessionDeps({ sessions: sessionManager, projectDir: config.projectDir, tmuxPath: config.sessions.tmuxPath })');
  });
});
