// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * First parts in LocalVerifyService (spec docs/specs/local-verify-likely-failing-first.md,
 * sections B, E, F and measure 6): the list is updated by the one completion path, the run input
 * and the hand-off to a peer carry it, a pull request keeps one assignment, and
 * every verify produces machine-local evidence without scheduling another run.
 * Real fs in a temp state dir; the child process, gh, the peer client and the clock are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunInput, VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import type { PeerClient, PeerRunRequest } from '../../../src/localVerify/peer.js';
import { parsePeerRunRequest } from '../../../src/localVerify/peer.js';
import type { FirstPartSummary } from '../../../src/localVerify/firstPart.js';
import { wireLocalVerifySwitches } from '../../../src/localVerify/localVerifyWiring.js';
import { generateSigningKeyPair } from '../../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineKeyLookup } from '../../../src/core/AppRecordSignatures.js';

/** The fake peer's machine key, pinned on the coordinator (a hand-off needs a peer whose answers could be checked). */
const PEER_KEYS = generateSigningKeyPair();
const PEER_KEY_HASH = signerKeyHashOf(PEER_KEYS.publicKey);
const pinnedPeerKeys = (): MachineKeyLookup => (_machineId, hash) => (hash === PEER_KEY_HASH ? { status: 'ok', publicKeyPem: PEER_KEYS.publicKey } : { status: 'unknown' });

const REPO = 'JKHeadley/instar';
const POLICY = computePolicyHash();
const sha = (c: string) => c.repeat(40);
const F1 = 'tests/unit/one.test.ts';
const F2 = 'tests/unit/two.test.ts';
const F3 = 'tests/e2e/three.test.ts';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'firstPartService.test.ts' }); });

function view(over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T12:00:30.000Z', finishedAt: '2026-10-21T12:20:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: POLICY, ...over,
  };
}
const failed = (pr: number, files: string[], over: Partial<LocalVerifyRecord> = {}) => record({
  pr, outcome: 'failure', failedFiles: files,
  lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 2, failed: 1, skipped: 0, todo: 0, seconds: 1 }], ...over,
});
const ok = (r: LocalVerifyRecord, extra: Partial<Extract<VerifyRunResult, { kind: 'record' }>> = {}): VerifyRunResult => ({ kind: 'record', record: r, reasons: [], overlaps: [], keptWorktree: null, ...extra });

const summary = (over: Partial<FirstPartSummary> = {}): FirstPartSummary => ({
  setting: 'alternate', group: 'with', active: true, endedInFirstPart: false,
  lanes: [{ lane: 'unit', files: 2, fromChange: 1, fromPrevious: 0, fromList: 1, partners: 0, ms: 4000, endedHere: false }], ...over,
});

interface Spawned { pid: number; args: string[]; resultPath: string; inputPath: string; input: VerifyRunInput; resolve: (x: { status: number | null; signal: string | null }) => void }

function setup(opts: { peerOnly?: boolean; machineId?: string; stateDir?: string; views?: Record<number, PrView>; draws?: number[] } = {}) {
  const machineId = opts.machineId ?? 'm1';
  const stateDir = opts.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvfirst-')));
  const lvDir = path.join(stateDir, 'state', 'local-verify');
  if (!opts.stateDir) {
    dirs.push(stateDir);
    fs.mkdirSync(lvDir, { recursive: true });
    fs.writeFileSync(path.join(lvDir, 'main-health.json'), JSON.stringify({ v: 1, machineId, state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z' }));
  }
  const views: Record<number, PrView> = opts.views ?? { 1: view(), 2: view({ headRefOid: sha('c') }), 3: view({ headRefOid: sha('e') }), 4: view({ headRefOid: sha('1') }), 5: view({ headRefOid: sha('2') }), 6: view({ headRefOid: sha('3') }), 7: view({ headRefOid: sha('4') }) };
  const spawned: Spawned[] = [];
  const alive = new Set<number>();
  const kills: Array<{ pgid: number; signal: string }> = [];
  const procArgs = new Map<number, string>();
  const timers: Array<() => void> = [];
  const records: LocalVerifyRecord[] = [];
  const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
  const draws = opts.draws ?? [];
  const sweeps: Array<Array<{ prefix: string; minAgeS: number }>> = [];
  let t = Date.parse('2026-10-21T12:30:00.000Z');
  let pid = 5000;
  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async () => true,
    baseHead: async () => sha('b'),
    spawnRun: (a) => {
      const p = ++pid;
      alive.add(p);
      let resolve!: Spawned['resolve'];
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      const inputPath = a.args[a.args.indexOf('--input') + 1];
      spawned.push({ pid: p, args: [a.command, ...a.args], resultPath: a.args[a.args.indexOf('--result') + 1], inputPath, input: JSON.parse(fs.readFileSync(inputPath, 'utf-8')), resolve });
      return { pid: p, exited };
    },
    isGroupAlive: (g) => alive.has(g),
    killGroup: (g, s) => { kills.push({ pgid: g, signal: s }); alive.delete(g); },
    readProcessArgs: async (p) => procArgs.get(p) ?? null,
    foreignSuiteHolders: () => [],
    onRecord: (r) => { records.push(r); },
    signal: (key, detail) => { signals.push({ key, detail }); },
    now: () => t,
    setTimer: (fn) => { timers.push(fn); },
    random: () => (draws.length ? draws.shift()! : 0.1),
    reapLeftovers: async (prefixes) => { sweeps.push(prefixes.map((x) => ({ prefix: x.prefix, minAgeS: x.minAgeS }))); return { matched: 0, killed: 0, sample: [] } as never; },
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId, nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, ...(opts.peerOnly ? { peerOnly: true } : {}),
  }, seams);
  const flush = async () => { for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r)); };
  const runTimers = async () => { for (let k = 0; k < 5; k++) { const ts = timers.splice(0); for (const f of ts) f(); await flush(); } };
  const finish = async (k: number, result: VerifyRunResult | null) => {
    const s = spawned[k];
    if (result) fs.writeFileSync(s.resultPath, JSON.stringify(result));
    alive.delete(s.pid);
    s.resolve({ status: 0, signal: null });
    await flush();
  };
  const audit = () => {
    try { return fs.readFileSync(svc.auditPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; }
  };
  const events = (name: string) => audit().filter((e) => e.event === name);
  return { sweeps, svc, seams, stateDir, lvDir, views, spawned, alive, kills, procArgs, timers, records, signals, flush, runTimers, finish, audit, events, advance: (ms: number) => { t += ms; }, now: () => t };
}

/** Put a record through the ONE completion path, as a finished local run does. */
async function runAndFinish(h: ReturnType<typeof setup>, pr: number, result: (input: VerifyRunInput) => VerifyRunResult): Promise<Spawned> {
  const before = h.spawned.length;
  await h.svc.request(pr, { explicit: true });
  await h.flush();
  expect(h.spawned.length).toBe(before + 1);
  const s = h.spawned[before];
  await h.finish(before, result(s.input));
  return s;
}

// ── B: the list is updated by the completion path ──────────────────────

describe('the likely-failing list is updated when a verify of a change is recorded', () => {
  it('a recorded failure appears in the list file, with one audit row; a pass, an error and a failure that names no file add nothing', async () => {
    const h = setup();
    await runAndFinish(h, 1, () => ok(failed(1, [F1, F2])));
    const file = path.join(h.lvDir, 'likely-failing.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as { files: Record<string, Array<{ pr: number; at: number }>> };
    expect(doc.files).toEqual({ [F1]: [{ pr: 1, at: Date.parse('2026-10-21T12:20:00.000Z') }], [F2]: [{ pr: 1, at: Date.parse('2026-10-21T12:20:00.000Z') }] });
    expect(h.events('likely-failing-updated')).toEqual([expect.objectContaining({ pr: 1, files: 2 })]);
    await runAndFinish(h, 2, () => ok(record({ pr: 2, headSha: sha('c') })));
    await runAndFinish(h, 3, () => ok(record({ pr: 3, headSha: sha('e'), outcome: 'error', errorStep: 'conflict', lanes: [], mergeTree: '' })));
    await runAndFinish(h, 4, () => ok(record({ pr: 4, headSha: sha('1'), outcome: 'failure' }))); // more than 3 failed files: no `failedFiles`
    expect(h.events('likely-failing-updated')).toHaveLength(1);
    expect(h.svc.snapshot().likelyFailingFirst.list).toMatchObject({ files: 2, problem: null, stale: false });
  });

  it('the store is real and is ONE store: what the recorder writes is what the next run input reads', async () => {
    const h = setup();
    h.svc.setLikelyFailingFirst(() => 'on');
    await runAndFinish(h, 1, () => ok(failed(1, [F1])));
    // The recorder wrote through the same object the service exposes and the run input uses.
    expect(h.svc.likelyFailing.file).toBe(path.join(h.lvDir, 'likely-failing.json'));
    expect(h.svc.likelyFailing.listFor(2)).toEqual([F1]);
    expect(h.svc.firstPartFor(2).list).toEqual([F1]);
    const s = await runAndFinish(h, 2, (inp) => ok(record({ pr: 2, headSha: inp.headSha })));
    expect(s.input.likelyFailingFirst).toMatchObject({ setting: 'on', list: [F1], previous: [] });
  });

  it('a re-run alone cut off by another lane’s failure is not counted in the list, nor as one of the change’s previous failures', async () => {
    const h = setup();
    await runAndFinish(h, 1, () => ok(failed(1, [F1, F2], { rerunCutOff: [F2] })));
    expect(h.svc.likelyFailing.listFor(99)).toEqual([F1]);
    expect(h.svc.previousFailures(1)).toEqual([F1]);
    // A verify whose only named file was cut off counts nothing at all.
    await runAndFinish(h, 2, () => ok(failed(2, [F3], { headSha: sha('c'), rerunCutOff: [F3] })));
    expect(h.svc.likelyFailing.listFor(99)).toEqual([F1]);
    expect(h.svc.previousFailures(2)).toEqual([]);
    expect(h.events('likely-failing-updated')).toHaveLength(1);
  });

  it('a record whose `rerunCutOff` names a file that is not in `failedFiles` is rejected whole', async () => {
    const h = setup();
    await runAndFinish(h, 1, () => ok(failed(1, [F1], { rerunCutOff: [F2] })));
    expect(h.events('record-rejected')).toHaveLength(1);
    expect(h.svc.likelyFailing.listFor(99)).toEqual([]);
  });

  it('the list for a verify excludes that pull request’s own failures; they come back through its previous failures instead', async () => {
    const h = setup();
    h.svc.setLikelyFailingFirst(() => 'on');
    await runAndFinish(h, 1, () => ok(failed(1, [F1])));
    await runAndFinish(h, 2, () => ok(failed(2, [F2], { headSha: sha('c') })));
    expect(h.svc.firstPartFor(1)).toMatchObject({ list: [F2], previous: [F1] });
    expect(h.svc.firstPartFor(2)).toMatchObject({ list: [F1], previous: [F2] });
    expect(h.svc.firstPartFor(3)).toMatchObject({ previous: [] });
    expect(new Set(h.svc.firstPartFor(3).list)).toEqual(new Set([F1, F2]));
  });

  it('previous failures are those of the change’s newest record: a later pass clears them', async () => {
    const h = setup();
    await runAndFinish(h, 1, () => ok(failed(1, [F1])));
    expect(h.svc.previousFailures(1)).toEqual([F1]);
    h.views[1] = view({ headRefOid: sha('9') });
    await runAndFinish(h, 1, (inp) => ok(record({ pr: 1, headSha: inp.headSha, startedAt: '2026-10-21T12:25:00.000Z', finishedAt: '2026-10-21T12:29:00.000Z' })));
    expect(h.svc.previousFailures(1)).toEqual([]);
  });

  it('an unreadable list still leaves the change’s previous failures in the run input, with one audit row', async () => {
    const h = setup();
    fs.writeFileSync(path.join(h.lvDir, 'likely-failing.json'), '{ broken');
    h.svc.setLikelyFailingFirst(() => 'on');
    // The change's previous failure comes from its verify record, not from the list. Counting it also rebuilds the list.
    await runAndFinish(h, 1, () => ok(failed(1, [F1])));
    expect(h.events('likely-failing-unreadable')).toEqual([expect.objectContaining({ reason: 'unparseable' })]);
    h.views[1] = view({ headRefOid: sha('9') });
    const s = await runAndFinish(h, 1, (inp) => ok(record({ pr: 1, headSha: inp.headSha, startedAt: '2026-10-21T12:25:00.000Z', finishedAt: '2026-10-21T12:29:00.000Z' })));
    expect(s.input.likelyFailingFirst).toMatchObject({ previous: [F1], list: [] });
    expect(h.events('likely-failing-unreadable')).toHaveLength(1);
  });
});

// ── E: the setting, read per machine at each start ─────────────────────

describe('the setting is read live at the start of each verify this machine runs', () => {
  it('off (the default, absent, or anything else): the run input has no first-part block at all', async () => {
    const h = setup();
    const a = await runAndFinish(h, 1, () => ok(failed(1, [F1])));
    expect('likelyFailingFirst' in a.input).toBe(false);
    expect('collectFileOutcomes' in a.input).toBe(false);
    for (const [k, v] of [['2', 'off'], ['3', 'yes'], ['4', true]] as const) {
      h.svc.setLikelyFailingFirst(() => v);
      const s = await runAndFinish(h, Number(k), (inp) => ok(record({ pr: inp.pr, headSha: inp.headSha })));
      expect('likelyFailingFirst' in s.input).toBe(false);
    }
    expect(h.svc.likelyFailingFirst()).toBe('off');
    expect(h.events('first-part')).toEqual([]);
  });

  it('a throwing setting reads as off', async () => {
    const h = setup();
    h.svc.setLikelyFailingFirst(() => { throw new Error('config unreadable'); });
    expect(h.svc.likelyFailingFirst()).toBe('off');
  });

  it('changed between two verifies, the next start uses the new value (no restart)', async () => {
    const h = setup();
    let value: unknown = 'off';
    h.svc.setLikelyFailingFirst(() => value);
    expect('likelyFailingFirst' in (await runAndFinish(h, 1, () => ok(record()))).input).toBe(false);
    value = 'on';
    expect((await runAndFinish(h, 2, (inp) => ok(record({ pr: 2, headSha: inp.headSha })))).input.likelyFailingFirst).toMatchObject({ setting: 'on' });
    value = 'alternate';
    expect((await runAndFinish(h, 3, (inp) => ok(record({ pr: 3, headSha: inp.headSha })))).input.likelyFailingFirst).toMatchObject({ setting: 'alternate' });
  });

  it('wireLocalVerifySwitches reads `monitoring.localVerify.likelyFailingFirst` live and wires the off-writer', () => {
    const h = setup();
    const cfg: Record<string, unknown> = {};
    const liveConfig = { get: <T,>(key: string, fallback: T): T => (key in cfg ? cfg[key] as T : fallback), set: (key: string, value: unknown) => { cfg[key] = value; } };
    wireLocalVerifySwitches(h.svc, liveConfig);
    expect(h.svc.likelyFailingFirst()).toBe('off');
    cfg['monitoring.localVerify.likelyFailingFirst'] = 'alternate';
    expect(h.svc.likelyFailingFirst()).toBe('alternate');
    cfg['monitoring.localVerify.likelyFailingFirst'] = 'on';
    expect(h.svc.likelyFailingFirst()).toBe('on');
    expect(h.svc.snapshot().likelyFailingFirst.setting).toBe('on');
  });

  it('a main verify never gets the block', async () => {
    const h = setup();
    h.svc.setLikelyFailingFirst(() => 'on');
    h.svc.noteMainHead(sha('7'));
    await h.runTimers();
    const mainRun = h.spawned.find((s) => s.input.kind === 'main');
    if (mainRun) expect('likelyFailingFirst' in mainRun.input).toBe(false);
    // Whether or not the debounce let it start here, firstPartInput refuses a main entry by kind.
    expect(h.spawned.every((s) => s.input.kind !== 'main' || !('likelyFailingFirst' in s.input))).toBe(true);
  });
});

// ── E: alternate, one assignment per pull request ──────────────────────

describe('alternate: a pull request keeps one assignment', () => {
  it('drawn once when it is first queued, kept across a retry and a moved head, written to the audit log once', async () => {
    const h = setup({ draws: [0.9, 0.1] }); // PR 1 → without, PR 2 → with
    h.svc.setLikelyFailingFirst(() => 'alternate');
    const a = await runAndFinish(h, 1, () => ok(failed(1, [F1])));
    expect(a.input.likelyFailingFirst).toMatchObject({ setting: 'alternate', group: 'without' });
    // An automatic retry of the same head (after an infrastructure error).
    h.views[1] = view({ headRefOid: sha('8') });
    await runAndFinish(h, 1, (inp) => ok(record({ pr: 1, headSha: inp.headSha, outcome: 'error', errorStep: 'fetch', lanes: [], mergeTree: '' })));
    const b = h.spawned.at(-1)!;
    expect(b.input).toMatchObject({ pr: 1, headSha: sha('8') });
    expect(b.input.likelyFailingFirst!.group).toBe('without');
    await h.finish(h.spawned.length - 1, ok(failed(1, [F1], { headSha: sha('8') })));
    // A new head.
    h.views[1] = view({ headRefOid: sha('9') });
    const c = await runAndFinish(h, 1, (inp) => ok(record({ pr: 1, headSha: inp.headSha })));
    expect(c.input.headSha).toBe(sha('9'));
    expect(c.input.likelyFailingFirst!.group).toBe('without');
    const d = await runAndFinish(h, 2, (inp) => ok(record({ pr: 2, headSha: inp.headSha })));
    expect(d.input.likelyFailingFirst!.group).toBe('with');
    expect(h.events('first-part-assigned')).toEqual([expect.objectContaining({ pr: 1, group: 'without' }), expect.objectContaining({ pr: 2, group: 'with' })]);
  });

  it('survives a restart of the coordinator', async () => {
    const h = setup({ draws: [0.9] });
    h.svc.setLikelyFailingFirst(() => 'alternate');
    await runAndFinish(h, 1, () => ok(failed(1, [F1])));
    const again = setup({ stateDir: h.stateDir, draws: [0.1] }); // the opposite draw would be made now
    again.svc.setLikelyFailingFirst(() => 'alternate');
    expect(again.svc.firstPartFor(1).group).toBe('without');
  });

  it('is drawn whatever the coordinator’s own setting is, so a peer set to alternate gets it', async () => {
    const h = setup({ draws: [0.1] });
    await h.svc.request(1, { explicit: true });
    expect(h.events('first-part-assigned')).toEqual([expect.objectContaining({ pr: 1, group: 'with' })]);
    expect('likelyFailingFirst' in h.spawned[0].input).toBe(false); // its own setting is off
  });

  it('every verify with the setting on or alternate writes one `first-part` audit row with the group and the numbers', async () => {
    const h = setup({ draws: [0.9] });
    h.svc.setLikelyFailingFirst(() => 'alternate');
    await runAndFinish(h, 1, () => ok(record(), { firstPart: summary({ group: 'without', active: false, lanes: [] }) }));
    expect(h.events('first-part')).toEqual([expect.objectContaining({ pr: 1, setting: 'alternate', group: 'without', active: false, outcome: 'success', endedInFirstPart: false, minutes: 19.5, lanes: [] })]);
    expect(h.spawned).toHaveLength(1); // a `without` verify is never followed by a comparison
  });
});

// ── B: the same list on both machines ──────────────────────────────────

function fakePeerClient() {
  const runs: PeerRunRequest[] = [];
  const client: PeerClient = {
    status: async () => ({ inFlight: null, verifierVersion: '1.0.0', policyHash: POLICY, slotBusy: false, signerKeyHash: PEER_KEY_HASH }),
    run: async (_p, req) => { runs.push(JSON.parse(JSON.stringify(req))); return { ok: true, attemptId: req.attemptId }; },
    result: async () => ({ state: 'running' }),
    cancel: async () => {},
  };
  return { client, runs };
}

function coordinator(opts: Parameters<typeof setup>[0] = {}) {
  const h = setup({ machineId: 'coord', ...opts });
  const peer = fakePeerClient();
  h.svc.setPeerWiring({
    peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }],
    client: peer.client,
    lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' },
    keyLookupFactory: pinnedPeerKeys,
  });
  return { ...h, peer };
}

describe('a verify handed to a peer carries the list', () => {
  it('the list in use, the change’s previous failures and its assignment travel in the request; the request parses on the peer', async () => {
    const c = coordinator({ draws: [0.1, 0.9, 0.1] });
    // History: PR 3 failed on F3 (the list), and PR 2 failed on F2 at an older head (its own previous failure).
    await runAndFinish(c, 3, (inp) => ok(failed(3, [F3], { headSha: inp.headSha, machineId: 'coord' })));
    await runAndFinish(c, 2, (inp) => ok(failed(2, [F2], { headSha: inp.headSha, machineId: 'coord' })));
    c.views[2] = view({ headRefOid: sha('8') });
    await c.svc.request(1, { explicit: true }); // runs locally
    await c.runTimers();
    await c.svc.request(2, { explicit: true }); // handed to the peer
    await c.runTimers();
    expect(c.peer.runs).toHaveLength(1);
    const req = c.peer.runs[0];
    expect(req).toMatchObject({ pr: 2, headSha: sha('8'), firstPartGroup: 'without', likelyFailing: { list: [F3], previous: [F2] } });
    expect(parsePeerRunRequest(req)).not.toBeNull();
  });

  it('the list is sent whether or not the coordinator’s own switch is on, and the field is omitted when it is empty', async () => {
    const c = coordinator({ draws: [0.1, 0.1] });
    expect(c.svc.likelyFailingFirst()).toBe('off');
    await c.svc.request(1, { explicit: true });
    await c.runTimers();
    await c.svc.request(2, { explicit: true });
    await c.runTimers();
    const req = c.peer.runs[0];
    expect(req.pr).toBe(2);
    expect('likelyFailing' in req).toBe(false); // nothing listed, no previous failure
    expect(req.firstPartGroup).toBe('with');
    expect(parsePeerRunRequest(req)).not.toBeNull();
  });

  it('a path over 300 characters is left out of the request with an audit row naming it; the request still parses', async () => {
    const c = coordinator();
    const LONG = `tests/unit/${'x'.repeat(300)}.test.ts`;
    // (A verify record never names a path this long, so the list is seeded directly: the bound on the request is its own guard.)
    c.svc.likelyFailing.record({ pr: 3, files: [LONG, F3], at: c.now() });
    await c.svc.request(1, { explicit: true });
    await c.runTimers();
    await c.svc.request(2, { explicit: true });
    await c.runTimers();
    const req = c.peer.runs[0];
    expect(req.likelyFailing).toEqual({ list: [F3], previous: [] });
    expect(parsePeerRunRequest(req)).not.toBeNull();
    const rows = c.events('likely-failing-path-too-long');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pr: 2, count: 1 });
    expect((rows[0].paths as string[])[0].startsWith('tests/unit/xxx')).toBe(true);
  });

  it('a peer verify’s failure the coordinator imports would feed the same one list (the completion path is shared)', async () => {
    // complete() is the single writer for local runs and peer imports alike; a record with another machine's id counts the same.
    const c = coordinator();
    await runAndFinish(c, 3, (inp) => ok(failed(3, [F3], { headSha: inp.headSha, machineId: 'coord' })));
    expect(c.svc.likelyFailing.listFor(1)).toEqual([F3]);
  });
});

describe('the peer side', () => {
  const ATT = 'a'.repeat(32);
  const req = (over: Partial<PeerRunRequest> = {}): PeerRunRequest => ({
    attemptId: ATT, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY,
    coordinatorMachineId: 'coord', leaseEpoch: 7, ...over,
  });
  const notHolder = { holdsLease: false, holderMachineId: 'coord' };
  function peerSide() {
    const h = setup({ peerOnly: true, machineId: 'peer1' });
    h.svc.setPeerWiring({ peerRoleEnabled: () => true });
    return h;
  }

  it('uses the coordinator’s list, previous failures and assignment, under ITS OWN setting; it never builds its own list', async () => {
    const h = peerSide();
    h.svc.setLikelyFailingFirst(() => 'alternate');
    // The peer's own store holds something else: it must not be used.
    h.svc.likelyFailing.record({ pr: 50, files: ['tests/unit/peers-own.test.ts'], at: h.now() });
    expect(await h.svc.peerRun(req({ likelyFailing: { list: [F3], previous: [F2] }, firstPartGroup: 'with' }), notHolder)).toEqual({ ok: true, attemptId: ATT });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].input.likelyFailingFirst).toEqual({ setting: 'alternate', group: 'with', previous: [F2], list: [F3] });
    expect(h.events('first-part-assigned')).toEqual([]); // a peer never draws
  });

  it('its own setting off: no block, whatever the coordinator sent', async () => {
    const h = peerSide();
    await h.svc.peerRun(req({ likelyFailing: { list: [F3], previous: [] }, firstPartGroup: 'with' }), notHolder);
    expect('likelyFailingFirst' in h.spawned[0].input).toBe(false);
  });

  it('alternate with no assignment sent counts the pull request as without (the block carries no group)', async () => {
    const h = peerSide();
    h.svc.setLikelyFailingFirst(() => 'alternate');
    await h.svc.peerRun(req(), notHolder);
    expect(h.spawned[0].input.likelyFailingFirst).toEqual({ setting: 'alternate', previous: [], list: [] });
    expect('collectFileOutcomes' in h.spawned[0].input).toBe(false);
  });
});

// ── Measure 6: the verdict check ───────────────────────────────────────

describe('what the snapshot shows', () => {
  it('the setting, the list’s size, age and top files, and the trial’s counts', async () => {
    const h = setup();
    h.svc.setLikelyFailingFirst(() => 'on');
    await runAndFinish(h, 1, () => ok(failed(1, [F1, F2])));
    await runAndFinish(h, 2, (inp) => ok(failed(2, [F2], { headSha: inp.headSha, startedAt: '2026-10-21T12:21:00.000Z', finishedAt: '2026-10-21T12:25:00.000Z' })));
    const s = h.svc.snapshot().likelyFailingFirst;
    expect(s.setting).toBe('on');
    expect(s.list).toMatchObject({ files: 2, stale: false, problem: null, oldestFailureAt: '2026-10-21T12:20:00.000Z' });
    expect(typeof s.list.updatedAt).toBe('string');
    expect(s.list.top).toEqual([
      { file: F2, prs: 2, last: '2026-10-21T12:25:00.000Z' },
      { file: F1, prs: 1, last: '2026-10-21T12:20:00.000Z' },
    ]);
    expect(s.open).toBe(0);
    expect(s.overdue).toBe(0);
    expect(s).not.toHaveProperty('trial');
  });
});


describe('the amended check removes comparison execution and preserves signed evidence', () => {
  it('ignores old trial marks and never reads comparison state at boot', async () => {
    const h = setup();
    fs.writeFileSync(path.join(h.lvDir, 'first-part-trial.json'), JSON.stringify({ switchedOff: { at: 'old' } }));
    fs.writeFileSync(path.join(h.lvDir, 'first-part-compare-inflight.json'), '{ old state');
    h.svc.setLikelyFailingFirst(() => 'alternate');
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      await h.svc.boot();
      expect(h.svc.likelyFailingFirst()).toBe('alternate');
      expect(read.mock.calls.some(([p]) => /first-part-(trial|compare-inflight)\.json$/.test(String(p)))).toBe(false);
    } finally { read.mockRestore(); h.svc.shutdown(); }
  });
  it.each(['success', 'failure', 'error'] as const)('queues no comparison after %s', async (outcome) => {
    const h = setup(); h.svc.setLikelyFailingFirst(() => 'alternate');
    await runAndFinish(h, 1, () => ok(record({ outcome, ...(outcome === 'error' ? { errorStep: 'conflict' } : {}) }), { firstPart: summary() }));
    expect(h.spawned.every((s) => !('variant' in s.input) && !('collectFileOutcomes' in s.input))).toBe(true);
    expect(h.audit().some((r) => String(r.event).startsWith('first-part-compare'))).toBe(false);
    expect(h.svc.firstPartReport.rows().filter((r) => r.type === 'observation')).toHaveLength(1);
    h.svc.shutdown();
  });
  it('a derived record carries its original verify evidence and creates no second observation', async () => {
    const h = setup({ views: { 1: view(), 2: view() } });
    const firstPart = { setting: 'alternate', group: 'with', ran: true } as const;
    await runAndFinish(h, 1, () => ok(record({ firstPart })));
    const answer = await h.svc.request(2, { explicit: true });
    expect(answer.ok).toBe(true);
    expect(h.svc.getRecord(2, sha('a'), 'main')?.firstPart).toEqual(firstPart);
    expect(h.spawned).toHaveLength(1);
    expect(h.svc.firstPartReport.rows().filter((r) => r.type === 'observation')).toHaveLength(1);
    h.svc.shutdown();
  });
});

it('writes an episode only on confirmed main red, reads history once, and ends it on green', async () => {
  const h = setup(); h.seams.isAncestor = async () => true;
  let reads = 0;
  h.seams.firstPartHistory = async () => { reads++; return [{ head: sha('c'), message: 'change (#1)' }, { head: sha('d'), message: 'release' }]; };
  await runAndFinish(h, 1, () => ok(record({ firstPart: { setting: 'alternate', group: 'with', ran: true } })));
  const main = async (outcome: LocalVerifyRecord['outcome'], head: string) => {
    const r = record({ kind: 'main', pr: 0, headSha: head, baseSha: head, outcome });
    (h.svc as any).completeMain(r, { kind: 'main', pr: 0, headSha: head, baseSha: head, baseRefName: 'main', attempts: 1, errorRetries: 0 });
    await h.flush();
  };
  await main('success', sha('b'));
  await main('failure', sha('c'));
  expect(h.svc.firstPartReport.report('off').episodes).toHaveLength(0);
  await main('failure', sha('c'));
  expect(h.svc.firstPartReport.report('off').episodes).toHaveLength(1);
  expect(h.svc.firstPartReport.report('off').open).toBe(1);
  await main('failure', sha('c'));
  expect(reads).toBe(1);
  expect(h.svc.firstPartReport.report('off').episodes[0]).toMatchObject({ lastGreenHead: sha('b'), redHead: sha('c') });
  await main('success', sha('d'));
  expect(h.svc.firstPartReport.report('off').episodes[0].endedAt).toBeDefined();
  h.svc.shutdown();
});


it('detects a nonthrowing config writer that leaves alternate unchanged and retries next day', () => {
  const h = setup(); const key = 'monitoring.localVerify.likelyFailingFirst';
  const config = { [key]: 'alternate' }; const writer = vi.fn();
  wireLocalVerifySwitches(h.svc, { get: (_key: string, fallback: unknown) => config[_key] ?? fallback, set: writer } as any);
  h.svc.likelyFailingFirst();
  const seed = (id: string, group: 'with' | 'without') => h.svc.firstPartReport.observe({
    type: 'observation', id, at: h.now(), startedAt: h.now(), pr: 1, head: sha('a'), base: sha('b'),
    setting: 'alternate', group, ran: group === 'with', outcome: 'success', minutes: group === 'with' ? 12 : 10,
    incomplete: false, completedLanes: [], firstPartFiles: {}, failures: [], failuresTotal: 0,
  });
  for (let i = 0; i < 8; i++) { seed(`with${i}`, 'with'); seed(`without${i}`, 'without'); }
  const complete = () => (h.svc as any).noteFirstPart({ token: String(h.now()) }, ok(record({
    startedAt: new Date(h.now()).toISOString(), finishedAt: new Date(h.now() + 12 * 60000).toISOString(),
    firstPart: { setting: 'alternate', group: 'with', ran: true },
  })));
  complete(); h.advance(86400001); complete();
  expect(writer).toHaveBeenCalledTimes(1);
  expect(config[key]).toBe('alternate');
  expect(h.svc.firstPartReport.report('alternate').lastEvaluation?.configWritten).toBe(false);
  expect(h.svc.firstPartReport.report('alternate').trial.ended).toBe(false);
  expect(h.signals.at(-1)?.detail.note).toContain('could not be written');
  h.svc.likelyFailingFirst(); h.advance(86400001); complete();
  expect(writer).toHaveBeenCalledTimes(2);
  expect(h.svc.firstPartReport.report('alternate').markers.map((m) => m.reason)).toEqual(['setting']);
  h.svc.shutdown();
});

it('status counts do not read the observation log', () => {
  const h = setup(); h.svc.likelyFailingFirst();
  const read = vi.spyOn(fs, 'readFileSync');
  try {
    h.svc.snapshot(); h.svc.snapshot();
    expect(read.mock.calls.some(([p]) => p === h.svc.firstPartReport.log)).toBe(false);
  } finally { read.mockRestore(); h.svc.shutdown(); }
});

it('suspects and confirmed red main do not call the off writer or wait for history', async () => {
  const h = setup(); const off = vi.fn(); h.svc.setLikelyFailingFirstOff(off);
  h.svc.setLikelyFailingFirst(() => 'alternate'); h.svc.likelyFailingFirst();
  h.svc.firstPartReport.episode({ redHead: 'previous', lastGreenHead: null, at: h.now(), historyUnknown: false,
    commits: [{ head: 'p', pr: 1, firstParts: 'yes' }] });
  for (let pr = 1; pr <= 4; pr++) h.svc.firstPartReport.observe({
    type: 'observation', id: `suspect-${pr}`, at: h.now(), startedAt: h.now(), pr, head: sha('a'), base: sha('b'),
    setting: 'alternate', group: 'with', ran: true, outcome: 'failure', minutes: 10, incomplete: false,
    completedLanes: ['unit'], firstPartFiles: {}, failuresTotal: 1,
    failures: [{ file: F1, lane: 'unit', firstPart: true, own: false, result: 'failed' }],
  });
  h.svc.firstPartReport.evaluate(); expect(h.svc.firstPartReport.counts().open).toBe(2); h.svc.firstPartReport.green();
  let resolve!: (v: Array<{ head: string; message: string }>) => void;
  h.seams.firstPartHistory = vi.fn(() => new Promise((r) => { resolve = r; }));
  h.seams.isAncestor = async () => true;
  const main = async (outcome: LocalVerifyRecord['outcome'], head: string) => {
    (h.svc as any).completeMain(record({ kind: 'main', pr: 0, headSha: head, baseSha: head, outcome }),
      { kind: 'main', pr: 0, headSha: head, baseSha: head, baseRefName: 'main', attempts: 1, errorRetries: 0 });
    await h.flush();
  };
  await main('success', sha('b')); await main('failure', sha('c')); await main('failure', sha('c'));
  expect(h.svc.firstPartReport.hasOpenEpisode()).toBe(true);
  expect(h.seams.firstPartHistory).toHaveBeenCalledTimes(1);
  // Health completion must settle while history is still pending.
  expect(await Promise.race([Promise.all((h.svc as any).pendingMainWork).then(() => 'done'), h.flush().then(() => 'blocked')])).toBe('done');
  await main('failure', sha('c')); expect(h.seams.firstPartHistory).toHaveBeenCalledTimes(1);
  await main('success', sha('d')); resolve([{ head: sha('c'), message: 'fix (#1)' }]); await h.flush();
  expect(h.svc.firstPartReport.hasOpenEpisode()).toBe(false);
  expect(off).not.toHaveBeenCalled(); h.svc.shutdown();
});
