// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the run machine's server side of borrowed helpers (docs/specs/local-verify-borrowed-slices-count.md,
 * F and "Build decisions"), against a real HelperService in-process:
 *  - the loopback proxy: its refusals (a tunnel request, another forwarder, a socket that is not
 *    loopback, a wrong or finished verify's token, a main verify), a caller-supplied commit never
 *    being read, bounded test-file lists only, the 5-second limit, "no helper answer" on any failure;
 *  - the one status request at the start of a verify and the assignment drawn before it;
 *  - the decision route refusing without evidence and recording with it (practice record, audit
 *    row, evidence-log row);
 *  - "I am here" with a good and with a bad signature;
 *  - helper events told once, by the coordinator only, the owner only in the two stated cases;
 *  - the baseline results kept by the coordinator and sent to a peer that wants them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { BORROWED_PROXY, BorrowedRunMachine, parseProxyOp, proxyRouteRefusal } from '../../../src/localVerify/BorrowedRunMachine.js';
import { parseHelperStatus, type HelperClient } from '../../../src/localVerify/borrowedClient.js';
import { BORROWED_CANARY_FILES } from '../../../src/localVerify/borrowedCanary.js';
import type { HelperEvent } from '../../../src/localVerify/borrowedNotices.js';
import type { LaneVerifyOutcome, PracticeLane } from '../../../src/localVerify/borrowedPractice.js';
import { BorrowedPracticeStore } from '../../../src/localVerify/borrowedState.js';
import { appendLocalVerifyAudit } from '../../../src/localVerify/LocalVerifyService.js';
import { MainFileCountsStore, type FileCountsRow } from '../../../src/localVerify/mainFileCounts.js';
import { signHelperHere, signHelperStatus, type HelperHereRequest } from '../../../src/localVerify/helper/helperProtocol.js';
import { HEAD, UNIT_A, UNIT_B, helperRig, machineKeys, pins, sha, type HelperRig } from '../../helpers/borrowedHelperFixture.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedRunMachine.test.ts' }); });

const LOOP = { remoteAddress: '127.0.0.1' };
const TOKEN = '1'.repeat(32);
const DAY = 24 * 60 * 60_000;
const LAPTOP = { machineId: 'm_laptop', url: 'http://100.64.0.9:4042' };
const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Every call goes straight to the helper service, through JSON like the wire; each request body is kept. */
function inProcessClient(r: HelperRig, seen: Array<{ call: string; body?: Record<string, unknown>; timeoutMs?: number }>): HelperClient {
  return {
    async slice(_h, body, timeoutMs) { seen.push({ call: 'slice', body: wire(body) as Record<string, unknown>, timeoutMs }); const a = await r.svc.handleSlice(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async cancel(_h, body, _s, timeoutMs) { seen.push({ call: 'cancel', body: wire(body) as Record<string, unknown>, timeoutMs }); const a = await r.svc.handleCancel(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async learned(_h, body) { seen.push({ call: 'learned', body: wire(body) as Record<string, unknown> }); const a = await r.svc.handleLearned(wire(body), r.route); return { status: a.status, body: wire(a.body) }; },
    async status(_h, _signal, query, timeoutMs) { seen.push({ call: 'status', timeoutMs }); return parseHelperStatus(wire(r.svc.status({ ...(query?.run ? { runAttemptId: query.run } : {}), ...(query?.since !== undefined ? { sinceSeq: query.since } : {}) }))); },
  };
}

interface Opts {
  mode?: 'off' | 'practice' | 'count';
  coordinator?: boolean;
  client?: (r: HelperRig, seen: Array<{ call: string; body?: Record<string, unknown>; timeoutMs?: number }>) => HelperClient;
  randomInt?: (n: number) => number;
  stateDir?: string;
  rig?: HelperRig;
  machineId?: string;
  postPeerBaseline?: (peer: { machineId: string; url: string }, body: unknown) => Promise<boolean>;
}

function setup(o: Opts = {}) {
  const r = o.rig ?? helperRig({}, dirs);
  for (const f of BORROWED_CANARY_FILES) r.trees.files[HEAD][f] = "it('c', () => {});\n";
  const stateDir = o.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvrunm-')));
  if (!o.stateDir) dirs.push(stateDir);
  const audits: Array<Record<string, unknown>> = [];
  const notices: Array<{ who: 'line' | 'owner'; event: HelperEvent; text: string; ownerReason: string | null }> = [];
  const evidence: Array<{ kind: string; reason: string; subject: string; context: Record<string, unknown> }> = [];
  const seen: Array<{ call: string; body?: Record<string, unknown>; timeoutMs?: number }> = [];
  const cfg = { mode: o.mode ?? 'practice' as 'off' | 'practice' | 'count', coordinator: o.coordinator ?? true };
  const auditPath = path.join(stateDir, 'logs', 'local-verify.jsonl');
  const store = new BorrowedPracticeStore(stateDir);
  const baseline = new MainFileCountsStore({ stateDir, audit: (e) => appendLocalVerifyAudit(auditPath, e, Date.now()) });
  const machine = new BorrowedRunMachine({
    config: () => (cfg.mode === 'off' ? { mode: 'off', helpers: [] } : { mode: cfg.mode, helpers: [LAPTOP] }),
    store, baseline,
    client: (o.client ?? inProcessClient)(r, seen),
    signer: r.requester.signer, keyLookup: () => pins(r.helperKeys), machineId: o.machineId ?? 'm_studio',
    isCoordinator: () => cfg.coordinator,
    ...(o.postPeerBaseline ? { postPeerBaseline: o.postPeerBaseline } : {}),
    audit: (e) => audits.push(e),
    notify: (who, event, text, ownerReason) => notices.push({ who, event, text, ownerReason }),
    evidence: (row) => evidence.push(row),
    now: () => r.clock.t,
    randomInt: o.randomInt ?? (() => 5),
  });
  const start = (token = TOKEN, kind: 'main' | 'waiting' = 'waiting', head = HEAD, base = HEAD) => machine.onVerifyStart({ token, kind, pr: kind === 'main' ? 0 : 3501, baseSha: base, headSha: head, startedAt: r.clock.t });
  const call = async (body: unknown, token: string | undefined = TOKEN, route: Record<string, unknown> = LOOP) => machine.proxy(token, body, route);
  return { r, machine, store, baseline, audits, notices, evidence, seen, cfg, stateDir, start, call };
}

const outcome = (over: Partial<LaneVerifyOutcome> = {}): LaneVerifyOutcome => ({
  verifyId: 'v1', kind: 'waiting', change: '3501', compareOnly: false, assigned: 'counting', sent: 4, finished: 4,
  agreed: [], digestDiffersBothPass: [], helperFailedLocalPassed: [], confirmedWrongPasses: [], failingAgreed: [], environmentDifferences: 0, check: null, answers: ['valid'], ...over,
});
const f = (n: number) => `tests/integration/f${n}.test.ts`;

/** Bring a lane to complete evidence through the same entry points the dry run and the lane flow will use. */
function completeEvidence(s: ReturnType<typeof setup>, lane: PracticeLane = 'integration'): void {
  s.machine.recordDryRunResult('m_laptop', lane, { eligible: [f(1), f(2)], compared: [f(1), f(2)], eligibleDigest: 'a'.repeat(64) });
  const steps: Array<Partial<LaneVerifyOutcome>> = [
    { verifyId: 'v1', agreed: [f(1)], failingAgreed: [f(7), f(8), f(9)], check: 'right' },
    { verifyId: 'v2', agreed: [f(1)], failingAgreed: [f(7), f(8)], check: 'right' },
    { verifyId: 'v3', agreed: [f(1)], check: 'right' }, { verifyId: 'v4', agreed: [f(1)], check: 'right' }, { verifyId: 'v5', agreed: [f(2)], check: 'right' },
  ];
  for (const st of steps) s.machine.recordVerify('m_laptop', { [lane]: outcome(st) });
}

const decide = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) => s.machine.decide({ helper: 'm_laptop', lane: 'integration', reason: 'practice report reviewed', by: 'echo-increasing-throughput', ...over });

describe('the loopback proxy: what it refuses before anything else', () => {
  it('pure route check: the tunnel, another forwarder, and any socket that is not loopback (or unknown)', () => {
    expect(proxyRouteRefusal({ remoteAddress: '127.0.0.1' })).toBeNull();
    expect(proxyRouteRefusal({ remoteAddress: '::1' })).toBeNull();
    expect(proxyRouteRefusal({ remoteAddress: '::ffff:127.0.0.1' })).toBeNull();
    expect(proxyRouteRefusal({ remoteAddress: '127.0.0.1', cfConnectingIp: '203.0.113.9' })).toBe('tunnel'); // the connector reaches the server ON loopback
    expect(proxyRouteRefusal({ remoteAddress: '127.0.0.1', cfConnectingIp: ['203.0.113.9'] })).toBe('tunnel');
    expect(proxyRouteRefusal({ remoteAddress: '127.0.0.1', forwardedFor: '10.0.0.4' })).toBe('forwarded');
    expect(proxyRouteRefusal({ remoteAddress: '192.168.87.30' })).toBe('not-loopback');
    expect(proxyRouteRefusal({ remoteAddress: '100.64.0.9' })).toBe('not-loopback');
    expect(proxyRouteRefusal({ remoteAddress: '127.0.0.1.evil.example' })).toBe('not-loopback');
    expect(proxyRouteRefusal({})).toBe('not-loopback');
  });

  it('a request that arrived through the tunnel is refused although its token is a running verify\'s, and nothing reaches the helper', async () => {
    const s = setup();
    s.start();
    const before = s.seen.length;
    expect(await s.call({ op: 'plan' }, TOKEN, { remoteAddress: '127.0.0.1', cfConnectingIp: '203.0.113.9' })).toEqual({ status: 403, body: { ok: false, reason: 'tunnel' } });
    expect(await s.call({ op: 'plan' }, TOKEN, { remoteAddress: '192.168.87.30' })).toEqual({ status: 403, body: { ok: false, reason: 'not-loopback' } });
    expect(await s.call({ op: 'plan' }, TOKEN, { remoteAddress: '127.0.0.1', forwardedFor: '1.2.3.4' })).toEqual({ status: 403, body: { ok: false, reason: 'forwarded' } });
    expect(s.seen.length).toBe(before);
    expect(s.audits.filter((a) => a.event === 'borrowed-proxy-refused').map((a) => a.reason)).toEqual(['tunnel', 'not-loopback', 'forwarded']);
  });

  it('needs the attempt token of a verify that is running now: a wrong one, a missing one and a finished verify\'s are refused', async () => {
    const s = setup();
    s.start();
    expect((await s.call({ op: 'plan' }, '2'.repeat(32))).status).toBe(401);
    expect((await s.machine.proxy(undefined, { op: 'plan' }, LOOP)).status).toBe(401);
    expect((await s.call({ op: 'plan' }, 'not-a-token')).status).toBe(401);
    expect((await s.call({ op: 'plan' })).status).toBe(200);
    s.machine.onVerifyEnd({ token: TOKEN, recorded: true, outcome: 'success', cancelled: false });
    expect(await s.call({ op: 'plan' })).toEqual({ status: 401, body: { ok: false, reason: 'unknown-attempt' } });
  });

  it('a main verify\'s token never opens it (main verifies keep the detached observer), and with the setting absent the route does not exist', async () => {
    const s = setup();
    s.start(TOKEN, 'main');
    expect(await s.call({ op: 'plan' })).toEqual({ status: 409, body: { ok: false, reason: 'main-verify' } });
    const off = setup({ mode: 'off' });
    off.start();
    expect(await off.call({ op: 'plan' })).toEqual({ status: 404, body: { ok: false, reason: 'not-found' } });
    expect(off.seen).toEqual([]);
    expect(off.audits.filter((a) => a.event === 'borrowed-assigned')).toEqual([]);
  });
});

describe('the loopback proxy: the commits, the helper and the ids are the server\'s own', () => {
  it('a body that names a commit, a helper, an address or an id is malformed: nothing the caller names in their place is read', () => {
    const evil = sha('f');
    for (const extra of [{ headSha: evil }, { baseSha: evil }, { helper: 'm_other' }, { helperMachineId: 'm_other' }, { url: 'http://203.0.113.9' }, { runAttemptId: '9'.repeat(32) }, { requesterMachineId: 'm_x' }, { attemptId: '9'.repeat(32) }, { deadlineAt: 1 }]) {
      expect(parseProxyOp({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000, ...extra })).toBeNull();
      expect(parseProxyOp({ op: 'slice', lane: 'unit', files: [UNIT_A], use: 'compare', budgetMs: 10_000, deadlineInMs: 60_000, ...extra })).toBeNull();
      expect(parseProxyOp({ op: 'status', ...extra })).toBeNull();
      expect(parseProxyOp({ op: 'cancel', ...extra })).toBeNull();
      expect(parseProxyOp({ op: 'plan', ...extra })).toBeNull();
    }
    expect(parseProxyOp({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 })).toEqual({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 });
  });

  it('a caller-supplied commit is refused whole and never forwarded; the request that IS forwarded carries the commits of the server\'s record', async () => {
    const s = setup();
    s.start(TOKEN, 'waiting', HEAD, HEAD);
    const evil = sha('f');
    const before = s.seen.filter((c) => c.call === 'slice').length;
    expect(await s.call({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000, headSha: evil, baseSha: evil })).toEqual({ status: 400, body: { ok: false, reason: 'invalid-request' } });
    expect(s.seen.filter((c) => c.call === 'slice').length).toBe(before);
    const ok = await s.call({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 });
    expect(ok.body).toMatchObject({ ok: true, answer: { state: 'preparing', baseSha: HEAD, headSha: HEAD } });
    const sent = s.seen.filter((c) => c.call === 'slice').at(-1)!.body!;
    expect(sent).toMatchObject({ kind: 'slice', prepare: true, lane: 'unit', baseSha: HEAD, headSha: HEAD, requesterMachineId: 'm_studio', helperMachineId: 'm_laptop', files: [] });
    expect(JSON.stringify(sent)).not.toContain(evil);
    expect((sent.sig as { machineId: string }).machineId).toBe('m_studio'); // signed with the machine signer
  });

  it('accepts file lists only as bounded lists of distinct test-file paths of the stated lane', () => {
    const slice = (over: Record<string, unknown>) => parseProxyOp({ op: 'slice', lane: 'unit', files: [UNIT_A], use: 'compare', budgetMs: 10_000, deadlineInMs: 60_000, ...over });
    expect(slice({})).toMatchObject({ op: 'slice', files: [UNIT_A] });
    expect(slice({ files: [] })).toBeNull();
    expect(slice({ files: [UNIT_A, UNIT_A] })).toBeNull(); // a file twice
    expect(slice({ files: ['src/core/Config.ts'] })).toBeNull(); // not a test file
    expect(slice({ files: ['tests/unit/../../etc/passwd.test.ts'] })).toBeNull();
    expect(slice({ files: ['/abs/tests/unit/a.test.ts'] })).toBeNull();
    expect(slice({ files: ['tests/integration/x.test.ts'] })).toBeNull(); // another lane's file
    expect(slice({ files: Array.from({ length: 401 }, (_, i) => `tests/unit/f${i}.test.ts`) })).toBeNull();
    expect(slice({ files: Array.from({ length: 400 }, (_, i) => `tests/unit/f${i}.test.ts`) })).not.toBeNull();
    expect(slice({ files: [UNIT_A, 7] })).toBeNull();
    expect(slice({ files: 'tests/unit/a.test.ts' })).toBeNull();
    expect(slice({ budgetMs: 10_001 })).toBeNull(); // above the unit lane's slice budget
    expect(slice({ lane: 'integration', files: ['tests/integration/x.test.ts'], budgetMs: 60_000 })).not.toBeNull();
    expect(slice({ deadlineInMs: BORROWED_PROXY.maxDeadlineInMs + 1 })).toBeNull();
    expect(slice({ use: 'trust' })).toBeNull();
    // The check slice holds the fixture files only; a real slice never holds one.
    expect(slice({ use: 'check', files: [...BORROWED_CANARY_FILES] })).not.toBeNull();
    expect(slice({ use: 'check', files: [UNIT_A] })).toBeNull();
    expect(slice({ use: 'compare', files: [BORROWED_CANARY_FILES[0]] })).toBeNull();
    expect(slice({ retrial: true, use: 'count' })).toBeNull(); // a trial is always compare-only
    expect(parseProxyOp({ op: 'learned', observations: [] })).toBeNull(); // not an operation a child may ask
    expect(parseProxyOp({ op: 'cancel', attemptIds: ['a'.repeat(32)], verifyOver: true })).toBeNull();
    expect(parseProxyOp(null)).toBeNull();
  });

  it('plan, prepare, slice, status and cancel go through signed, and each answer\'s signature is checked', async () => {
    const s = setup();
    s.start();
    const plan = await s.call({ op: 'plan' });
    expect(plan.body).toMatchObject({ ok: true, helper: 'm_laptop', mode: 'practice', assigned: 'counting', answered: true, spotOneIn: 20, lanes: { unit: { state: 'practice', mayCount: false }, integration: { mayCount: false }, e2e: { mayCount: false } } });
    expect((await s.call({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 })).body).toMatchObject({ ok: true });
    for (let i = 0; i < 200 && s.r.tree()?.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 5));
    const sl = await s.call({ op: 'slice', lane: 'unit', files: [UNIT_A, UNIT_B], use: 'compare', budgetMs: 10_000, deadlineInMs: 60_000 });
    expect(sl.body).toMatchObject({ ok: true, answer: { state: 'queued' } });
    const attemptId = (sl.body as { attemptId: string }).attemptId;
    expect((sl.body as { answer: { attemptId: string } }).answer.attemptId).toBe(attemptId);
    const st = await s.call({ op: 'status', since: 0 });
    expect(st.body).toMatchObject({ ok: true, status: { enabled: true } });
    expect((st.body as { status: { sig: unknown } }).status.sig).toBeTruthy();
    // A cancel may name only slices this server issued for this verify.
    expect(await s.call({ op: 'cancel', attemptIds: ['9'.repeat(32)] })).toEqual({ status: 400, body: { ok: false, reason: 'unknown-slice' } });
    expect((await s.call({ op: 'cancel', attemptIds: [attemptId] })).body).toMatchObject({ ok: true });
    expect((await s.call({ op: 'cancel', verifyOver: true })).body).toMatchObject({ ok: true });
    // Every forwarded request carries this server's run id, never one of the caller's, and the 5-second limit.
    const runIds = new Set(s.seen.filter((c) => c.body).map((c) => c.body!.runAttemptId));
    expect(runIds.size).toBe(1);
    expect(s.seen.filter((c) => c.call !== 'status' || c.timeoutMs !== 2_000).every((c) => c.timeoutMs === BORROWED_PROXY.callTimeoutMs)).toBe(true);
  });

  it('a slice may ask for its passes to be used only where the practice record admits it and the verify was not drawn compare-only', async () => {
    const s = setup({ mode: 'count' });
    s.start();
    const slice = { op: 'slice', lane: 'integration', files: ['tests/integration/x.test.ts'], use: 'count', budgetMs: 60_000, deadlineInMs: 60_000 };
    expect((await s.call(slice)).body).toEqual({ ok: false, reason: 'count-not-admitted' }); // mode `count` alone admits nothing
    completeEvidence(s);
    expect(decide(s).status).toBe(200);
    expect(((await s.call({ op: 'plan' })).body as { lanes: Record<string, { mayCount: boolean }> }).lanes.integration.mayCount).toBe(true);
    expect((await s.call(slice)).body).not.toMatchObject({ reason: 'count-not-admitted' });
    // The one-in-ten verify: nothing is held back, so nothing may be asked for counting.
    const drawn = setup({ mode: 'count', randomInt: () => 0 });
    completeEvidence(drawn);
    expect(decide(drawn).status).toBe(200);
    drawn.start();
    expect((await drawn.call(slice)).body).toEqual({ ok: false, reason: 'count-not-admitted' });
  });
});

describe('the loopback proxy can never hold a lane', () => {
  it('a helper that does not answer in 5 seconds reads as "no helper answer"', async () => {
    const never = <T,>() => new Promise<T>(() => {});
    const s = setup({ client: (r, seen) => ({ ...inProcessClient(r, seen), slice: () => never() }) });
    s.start();
    await s.call({ op: 'plan' }); // the verify's status request has been answered
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = s.call({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 });
    await vi.advanceTimersByTimeAsync(BORROWED_PROXY.callTimeoutMs - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 200, body: { ok: false, reason: 'no-helper-answer' } });
  });

  it('an unreachable helper, a throwing client and an answer whose signature does not hold all read as "no helper answer"', async () => {
    const dead = setup({ client: (r, seen) => ({ ...inProcessClient(r, seen), slice: async () => null, cancel: async () => null }) });
    dead.start();
    expect(await dead.call({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 })).toEqual({ status: 200, body: { ok: false, reason: 'no-helper-answer' } });
    expect(await dead.call({ op: 'cancel' })).toEqual({ status: 200, body: { ok: false, reason: 'no-helper-answer' } });
    const throwing = setup({ client: (r, seen) => ({ ...inProcessClient(r, seen), slice: async () => { throw new Error('boom'); } }) });
    throwing.start();
    expect(await throwing.call({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 })).toEqual({ status: 200, body: { ok: false, reason: 'no-helper-answer' } });
    expect(throwing.audits.some((a) => a.event === 'borrowed-proxy-error')).toBe(true);
    // The helper's answer altered on the way back.
    const forged = setup({ client: (r, seen) => { const c = inProcessClient(r, seen); return { ...c, slice: async (h, b, t, sg) => { const a = await c.slice(h, b, t, sg); return a ? { status: a.status, body: { ...(a.body as object), treeHash: 'f'.repeat(40) } } : a; } }; } });
    forged.start();
    expect(await forged.call({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 })).toEqual({ status: 200, body: { ok: false, reason: 'no-helper-answer' } });
    expect(forged.audits.find((a) => a.event === 'borrowed-proxy-answer-refused')).toMatchObject({ reason: 'signature-bad' });
    // A status answer altered on the way back.
    const forgedStatus = setup({ client: (r, seen) => { const c = inProcessClient(r, seen); let n = 0; return { ...c, status: async (h, sg, q, t) => (n++ === 0 ? c.status(h, sg, q, t) : parseHelperStatus({ ...wire(r.svc.status()), paused: true })) }; } });
    forgedStatus.start();
    expect(await forgedStatus.call({ op: 'status' })).toEqual({ status: 200, body: { ok: false, reason: 'no-helper-answer' } });
  });

  it('no answer to the verify\'s one status request means no helper for that verify', async () => {
    const s = setup({ client: (r, seen) => ({ ...inProcessClient(r, seen), status: async (_h, _s, _q, t) => { seen.push({ call: 'status', timeoutMs: t }); return null; } }) });
    s.start();
    expect((await s.call({ op: 'plan' })).body).toMatchObject({ ok: true, answered: false });
    expect(await s.call({ op: 'prepare', lane: 'unit', deadlineInMs: 60_000 })).toEqual({ status: 200, body: { ok: false, reason: 'no-helper' } });
    expect(s.seen.filter((c) => c.call === 'slice')).toEqual([]);
    expect(s.store.get('m_laptop').ask).toMatchObject({ unanswered: 1 });
  });
});

describe('asking at the start of a verify, and the assignment drawn before it', () => {
  it('draws and records the assignment before the helper is asked, then sends one status request with the 2-second limit', async () => {
    const order: string[] = [];
    const s = setup({ randomInt: (n) => { order.push(`draw:${n}`); return 0; }, client: (r, seen) => { const c = inProcessClient(r, seen); return { ...c, status: async (h, sg, q, t) => { order.push(`status:${t}`); return c.status(h, sg, q, t); } }; } });
    s.start();
    await s.call({ op: 'plan' });
    expect(order).toEqual(['draw:10', 'status:2000']);
    expect(s.audits.find((a) => a.event === 'borrowed-assigned')).toMatchObject({ pr: 3501, headSha: HEAD, helper: 'm_laptop', assigned: 'compare-only' });
    expect(s.machine.assignmentFor(TOKEN)).toBe('compare-only');
    // A main verify draws nothing and asks nothing here (its observer does, detached).
    const m = setup();
    m.start(TOKEN, 'main');
    await new Promise((r) => setTimeout(r, 10));
    expect(m.seen).toEqual([]);
    expect(m.machine.assignmentFor(TOKEN)).toBeNull();
  });

  it('after 10 unanswered verifies only every 5th asks; a valid "I am here" restores asking on the next verify', async () => {
    const s = setup({ client: (r, seen) => ({ ...inProcessClient(r, seen), status: async () => { seen.push({ call: 'status' }); return null; } }) });
    const verify = async (i: number) => { const t = i.toString(16).padStart(32, '0'); s.start(t); await s.call({ op: 'plan' }, t); s.machine.onVerifyEnd({ token: t, recorded: true, outcome: 'success', cancelled: false }); };
    for (let i = 0; i < 14; i++) await verify(i);
    expect(s.seen.filter((c) => c.call === 'status').length).toBe(10);
    const here = signHelperHere(s.r.helperKeys.signer, { kind: 'here', helperMachineId: 'm_laptop', runMachineId: 'm_studio', why: 'wake', at: s.r.clock.t, expiresAt: s.r.clock.t + 60_000, runnerVersion: 'hr1:runner-one' });
    expect(s.machine.helperHere(wire(here), { remoteAddress: '100.64.0.9' })).toEqual({ status: 200, body: { ok: true } });
    await verify(20);
    expect(s.seen.filter((c) => c.call === 'status').length).toBe(11);
  });
});

describe('"I am here"', () => {
  const here = (r: HelperRig, over: Partial<HelperHereRequest> = {}, signer = r.helperKeys.signer): HelperHereRequest =>
    wire(signHelperHere(signer, { kind: 'here', helperMachineId: 'm_laptop', runMachineId: 'm_studio', why: 'start', at: r.clock.t, expiresAt: r.clock.t + 60_000, runnerVersion: 'hr1:runner-one', ...over }));
  const slowed = (s: ReturnType<typeof setup>) => { s.store.get('m_laptop').ask = { unanswered: 12, silentSince: s.r.clock.t - 8 * DAY, skippedSinceAsk: 2 }; };

  it('verified against the paired helper\'s machine key, it restores asking at once (also after the 7-day stop)', () => {
    const s = setup();
    slowed(s);
    expect(s.machine.helperHere(here(s.r), {})).toEqual({ status: 200, body: { ok: true } });
    expect(s.store.get('m_laptop').ask).toEqual({ unanswered: 0, silentSince: null, skippedSinceAsk: 0 });
    expect(s.audits.find((a) => a.event === 'helper-here')).toMatchObject({ helper: 'm_laptop', why: 'start' });
    expect(new BorrowedPracticeStore(s.stateDir).get('m_laptop').ask.unanswered).toBe(0); // written
  });

  it('a bad signature changes nothing: a body altered after signing, another machine\'s key, and no signature', () => {
    const s = setup();
    slowed(s);
    const before = wire(s.store.get('m_laptop').ask);
    expect(s.machine.helperHere({ ...here(s.r), why: 'wake' }, {})).toEqual({ status: 401, body: { ok: false, reason: 'signature-bad' } });
    // Signed by a key that is not the paired helper's pinned key.
    const stranger = machineKeys('m_laptop');
    expect(s.machine.helperHere(here(s.r, {}, stranger.signer), {})).toMatchObject({ status: 401, body: { reason: 'signature-unknown-key' } });
    // Signed by another machine in its own name, claiming to be the helper.
    const other = machineKeys('m_other');
    expect(s.machine.helperHere(here(s.r, {}, other.signer), {})).toMatchObject({ status: 401, body: { reason: 'signature-wrong-machine' } });
    const { sig: _sig, ...unsigned } = here(s.r);
    void _sig;
    expect(s.machine.helperHere(unsigned, {})).toMatchObject({ status: 401, body: { reason: 'unsigned' } });
    expect(s.store.get('m_laptop').ask).toEqual(before);
    expect(s.audits.filter((a) => a.event === 'helper-here')).toEqual([]);
    expect(s.audits.filter((a) => a.event === 'helper-here-refused').length).toBe(4);
  });

  it('refuses a machine that is not this run machine\'s helper, one meant for another run machine, an expired one, the tunnel and a malformed body', () => {
    const s = setup();
    slowed(s);
    expect(s.machine.helperHere(here(s.r, { helperMachineId: 'm_winpc' }), {})).toMatchObject({ status: 403, body: { reason: 'unknown-helper' } });
    expect(s.machine.helperHere(here(s.r, { runMachineId: 'm_m5' }), {})).toMatchObject({ status: 409, body: { reason: 'wrong-run-machine' } });
    expect(s.machine.helperHere(here(s.r, { at: s.r.clock.t - 10 * 60_000, expiresAt: s.r.clock.t - 9 * 60_000 }), {})).toMatchObject({ status: 409, body: { reason: 'expired' } });
    expect(s.machine.helperHere(here(s.r), { cfConnectingIp: '203.0.113.9' })).toMatchObject({ status: 403, body: { reason: 'tunnel' } });
    expect(s.machine.helperHere({ kind: 'here' }, {})).toMatchObject({ status: 400 });
    expect(s.machine.helperHere({ ...here(s.r), extra: 1 }, {})).toMatchObject({ status: 400 });
    expect(s.store.get('m_laptop').ask.unanswered).toBe(12);
    expect(setup({ mode: 'off' }).machine.helperHere(here(s.r), {}).status).toBe(404);
  });
});

describe('the decision to count', () => {
  it('is refused without the evidence, naming what is missing, and writes nothing to the practice record', () => {
    const s = setup({ mode: 'count' });
    const r = decide(s);
    expect(r).toMatchObject({ status: 409, body: { ok: false, code: 'evidence-incomplete', missing: ['coverage', 'spread', 'failing-direction', 'check-slice'] } });
    expect(s.store.peekLane('m_laptop', 'integration')).toMatchObject({ state: 'practice', decision: null });
    expect(s.audits.find((a) => a.event === 'borrowed-decision-refused')).toMatchObject({ helper: 'm_laptop', lane: 'integration', code: 'evidence-incomplete' });
    expect(s.evidence).toEqual([{ kind: 'held', reason: 'count-decision-refused:evidence-incomplete', subject: 'm_laptop', context: { lane: 'integration', sevenDayException: false, missing: 'coverage,spread,failing-direction,check-slice' } }]);
    expect(s.audits.some((a) => a.event === 'borrowed-decision')).toBe(false);
  });

  it('with complete evidence it is written to the practice record, the audit log and the ladder\'s evidence log; only that lane counts', () => {
    const s = setup({ mode: 'count' });
    completeEvidence(s);
    const r = decide(s);
    expect(r).toMatchObject({ status: 200, body: { ok: true, helper: 'm_laptop', lane: 'integration', state: 'counting', usedException: false, mode: 'count' } });
    const stored = new BorrowedPracticeStore(s.stateDir); // read back from the file
    expect(stored.peekLane('m_laptop', 'integration')).toMatchObject({ state: 'counting', decision: { reason: 'practice report reviewed', sevenDayException: false, by: 'echo-increasing-throughput', at: s.r.clock.t } });
    expect(stored.peekLane('m_laptop', 'e2e')).toBeNull(); // a second lane needs its own decision
    expect(s.audits.find((a) => a.event === 'borrowed-decision')).toMatchObject({ helper: 'm_laptop', lane: 'integration', reason: 'practice report reviewed', by: 'echo-increasing-throughput', mode: 'count' });
    expect(s.evidence.at(-1)).toEqual({ kind: 'fired', reason: 'count-decision', subject: 'm_laptop', context: { lane: 'integration', sevenDayException: false, usedException: false, decidedBy: 'echo-increasing-throughput', runMachine: 'm_studio' } });
    expect(decide(s)).toMatchObject({ status: 409, body: { code: 'already-counting' } });
    expect(decide(s, { lane: 'e2e' })).toMatchObject({ status: 409, body: { code: 'evidence-incomplete' } });
  });

  it('the 7-day exception is refused on day 6 and recorded on day 7', () => {
    const s = setup();
    const t0 = s.r.clock.t;
    s.machine.recordDryRunResult('m_laptop', 'integration', { eligible: [f(1)], compared: [f(1)], eligibleDigest: 'a'.repeat(64) });
    const steps: Array<Partial<LaneVerifyOutcome>> = [
      { verifyId: 'v1', agreed: [f(1)], failingAgreed: [f(7), f(8)], check: 'right' }, { verifyId: 'v2', agreed: [f(1)], failingAgreed: [f(7)], check: 'right' },
      { verifyId: 'v3', agreed: [f(1)] }, { verifyId: 'v4', agreed: [f(1)] }, { verifyId: 'v5', agreed: [f(1)] },
    ];
    for (const st of steps) s.machine.recordVerify('m_laptop', { integration: outcome(st) });
    expect(decide(s)).toMatchObject({ status: 409, body: { code: 'evidence-incomplete', missing: ['failing-direction'] } });
    s.r.clock.t = t0 + 7 * DAY - 1;
    expect(decide(s, { sevenDayException: true })).toMatchObject({ status: 409, body: { code: 'exception-too-early' } });
    s.r.clock.t = t0 + 7 * DAY;
    expect(decide(s, { sevenDayException: true })).toMatchObject({ status: 200, body: { state: 'counting', usedException: true } });
    expect(s.store.peekLane('m_laptop', 'integration')?.decision).toMatchObject({ sevenDayException: true });
  });

  it('refuses a malformed body, an unknown helper, and everything while the setting is absent', () => {
    const s = setup();
    expect(decide(s, { helper: 'm_winpc' })).toMatchObject({ status: 404, body: { code: 'unknown-helper' } });
    for (const bad of [{ lane: 'smoke' }, { reason: '' }, { reason: 'x'.repeat(501) }, { sevenDayException: 'yes' }, { extra: true }, { by: '' }]) expect(decide(s, bad).status).toBe(400);
    expect(s.machine.decide(null).status).toBe(400);
    expect(decide(setup({ mode: 'off' })).status).toBe(404);
  });

  it('a dry-run request is recorded as an intent for the later dry-run task, and can be stopped', () => {
    const s = setup();
    const r = s.machine.dryRun({ helper: 'm_laptop', lanes: ['integration', 'e2e'], by: 'echo' });
    expect(r).toMatchObject({ status: 202, body: { ok: true, intent: { lanes: ['integration', 'e2e'], state: 'requested', by: 'echo', requestedAt: s.r.clock.t } } });
    expect(new BorrowedPracticeStore(s.stateDir).get('m_laptop').dryRunIntent).toMatchObject({ lanes: ['integration', 'e2e'], state: 'requested' });
    expect(s.audits.find((a) => a.event === 'borrowed-dry-run-requested')).toMatchObject({ helper: 'm_laptop', action: 'start' });
    expect(s.machine.dryRun({ helper: 'm_laptop' }).body).toMatchObject({ intent: { lanes: ['unit', 'integration', 'e2e'] } });
    expect(s.machine.dryRun({ helper: 'm_laptop', action: 'stop' }).body).toMatchObject({ intent: { state: 'stopped' } });
    expect(s.machine.dryRun({ helper: 'm_winpc' }).status).toBe(404);
    expect(s.machine.dryRun({ helper: 'm_laptop', lanes: ['smoke'] }).status).toBe(400);
    expect(s.machine.dryRun({ helper: 'm_laptop', commit: sha('f') }).status).toBe(400);
    expect(setup({ mode: 'off' }).machine.dryRun({ helper: 'm_laptop' }).status).toBe(404);
  });
});

describe('helper events: who is told, once, by the coordinator', () => {
  const counting = (o: Opts = {}) => { const s = setup({ mode: 'count', ...o }); completeEvidence(s); expect(decide(s).status).toBe(200); return s; };
  const wrongOnCompareOnly = (s: ReturnType<typeof setup>, id: string) => s.machine.recordVerify('m_laptop', { integration: outcome({ verifyId: id, kind: 'main', change: null, compareOnly: true, assigned: 'compare-only', agreed: [f(1)], confirmedWrongPasses: [f(2)] }) });

  it('a confirmed wrong pass and the lapse it causes go to the audit log and the line\'s session; the owner is not told', () => {
    const s = counting();
    wrongOnCompareOnly(s, 'cmp');
    expect(s.store.peekLane('m_laptop', 'integration')?.state).toBe('lapsed: wrong-pass-compare-only');
    expect(s.audits.filter((a) => a.event === 'borrowed-helper-event').map((a) => a.kind)).toEqual(['wrong-pass', 'lapse']);
    expect(s.notices.map((n) => [n.who, n.event.kind])).toEqual([['line', 'wrong-pass'], ['line', 'lapse']]);
    expect(s.notices[0].event).toMatchObject({ helper: 'm_laptop', lane: 'integration', runMachineId: 'm_studio', file: f(2) });
    expect(s.store.get('m_laptop').spot.raisedVerifiesLeft).toBe(50); // any disagreement raises the spot re-run rate
    // Told once: a tick does not send them again.
    s.machine.tick();
    expect(s.notices.length).toBe(2);
  });

  it('the owner is told at the third fault lapse within 7 days, and never for ordinary lapses', () => {
    const s = setup({ mode: 'count' });
    const again = () => { completeEvidence(s); expect(decide(s).status).toBe(200); };
    for (let i = 0; i < 3; i++) {
      again();
      wrongOnCompareOnly(s, `cmp${i}`);
      s.r.clock.t += DAY;
    }
    expect(s.notices.filter((n) => n.who === 'owner').map((n) => [n.event.kind, n.ownerReason])).toEqual([['lapse', 'three-fault-lapses']]);
    expect(s.notices.filter((n) => n.who === 'line').length).toBe(6);
    // Ordinary lapses: 7 days without an agreeing comparison, three times, tell the line only.
    const o = setup({ mode: 'count' });
    for (let i = 0; i < 3; i++) {
      completeEvidence(o);
      expect(decide(o).status).toBe(200);
      o.r.clock.t += 7 * DAY;
      o.machine.tick();
      expect(o.store.peekLane('m_laptop', 'integration')?.state).toBe('lapsed: no-agreeing-comparison');
    }
    expect(o.notices.filter((n) => n.who === 'owner')).toEqual([]);
    expect(o.notices.filter((n) => n.who === 'line').map((n) => n.event.reason)).toEqual(['no-agreeing-comparison', 'no-agreeing-comparison', 'no-agreeing-comparison']);
  });

  it('a peer never sends: it lists its events in its status, and the coordinator tells each once', () => {
    const peer = counting({ coordinator: false, machineId: 'm_m5' });
    wrongOnCompareOnly(peer, 'cmp');
    expect(peer.notices).toEqual([]);
    const extras = peer.machine.peerStatusExtras();
    expect(extras).toMatchObject({ wantsBaseline: true, helpers: ['m_laptop'] });
    expect((extras.helperEvents as HelperEvent[]).map((e) => e.kind)).toEqual(['wrong-pass', 'lapse']);
    const coord = setup({ mode: 'off' }); // the coordinator needs no helper of its own to relay
    coord.machine.onPeerStatus({ machineId: 'm_m5', url: 'http://m5:4042' }, wire(extras));
    expect(coord.notices.map((n) => [n.who, n.event.kind, n.event.runMachineId])).toEqual([['line', 'wrong-pass', 'm_m5'], ['line', 'lapse', 'm_m5']]);
    coord.machine.onPeerStatus({ machineId: 'm_m5', url: 'http://m5:4042' }, wire(extras)); // the next poll carries the same list
    expect(coord.notices.length).toBe(2);
    // The told ids survive a coordinator restart.
    const restarted = setup({ mode: 'off', stateDir: coord.stateDir });
    restarted.machine.onPeerStatus({ machineId: 'm_m5', url: 'http://m5:4042' }, wire(extras));
    expect(restarted.notices).toEqual([]);
    // Events claimed for another run machine, or malformed, are refused whole.
    const liar = setup({ mode: 'off' });
    liar.machine.onPeerStatus({ machineId: 'm_other', url: 'http://x:1' }, wire(extras));
    expect(liar.notices).toEqual([]);
    expect(liar.audits.some((a) => a.event === 'borrowed-peer-events-refused')).toBe(true);
    // A machine that becomes the coordinator tells what it had not told.
    peer.cfg.coordinator = true;
    peer.machine.tick();
    expect(peer.notices.map((n) => n.event.kind)).toEqual(['wrong-pass', 'lapse']);
  });

  it('a changed runner version in the helper\'s status lapses a counting lane as an ordinary event', async () => {
    let version = 'hr1:one';
    const s = counting({ client: (r, seen) => { const c = inProcessClient(r, seen); return { ...c, status: async () => { seen.push({ call: 'status' }); const body = wire(r.svc.status()) as Record<string, unknown>; delete body.sig; return parseHelperStatus(wire(signHelperStatus(r.helperKeys.signer, { ...body, runnerVersion: version, sandbox: { ...(body.sandbox as object), image: { imageDigest: 'sha256:img', settingsHash: 'set1' } } }))); } }; } });
    s.start('a'.repeat(32));
    await s.call({ op: 'plan' }, 'a'.repeat(32));
    expect(s.store.peekLane('m_laptop', 'integration')).toMatchObject({ state: 'counting', identity: { image: 'sha256:img:set1', runnerVersion: 'hr1:one' } });
    version = 'hr1:two';
    s.start('b'.repeat(32));
    await s.call({ op: 'plan' }, 'b'.repeat(32));
    expect(s.store.peekLane('m_laptop', 'integration')?.state).toBe('lapsed: runner-version-changed');
    expect(s.notices.map((n) => [n.who, n.event.reason, n.event.fault])).toEqual([['line', 'runner-version-changed', false]]);
  });
});

describe('the baseline results', () => {
  const counts = (n = 2): Record<string, FileCountsRow> => Object.fromEntries(Array.from({ length: n }, (_, i) => [f(i), [3, 0, 1, 0, 'b'.repeat(64)] as FileCountsRow]));
  const green = (c: string, fileCounts: unknown = counts()) => ({ commit: sha(c), finishedAt: '2026-11-19T08:00:00.000Z', machineId: 'm_studio', fileCounts });

  it('are wanted only when a helper is configured here or on a peer; with neither, nothing is asked, kept or written', () => {
    const off = setup({ mode: 'off' });
    expect(off.machine.wantsMainFileCounts()).toBe(false);
    off.machine.onGreenMain(green('a'));
    expect(off.baseline.read()).toEqual({ ok: false, reason: 'absent' });
    expect(off.machine.peerStatusExtras()).toEqual({});
    expect(setup().machine.wantsMainFileCounts()).toBe(true);
    off.machine.onPeerStatus({ machineId: 'm_m5', url: 'http://m5:4042' }, { wantsBaseline: true, helpers: ['m_winpc'] });
    expect(off.machine.wantsMainFileCounts()).toBe(true); // the M5 has a helper: the coordinator keeps baselines for it
    expect(off.machine.knownHelper('m_winpc', 'm_m5')).toBe(true);
    expect(off.machine.knownHelper('m_winpc')).toBe(false);
    expect(off.machine.knownHelper('m_laptop', 'm_m5')).toBe(false);
  });

  it('the coordinator keeps a green main verify\'s per-file counts; a peer never writes its own; a malformed map is skipped', () => {
    const s = setup();
    s.machine.onGreenMain(green('a'));
    expect(s.baseline.baselines().map((b) => [b.commit, Object.keys(b.files).length])).toEqual([[sha('a'), 2]]);
    s.machine.onGreenMain(green('b', { [f(1)]: [1, 0, 0, 0, 'short'] }));
    s.machine.onGreenMain(green('c', null));
    expect(s.baseline.baselines().map((b) => b.commit)).toEqual([sha('a')]);
    expect(s.audits.filter((a) => a.event === 'main-file-counts-skipped').map((a) => a.reason)).toEqual(['malformed', 'not-carried']);
    const peer = setup({ coordinator: false });
    peer.machine.onGreenMain(green('a'));
    expect(peer.baseline.read()).toEqual({ ok: false, reason: 'absent' });
    expect((s.machine.info() as { baseline: { ok: boolean; baselines: Array<{ commit: string; files: number }> } }).baseline).toMatchObject({ ok: true, baselines: [{ commit: sha('a'), files: 2 }] });
  });

  it('is sent to a peer that wants it when it changes, not with every poll, and stored there only from the coordinator', async () => {
    const sent: Array<{ peer: string; body: { coordinatorMachineId: string; file: unknown } }> = [];
    const peer = setup({ coordinator: false, machineId: 'm_m5' });
    const lease = { holdsLease: false, holderMachineId: 'm_studio' };
    const coord = setup({ postPeerBaseline: async (p, body) => { sent.push({ peer: p.machineId, body: wire(body) as { coordinatorMachineId: string; file: unknown } }); return peer.machine.acceptPeerBaseline(wire(body), lease).status === 200; } });
    const poll = async () => { coord.machine.onPeerStatus({ machineId: 'm_m5', url: 'http://m5:4042' }, wire(peer.machine.peerStatusExtras())); await new Promise((r) => setTimeout(r, 5)); };
    await poll();
    expect(sent).toEqual([]); // nothing to send yet
    coord.machine.onGreenMain(green('a'));
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.map((x) => x.peer)).toEqual(['m_m5']);
    expect(peer.baseline.baselines().map((b) => b.commit)).toEqual([sha('a')]);
    expect(peer.baseline.hash()).toBe(coord.baseline.hash());
    await poll();
    await poll();
    expect(sent.length).toBe(1); // unchanged: not sent again
    coord.machine.onGreenMain(green('b'));
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.length).toBe(2);
    expect(peer.baseline.baselines().map((b) => b.commit)).toEqual([sha('b'), sha('a')]);
    // A peer that does not store an offered version is offered it again only after the retry time.
    let refusals = 0;
    const deaf = setup({ postPeerBaseline: async () => { refusals++; return false; } });
    deaf.machine.onPeerStatus({ machineId: 'm_m5', url: 'http://m5:4042' }, { wantsBaseline: true, helpers: ['m_winpc'] });
    deaf.machine.onGreenMain(green('a'));
    await new Promise((r) => setTimeout(r, 5));
    deaf.machine.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(refusals).toBe(1);
    deaf.r.clock.t += BORROWED_PROXY.baselineRetryMs;
    deaf.machine.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(refusals).toBe(2);
    // The peer side refuses anyone but the lease holder, a lease holder storing a "coordinator's copy", and a malformed file.
    const body = sent[1].body;
    expect(peer.machine.acceptPeerBaseline(body, { holdsLease: false, holderMachineId: 'm_other' })).toMatchObject({ status: 409, body: { reason: 'not-coordinator' } });
    expect(peer.machine.acceptPeerBaseline(body, { holdsLease: false, holderMachineId: null })).toMatchObject({ status: 409 });
    expect(peer.machine.acceptPeerBaseline(body, { holdsLease: true, holderMachineId: 'm_studio' })).toMatchObject({ status: 409, body: { reason: 'is-lease-holder' } });
    expect(peer.machine.acceptPeerBaseline({ ...body, file: { v: 1, baselines: 'all', pinned: [] } }, lease).status).toBe(400);
    expect(peer.machine.acceptPeerBaseline({ ...body, extra: 1 }, lease).status).toBe(400);
    expect(setup({ mode: 'off', coordinator: false }).machine.acceptPeerBaseline(body, lease).status).toBe(404);
  });
});

describe('GET /local-verify: the borrowed summary', () => {
  it('shows the mode and, per helper and lane, the state, each evidence item\'s progress, and the last verify\'s share and how much the helper finished', () => {
    const s = setup({ mode: 'count' });
    completeEvidence(s);
    s.machine.recordVerify('m_laptop', { integration: outcome({ verifyId: 'last', sent: 40, finished: 31, agreed: [f(1)] }) });
    const info = s.machine.info() as { mode: string; countBehavesAsPractice: boolean; helpers: Array<{ machineId: string; asking: unknown; spotOneIn: number; lanes: Record<string, { state: string; mayCount: boolean; evidence: Record<string, { complete: boolean }> | null; lastVerify: unknown }> }> };
    expect(info).toMatchObject({ mode: 'count', countBehavesAsPractice: true });
    const lane = info.helpers[0].lanes.integration;
    expect(lane).toMatchObject({
      state: 'practice', mayCount: false,
      evidence: {
        coverage: { dryRunDone: true, eligible: 2, uncovered: 0, complete: true },
        spread: { verifies: 6, waiting: 6, complete: true },
        failingDirection: { comparisons: 5, files: 3, verifies: 2, complete: true },
        checkSlice: { seen: 5, right: 5, complete: true },
        wrongPassWindow: { inWindow: 0, complete: true },
      },
      lastVerify: { assigned: 'counting', sent: 40, finished: 31 },
    });
    expect(info.helpers[0].lanes.unit).toMatchObject({ state: 'practice', mayCount: false, evidence: null, lastVerify: null });
    expect(info.helpers[0]).toMatchObject({ machineId: 'm_laptop', spotOneIn: 20 });
    expect(setup({ mode: 'off' }).machine.info()).toMatchObject({ mode: 'off', helpers: [], baseline: null });
  });
});
