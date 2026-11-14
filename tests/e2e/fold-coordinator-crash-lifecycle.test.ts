// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.

/**
 * context-budget-layered-summaries §9.3 — e2e lifecycle of the fold record
 * across a REAL process crash:
 *
 *  1. A child process (vite-node, the production modules, no mocks) builds the
 *     coordinator exactly as server.ts does (buildFoldCoordinator), begins a
 *     fold, stages real carriers, advances it to a chosen state, and dies with
 *     process.exit mid-fold: no terminal transition, no lock release.
 *  2. This process then boots like the server: a fresh buildFoldCoordinator on
 *     the same state directory and recoverPendingFolds(). Before the point of
 *     no return the fold is aborted and every carrier and the lock are freed;
 *     past it the fold is quarantined with containment intact.
 *  3. WIRED source check (dead-code guard): server.ts builds the coordinator,
 *     runs recoverPendingFolds() unconditionally, and does so BEFORE the
 *     inbound-queue boot sweep and recoverPendingInjects (§9.3 boot order).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { listClearSeedPointers } from '../../src/monitoring/clearSeedPointer.js';
import { PendingInjectStore } from '../../src/core/PendingInjectStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/fold-coordinator-crash-lifecycle.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = '141133';

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
import { buildFoldCoordinator } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/foldCoordinatorBoot.ts'))};
import { writeClearSeedPointer, contextLayersRoot } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/clearSeedPointer.ts'))};
import { PendingInjectStore } from ${JSON.stringify(path.join(ROOT, 'src/core/PendingInjectStore.ts'))};
const [stateDir, target] = process.argv.slice(-2);
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
const path_ = { locked: [], staged: ['snapshotted', 'staged'], replacing: ['snapshotted', 'staged', 'replacing'] }[target];
for (const to of path_) {
  const r = coordinator.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
  if (!r.ok) { console.error('refused', r.reason); process.exit(4); }
  rec = r.record;
}
console.log(JSON.stringify({ foldId: rec.foldId, state: rec.state }));
process.exit(0); // die mid-fold: no terminal transition, no release
`;

describe('FoldCoordinator across a real process crash', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  const crashAt = (target: 'locked' | 'staged' | 'replacing') => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-e2e-'));
    dirs.push(stateDir);
    const script = path.join(stateDir, 'child.ts');
    fs.writeFileSync(script, CHILD);
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/vite-node'), [script, stateDir, target], { cwd: ROOT, encoding: 'utf-8', timeout: 90_000 });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').pop() as string;
    return { stateDir, ...(JSON.parse(last) as { foldId: string; state: string }) };
  };
  const boot = (stateDir: string) => buildFoldCoordinator({
    stateDir, runningTopicSessions: () => [{ topicKey: TOPIC }], poolPlacementLive: () => false,
    inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
  }).coordinator;
  const carriers = (stateDir: string) => ({
    clearSeed: listClearSeedPointers(stateDir).length,
    inject: new PendingInjectStore(path.join(stateDir, 'state')).list().records.filter((x) => x.fold).length,
  });

  for (const target of ['locked', 'staged'] as const) {
    it(`crash at ${target} ⇒ aborted at boot, carriers and lock freed`, () => {
      const { stateDir, foldId, state } = crashAt(target);
      expect(state).toBe(target);
      expect(carriers(stateDir)).toEqual({ clearSeed: 1, inject: 1 });
      const c = boot(stateDir);
      const swept = c.recoverPendingFolds();
      expect(swept.aborted.map((x) => [x.foldId, x.state])).toEqual([[foldId, 'aborted']]);
      expect(carriers(stateDir)).toEqual({ clearSeed: 0, inject: 0 });
      expect(c.begin(TOPIC).ok).toBe(true);
    }, 120_000);
  }

  it('crash at replacing ⇒ quarantined for the sentinel, containment kept', () => {
    const { stateDir, foldId } = crashAt('replacing');
    const c = boot(stateDir);
    const swept = c.recoverPendingFolds();
    expect(swept.quarantined.map((x) => [x.foldId, x.state, x.role])).toEqual([[foldId, 'quarantined', 'sentinel']]);
    expect(carriers(stateDir)).toEqual({ clearSeed: 1, inject: 1 });
    expect(c.begin(TOPIC)).toEqual({ ok: false, reason: 'fold-in-progress' });
  }, 120_000);

  it('server.ts wires the fold boot sweep unconditionally, before the inbound sweep and recoverPendingInjects', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const build = src.indexOf("await import('../monitoring/foldCoordinatorBoot.js')");
    const sweep = src.indexOf('built.coordinator.recoverPendingFolds()', build);
    const inbound = src.indexOf('// ── Durable Inbound Message Queue: unconditional boot sweep');
    const injects = src.indexOf('sessionManager.recoverPendingInjects()');
    expect(build).toBeGreaterThan(0);
    expect(sweep).toBeGreaterThan(build);
    expect(inbound).toBeGreaterThan(sweep);
    expect(injects).toBeGreaterThan(inbound);
    // not behind a feature flag: the 2 KB before the import carry no `if (` gate on config
    const lead = src.slice(Math.max(0, build - 2000), build);
    expect(lead).not.toMatch(/if \(config\.[A-Za-z.?]*contextBudget/);
  });
});
