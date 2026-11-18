/**
 * SEC-088 part 2 (docs/specs/trust-records-holder-authored.md, cut form): a grant counts only where it
 * was written and only inside the writer's current run of the lease; a record another machine wrote
 * only closes, uses or withdraws by id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrustJourneyStore, keyEpoch, epochKey, type TrustRecord, type TrustRecordSink, type TrustRunView } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { TrustRunTracker, type LeaseSnapshot } from '../../src/core/trustJourney/TrustRunTracker.js';
import { resolvePeerGrants } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

class MemSink implements TrustRecordSink {
  readonly description = 'memory';
  rows: TrustRecord[] = [];
  async append(recordKey: string, rec: TrustRecord) { this.rows.push({ ...rec, recordKey } as TrustRecord); return true; }
  loadAll() { return this.rows.map((r) => ({ ...r })); }
}

const SELF = 'm_self';
const PEER = 'm_peer';

/** A run view driven by the test: the epochs this machine held, the current epoch, holding or not. */
function fakeRun(state: { held: Set<number>; epoch: number | null; holds: boolean; multi?: boolean }): TrustRunView {
  return {
    multiMachine: () => state.multi ?? true,
    writeEpoch: () => state.epoch,
    inRun: (e) => {
      if (!(state.multi ?? true)) return true;
      if (e === null || state.epoch === null || !state.holds || e > state.epoch) return false;
      for (let x = e; x <= state.epoch; x++) if (!state.held.has(x)) return false;
      return true;
    },
  };
}

const peerRec = (store: TrustJourneyStore, recordKey: string, data: Record<string, unknown>) =>
  store.applyCommitted([{ writer: PEER, recordKey, data: { minReader: 1, at: '2026-11-18T00:00:00.000Z', ...data } }]);

describe('key epochs', () => {
  it('an epoch goes after the type segment and parses back; keys from before this build have none', () => {
    expect(epochKey('tj:request:abc:card', 7)).toBe('tj:request:e7:abc:card');
    expect(epochKey('tj:legacy:m1:gmail.write', 3)).toBe('tj:legacy:e3:m1:gmail.write');
    expect(keyEpoch('tj:request:e7:abc:card')).toBe(7);
    expect(keyEpoch('tj:request:abc:card')).toBeNull();
    expect(keyEpoch('tj:action-approval:e12345678abcdef')).toBeNull(); // random hex, no colon after
  });
});

describe('own index vs peer records (ignore)', () => {
  let state: { held: Set<number>; epoch: number | null; holds: boolean };
  let store: TrustJourneyStore;
  beforeEach(() => {
    state = { held: new Set([5]), epoch: 5, holds: true };
    store = new TrustJourneyStore(new MemSink(), () => new Date('2026-11-18T01:00:00Z'), { self: SELF, run: fakeRun(state), peerGrants: 'ignore' });
  });

  it('a peer action-approval never yields an unused approval; an own one in the run does', async () => {
    peerRec(store, 'tj:action-approval:e5:x', { recordType: 'action-approval', approvalId: 'p1', actionIdentity: 'act', consumptionId: 'c' });
    expect(store.unusedActionApproval('act')).toBeNull();
    expect((await store.write('action-approval', { approvalId: 'o1', actionIdentity: 'act', consumptionId: 'c' })).recordKey).toMatch(/^tj:action-approval:e5:/);
    expect(store.unusedActionApproval('act')?.approvalId).toBe('o1');
    expect(store.summary().peerGrantsIgnored).toEqual([{ type: 'action-approval', writer: PEER, count: 1 }]);
  });

  it('a peer dispatch marks an own approval used (narrowing by id)', async () => {
    await store.write('action-approval', { approvalId: 'o1', actionIdentity: 'act', consumptionId: 'c' });
    peerRec(store, 'tj:dispatch:o1', { recordType: 'dispatch', approvalId: 'o1', actionIdentity: 'act' });
    expect(store.unusedActionApproval('act')).toBeNull();
  });

  it('a peer request reusing an own requestId with a card never replaces the own request', async () => {
    await store.write('request', { requestId: 'r1', code: 'AAAA', proposalHash: 'h', principal: 'owner', adapter: 'telegram', approverPlatformId: '1', expiresAt: '2026-12-01T00:00:00Z', status: 'open', change: { kind: 'board-policy', policy: 'own' }, summary: [], cardMessageId: '', cardChatId: '' }, 'tj:request:r1');
    peerRec(store, 'tj:request:e5:r1:card', { recordType: 'request', requestId: 'r1', code: 'BBBB', proposalHash: 'evil', principal: 'owner', adapter: 'telegram', approverPlatformId: '1', expiresAt: '2026-12-01T00:00:00Z', status: 'open', change: { kind: 'board-policy', policy: 'evil' }, summary: [], cardMessageId: '77', cardChatId: '1' });
    expect(store.request('r1')?.proposalHash).toBe('h');
    expect(store.requestByCard('telegram', '77')).toBeNull();
    expect(store.codeTaken('BBBB')).toBe(true); // a peer's code is still never reused
  });

  it('a peer consumption closes an own request and is marked as closed by another machine', async () => {
    await store.write('request', { requestId: 'r2', code: 'CCCC', proposalHash: 'h', principal: 'owner', adapter: 'telegram', approverPlatformId: '1', expiresAt: '2026-12-01T00:00:00Z', status: 'open', change: { kind: 'board-policy', policy: 'x' }, summary: [], cardMessageId: '', cardChatId: '' }, 'tj:request:r2');
    peerRec(store, 'tj:consumption:r2', { recordType: 'consumption', consumptionId: 'pc', requestId: 'r2', receiptId: 'rr', acceptanceId: 'a', proposalHash: 'h', principal: 'owner' });
    expect(store.request('r2')?.status).toBe('consumed');
    expect(store.requestNarrowedByPeer('r2')).toBe(true);
    expect(store.consumptionOf('r2')).toBeNull(); // the peer's consumption is not an own outcome
  });

  it('a peer change (any key, any id, any time) never touches levels, the change log or legacy validity', async () => {
    await store.write('legacy-grant', { key: 'gmail.write', machine: SELF, behaviour: 'log', afterChange: null }, `tj:legacy:${SELF}:gmail.write`);
    expect(store.legacyUnchanged('gmail.write')).toBe(true);
    peerRec(store, 'tj:change:e999999999:x', { recordType: 'change', changeId: 'k', key: 'gmail.write', from: 'log', to: 'autonomous', direction: 'raise', source: 'user-explicit', at: '2999-01-01T00:00:00Z' });
    peerRec(store, 'tj:change:y', { recordType: 'change', changeId: 'k2', key: 'slack.write', from: null, to: 'autonomous', direction: 'raise', source: 'earned' });
    expect(store.lastChange('gmail.write')).toBeNull();
    expect(store.lastChange('slack.write')).toBeNull();
    expect(store.changeLog()).toEqual([]);
    expect(store.legacyUnchanged('gmail.write')).toBe(true);
  });

  it('an own change after an own legacy grant ends it, by own write order', async () => {
    await store.write('legacy-grant', { key: 'gmail.write', machine: SELF, behaviour: 'log', afterChange: null }, `tj:legacy:${SELF}:gmail.write`);
    await store.write('change', { changeId: 'c1', key: 'gmail.write', from: 'log', to: 'approve-always', direction: 'lower', source: 'user-explicit', at: '2000-01-01T00:00:00Z' });
    expect(store.legacyUnchanged('gmail.write')).toBe(false);
  });

  it('peer legacy grants are evidence only: never imported, but they mark a joining machine', () => {
    peerRec(store, 'tj:legacy:m_peer:gmail.write', { recordType: 'legacy-grant', key: 'gmail.write', machine: PEER, behaviour: 'log', afterChange: null });
    expect(store.legacyKeys()).toEqual([]);
    expect(store.unchangedLegacyKeys()).toEqual([]);
    expect(store.legacyImportedAnywhere(SELF)).toBe(true);
  });

  it('a peer device acceptance never counts here and is shown as not counted', () => {
    peerRec(store, 'tj:device-acceptance:e5:z', { recordType: 'device-acceptance', acceptanceId: 'pa', principal: 'owner', deviceId: 'd1', keyFingerprint: 'f', presenceKeyHash: 'h', keyPolicy: 'userPresence', disclosureHash: 'x', via: 'local-install', acceptedAt: '2026-11-18T00:00:00Z' });
    expect(store.deviceAcceptance('d1')).toBeNull();
    expect(store.currentDeviceAcceptances()).toEqual([]);
    expect(store.deviceAcceptanceHistory()[0]).toMatchObject({ acceptanceId: 'pa', countedHere: false, writtenBy: PEER });
  });

  it('a withdrawal made where approvals are not handled names the holder\'s acceptance too (round 8 hole)', async () => {
    peerRec(store, 'tj:acceptance:e5:h', { recordType: 'acceptance', acceptanceId: 'holder-acc', principal: 'owner', adapter: 'telegram', accountId: '1', acceptedAt: '2026-11-18T00:00:00Z' });
    expect(store.acceptanceIdsToWithdraw('owner', 'telegram')).toEqual(['holder-acc']);
    await store.write('acceptance-withdrawn', { acceptanceId: 'holder-acc', principal: 'owner', adapter: 'telegram' }, 'tj:acceptance-withdrawn:holder-acc');
    expect(store.acceptanceIdsToWithdraw('owner', 'telegram')).toEqual([]);
    // On the holder, the standby's withdrawal (a peer record) ends its own acceptance by id.
    const holder = new TrustJourneyStore(new MemSink(), () => new Date('2026-11-18T01:00:00Z'), { self: PEER, run: fakeRun(state) });
    await holder.write('acceptance', { acceptanceId: 'holder-acc', principal: 'owner', adapter: 'telegram', accountId: '1', acceptedAt: '2026-11-18T00:00:00Z' });
    expect(holder.acceptance('owner', 'telegram')?.acceptanceId).toBe('holder-acc');
    holder.applyCommitted([{ writer: SELF, recordKey: 'tj:acceptance-withdrawn:holder-acc', data: { recordType: 'acceptance-withdrawn', acceptanceId: 'holder-acc', principal: 'owner', adapter: 'telegram', at: '2026-11-18T00:00:00Z', minReader: 1 } }]);
    expect(holder.acceptance('owner', 'telegram')).toBeNull();
  });

  it('device acceptances from any machine are listed for a withdrawal', () => {
    peerRec(store, 'tj:device-acceptance:e5:z', { recordType: 'device-acceptance', acceptanceId: 'pa', principal: 'owner', deviceId: 'peer-dev-1', keyFingerprint: 'fp1', presenceKeyHash: 'h', keyPolicy: 'userPresence', disclosureHash: 'x', via: 'local-install', acceptedAt: '2026-11-18T00:00:00Z' });
    expect(store.deviceAcceptancesToWithdraw().map((a) => a.acceptanceId)).toEqual(['pa']);
  });

  it('an unreadable peer change never puts a kind into unreadable history', () => {
    peerRec(store, 'tj:change:u', { recordType: 'change', changeId: 'u', key: 'gmail.write', from: 'a', to: 'b', direction: 'raise', source: 'x', futureField: 1 });
    expect(store.hasUnreadableHistory('gmail.write')).toBe(false);
  });

  it('a boot refold gives the same state and does not re-count ignored peer grants', async () => {
    const sink = new MemSink();
    const s1 = new TrustJourneyStore(sink, () => new Date('2026-11-18T01:00:00Z'), { self: SELF, run: fakeRun(state) });
    await s1.write('action-approval', { approvalId: 'o1', actionIdentity: 'act', consumptionId: 'c' });
    sink.rows.push({ recordType: 'action-approval', approvalId: 'p1', actionIdentity: 'act2', consumptionId: 'c', at: '2026-11-18T00:00:00Z', minReader: 1, recordKey: 'tj:action-approval:e5:p', writer: PEER } as unknown as TrustRecord);
    const s2 = new TrustJourneyStore(sink, () => new Date('2026-11-18T01:00:00Z'), { self: SELF, run: fakeRun(state) });
    s2.applyCommitted([{ writer: PEER, recordKey: 'tj:action-approval:e5:p', data: { recordType: 'action-approval', approvalId: 'p1', actionIdentity: 'act2', consumptionId: 'c', at: '2026-11-18T00:00:00Z', minReader: 1 } }]);
    expect(s2.unusedActionApproval('act')?.approvalId).toBe('o1');
    expect(s2.unusedActionApproval('act2')).toBeNull();
    expect(s2.summary().peerGrantsIgnored).toEqual([{ type: 'action-approval', writer: PEER, count: 1 }]);
  });
});

describe('the current run', () => {
  let state: { held: Set<number>; epoch: number | null; holds: boolean };
  let store: TrustJourneyStore;
  beforeEach(() => {
    state = { held: new Set([5]), epoch: 5, holds: true };
    store = new TrustJourneyStore(new MemSink(), () => new Date('2026-11-18T01:00:00Z'), { self: SELF, run: fakeRun(state) });
  });

  it('A -> B -> A leaves every earlier own grant absent', async () => {
    await store.write('action-approval', { approvalId: 'o1', actionIdentity: 'act', consumptionId: 'c' });
    await store.write('change', { changeId: 'c1', key: 'gmail.write', from: 'approve-always', to: 'autonomous', direction: 'raise', consumptionId: 'x', source: 'person' });
    await store.write('acceptance', { acceptanceId: 'acc1', principal: 'owner', adapter: 'telegram', accountId: '1', acceptedAt: '2026-11-18T00:00:00Z' });
    await store.write('legacy-grant', { key: 'slack.write', machine: SELF, behaviour: 'log', afterChange: null }, `tj:legacy:${SELF}:slack.write`);
    // B held 6; A took 7.
    state.epoch = 7; state.held.add(7);
    expect(store.unusedActionApproval('act')).toBeNull();
    expect(store.lastChange('gmail.write')).toBeNull();
    expect(store.acceptance('owner', 'telegram')).toBeNull();
    expect(store.legacyUnchanged('slack.write')).toBe(false);
    expect(store.summary().outsideRun).toMatchObject({ 'action-approval': 1, change: 1, acceptance: 1, 'legacy-grant': 1 });
  });

  it('a same-machine re-acquire N -> N+1 keeps the run', async () => {
    await store.write('action-approval', { approvalId: 'o1', actionIdentity: 'act', consumptionId: 'c' });
    state.epoch = 6; state.held.add(6);
    expect(store.unusedActionApproval('act')?.approvalId).toBe('o1');
  });

  it('not holding the lease: no grant counts, and a grant written then never counts later', async () => {
    state.holds = false; // a standby at the holder's epoch 5
    state.held = new Set();
    await store.write('action-approval', { approvalId: 's1', actionIdentity: 'act', consumptionId: 'c' });
    expect(store.unusedActionApproval('act')).toBeNull();
    state.holds = true; state.epoch = 6; state.held.add(6);
    expect(store.unusedActionApproval('act')).toBeNull();
  });

  it('an unknown epoch writes no grant (the caller asks); narrowing is still written', async () => {
    state.epoch = null;
    expect((await store.write('action-approval', { approvalId: 'o1', actionIdentity: 'act', consumptionId: 'c' })).ok).toBe(false);
    expect((await store.write('dispatch', { approvalId: 'zz', actionIdentity: 'act' }, 'tj:dispatch:zz')).ok).toBe(true);
  });

  it('records written before this build are outside every run on a multi-machine agent', () => {
    store.applyCommitted([{ writer: SELF, recordKey: 'tj:action-approval:old', data: { recordType: 'action-approval', approvalId: 'old', actionIdentity: 'act', consumptionId: 'c', at: '2026-01-01T00:00:00Z', minReader: 1 } }]);
    expect(store.unusedActionApproval('act')).toBeNull();
  });

  it('on a single machine nothing changes: no epoch in keys, earlier records count', async () => {
    const single = new TrustJourneyStore(new MemSink(), () => new Date('2026-11-18T01:00:00Z'), { self: SELF });
    single.applyCommitted([{ writer: SELF, recordKey: 'tj:action-approval:old', data: { recordType: 'action-approval', approvalId: 'old', actionIdentity: 'act', consumptionId: 'c', at: '2026-01-01T00:00:00Z', minReader: 1 } }]);
    expect(single.unusedActionApproval('act')?.approvalId).toBe('old');
    expect((await single.write('change', { changeId: 'c', key: 'k.write', from: null, to: 'log', direction: 'raise', source: 'person' })).recordKey).not.toMatch(/:e\d+:/);
  });

  it('fold restores today: a peer grant counts', () => {
    const fold = new TrustJourneyStore(new MemSink(), () => new Date('2026-11-18T01:00:00Z'), { self: SELF, run: fakeRun(state), peerGrants: 'fold' });
    fold.applyCommitted([{ writer: PEER, recordKey: 'tj:action-approval:p', data: { recordType: 'action-approval', approvalId: 'p1', actionIdentity: 'act', consumptionId: 'c', at: '2026-11-18T00:00:00Z', minReader: 1 } }]);
    expect(fold.unusedActionApproval('act')?.approvalId).toBe('p1');
  });
});

describe('TrustRunTracker', () => {
  let dir: string;
  let lease: LeaseSnapshot | null;
  let runs: Array<[number, number | null]>;
  const make = () => new TrustRunTracker({ stateDir: dir, multiMachine: () => true, lease: () => lease, onNewRun: (a, b) => runs.push([a, b]) });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec088-run-')); lease = { holds: true, epoch: 10, contested: false }; runs = []; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec088-trust-holder-authored.test.ts' }); });

  it('an epoch held by this machine and every one after it to now keeps the run; a gap ends it', () => {
    const t = make();
    t.observe();
    expect(t.inRun(10)).toBe(true);
    lease = { holds: true, epoch: 11, contested: false }; t.observe();
    expect(t.inRun(10)).toBe(true); // same-machine re-acquire
    lease = { holds: true, epoch: 13, contested: false }; t.observe(); // 12 was another holder's
    expect(t.inRun(10)).toBe(false);
    expect(t.inRun(13)).toBe(true);
    expect(runs).toEqual([[10, null], [13, 11]]); // the first observation starts a run too
  });

  it('the held set survives a restart; a lost file counts only grants from now on', () => {
    const t = make(); t.observe();
    lease = { holds: true, epoch: 11, contested: false };
    expect(make().inRun(10)).toBe(true);
    SafeFsExecutor.safeRmSync(path.join(dir, 'state', 'trust-held-epochs.json'), { force: true, operation: 'tests/unit/sec088-trust-holder-authored.test.ts' });
    expect(make().inRun(10)).toBe(false);
  });

  it('not holding, contested, or no lease view: nothing is in the run', () => {
    const t = make(); t.observe();
    lease = { holds: false, epoch: 10, contested: false }; expect(make().inRun(10)).toBe(false);
    lease = { holds: true, epoch: 10, contested: true }; expect(make().inRun(10)).toBe(false);
    lease = null; expect(make().inRun(10)).toBe(false);
  });

  it('a pre-build key (no epoch) is never in the run on a multi-machine agent', () => {
    const t = make(); t.observe();
    expect(t.inRun(null)).toBe(false);
  });

  it('a grant written while not holding the lease is marked a standby write and never counts, even after taking the lease', () => {
    lease = { holds: false, epoch: 10, contested: false };
    const t = make();
    const w = t.writeEpoch();
    expect(w).toBe(-11);
    expect(epochKey('tj:change:x', w!)).toBe('tj:change:s10:x');
    expect(keyEpoch('tj:change:s10:x')).toBeNull();
    lease = { holds: true, epoch: 11, contested: false }; t.observe();
    expect(t.inRun(keyEpoch('tj:change:s10:x'))).toBe(false);
  });

  it('a same-epoch tie ends the run even after the coordinator resolves it (round 8 hole)', () => {
    const t = make();
    t.observe(); // held 10
    lease = { holds: true, epoch: 11, contested: false }; t.observe(); // both machines think they hold 11
    lease = { holds: true, epoch: 11, contested: true }; t.observe(); // the contest is seen
    lease = { holds: true, epoch: 12, contested: false }; t.observe(); // the winner advances
    expect(t.inRun(10)).toBe(false);
    expect(t.inRun(11)).toBe(false);
    expect(t.inRun(12)).toBe(true);
  });

  it('a tie detected and resolved between two reads still ends the run (split-brain event)', () => {
    const t = make();
    t.observe();
    lease = { holds: true, epoch: 11, contested: false }; t.observe();
    t.markForeign([11], 'same-epoch tie detected');
    lease = { holds: true, epoch: 12, contested: false }; t.observe();
    expect(t.inRun(10)).toBe(false);
    expect(make().inRun(10)).toBe(false); // persisted
  });

  it('a tie the loser gave up first: the winner sees only the expired peer lease at N, and N is still foreign', () => {
    const t = make();
    t.observe(); // 10
    lease = { holds: true, epoch: 11, contested: false }; t.observe(); // both held 11
    // The loser relinquished; the winner never sees a live contest, only the peer's expired lease at 11.
    lease = { holds: true, epoch: 11, contested: false, peerHeldEpochs: [11] }; t.observe();
    expect(t.inRun(10)).toBe(false);
    expect(t.inRun(11)).toBe(false);
  });

  it('the foreign list is pruned by value: an epoch below the oldest held range is dropped, newer ones stay', () => {
    const t = make();
    lease = { holds: true, epoch: 100, contested: false, peerHeldEpochs: [5, 150] }; t.observe();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'trust-held-epochs.json'), 'utf8'));
    expect(saved.foreign).toEqual([150]);
    lease = { holds: true, epoch: 101, contested: false }; t.observe();
    expect(t.inRun(100)).toBe(true);
  });

  it('an epoch another machine is seen holding is foreign', () => {
    const t = make();
    t.observe();
    lease = { holds: false, epoch: 11, contested: false, foreignHolder: true }; t.observe();
    lease = { holds: true, epoch: 11, contested: false }; t.observe();
    expect(t.inRun(10)).toBe(false);
  });

  it('a single machine is always in the run and writes no epoch', () => {
    const t = new TrustRunTracker({ stateDir: dir, multiMachine: () => false, lease: () => null });
    expect(t.inRun(null)).toBe(true);
    expect(t.writeEpoch()).toBeNull();
  });
});

describe('trustJourney.peerGrants resolution', () => {
  it('explicit wins; otherwise ignore on a dev or throwaway agent and fold on the fleet; invalid is logged', () => {
    const logged: string[] = [];
    expect(resolvePeerGrants({ trustJourney: { peerGrants: 'fold' }, developmentAgent: true })).toBe('fold');
    expect(resolvePeerGrants({ trustJourney: { peerGrants: 'ignore' } })).toBe('ignore');
    expect(resolvePeerGrants({ developmentAgent: true })).toBe('ignore');
    expect(resolvePeerGrants({ throwawayAgent: true })).toBe('ignore');
    expect(resolvePeerGrants({})).toBe('fold');
    expect(resolvePeerGrants({ trustJourney: { peerGrants: 'yes' } }, (e) => logged.push(e))).toBe('fold');
    expect(logged).toEqual(['trust-peer-grants-invalid']);
  });
});

describe('runtime wiring (second-pass review fixes)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec088-rt-')); fs.writeFileSync(path.join(dir, 'config.json'), '{}'); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec088-trust-holder-authored.test.ts' }); });
  const rt = async (cfg: Record<string, unknown>, extra: Record<string, unknown>) => {
    const { createTrustJourneyRuntime } = await import('../../src/core/trustJourney/TrustJourneyRuntime.js');
    const { AdaptiveTrust } = await import('../../src/core/AdaptiveTrust.js');
    return createTrustJourneyRuntime({
      stateDir: dir, configPath: path.join(dir, 'config.json'), runtimeConfig: cfg, installationId: 'x', machineId: SELF, sink: new MemSink(),
      adaptiveTrust: new AdaptiveTrust({ stateDir: dir }), autonomyManager: null, trustRecovery: null, telegram: null, slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
      ...extra,
    } as never);
  };

  for (const mode of ['ignore', 'fold'] as const) {
    it(`a single-machine agent with production wiring still admits a one-time approval (${mode})`, async () => {
      const r = await rt({ trustJourney: { peerGrants: mode } }, { multiMachine: () => false, lease: () => null });
      const { deriveEffect } = await import('../../src/data/effect-kinds.js');
      const e = deriveEffect('mcp__svc__send_note', { a: 1 })!;
      expect((await r.store.write('action-approval', { approvalId: 'ap1', actionIdentity: e.actionIdentity, consumptionId: 'c', expiresAt: '2099-01-01T00:00:00Z' })).ok).toBe(true);
      expect((await r.admit('mcp__svc__send_note', { a: 1 })).decision.verdict).toBe('proceed-once');
    });
  }

  it('"fold" creates no run tracker (today\'s behaviour: no recheck, no profile narrowing, no held-epoch file)', async () => {
    const r = await rt({ trustJourney: { peerGrants: 'fold' } }, { multiMachine: () => true, lease: () => ({ holds: true, epoch: 3, contested: false }) });
    expect(r.run).toBeNull();
    expect(fs.existsSync(path.join(dir, 'state', 'trust-held-epochs.json'))).toBe(false);
  });

  it('under "ignore" the lease is read on a tick, so a same-machine N -> N+1 -> N+2 keeps the run', async () => {
    let epoch = 3;
    const r = await rt({ trustJourney: { peerGrants: 'ignore' } }, { multiMachine: () => true, lease: () => ({ holds: true, epoch, contested: false }), runObserveMs: 5 });
    const w = await r.store.write('action-approval', { approvalId: 'ap1', actionIdentity: 'act', consumptionId: 'c', expiresAt: '2099-01-01T00:00:00Z' });
    expect(w.recordKey).toMatch(/:e3:/);
    for (const next of [4, 5]) { epoch = next; await new Promise((res) => setTimeout(res, 40)); }
    expect(r.store.unusedActionApproval('act')?.approvalId).toBe('ap1');
  });
});

describe('device withdrawal across machines (service level)', () => {
  it('a withdrawal on a standby, named by its own device id, reaches the holder\'s acceptance of the same phone by key fingerprint', async () => {
    const { AccountPathService } = await import('../../src/core/trustJourney/AccountPathService.js');
    const state = { held: new Set([5]), epoch: 5, holds: false };
    const store = new TrustJourneyStore(new MemSink(), () => new Date('2026-11-18T01:00:00Z'), { self: SELF, run: fakeRun(state) });
    // The holder (another machine) accepted this phone under its own device id.
    peerRec(store, 'tj:device-acceptance:e5:h', { recordType: 'device-acceptance', acceptanceId: 'holder-dacc', principal: 'owner', deviceId: 'holder-dev-id', keyFingerprint: 'fp-phone', presenceKeyHash: 'h', keyPolicy: 'userPresence', disclosureHash: 'x', via: 'local-install', acceptedAt: '2026-11-18T00:00:00Z' });
    const svc = new AccountPathService({
      store, adapters: {}, ownerPlatformId: () => null, installationId: 'x', raisesOf: () => [], summarize: () => [],
      apply: async () => ({ ok: true }), cardTtlDays: () => 7, holdsLease: () => false,
      devices: { get: (id: string) => (id === 'standby-dev-id' ? { deviceId: id, name: 'phone', active: true, keyFingerprint: 'fp-phone', presenceKeyHash: 'h' } as never : null) },
    });
    expect(await svc.withdrawDeviceAcceptance('standby-dev-id')).toBe(1);
    expect(store.deviceAcceptancesToWithdraw()).toEqual([]);
  });
});

