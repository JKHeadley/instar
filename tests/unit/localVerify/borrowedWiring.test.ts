// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Wiring integrity for the run machine's borrowed-helper side (docs/specs/local-verify-borrowed-slices-count.md, F):
 * `wireBorrowedRunMachine`, the function server.ts calls, hands the service a seam and an observer
 * whose dependencies are real and delegate: one practice record shared by both, the signer and the
 * pinned keys, the HTTP client (Bearer credential, the 2-second status limit), the audit log (where
 * the baseline file's hash is written and later checked), the attention seam for notices, the
 * evidence log for the decision, and the lease for "only the coordinator".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { BORROWED_NOTICE_KEYS, localVerifyAttentionItem, makePeerClient, wireBorrowedRunMachine, wireBorrowedShadow } from '../../../src/localVerify/localVerifyWiring.js';
import type { BorrowedRunSeam, MainRunObserver } from '../../../src/localVerify/mainRunObserver.js';
import { BorrowedPracticeStore } from '../../../src/localVerify/borrowedState.js';
import { signHelperHere } from '../../../src/localVerify/helper/helperProtocol.js';
import type { LaneVerifyOutcome } from '../../../src/localVerify/borrowedPractice.js';
import { HEAD, helperRig, pins, sha, type HelperRig } from '../../helpers/borrowedHelperFixture.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedWiring.test.ts' }); });
const AUTH = 'wiring-bearer';
const f = (n: number) => `tests/integration/f${n}.test.ts`;

function helperFetch(r: HelperRig, calls: Array<{ url: string; method: string; auth: string | null; agent: string | null; body?: unknown }>, peer: { status: number } = { status: 200 }): typeof fetch {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url: `${url.origin}${url.pathname}`, method: init?.method ?? 'GET', auth: headers.get('authorization'), agent: headers.get('x-instar-agentid'), body });
    if (url.pathname === '/local-verify/helper-status') return json(200, r.svc.status());
    if (url.pathname === '/local-verify/helper-slice') { const a = await r.svc.handleSlice(body, r.route); return json(a.status, a.body); }
    if (url.pathname === '/local-verify/peer-baseline') return json(peer.status, { ok: peer.status === 200 });
    return json(404, {});
  }) as typeof fetch;
}

async function wire(o: { mode?: 'practice' | 'count' | null; holdsLease?: boolean | null } = {}) {
  const r = helperRig({}, dirs);
  r.clock.t = Date.now(); // the wiring runs on the real clock
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvwire-')));
  dirs.push(stateDir);
  const set: { observer: MainRunObserver | null; seam: BorrowedRunSeam | null } = { observer: null, seam: null };
  const calls: Array<{ url: string; method: string; auth: string | null; agent: string | null; body?: unknown }> = [];
  const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const mode = o.mode === undefined ? 'count' : o.mode;
  const lease = { holds: o.holdsLease ?? true };
  const wired = await wireBorrowedRunMachine({ setMainRunObserver: (x) => { set.observer = x; }, setBorrowedRunSeam: (x) => { set.seam = x; } }, {
    liveConfig: { get: <T>(k: string, fb: T): T => (k === 'monitoring.localVerify.borrowed' && mode ? { mode, helpers: [{ machineId: 'm_laptop', url: 'http://100.64.0.9:4042' }] } as T : fb) },
    stateDir, agentHome: stateDir, machineId: 'm_studio', authToken: AUTH, agentId: 'echo', version: 'w',
    fetchImpl: helperFetch(r, calls), signer: r.requester.signer, keyLookup: () => pins(r.helperKeys),
    ...(o.holdsLease === null ? {} : { lease: { holdsLease: () => lease.holds } }),
    hooks: { signal: (key, detail) => { signals.push({ key, detail }); } },
    evidence: (row) => { evidence.push(row); },
  });
  const audit = () => fs.existsSync(path.join(stateDir, 'logs', 'local-verify.jsonl'))
    ? fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  return { r, stateDir, set, calls, signals, evidence, wired, audit, lease };
}

const outcome = (over: Partial<LaneVerifyOutcome>): LaneVerifyOutcome => ({
  verifyId: 'v', kind: 'waiting', change: '7', compareOnly: false, assigned: 'counting', sent: 2, finished: 2, agreed: [], digestDiffersBothPass: [], helperFailedLocalPassed: [],
  confirmedWrongPasses: [], failingAgreed: [], environmentDifferences: 0, check: null, answers: ['valid'], ...over,
});

function complete(w: Awaited<ReturnType<typeof wire>>): void {
  w.wired.machine.recordDryRunResult('m_laptop', 'integration', { eligible: [f(1)], compared: [f(1)], eligibleDigest: 'a'.repeat(64) });
  const steps: Array<Partial<LaneVerifyOutcome>> = [
    { verifyId: 'v1', agreed: [f(1)], failingAgreed: [f(7), f(8), f(9)], check: 'right' }, { verifyId: 'v2', agreed: [f(1)], failingAgreed: [f(7), f(8)], check: 'right' },
    { verifyId: 'v3', agreed: [f(1)] }, { verifyId: 'v4', agreed: [f(1)] }, { verifyId: 'v5', agreed: [f(1)] },
  ];
  for (const s of steps) w.wired.machine.recordVerify('m_laptop', { integration: outcome(s) });
}

describe('wireBorrowedRunMachine: real dependencies, not no-ops', () => {
  it('hands the service both the observer and the seam, and they are the objects it returns', async () => {
    const w = await wire();
    expect(w.set.observer).toBe(w.wired.shadow);
    expect(w.set.seam).toBe(w.wired.machine);
    expect(typeof w.set.seam!.proxy).toBe('function');
    // The older entry point still wires both and returns the observer.
    const set: { observer: unknown; seam: unknown } = { observer: null, seam: null };
    const shadow = await wireBorrowedShadow({ setMainRunObserver: (x) => { set.observer = x; }, setBorrowedRunSeam: (x) => { set.seam = x; } }, {
      liveConfig: { get: <T>(_k: string, fb: T): T => fb }, stateDir: w.stateDir, agentHome: w.stateDir, machineId: 'm_studio', authToken: AUTH, agentId: 'echo', version: 'w',
      signer: null, keyLookup: () => pins(),
    });
    expect(set.observer).toBe(shadow);
    expect(set.seam).not.toBeNull();
  });

  it('with the setting absent the wired seam is inert: no request, no file, no notice', async () => {
    const w = await wire({ mode: null });
    const seam = w.set.seam!;
    seam.onVerifyStart({ token: '1'.repeat(32), kind: 'waiting', pr: 7, baseSha: HEAD, headSha: HEAD, startedAt: Date.now() });
    seam.onGreenMain({ commit: HEAD, finishedAt: '2026-11-19T08:00:00.000Z', machineId: 'm_studio', fileCounts: { [f(1)]: [1, 0, 0, 0, 'a'.repeat(64)] } });
    seam.tick();
    expect(seam.wantsMainFileCounts()).toBe(false);
    expect(seam.peerStatusExtras()).toEqual({});
    expect(seam.decide({ helper: 'm_laptop', lane: 'integration', reason: 'r' }).status).toBe(404);
    expect((await seam.proxy('1'.repeat(32), { op: 'plan' }, { remoteAddress: '127.0.0.1' })).status).toBe(404);
    await new Promise((res) => setTimeout(res, 20));
    expect(w.calls).toEqual([]);
    expect(w.signals).toEqual([]);
    expect(fs.existsSync(path.join(w.stateDir, 'state', 'local-verify', 'main-file-counts.json'))).toBe(false);
    expect(fs.existsSync(path.join(w.stateDir, 'state', 'local-verify', 'borrowed-helpers.json'))).toBe(false);
  });

  it('the client is real: the verify-start status request goes to the helper\'s address with the Bearer credential, and the signed answer is verified with the pinned key', async () => {
    const w = await wire();
    w.set.seam!.onVerifyStart({ token: '1'.repeat(32), kind: 'waiting', pr: 7, baseSha: HEAD, headSha: HEAD, startedAt: Date.now() });
    const plan = await w.set.seam!.proxy('1'.repeat(32), { op: 'plan' }, { remoteAddress: '127.0.0.1' });
    expect(plan.body).toMatchObject({ ok: true, answered: true, helper: 'm_laptop' });
    expect(w.calls[0]).toMatchObject({ url: 'http://100.64.0.9:4042/local-verify/helper-status', method: 'GET', auth: `Bearer ${AUTH}`, agent: 'echo' });
    // The signer is real: the forwarded request verifies on the helper (a real HelperService) and comes back signed.
    const prep = await w.set.seam!.proxy('1'.repeat(32), { op: 'prepare', lane: 'unit', deadlineInMs: 60_000 }, { remoteAddress: '127.0.0.1' });
    expect(prep.body).toMatchObject({ ok: true, answer: { state: 'preparing', headSha: HEAD } });
    expect(w.audit().find((e) => e.event === 'borrowed-assigned')).toMatchObject({ src: 'borrowed', pr: 7 });
  });

  it('the observer and the seam share ONE practice record: "I am here" through the seam is what the observer\'s asking reads', async () => {
    const again = await wire();
    const here = JSON.parse(JSON.stringify(signHelperHere(again.r.helperKeys.signer, { kind: 'here', helperMachineId: 'm_laptop', runMachineId: 'm_studio', why: 'wake', at: Date.now(), expiresAt: Date.now() + 60_000, runnerVersion: 'hr1:runner-one' })));
    expect(again.set.seam!.helperHere(here, {})).toEqual({ status: 200, body: { ok: true } });
    // The observer's summary shows the same asking state the seam just wrote, and the file holds it.
    expect((again.wired.shadow.info() as { helpers: Array<{ asking: unknown }> }).helpers[0].asking).toEqual({ unanswered: 0, silentSince: null, skippedSinceAsk: 0 });
    expect((again.set.seam!.info() as { helpers: Array<{ asking: { unanswered: number } }> }).helpers[0].asking.unanswered).toBe(0);
    expect(new BorrowedPracticeStore(again.stateDir).get('m_laptop').ask.unanswered).toBe(0);
  });

  it('the decision reaches the practice record, the audit log and the evidence log', async () => {
    const w = await wire();
    complete(w);
    const r = w.set.seam!.decide({ helper: 'm_laptop', lane: 'integration', reason: 'practice report reviewed', by: 'echo-increasing-throughput' });
    expect(r).toMatchObject({ status: 200, body: { ok: true, state: 'counting' } });
    expect(new BorrowedPracticeStore(w.stateDir).peekLane('m_laptop', 'integration')?.state).toBe('counting');
    expect(w.audit().find((e) => e.event === 'borrowed-decision')).toMatchObject({ src: 'borrowed', helper: 'm_laptop', lane: 'integration' });
    expect(w.evidence).toEqual([{ kind: 'fired', reason: 'count-decision', subject: 'm_laptop', context: expect.objectContaining({ lane: 'integration', decidedBy: 'echo-increasing-throughput' }) }]);
  });

  it('notices go through the existing attention seam, one item per event, the owner\'s only for the third fault lapse; a peer sends none', async () => {
    const w = await wire();
    const lapseOnce = (i: number) => {
      complete(w);
      expect(w.set.seam!.decide({ helper: 'm_laptop', lane: 'integration', reason: 'r' }).status).toBe(200);
      w.wired.machine.recordVerify('m_laptop', { integration: outcome({ verifyId: `cmp${i}`, kind: 'main', change: null, compareOnly: true, assigned: 'compare-only', agreed: [f(1)], confirmedWrongPasses: [f(2)] }) });
    };
    lapseOnce(1);
    expect(w.signals.map((s) => s.key.replace(/:[0-9a-f]{32}$/, ''))).toEqual([BORROWED_NOTICE_KEYS.line, BORROWED_NOTICE_KEYS.line]);
    expect(new Set(w.signals.map((s) => s.key)).size).toBe(2); // one item per event id
    expect(w.signals[0].detail).toMatchObject({ helper: 'm_laptop', lane: 'integration', kind: 'wrong-pass', audience: 'line' });
    expect(String(w.signals[0].detail.note)).toContain(f(2));
    lapseOnce(2);
    lapseOnce(3);
    const owner = w.signals.filter((s) => s.key.startsWith(`${BORROWED_NOTICE_KEYS.owner}:`));
    expect(owner.length).toBe(1);
    expect(owner[0].detail).toMatchObject({ kind: 'lapse', audience: 'owner' });
    expect(String(owner[0].detail.note)).toContain('three times in 7 days');
    // The attention items these keys become.
    expect(localVerifyAttentionItem(owner[0].key, owner[0].detail)).toMatchObject({ id: owner[0].key, mode: 'create', priority: 'HIGH' });
    expect(localVerifyAttentionItem(w.signals[0].key, w.signals[0].detail)).toMatchObject({ id: w.signals[0].key, mode: 'create', priority: 'MEDIUM' });
    // A machine that does not hold the lease records the events and sends nothing.
    const peer = await wire({ holdsLease: false });
    complete(peer);
    expect(peer.set.seam!.decide({ helper: 'm_laptop', lane: 'integration', reason: 'r' }).status).toBe(200);
    peer.wired.machine.recordVerify('m_laptop', { integration: outcome({ verifyId: 'cmp', kind: 'main', change: null, compareOnly: true, assigned: 'compare-only', agreed: [f(1)], confirmedWrongPasses: [f(2)] }) });
    expect(peer.signals).toEqual([]);
    expect((peer.set.seam!.peerStatusExtras().helperEvents ?? []).length).toBe(2);
  });

  it('the baseline file\'s hash goes to the real audit log and is checked from it by a new process; the peer push carries the Bearer credential', async () => {
    const w = await wire();
    const seam = w.set.seam!;
    seam.onPeerStatus({ machineId: 'm_m5', url: 'http://192.168.87.30:4042' }, { wantsBaseline: true, helpers: ['m_winpc'] });
    seam.onGreenMain({ commit: sha('c'), finishedAt: '2026-11-19T08:00:00.000Z', machineId: 'm_studio', fileCounts: { [f(1)]: [3, 0, 1, 0, 'b'.repeat(64)] } });
    await new Promise((res) => setTimeout(res, 20));
    const row = w.audit().find((e) => e.event === 'main-file-counts-written');
    expect(row).toMatchObject({ baselines: [sha('c')], why: 'green-main' });
    // A second wiring on the same folder (a restart) reads the file because the audited hash matches.
    const again = await wireBorrowedRunMachine({ setMainRunObserver: () => {}, setBorrowedRunSeam: () => {} }, {
      liveConfig: { get: <T>(k: string, fb: T): T => (k === 'monitoring.localVerify.borrowed' ? { mode: 'practice', helpers: [{ machineId: 'm_laptop', url: 'http://100.64.0.9:4042' }] } as T : fb) },
      stateDir: w.stateDir, agentHome: w.stateDir, machineId: 'm_studio', authToken: AUTH, agentId: 'echo', version: 'w', signer: w.r.requester.signer, keyLookup: () => pins(w.r.helperKeys),
    });
    expect((again.machine.info() as { baseline: { ok: boolean; hash: string } }).baseline).toMatchObject({ ok: true, hash: row!.hash });
    // Changed behind the server's back: the same restart reads no baseline.
    const file = path.join(w.stateDir, 'state', 'local-verify', 'main-file-counts.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('[3,0,1,0', '[3,0,0,0'));
    const tampered = await wireBorrowedRunMachine({ setMainRunObserver: () => {}, setBorrowedRunSeam: () => {} }, {
      liveConfig: { get: <T>(k: string, fb: T): T => (k === 'monitoring.localVerify.borrowed' ? { mode: 'practice', helpers: [{ machineId: 'm_laptop', url: 'http://100.64.0.9:4042' }] } as T : fb) },
      stateDir: w.stateDir, agentHome: w.stateDir, machineId: 'm_studio', authToken: AUTH, agentId: 'echo', version: 'w', signer: w.r.requester.signer, keyLookup: () => pins(w.r.helperKeys),
    });
    expect((tampered.machine.info() as { baseline: unknown }).baseline).toEqual({ ok: false, reason: 'hash-mismatch' });
    // The push to the peer that wants it.
    const push = w.calls.find((c) => c.url.endsWith('/local-verify/peer-baseline'));
    expect(push).toMatchObject({ url: 'http://192.168.87.30:4042/local-verify/peer-baseline', method: 'POST', auth: `Bearer ${AUTH}`, agent: 'echo' });
    expect(push!.body).toMatchObject({ coordinatorMachineId: 'm_studio', file: { v: 1, baselines: [{ commit: sha('c') }] } });
  });

  it('with no lease view (a single machine) this machine is its own coordinator', async () => {
    const w = await wire({ holdsLease: null });
    w.set.seam!.onGreenMain({ commit: sha('c'), finishedAt: '2026-11-19T08:00:00.000Z', machineId: 'm_studio', fileCounts: { [f(1)]: [3, 0, 1, 0, 'b'.repeat(64)] } });
    expect((w.set.seam!.info() as { baseline: { ok: boolean } }).baseline.ok).toBe(true);
  });

  it('the coordinator\'s peer client passes a peer status\'s borrowed extras through, strictly shaped, and leaves a status without them as it was', async () => {
    const base = { enabled: true, inFlight: null, verifierVersion: 'v', policyHash: 'p', slotBusy: false };
    const event = { id: 'e'.repeat(32), at: 1, runMachineId: 'm_m5', helper: 'm_winpc', lane: 'integration', kind: 'suspended' };
    const answer = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const peer = { machineId: 'm_m5', url: 'http://m5:4042' };
    expect(await makePeerClient('t', 'echo', answer(base)).status(peer)).toEqual({ inFlight: null, verifierVersion: 'v', policyHash: 'p', slotBusy: false });
    expect(await makePeerClient('t', 'echo', answer({ ...base, wantsBaseline: true, helpers: ['m_winpc'], helperEvents: [event] })).status(peer))
      .toEqual({ inFlight: null, verifierVersion: 'v', policyHash: 'p', slotBusy: false, wantsBaseline: true, helpers: ['m_winpc'], helperEvents: [event] });
    expect(await makePeerClient('t', 'echo', answer({ ...base, wantsBaseline: 1, helpers: ['a', 'b', 'c'], helperEvents: 'x' })).status(peer))
      .toEqual({ inFlight: null, verifierVersion: 'v', policyHash: 'p', slotBusy: false });
  });
});
