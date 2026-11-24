// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 lifecycle test for the Local Verify queue controls (spec
 * docs/specs/local-verify-queue-controls.md): the service is built through
 * buildLocalVerifyService and its live switches through wireLocalVerifySwitches, the same
 * functions server.ts calls, booted, and served through the real routes. With the switch on
 * the four routes are alive (200, not 503 or 404), a hold stops a start, a front admits into a
 * full queue, and the operator file is written where the server reads it. A wiring test checks
 * that the operator store is ONE real object shared by admission, the start check and the
 * dispatch check. Only gh and the run child are stand-ins (patched on the built seams).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildLocalVerifyService, localVerifyAttentionItem, wireLocalVerifyOperatorNotice, wireLocalVerifySwitches } from '../../src/localVerify/localVerifyWiring.js';
import type { LocalVerifyService, LocalVerifyServiceSeams, QueueEntry } from '../../src/localVerify/LocalVerifyService.js';
import { LOCAL_VERIFY_LIMITS } from '../../src/localVerify/policy.js';
import { OperatorQueueStore } from '../../src/localVerify/operatorQueue.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'localVerify', 'runVerifyMain.js');
const BY = 'echo-increasing-throughput';
const KEY = 'monitoring.localVerify.queueControls';
const headOf = (pr: number) => pr.toString(16).padStart(4, '0').repeat(10);
const dirs: string[] = [];
const services: LocalVerifyService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) { try { s.shutdown(); } catch { /* already stopped */ } }
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-queue-controls-lifecycle.test.ts' });
});

function sourceCheckout(): { home: string; stateDir: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvqclife-')));
  dirs.push(home);
  fs.mkdirSync(path.join(home, '.git'));
  fs.mkdirSync(path.join(home, 'scripts'));
  fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// stand-in\n');
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(stateDir);
  return { home, stateDir };
}

function ctx(stateDir: string, localVerify: RouteContext['localVerify'], over: Partial<RouteContext> = {}): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify, localVerifyStatus: null,
    startTime: new Date(),
    ...over,
  } as never;
}

function serve(c: RouteContext) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(c));
  return a;
}

/**
 * The production build of the service, with the live switch read from `values` exactly as
 * server.ts wires it, and gh and the run child replaced on the built seams.
 */
function production(home: string, stateDir: string, values: Record<string, unknown>) {
  const built = buildLocalVerifyService({
    config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
    repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
  });
  expect(built.reason).toBeNull();
  const svc = built.service!;
  services.push(svc);
  wireLocalVerifySwitches(svc, { get: <T,>(k: string, fb: T): T => (k in values ? (values[k] as T) : fb) });
  const seams = (svc as unknown as { seams: LocalVerifyServiceSeams }).seams;
  const started: number[] = [];
  let busy = true; // another suite holds the host's slot until the test frees it
  const closed = new Set<number>();
  seams.prView = async (pr) => ({ author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: `echo/pr-${pr}`, headRefOid: headOf(pr), baseRefName: 'main', baseRefOid: 'b'.repeat(40) });
  seams.baseHead = async () => 'b'.repeat(40);
  seams.isPrOpen = async (pr) => !closed.has(pr);
  seams.foreignSuiteHolders = () => (busy ? [{ pid: 1 }] : []);
  seams.spawnRun = (a) => {
    started.push((JSON.parse(fs.readFileSync(a.args[a.args.indexOf('--input') + 1], 'utf-8')) as { pr: number }).pr);
    return { pid: 9400 + started.length, exited: new Promise(() => { /* the run never ends in these tests */ }) };
  };
  seams.isGroupAlive = () => false;
  seams.killGroup = () => {};
  /** Free the slot and wait (bounded) for the service to start something. */
  const freeSlotAndWaitForStart = async () => {
    busy = false;
    await svc.tick();
    for (let i = 0; i < 300 && started.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { svc, seams, started, closed, freeSlotAndWaitForStart, setBusy: (v: boolean) => { busy = v; } };
}

const post = (a: express.Express, route: string, body: unknown) => request(a).post(`/local-verify/queue/${route}`).send(body as object);
const operatorPath = (stateDir: string) => path.join(stateDir, 'state', 'local-verify', 'operator-queue.json');

describe('local-verify queue controls lifecycle (production wiring)', () => {
  it('the production service reloads a waiting request and admits it on a later healthy tick', async () => {
    const { home, stateDir } = sourceCheckout();
    const health = path.join(stateDir, 'state', 'local-verify', 'main-health.json');
    fs.mkdirSync(path.dirname(health), { recursive: true });
    fs.writeFileSync(health, JSON.stringify({ v: 1, machineId: 'm_e2e', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: new Date().toISOString() }));
    const values = { [KEY]: true };
    const p = production(home, stateDir, values);
    await p.svc.boot();
    const a = serve(ctx(stateDir, p.svc));
    for (let pr = 1; pr <= LOCAL_VERIFY_LIMITS.queueCap; pr++) expect((await request(a).post('/local-verify').send({ pr })).status).toBe(202);
    expect((await request(a).post('/local-verify').send({ pr: 50 })).status).toBe(429);
    p.svc.shutdown();
    const q = production(home, stateDir, values);
    await q.svc.boot();
    const b = serve(ctx(stateDir, q.svc));
    expect((await request(b).get('/local-verify')).body.waiting.map((w: { pr: number }) => w.pr)).toEqual([50]);
    q.closed.add(1);
    expect((await request(b).post('/local-verify').send({ pr: 1 })).status).toBe(409);
    await q.svc.tick();
    const snapshot = (await request(b).get('/local-verify')).body;
    expect(snapshot.queue.find((e: { pr: number }) => e.pr === 50)).toMatchObject({ headSha: headOf(50) });
    expect(snapshot.waiting).toEqual([]);
    expect(q.started).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'state', 'local-verify', 'queue.json'))).toBe(true);
  });

  it('the built dist ships the child entry the server spawns', () => {
    expect(fs.existsSync(DIST_ENTRY)).toBe(true);
  });

  it('the switch is read live from the config: absent means off (404), only a real true turns it on, and then the routes are alive (200)', async () => {
    const { home, stateDir } = sourceCheckout();
    const values: Record<string, unknown> = {};
    const p = production(home, stateDir, values);
    await p.svc.boot();
    const a = serve(ctx(stateDir, p.svc));
    // Absent: off. The routes exist only for an operator who turned them on.
    expect(p.svc.queueControlsOn()).toBe(false);
    expect((await post(a, 'hold', { pr: 7, by: BY, reason: 'r' })).status).toBe(404);
    expect((await request(a).get('/local-verify')).body).not.toHaveProperty('operator');
    values[KEY] = 'yes';
    expect(p.svc.queueControlsOn()).toBe(false);
    expect((await post(a, 'front', { pr: 7, by: BY, reason: 'r' })).status).toBe(404);
    expect(fs.existsSync(operatorPath(stateDir))).toBe(false);
    // On, with no restart: alive.
    values[KEY] = true;
    expect(p.svc.queueControlsOn()).toBe(true);
    const held = await post(a, 'hold', { pr: 7, by: BY, reason: 'waiting on PR 120' });
    expect(held.status).toBe(200); // not 503, not 404
    expect(held.body).toMatchObject({ ok: true, pr: 7, held: true, queueHold: true, mergeHold: 'not-requested' });
    const fr = await post(a, 'front', { pr: 8, by: BY, reason: 'unblocks fourteen others' });
    expect(fr.status).toBe(200);
    expect(fr.body).toMatchObject({ ok: true, pr: 8, status: 'admitted' });
    const v = await request(a).get('/local-verify');
    expect(v.status).toBe(200);
    expect(v.body.operator).toMatchObject({ enabled: true, held: [{ pr: 7, reason: 'waiting on PR 120', by: BY }], fronted: [{ pr: 8, reason: 'unblocks fourteen others', by: BY, queued: true }] });
    expect((await post(a, 'unfront', { pr: 8, by: BY })).status).toBe(200);
    expect((await post(a, 'release', { pr: 7, by: BY })).status).toBe(200);
    // The audit rows land in the server's own audit log: who and why, and one `boot` row for this start.
    const audit = fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; by?: string; reason?: string });
    expect(audit.filter((x) => x.event === 'boot')).toEqual([expect.objectContaining({ reason: 'unknown' })]);
    expect(audit.find((x) => x.event === 'operator-hold')).toMatchObject({ by: BY, reason: 'waiting on PR 120' });
    expect(audit.find((x) => x.event === 'operator-front')).toMatchObject({ by: BY, reason: 'unblocks fourteen others' });
    expect(audit.some((x) => x.event === 'operator-release')).toBe(true);
    expect(audit.some((x) => x.event === 'operator-unfront')).toBe(true);
  });

  it('a hold stops a start, and the operator file is written where the server reads it (a restarted server still holds the change)', async () => {
    const { home, stateDir } = sourceCheckout();
    const values: Record<string, unknown> = { [KEY]: true };
    const p = production(home, stateDir, values);
    await p.svc.boot();
    const a = serve(ctx(stateDir, p.svc));
    for (const pr of [3, 4]) expect((await request(a).post('/local-verify').send({ pr })).status).toBe(202);
    const held = await post(a, 'hold', { pr: 3, by: BY, reason: 'known wrong', until: '2027-01-01T00:00:00Z' });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ held: true, running: false, removed: 'queue' });
    // Written where the server reads it, with the entry the hold took out.
    const file = JSON.parse(fs.readFileSync(operatorPath(stateDir), 'utf-8')) as { v: number; records: Array<{ pr: number; hold?: { by: string; reason: string; entry?: { headSha: string } } }> };
    expect(file.v).toBe(1);
    expect(file.records).toEqual([expect.objectContaining({ pr: 3, hold: expect.objectContaining({ by: BY, reason: 'known wrong', entry: expect.objectContaining({ headSha: headOf(3) }) }) })]);
    expect(p.svc.operatorQueuePath).toBe(operatorPath(stateDir));
    // The slot frees: PR 4 starts, the held PR 3 (queued first) does not.
    await p.freeSlotAndWaitForStart();
    expect(p.started).toEqual([4]);
    expect((await request(a).post('/local-verify').send({ pr: 3 })).status).toBe(409); // held
    p.svc.shutdown();
    // A restart: a second service built by the same production wiring on the same state reads the file back.
    const q = production(home, stateDir, values);
    await q.svc.boot();
    const b = serve(ctx(stateDir, q.svc));
    const v = (await request(b).get('/local-verify')).body;
    expect(v.operator.held).toEqual([expect.objectContaining({ pr: 3, reason: 'known wrong', by: BY, until: '2027-01-01T00:00:00.000Z', savedEntry: true })]);
    expect((await request(b).post('/local-verify').send({ pr: 3 })).body).toEqual({ ok: false, code: 'held' });
    await q.freeSlotAndWaitForStart(); // the run PR 4's restart interrupted comes back; the held change still does not start
    expect(q.started).not.toContain(3);
    // Released: back in the queue with what the hold took out.
    const rel = await post(b, 'release', { pr: 3, by: BY });
    expect(rel.status).toBe(200);
    expect(rel.body).toMatchObject({ released: true, placed: 'queue' });
    expect((await request(b).get('/local-verify')).body.operator.held).toEqual([]);
  });

  it('a front admits a change into a full queue and it starts next', async () => {
    const { home, stateDir } = sourceCheckout();
    const p = production(home, stateDir, { [KEY]: true });
    await p.svc.boot();
    const a = serve(ctx(stateDir, p.svc));
    for (let pr = 1; pr <= LOCAL_VERIFY_LIMITS.queueCap; pr++) expect((await request(a).post('/local-verify').send({ pr })).status).toBe(202);
    expect((await request(a).post('/local-verify').send({ pr: 50 })).status).toBe(429); // full: an ordinary request is refused
    const fr = await post(a, 'front', { pr: 50, by: BY, reason: 'unblocks fourteen others' });
    expect(fr.status).toBe(200);
    expect(fr.body).toMatchObject({ ok: true, pr: 50, status: 'admitted', overCap: true });
    const v = (await request(a).get('/local-verify')).body;
    expect(v.queue).toHaveLength(LOCAL_VERIFY_LIMITS.queueCap + 1);
    expect(v.operator.fronted).toEqual([expect.objectContaining({ pr: 50, queued: true })]);
    expect(v.operator.overflow).toEqual({ used: 1, max: 5 });
    await p.freeSlotAndWaitForStart();
    expect(p.started).toEqual([50]); // ahead of the ten that queued before it
    // A start does not end the mark: a run that came back without a result would still be first.
    expect((await request(a).get('/local-verify')).body.operator.fronted.map((f: { pr: number }) => f.pr)).toEqual([50]);
  });

  it('wiring: the operator store is one real object shared by admission, the start check and the dispatch check', async () => {
    const { home, stateDir } = sourceCheckout();
    const p = production(home, stateDir, { [KEY]: true });
    await p.svc.boot();
    const a = serve(ctx(stateDir, p.svc));
    const inner = p.svc as unknown as {
      operator: OperatorQueueStore; queue: QueueEntry[];
      nextRunnableQueuedEntry(): QueueEntry | null; dispatchable(e: QueueEntry, held: Set<number>): boolean;
      entryFromSaved(pr: number, s: unknown, heldMs: number): QueueEntry;
    };
    // Real, not null and not a stand-in: the store class, on the server's own state path.
    expect(inner.operator).toBeInstanceOf(OperatorQueueStore);
    expect(inner.operator.path).toBe(operatorPath(stateDir));
    // A hold made through the HTTP route lands in that one object…
    expect((await request(a).post('/local-verify').send({ pr: 5 })).status).toBe(202);
    expect((await post(a, 'hold', { pr: 5, by: BY, reason: 'r' })).status).toBe(200);
    expect(inner.operator.isHeld(5)).toBe(true);
    expect(inner.operator.isHeld(6)).toBe(false);
    // …and each of the three decisions reads it. Admission:
    expect(await p.svc.request(5, { explicit: true })).toEqual({ ok: false, code: 'held' });
    expect(await p.svc.request(5, { explicit: false })).toEqual({ ok: false, code: 'held' });
    // The start check and the dispatch check, on an entry of the held change that is still in the
    // queue (the case the sweep has not reached yet), beside an entry of a change that is not held.
    const saved = inner.operator.get(5)!.hold!.entry!;
    const strayHeld = inner.entryFromSaved(5, saved, 0);
    const notHeld = inner.entryFromSaved(6, { ...saved, headSha: headOf(6) }, 0);
    p.setBusy(false);
    inner.queue.push(strayHeld);
    expect(inner.nextRunnableQueuedEntry()).toBeNull(); // the only entry is held: nothing may start
    expect(inner.dispatchable(strayHeld, new Set())).toBe(false);
    inner.queue.push(notHeld);
    expect(inner.nextRunnableQueuedEntry()).toBe(notHeld);
    expect(inner.dispatchable(notHeld, new Set())).toBe(true);
    // The same object decides once the hold ends: releasing through the route frees all three.
    inner.queue.length = 0;
    expect((await post(a, 'release', { pr: 5, by: BY })).status).toBe(200);
    expect(inner.operator.isHeld(5)).toBe(false);
    expect(inner.dispatchable(strayHeld, new Set())).toBe(true);
  });

  it('wiring: the lease-loss notice is sent to the session named in the config, through the sender the server passes in', async () => {
    const { home, stateDir } = sourceCheckout();
    const values: Record<string, unknown> = { [KEY]: true };
    const p = production(home, stateDir, values);
    const sent: Array<{ session: string; subject: string; body: string }> = [];
    let phase = 'delivered';
    // server.ts passes the message router's send here; a recorder stands in for it.
    wireLocalVerifyOperatorNotice(p.svc, {
      liveConfig: { get: <T,>(k: string, fb: T): T => (k in values ? (values[k] as T) : fb) },
      send: async (session, subject, body) => { sent.push({ session, subject, body }); return { phase }; },
    });
    const notifier = (p.svc as unknown as { operatorNotifier: ((m: { subject: string; body: string }) => Promise<{ sent: boolean; phase?: string | null }>) | null }).operatorNotifier;
    expect(typeof notifier).toBe('function'); // wired, not null
    expect(await notifier!({ subject: 's', body: 'b' })).toEqual({ sent: false, phase: 'no-session-set' }); // no session named: the attention item is the fallback
    expect(sent).toEqual([]);
    values['monitoring.localVerify.operatorSession'] = 'echo-increasing-throughput';
    expect(await notifier!({ subject: 's', body: 'b' })).toEqual({ sent: true, phase: 'delivered' }); // read live, no restart
    expect(sent).toEqual([{ session: 'echo-increasing-throughput', subject: 's', body: 'b' }]);
    // Queued for a session that is not running is not sent: the attention item is raised as well.
    phase = 'queued';
    expect(await notifier!({ subject: 's', body: 'b' })).toEqual({ sent: false, phase: 'queued' });
  });

  it('wiring: the notices the controls raise become attention items with a plain title and a create-once id', () => {
    const due = localVerifyAttentionItem('local-verify:operator-hold-due:2026-11-19T08:00:00.000Z', { note: 'A change is still held back from testing past its expected release: PR #7 (held 26 h by echo: waiting on PR 120).' });
    expect(due).toMatchObject({ id: 'local-verify:operator-hold-due:2026-11-19T08:00:00.000Z', mode: 'create', priority: 'MEDIUM', title: 'Local Verify: a held change is past its expected release' });
    expect(due.summary).toContain('PR #7');
    const unreadable = localVerifyAttentionItem('local-verify:operator-file-unreadable:2026-11-19T08:00:00.000Z', { note: 'No change is held and none is moved to the front now.' });
    expect(unreadable).toMatchObject({ mode: 'create', priority: 'HIGH', title: 'Local Verify: the list of held changes could not be read' });
    const moved = localVerifyAttentionItem('local-verify:operator-lease-moved:2026-11-19T08:00:00.000Z', { note: 'Held back from testing here: PR #7 (waiting; set by echo).' });
    expect(moved).toMatchObject({ mode: 'create', priority: 'MEDIUM', title: 'Local Verify: held changes stayed on a machine that no longer runs the line' });
  });
});
