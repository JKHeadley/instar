// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §10 + §9.3 — e2e lifecycle of the egress
 * fold hold across a REAL process crash, observed over REAL HTTP:
 *
 *  1. A child process (vite-node, production modules) builds the coordinator
 *     and the hold store exactly as server.ts does, begins a fold, writes the
 *     hold, advances the fold, and exits mid-fold.
 *  2. This process boots like the server (buildFoldCoordinator + buildFoldHolds
 *     + carrier registered before recoverPendingFolds) and serves createRoutes
 *     with that hold store. Before the point of no return the sweep aborts the
 *     fold and releases the hold, so the reply goes out; past it the fold is
 *     quarantined and the reply is refused 409 fold-hold.
 *  3. WIRED source check: server.ts builds the hold with buildFoldHolds,
 *     registers its carrier BEFORE the sweep, and hands it to AgentServer,
 *     which passes it to the routes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRoutes } from '../../src/server/routes.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { buildFoldCoordinator, buildFoldHolds } from '../../src/monitoring/foldCoordinatorBoot.js';
import { foldHoldCarrier } from '../../src/monitoring/FoldHoldStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/fold-hold-crash-lifecycle.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = 141133;

const deps = (stateDir: string) => ({
  stateDir, runningTopicSessions: () => [{ topicKey: String(TOPIC) }], poolPlacementLive: () => false,
  inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
});

const CHILD = `
import { buildFoldCoordinator, buildFoldHolds } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/foldCoordinatorBoot.ts'))};
import { foldHoldCarrier } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/FoldHoldStore.ts'))};
const [stateDir, target] = process.argv.slice(-2);
const { coordinator } = buildFoldCoordinator({
  stateDir, runningTopicSessions: () => [{ topicKey: '${TOPIC}' }], poolPlacementLive: () => false,
  inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
});
const holds = buildFoldHolds({ stateDir });
coordinator.registerCarrier(foldHoldCarrier(holds));
const b = coordinator.begin('${TOPIC}');
if (!b.ok) { console.error('begin refused', b.reason); process.exit(3); }
let rec = b.record;
if (!holds.write('${TOPIC}', rec.foldId, Date.now() + 600000)) process.exit(5);
const steps = { staged: ['snapshotted', 'staged'], replacing: ['snapshotted', 'staged', 'replacing'] }[target];
for (const to of steps) {
  const r = coordinator.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
  if (!r.ok) { console.error('refused', r.reason); process.exit(4); }
  rec = r.record;
}
console.log(JSON.stringify({ foldId: rec.foldId }));
process.exit(0); // die mid-fold
`;

describe('fold hold across a real process crash (HTTP)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

  const crashAt = (target: 'staged' | 'replacing') => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-hold-e2e-'));
    cleanups.push(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ authToken: 'test', port: 0, dashboardPin: '123456' }));
    const script = path.join(stateDir, 'child.ts');
    fs.writeFileSync(script, CHILD);
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/vite-node'), [script, stateDir, target], { cwd: ROOT, encoding: 'utf-8', timeout: 90_000 });
    expect(r.status, r.stderr).toBe(0);
    return { stateDir, ...(JSON.parse(r.stdout.trim().split('\n').pop() as string) as { foldId: string }) };
  };

  const bootAndServe = async (stateDir: string) => {
    const { coordinator } = buildFoldCoordinator(deps(stateDir));
    const holds = buildFoldHolds({ stateDir });
    coordinator.registerCarrier(foldHoldCarrier(holds));
    const swept = coordinator.recoverPendingFolds();
    const sent: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 'test', stateDir, port: 0, dashboardPin: '123456' },
      liveConfig: new LiveConfig(stateDir),
      foldHolds: holds,
      sessionManager: { clearInjectionTracker() {}, listRunningSessions: () => [], getSessionByTopic: () => null },
      telegram: { sendToTopic: async (_t: number, text: string) => { sent.push(text); return true; }, getTopicHistory: () => [] },
      startTime: new Date(),
    } as any));
    const url = await new Promise<string>((resolve) => {
      const srv = app.listen(0, () => {
        cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
        resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
      });
    });
    const reply = async (text: string) => {
      const res = await fetch(`${url}/telegram/reply/${TOPIC}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify({ text }) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    return { swept, reply, sent };
  };

  it('crash before the point of no return ⇒ the boot sweep releases the hold and the reply is not refused', async () => {
    const { stateDir, foldId } = crashAt('staged');
    const { swept, reply, sent } = await bootAndServe(stateDir);
    expect(swept.aborted.map((x) => x.foldId)).toEqual([foldId]);
    const r = await reply('back to normal');
    expect(r.status).toBe(200);
    expect(sent).toContain('back to normal'); // it actually went out
  }, 120_000);

  it('crash past the point of no return ⇒ quarantined, and the hold keeps refusing sends (409 fold-hold)', async () => {
    const { stateDir, foldId } = crashAt('replacing');
    const { swept, reply, sent } = await bootAndServe(stateDir);
    expect(swept.quarantined.map((x) => x.foldId)).toEqual([foldId]);
    const r = await reply('an internal answer that must not leak');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'fold-hold', foldId });
    expect(sent).toEqual([]);
  }, 120_000);

  it('server.ts builds the hold, registers its carrier before the sweep, and AgentServer passes it to the routes', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const build = src.indexOf('_foldHolds = buildFoldHolds(');
    const carrier = src.indexOf('built.coordinator.registerCarrier(foldHoldCarrier(_foldHolds))');
    const sweep = src.indexOf('built.coordinator.recoverPendingFolds()');
    expect(build).toBeGreaterThan(0);
    expect(carrier).toBeGreaterThan(build);
    expect(sweep).toBeGreaterThan(carrier);
    expect(src).toContain('foldHolds: _foldHolds ?? undefined');
    const agent = fs.readFileSync(path.join(ROOT, 'src/server/AgentServer.ts'), 'utf-8');
    expect(agent).toContain('foldHolds: options.foldHolds ?? null');
  });
});
