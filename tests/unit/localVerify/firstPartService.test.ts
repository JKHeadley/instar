// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * First parts in LocalVerifyService (spec docs/specs/local-verify-likely-failing-first.md,
 * sections B, E, F and measure 6): the list is updated by the one completion path, the run input
 * and the hand-off to a peer carry it, a pull request keeps one assignment, and in `alternate`
 * the verdict check follows a finished verify with a comparison run that can never change it.
 * Real fs in a temp state dir; the child process, gh, the peer client and the clock are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type LocalVerifyServiceSeams, type PrView } from '../../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunInput, VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import type { PeerClient, PeerRunRequest } from '../../../src/localVerify/peer.js';
import { parsePeerRunRequest } from '../../../src/localVerify/peer.js';
import type { FirstPartSummary } from '../../../src/localVerify/firstPart.js';
import type { FileOutcome } from '../../../src/localVerify/firstPartTrial.js';
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

interface Spawned { pid: number; args: string[]; resultPath: string; inputPath: string; input: VerifyRunInput; /** The comparison marker file as it was when this child was spawned (null = absent). */ markerAtSpawn: Record<string, unknown> | null; resolve: (x: { status: number | null; signal: string | null }) => void }

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
      let markerAtSpawn: Record<string, unknown> | null = null;
      try { markerAtSpawn = JSON.parse(fs.readFileSync(path.join(lvDir, 'first-part-compare-inflight.json'), 'utf-8')); } catch { markerAtSpawn = null; }
      spawned.push({ pid: p, args: [a.command, ...a.args], resultPath: a.args[a.args.indexOf('--result') + 1], inputPath, input: JSON.parse(fs.readFileSync(inputPath, 'utf-8')), markerAtSpawn, resolve });
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

describe('the verdict check: a comparison run after the verify is final', () => {
  const outcomes = (o: Record<string, FileOutcome>) => o;
  function trial(opts: Parameters<typeof setup>[0] = {}) {
    const h = setup(opts);
    let setting: unknown = 'alternate';
    let failFast = true;
    const offWrites: number[] = [];
    h.svc.setLikelyFailingFirst(() => setting);
    h.svc.setFailFastEnabled(() => failFast);
    h.svc.setLikelyFailingFirstOff(() => { offWrites.push(h.now()); setting = 'off'; });
    return { ...h, offWrites, setSetting: (v: unknown) => { setting = v; }, setFailFast: (v: boolean) => { failFast = v; } };
  }
  /** One verify of `pr` with first parts that passed, then its comparison finishing with `second`. Returns the two spawns. */
  async function verifyThenCompare(h: ReturnType<typeof trial>, pr: number, first: VerifyRunResult | ((inp: VerifyRunInput) => VerifyRunResult), second: ((inp: VerifyRunInput) => VerifyRunResult | null) | null) {
    const before = h.spawned.length;
    const s = await runAndFinish(h, pr, (inp) => (typeof first === 'function' ? first(inp) : first));
    const cmp = h.spawned[before + 1];
    if (cmp && second) await h.finish(before + 1, second(cmp.input));
    return { verify: s, compare: cmp };
  }
  const passedWith = (inp: VerifyRunInput, files: Record<string, FileOutcome> = { [F1]: 'passed', [F2]: 'passed' }) =>
    ok(record({ pr: inp.pr, headSha: inp.headSha }), { firstPart: summary(), fileOutcomes: files });

  it('starts only after the verify is recorded and acted on, in a fresh checkout, with no first part, and its result is never a record', async () => {
    const h = trial();
    const { verify, compare } = await verifyThenCompare(h, 1, (inp) => passedWith(inp), null);
    expect(verify.input.collectFileOutcomes).toBe(true);
    // The verify is final first: its record was journaled and handed on before the comparison was spawned.
    expect(h.records).toHaveLength(1);
    const finalRecord = JSON.stringify(h.records[0]);
    const order = h.audit().map((x) => x.event);
    expect(order.indexOf('record')).toBeLessThan(order.indexOf('first-part-compare-started'));
    expect(order.indexOf('first-part')).toBeLessThan(order.indexOf('first-part-compare-started'));
    // The comparison run: the same head and base, a fresh checkout of its own, no first part.
    expect(compare).toBeDefined();
    expect(compare.input).toMatchObject({ pr: 1, headSha: verify.input.headSha, baseSha: verify.input.baseSha, variant: 'compare', collectFileOutcomes: true, preflightMode: 'off' });
    expect('likelyFailingFirst' in compare.input).toBe(false);
    expect(compare.input.isolation).toEqual(verify.input.isolation);
    // It finishes with a DIFFERENT verdict and a later end time: nothing recorded changes.
    await h.finish(1, ok(record({ pr: 1, outcome: 'failure', failedFiles: [F1], startedAt: '2026-10-21T12:40:00.000Z', finishedAt: '2026-10-21T13:10:00.000Z' }), { fileOutcomes: outcomes({ [F1]: 'failed', [F2]: 'passed' }) }));
    expect(h.records).toHaveLength(1);
    expect(JSON.stringify(h.records[0])).toBe(finalRecord);
    expect(h.svc.getRecord(1, sha('a'), 'main')).toMatchObject({ outcome: 'success', finishedAt: '2026-10-21T12:20:00.000Z' });
    expect(h.events('record')).toHaveLength(1);
    // The comparison's failure never reached the list either.
    expect(h.svc.likelyFailing.listFor(99)).toEqual([]);
    const journal = fs.readFileSync(path.join(h.lvDir, 'journal.jsonl'), 'utf-8').split('\n').filter(Boolean);
    expect(journal).toHaveLength(1);
  });

  it('the `first-part-compare` row records both verdicts, the files that ran in both, and the failures only one run reached', async () => {
    const h = trial();
    // The verify ended in its first part on F1 (F2 and F3 never ran); the comparison saw F1 and F3 fail.
    await verifyThenCompare(h, 1,
      (inp) => ok(failed(1, [F1], { headSha: inp.headSha }), { firstPart: summary({ endedInFirstPart: true }), fileOutcomes: outcomes({ [F1]: 'failed' }) }),
      (inp) => ok(failed(1, [F3, F1], { headSha: inp.headSha }), { fileOutcomes: outcomes({ [F1]: 'failed', [F2]: 'passed', [F3]: 'failed' }) }));
    const rows = h.events('first-part-compare');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pr: 1, kind: 'ended-first', first: 'failure', compare: 'failure', verdictDiffers: false, ranInBoth: 1, bothPassed: 0, bothFailed: [F1],
      differing: [], onlyFirstReached: [], onlyCompareReached: [F3], difference: false, failFast: true,
      bothFailedCount: 1, flakyInEitherCount: 0, differingCount: 0, onlyFirstReachedCount: 0, onlyCompareReachedCount: 1,
    });
    expect(typeof rows[0].compareMinutes).toBe('number');
    // One fault in each part is not a difference: the setting stays as it was.
    expect(h.svc.likelyFailingFirst()).toBe('alternate');
    expect(h.offWrites).toEqual([]);
    expect(h.signals).toEqual([]);
    expect(h.svc.snapshot().likelyFailingFirst.trial.done).toEqual({ 'ended-first': 1, 'failed-later': 0, passed: 0 });
  });

  it('uses the machine’s own fail-fast setting as it is when the comparison starts', async () => {
    const h = trial();
    h.setFailFast(false);
    const a = await verifyThenCompare(h, 1, (inp) => passedWith(inp), (inp) => ok(record({ pr: 1, headSha: inp.headSha }), { fileOutcomes: outcomes({ [F1]: 'passed', [F2]: 'passed' }) }));
    expect('failFast' in a.verify.input).toBe(false);
    expect('failFast' in a.compare.input).toBe(false);
    expect(h.events('first-part-compare')[0]).toMatchObject({ failFast: false });
    // Turned on between the verify's start and the comparison's start: the comparison has it on.
    const before = h.spawned.length;
    await h.svc.request(2, { explicit: true });
    await h.flush();
    expect('failFast' in h.spawned[before].input).toBe(false);
    h.setFailFast(true);
    await h.finish(before, passedWith(h.spawned[before].input));
    expect(h.spawned[before + 1].input).toMatchObject({ variant: 'compare', failFast: true });
  });

  it('a difference on a file not known to be unreliable switches the setting off on this machine and raises ONE notice', async () => {
    const h = trial();
    await verifyThenCompare(h, 1,
      (inp) => ok(failed(1, [F2], { headSha: inp.headSha }), { firstPart: summary(), fileOutcomes: outcomes({ [F1]: 'passed', [F2]: 'failed' }) }),
      (inp) => ok(record({ pr: 1, headSha: inp.headSha }), { fileOutcomes: outcomes({ [F1]: 'passed', [F2]: 'passed' }) }));
    expect(h.events('first-part-compare')[0]).toMatchObject({ kind: 'failed-later', first: 'failure', compare: 'success', verdictDiffers: true, difference: true, differing: [{ file: F2, first: 'failed', compare: 'passed', known: false }] });
    expect(h.offWrites).toHaveLength(1);
    expect(h.svc.likelyFailingFirst()).toBe('off');
    expect(h.events('first-part-switched-off')).toEqual([expect.objectContaining({ pr: 1, configWritten: true, files: [F2] })]);
    expect(h.signals.map((s) => s.key)).toEqual(['local-verify:first-part-difference']);
    expect(String(h.signals[0].detail.note)).toContain(F2);
    // The recorded verdict is still the verify's own.
    expect(h.svc.getRecord(1, sha('a'), 'main')).toMatchObject({ outcome: 'failure', failedFiles: [F2] });
    // Even with the config put back to alternate, this machine stays off, and nothing more is compared.
    h.setSetting('alternate');
    expect(h.svc.likelyFailingFirst()).toBe('off');
    const next = await runAndFinish(h, 2, (inp) => ok(record({ pr: 2, headSha: inp.headSha })));
    expect('likelyFailingFirst' in next.input).toBe(false);
    expect(h.offWrites).toHaveLength(1);
    expect(h.signals).toHaveLength(1);
    // Removing the trial state file is how the trial is started again.
    SafeFsExecutor.safeRmSync(path.join(h.lvDir, 'first-part-trial.json'), { force: true, operation: 'firstPartService.test.ts' });
    expect(h.svc.likelyFailingFirst()).toBe('alternate');
  });

  it('with no config writer the trial state file alone holds it off, and the notice says so', async () => {
    const h = trial();
    h.svc.setLikelyFailingFirstOff(null);
    await verifyThenCompare(h, 1,
      (inp) => ok(failed(1, [F2], { headSha: inp.headSha }), { firstPart: summary(), fileOutcomes: outcomes({ [F2]: 'failed' }) }),
      (inp) => ok(record({ pr: 1, headSha: inp.headSha }), { fileOutcomes: outcomes({ [F2]: 'passed' }) }));
    expect(h.svc.likelyFailingFirst()).toBe('off');
    expect(h.events('first-part-switched-off')[0]).toMatchObject({ configWritten: false });
    expect(String(h.signals[0].detail.note)).toContain('first-part-trial.json');
  });

  it('a difference on a file already known to be unreliable does not switch anything off', async () => {
    const h = trial();
    // F2 is known: it failed and passed alone in an earlier verify on this machine.
    await runAndFinish(h, 7, (inp) => ok(record({ pr: 7, headSha: inp.headSha, flakyRetried: [{ file: F2, lane: 'unit', firstMessage: 'boom' }] }), { firstPart: summary({ group: 'with', active: false, lanes: [] }) }));
    expect(Object.keys(h.svc.flakyFiles())).toContain(F2);
    await verifyThenCompare(h, 1,
      (inp) => ok(failed(1, [F2], { headSha: inp.headSha }), { firstPart: summary(), fileOutcomes: outcomes({ [F1]: 'passed', [F2]: 'failed' }) }),
      (inp) => ok(record({ pr: 1, headSha: inp.headSha }), { fileOutcomes: outcomes({ [F1]: 'passed', [F2]: 'passed' }) }));
    expect(h.events('first-part-compare')[0]).toMatchObject({ difference: false, verdictDiffers: true, differing: [{ file: F2, first: 'failed', compare: 'passed', known: true }] });
    expect(h.svc.likelyFailingFirst()).toBe('alternate');
    expect(h.signals.filter((s) => s.key === 'local-verify:first-part-difference')).toEqual([]);
  });

  it('runs for the first 5 verifies of each kind and then no more', async () => {
    const h = trial();
    let compares = 0;
    for (let n = 0; n < 7; n++) {
      h.views[100 + n] = view({ headRefOid: sha(String(n)) });
      const { compare } = await verifyThenCompare(h, 100 + n, (inp) => passedWith(inp), (inp) => ok(record({ pr: inp.pr, headSha: inp.headSha }), { fileOutcomes: outcomes({ [F1]: 'passed', [F2]: 'passed' }) }));
      if (compare) compares++;
    }
    expect(compares).toBe(5);
    expect(h.events('first-part-compare')).toHaveLength(5);
    expect(h.svc.snapshot().likelyFailingFirst.trial.done).toEqual({ 'ended-first': 0, 'failed-later': 0, passed: 5 });
    // Another kind still has its own five.
    h.views[200] = view({ headRefOid: sha('f') });
    const other = await verifyThenCompare(h, 200,
      (inp) => ok(failed(200, [F1], { headSha: inp.headSha }), { firstPart: summary({ endedInFirstPart: true }), fileOutcomes: outcomes({ [F1]: 'failed' }) }),
      (inp) => ok(failed(200, [F1], { headSha: inp.headSha }), { fileOutcomes: outcomes({ [F1]: 'failed', [F2]: 'passed' }) }));
    expect(other.compare).toBeDefined();
    expect(h.svc.snapshot().likelyFailingFirst.trial.done['ended-first']).toBe(1);
  });

  it('a comparison that ends as an error, or with no result, concludes nothing and is not counted as compared', async () => {
    const h = trial();
    await verifyThenCompare(h, 1, (inp) => passedWith(inp), (inp) => ok(record({ pr: 1, headSha: inp.headSha, outcome: 'error', errorStep: 'deadline:unit', lanes: [] })));
    await verifyThenCompare(h, 2, (inp) => passedWith(inp), () => null);
    const rows = h.events('first-part-compare');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ inconclusive: true, reason: 'error:deadline:unit', first: 'success', compare: 'error' });
    expect(rows[1]).toMatchObject({ inconclusive: true, reason: 'no-record' });
    const trialState = h.svc.snapshot().likelyFailingFirst.trial;
    expect(trialState.done.passed).toBe(0);
    expect(trialState.started.passed).toBe(2);
    expect(h.svc.likelyFailingFirst()).toBe('alternate');
    expect(h.records).toHaveLength(2);
  });

  it('never follows a verify without first parts, an error, or a verify under `on`', async () => {
    const h = trial();
    await runAndFinish(h, 1, (inp) => ok(record({ pr: 1, headSha: inp.headSha }), { firstPart: summary({ group: 'without', active: false, lanes: [] }), fileOutcomes: outcomes({ [F1]: 'passed' }) }));
    await runAndFinish(h, 2, (inp) => ok(record({ pr: 2, headSha: inp.headSha, outcome: 'error', errorStep: 'conflict', lanes: [], mergeTree: '' }), { firstPart: summary({ lanes: [] }) }));
    h.setSetting('on');
    await runAndFinish(h, 3, (inp) => ok(record({ pr: 3, headSha: inp.headSha }), { firstPart: summary({ setting: 'on' }), fileOutcomes: outcomes({ [F1]: 'passed' }) }));
    expect(h.events('first-part-compare-started')).toEqual([]);
    expect(h.spawned.every((s) => s.input.variant !== 'compare')).toBe(true);
  });

  it('holds this machine like a verify while it runs: the next queued verify starts when the comparison ends', async () => {
    const h = trial();
    const first = await verifyThenCompare(h, 1, (inp) => passedWith(inp), null);
    expect(first.compare.input.variant).toBe('compare');
    await h.svc.request(2, { explicit: true });
    await h.flush();
    expect(h.spawned).toHaveLength(2); // PR 2 waits
    expect(h.svc.snapshot().likelyFailingFirst.trial.comparing).toEqual({ pr: 1, headSha: sha('a'), kind: 'passed' });
    await h.finish(1, ok(record({ pr: 1 }), { fileOutcomes: outcomes({ [F1]: 'passed', [F2]: 'passed' }) }));
    expect(h.spawned).toHaveLength(3);
    expect(h.spawned[2].input).toMatchObject({ pr: 2 });
    expect(h.spawned[2].input.variant).toBeUndefined();
    expect(h.svc.snapshot().likelyFailingFirst.trial.comparing).toBeNull();
  });

  it('a running comparison counts as busy: not idle for the leftover sweep, slot busy for the coordinator, diagnosis capacity busy', async () => {
    const h = trial();
    // Idle first: the sweep may take this agent's run folders at any age, the slot is free, a diagnosis may start.
    await h.svc.sweepLeftovers('tick');
    const ownAges = (k: number) => h.sweeps[k].filter((x) => x.prefix.includes('/.worktrees/')).map((x) => x.minAgeS);
    expect(ownAges(0).length).toBeGreaterThan(0);
    expect(ownAges(0).every((a) => a === 0)).toBe(true);
    expect(h.svc.peerStatus().slotBusy).toBe(false);
    expect(h.svc.isDiagnosisCapacityBusy()).toBe(false);
    const { compare } = await verifyThenCompare(h, 1, (inp) => passedWith(inp), null);
    expect(compare.input.variant).toBe('compare');
    expect(h.svc.snapshot().inFlight).toBeNull(); // only the comparison is running
    // The comparison's tests live in this agent's run folders: they are not leftovers while it runs.
    await h.svc.sweepLeftovers('tick');
    expect(ownAges(1).every((a) => a > 0)).toBe(true);
    expect(h.svc.peerStatus().slotBusy).toBe(true);
    expect(h.svc.isDiagnosisCapacityBusy()).toBe(true);
    // When it ends, all three read free again.
    await h.finish(1, ok(record({ pr: 1 }), { fileOutcomes: outcomes({ [F1]: 'passed', [F2]: 'passed' }) }));
    await h.svc.sweepLeftovers('tick');
    expect(ownAges(2).every((a) => a === 0)).toBe(true);
    expect(h.svc.peerStatus().slotBusy).toBe(false);
    expect(h.svc.isDiagnosisCapacityBusy()).toBe(false);
  });

  it('the marker is on disk BEFORE the child is spawned, and names the group right after', async () => {
    const h = trial();
    const { verify, compare } = await verifyThenCompare(h, 1, (inp) => passedWith(inp), null);
    expect(verify.markerAtSpawn).toBeNull(); // an ordinary verify has no comparison marker
    const token = compare.args[compare.args.indexOf('--attempt-token') + 1];
    expect(compare.markerAtSpawn).toMatchObject({ v: 1, attemptToken: token, pid: null, pgid: null, pr: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(h.lvDir, 'first-part-compare-inflight.json'), 'utf-8'))).toMatchObject({ attemptToken: token, pid: compare.pid, pgid: compare.pid });
    // A marker left without a group (a crash between the two writes) is simply cleared at boot.
    h.svc.shutdown();
    fs.writeFileSync(path.join(h.lvDir, 'first-part-compare-inflight.json'), JSON.stringify({ v: 1, attemptToken: token, pid: null, pgid: null, pr: 1 }));
    const boot = trial({ stateDir: h.stateDir });
    await boot.svc.reapOrphan();
    expect(fs.existsSync(path.join(h.lvDir, 'first-part-compare-inflight.json'))).toBe(false);
    expect(boot.kills).toEqual([]);
  });

  it('a marker that cannot be written means no comparison child at all', async () => {
    const h = trial();
    // A folder where the marker file should be: the write (a rename onto it) fails.
    fs.mkdirSync(path.join(h.lvDir, 'first-part-compare-inflight.json'));
    fs.writeFileSync(path.join(h.lvDir, 'first-part-compare-inflight.json', 'x'), '');
    const before = h.spawned.length;
    await runAndFinish(h, 1, (inp) => passedWith(inp));
    expect(h.spawned.length).toBe(before + 1); // the verify only
    expect(h.events('first-part-compare-dropped')).toEqual([expect.objectContaining({ pr: 1, reason: 'marker-unwritable' })]);
    expect(h.svc.peerStatus().slotBusy).toBe(false);
  });

  it('a stop ends a running comparison without counting it; a server that died under one ends its group at the next boot', async () => {
    const h = trial();
    const { compare } = await verifyThenCompare(h, 1, (inp) => passedWith(inp), null);
    const marker = path.join(h.lvDir, 'first-part-compare-inflight.json');
    expect(JSON.parse(fs.readFileSync(marker, 'utf-8'))).toMatchObject({ pid: compare.pid, pgid: compare.pid, pr: 1 });
    h.svc.shutdown();
    expect(h.kills).toContainEqual({ pgid: compare.pid, signal: 'SIGKILL' });
    expect(h.svc.snapshot().likelyFailingFirst.trial.done.passed).toBe(0);
    // A crash instead of a clean stop: the marker names the group, and boot ends it.
    const token = compare.args[compare.args.indexOf('--attempt-token') + 1];
    fs.writeFileSync(marker, JSON.stringify({ v: 1, attemptToken: token, pid: 9001, pgid: 9001, pr: 1, headSha: sha('a'), startedAt: 1 }));
    const boot = trial({ stateDir: h.stateDir });
    boot.alive.add(9001);
    boot.procArgs.set(9001, `node runVerifyMain.js --attempt-token ${token}`);
    await boot.svc.reapOrphan();
    expect(boot.kills).toContainEqual({ pgid: 9001, signal: 'SIGKILL' });
    expect(fs.existsSync(marker)).toBe(false);
    expect(boot.events('first-part-compare-orphan-reaped').length).toBeGreaterThanOrEqual(1);
  });

  it('on a peer: the comparison follows the finished attempt, whose record is already kept for the coordinator', async () => {
    const h = trial({ peerOnly: true, machineId: 'peer1' });
    h.svc.setPeerWiring({ peerRoleEnabled: () => true });
    const ATT = 'b'.repeat(32);
    const answer = await h.svc.peerRun({
      attemptId: ATT, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY,
      coordinatorMachineId: 'coord', leaseEpoch: 7, firstPartGroup: 'with', likelyFailing: { list: [F1], previous: [] },
    }, { holdsLease: false, holderMachineId: 'coord' });
    expect(answer).toEqual({ ok: true, attemptId: ATT });
    const att = { id: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 };
    await h.finish(0, ok(record({ machineId: 'peer1', attempt: att }), { firstPart: summary(), fileOutcomes: outcomes({ [F1]: 'passed' }) }));
    const order = h.audit().map((x) => x.event);
    expect(order.indexOf('peer-attempt-done')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('peer-attempt-done')).toBeLessThan(order.indexOf('first-part-compare-started'));
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1].input).toMatchObject({ variant: 'compare', pr: 1 });
    expect('attempt' in h.spawned[1].input).toBe(false);
    expect('likelyFailingFirst' in h.spawned[1].input).toBe(false);
    // While it runs the peer answers busy to a new hand-off.
    const busy = await h.svc.peerRun({
      attemptId: 'c'.repeat(32), pr: 2, headSha: sha('c'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0', policyHash: POLICY,
      coordinatorMachineId: 'coord', leaseEpoch: 7,
    }, { holdsLease: false, holderMachineId: 'coord' });
    expect(busy).toEqual({ ok: false, reason: 'peer-busy' });
    await h.finish(1, ok(record({ machineId: 'peer1' }), { fileOutcomes: outcomes({ [F1]: 'passed' }) }));
    expect(h.events('first-part-compare')).toEqual([expect.objectContaining({ pr: 1, kind: 'passed', difference: false })]);
  });
});

// ── F: GET /local-verify ───────────────────────────────────────────────

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
    expect(s.trial).toEqual({ done: { 'ended-first': 0, 'failed-later': 0, passed: 0 }, started: { 'ended-first': 0, 'failed-later': 0, passed: 0 }, switchedOff: null, comparing: null });
  });
});
