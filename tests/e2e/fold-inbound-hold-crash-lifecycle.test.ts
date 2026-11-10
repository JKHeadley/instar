// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §9.3 "Held inbound" — e2e across a REAL
 * process crash, booted in the server's order:
 *  1. a child process (vite-node, production modules) begins a fold, holds the
 *     topic's inbound queue, receives a message while held, and dies mid-fold;
 *  2. this process boots like server.ts: fold boot sweep first (queue not open
 *     yet), then the queue opens and releaseSettledInboundHolds runs.
 *  Before the point of no return the message becomes deliverable; past it the
 *  message stays held for the sentinel's rollback.
 *  3. WIRED source check: server.ts registers the inbound-hold carrier with the
 *     coordinator, runs the settle pass after the inbound boot sweep, and hands
 *     the sweep a gate-expiry callback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore, TERMINAL_STATES } from '../../src/monitoring/FoldCoordinator.js';
import { releaseSettledInboundHolds } from '../../src/monitoring/foldInboundHold.js';
import { PendingInboundStore } from '../../src/core/PendingInboundStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/fold-inbound-hold-crash-lifecycle.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = '141133';

const CHILD = `
import { buildFoldCoordinator } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/foldCoordinatorBoot.ts'))};
import { PendingInboundStore } from ${JSON.stringify(path.join(ROOT, 'src/core/PendingInboundStore.ts'))};
const [stateDir, target] = process.argv.slice(-2);
const { coordinator } = buildFoldCoordinator({
  stateDir, runningTopicSessions: () => [{ topicKey: '${TOPIC}' }], poolPlacementLive: () => false,
  inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
});
const store = PendingInboundStore.open('echo', stateDir);
const b = coordinator.begin('${TOPIC}');
if (!b.ok) process.exit(3);
let rec = b.record;
store.holdForFold('${TOPIC}', rec.foldId, new Date().toISOString());
const q = store.enqueue({ sessionKey: '${TOPIC}', messageId: 'm1', payload: 'are you there?', reason: 'r', tenure: 't', nowIso: new Date().toISOString(), monoMs: 1, bootSessionId: 'old' },
  { maxPerSession: 10, maxTotal: 20, hardMaxTotal: 30, maxPayloadBytes: 4096 });
if (q.result !== 'queued') process.exit(5);
for (const to of ({ staged: ['snapshotted', 'staged'], replacing: ['snapshotted', 'staged', 'replacing'] })[target]) {
  const r = coordinator.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
  if (!r.ok) process.exit(4);
  rec = r.record;
}
console.log(JSON.stringify({ foldId: rec.foldId }));
process.exit(0); // die mid-fold (store not closed: WAL recovery on next open)
`;

describe('inbound fold hold across a real process crash', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  const crashAt = (target: 'staged' | 'replacing') => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-inbound-e2e-'));
    dirs.push(stateDir);
    const script = path.join(stateDir, 'child.ts');
    fs.writeFileSync(script, CHILD);
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/vite-node'), [script, stateDir, target], { cwd: ROOT, encoding: 'utf-8', timeout: 90_000 });
    expect(r.status, r.stderr).toBe(0);
    return { stateDir, ...(JSON.parse(r.stdout.trim().split('\n').pop() as string) as { foldId: string }) };
  };
  const bootLikeServer = (stateDir: string) => {
    const { coordinator } = buildFoldCoordinator({
      stateDir, runningTopicSessions: () => [{ topicKey: TOPIC }], poolPlacementLive: () => false,
      inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
    });
    const swept = coordinator.recoverPendingFolds(); // fold sweep first: queue not open yet
    const store = PendingInboundStore.open('echo', stateDir);
    const recs = new FoldRecordStore(stateDir);
    const released = releaseSettledInboundHolds(store, (t, f) => { const r = recs.get(t, f); return r ? !TERMINAL_STATES.has(r.state) : null; }, new Date().toISOString());
    const heads = store.selectEligibleHeads(new Date(Date.now() + 1000).toISOString(), 10).map((r) => r.payload);
    store.close();
    return { swept, released, heads };
  };

  it('crash before the point of no return ⇒ the held message becomes deliverable after boot', () => {
    const { stateDir, foldId } = crashAt('staged');
    const { swept, released, heads } = bootLikeServer(stateDir);
    expect(swept.aborted.map((x) => x.foldId)).toEqual([foldId]);
    expect(released).toEqual([foldId]);
    expect(heads).toEqual(['are you there?']);
  }, 120_000);

  it('crash past the point of no return ⇒ the message stays held for the rollback', () => {
    const { stateDir, foldId } = crashAt('replacing');
    const { swept, released, heads } = bootLikeServer(stateDir);
    expect(swept.quarantined.map((x) => x.foldId)).toEqual([foldId]);
    expect(released).toEqual([]);
    expect(heads).toEqual([]);
  }, 120_000);

  it('server.ts registers the carrier, settles after the inbound boot sweep, and passes the gate-expiry callback', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const carrier = src.indexOf('built.coordinator.registerCarrier(inboundHoldCarrier(() => _sweptInboundStore))');
    const foldSweep = src.indexOf('built.coordinator.recoverPendingFolds()');
    const gate = src.indexOf('onFoldRowsGateExpired:');
    const settle = src.indexOf('releaseSettledInboundHolds(sweepRes.store');
    expect(carrier).toBeGreaterThan(0);
    expect(foldSweep).toBeGreaterThan(carrier);
    expect(gate).toBeGreaterThan(foldSweep);
    expect(settle).toBeGreaterThan(gate);
  });
});
