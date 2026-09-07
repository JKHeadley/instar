import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { OriginStore, OriginStoreUnavailableError } from '../../src/messaging/telegram-origin/OriginStore.js';
import { PendingRelayStore, resolvePendingRelayPath } from '../../src/messaging/pending-relay-store.js';
import { admission, compileOriginWorker, hash, temporaryState } from '../helpers/telegramOriginStore.js';

let workerUrl: URL;
const stores: OriginStore[] = [];
const stateDirs: string[] = [];
beforeAll(async () => { workerUrl = await compileOriginWorker(); }, 30_000);
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const state of stateDirs.splice(0)) SafeFsExecutor.safeRmSync(state, { recursive: true, force: true, operation: 'test:origin-store:cleanup' }); });
async function open(options: Partial<Parameters<typeof OriginStore.open>[0]> = {}) {
  const stateDir = options.stateDir ?? temporaryState(); if (!stateDirs.includes(stateDir)) stateDirs.push(stateDir);
  const store = await OriginStore.open({ stateDir, agentId: 'echo', ...options }, workerUrl); stores.push(store); return { store, stateDir };
}
async function claimed(store: OriginStore, input = admission()) {
  await store.admit(input); const c = input.children[0];
  const result = await store.claim({ childId: c.childId, materializationId: c.materializations[0].materializationId, ownerBootId: 'boot-1', leaseMs: 60_000 });
  expect(result.status).toBe('claimed'); if (result.status !== 'claimed') throw new Error('claim missing'); return { input, claim: result.child };
}

describe('Telegram origin worker/outbox', () => {
  it('opens a file worker when the parent uses stdin-only module flags', async () => {
    const previous = process.execArgv;
    process.execArgv = ['--input-type=module'];
    try {
      const { store } = await open();
      expect((await store.diagnostics()).synchronous).toBe(2);
    } finally { process.execArgv = previous; }
  });

  it('opens the canonical queue with WAL/FULL and preserves immutable IDs', async () => {
    const { store, stateDir } = await open(); const input = admission('immutable');
    expect(await store.diagnostics()).toEqual({ path: resolvePendingRelayPath(stateDir, 'echo'), synchronous: 2, journalMode: 'wal', archiveReads: { filesVerified: 0, bytesHashed: 0 } });
    expect((await store.admit(input)).inserted).toBe(true);
    expect((await store.admit(input)).inserted).toBe(false);
    expect((await store.getOrigin(input.record.originId))?.record).toEqual(input.record);
    const changed = structuredClone(input); changed.record.envelopeJson = '{}'; changed.record.envelopeDigest = hash('{}');
    await expect(store.admit(changed)).rejects.toThrow('operation-id-conflict');
    await expect(store.putEvidence(changed.record)).rejects.toThrow('origin-id-conflict');
    const metrics = await store.getMetrics(); expect(metrics.counts['operation:prepared']).toBe(1); expect(metrics.counts['operation:admitted']).toBe(1);
  });

  it('rejects changed sealed bytes and oversized/expired budgets before executable admission', async () => {
    const { store } = await open(); const input = admission('tamper');
    input.children[0].materializations[0].requestJson = '{"text":"spoof"}';
    await expect(store.admit(input)).rejects.toThrow('digest-mismatch');
    expect(await store.getOrigin(input.record.originId)).toBeNull();
    const deadline = admission('deadline'); deadline.deadlineAt += 1;
    await expect(store.admit(deadline)).rejects.toThrow('invalid-bound');
    const tooSmall = admission('too-small'); tooSmall.payloadBytes = 1;
    await expect(store.admit(tooSmall)).rejects.toThrow('payload-budget');
  });

  it('has one winner across two actual workers and grants dispatch only once', async () => {
    const { store, stateDir } = await open(); const { store: peer } = await open({ stateDir }); const input = admission('race'); await store.admit(input);
    const c = input.children[0]; const request = { childId: c.childId, materializationId: c.materializations[0].materializationId, ownerBootId: 'one', leaseMs: 60_000 };
    const results = await Promise.all([store.claim(request), peer.claim({ ...request, ownerBootId: 'two' })]);
    expect(results.filter(result => result.status === 'claimed')).toHaveLength(1);
    const winner = results.find(result => result.status === 'claimed')!; if (winner.status !== 'claimed') throw new Error('missing');
    expect(await store.markDispatched(winner.child)).toBe(true);
    expect(await peer.markDispatched(winner.child)).toBe(false);
    expect(await store.recordOutcome({ ...winner.child, claimToken: 'counterfeit', outcome: 'accepted', receiptJson: '{"messageId":"8"}' })).toEqual({ recorded: false, reason: 'stale-fence' });
  });

  it('legacy selectors, direct transitions, claims and purge cannot consume prepared children', async () => {
    const { store, stateDir } = await open(); const input = admission('legacy-lane', Date.now() - 1000, 7); await store.admit(input);
    const legacy = PendingRelayStore.open('echo', stateDir);
    try {
      expect(legacy.selectClaimable(new Date().toISOString())).toEqual([]);
      expect(legacy.claimCas(input.children[0].deliveryId, 'legacy-owner', { state: 'queued', claimed_by: null })).toBe(false);
      expect(legacy.transition(input.children[0].deliveryId, 'dead-letter')).toBe(false);
      expect(legacy.purgeStaleClaimable(new Date(Date.now() + 1000).toISOString())).toBe(0);
      expect((await store.getOperation(input.operationId))?.children).toHaveLength(7);
    } finally { legacy.close(); }
  });

  it('distinguishes non-dispatch, suppression, validated acceptance and unknown receipt state', async () => {
    const { store } = await open(); const { input, claim } = await claimed(store, admission('receipts'));
    expect(await store.recordOutcome({ ...claim, outcome: 'accepted', receiptJson: '{"messageId":"8"}' })).toEqual({ recorded: false, reason: 'not-dispatched' });
    await store.markDispatched(claim);
    expect(await store.recordOutcome({ ...claim, outcome: 'accepted' })).toEqual({ recorded: false, reason: 'receipt-required' });
    expect(await store.recordOutcome({ ...claim, outcome: 'outcome-unknown' })).toEqual({ recorded: true });
    expect((await store.getOperation(input.operationId))?.attempts[0].outcome).toBe('outcome-unknown');
    expect((await store.claim({ childId: claim.childId, materializationId: claim.materialization.materializationId, ownerBootId: 'retry', leaseMs: 1000 })).status).toBe('unavailable');
    expect(await store.reconcileReceipt({ childId: claim.childId, attemptId: claim.attemptId, outcome: 'accepted', receiptJson: '{"accountId":"bot-1","chatId":"-100123","messageId":"8"}' })).toBe(true);
    expect((await store.getOperation(input.operationId))?.operation?.state).toBe('accepted');
    expect((await store.getMetrics()).counts['attempt:dispatched']).toBe(1);
  });

  it('expired claims become unknown and stale owners cannot renew or finalize', async () => {
    const { store } = await open(); const input = admission('abandoned'); await store.admit(input); const c = input.children[0]; const now = Date.now();
    const claim = await store.claim({ childId: c.childId, materializationId: c.materializations[0].materializationId, ownerBootId: 'dead-boot', leaseMs: 10, now });
    if (claim.status !== 'claimed') throw new Error('missing');
    expect(await store.reapAbandoned(now + 11)).toBe(1);
    expect(await store.renewClaim({ ...claim.child, leaseMs: 1000, now: now + 11 })).toBe(false);
    expect(await store.recordOutcome({ ...claim.child, outcome: 'known-failed', now: now + 11 })).toEqual({ recorded: false, reason: 'stale-fence' });
    expect((await store.getChild(c.childId))?.state).toBe('outcome-unknown');
  });

  it('retains child attempt ceilings across definitive retries', async () => {
    const { store } = await open(); const input = admission('retry-budget'); input.maxAttempts = 2; await store.admit(input); const c = input.children[0];
    for (let n = 0; n < 2; n++) {
      const result = await store.claim({ childId: c.childId, materializationId: c.materializations[0].materializationId, ownerBootId: `boot-${n}`, leaseMs: 1000 });
      if (result.status !== 'claimed') throw new Error('claim missing');
      const now = Date.now(); await store.recordOutcome({ ...result.child, outcome: 'known-failed', nextAttemptAt: now, now });
    }
    expect((await store.getChild(c.childId))?.attempts).toBe(2);
    expect((await store.claim({ childId: c.childId, materializationId: c.materializations[0].materializationId, ownerBootId: 'third', leaseMs: 1000 })).status).toBe('unavailable');
    expect((await store.getMetrics()).counts['attempt:known-failed']).toBe(2);
  });

  it('derivations fence old versions and keep author/destination/attempt budgets', async () => {
    const { store } = await open(); const input = admission('derive'); await store.admit(input); const c = input.children[0];
    const requestJson = JSON.stringify({ text: 'renewed signature bytes' });
    const derivation = { childId: c.childId, expectedGeneration: 0, kind: 'signature-renewal' as const, canonicalContentDigest: c.canonicalContentDigest, destinationJson: c.destinationJson, inputDigest: c.materializations[0].requestDigest, materialization: { materializationId: 'renewed', requestJson, requestDigest: hash(requestJson) } };
    await expect(store.addMaterialization({ ...derivation, destinationJson: '{}' })).rejects.toThrow('unauthorized-derivation');
    expect(await store.addMaterialization(derivation)).toBe(true);
    expect(await store.addMaterialization(derivation)).toBe(false);
    expect(await store.claim({ childId: c.childId, materializationId: c.materializations[0].materializationId, ownerBootId: 'boot', leaseMs: 1000 })).toEqual({ status: 'unavailable', reason: 'stale-materialization' });
    expect((await store.getChild(c.childId))?.generation).toBe(1);
    expect((await store.getChild(c.childId))?.attempts).toBe(0);
  });

  it('capacity refusal is atomic and a completed operation frees working admission', async () => {
    const { store } = await open({ maxOperations: 1 }); const { claim } = await claimed(store, admission('one'));
    const second = admission('two'); await expect(store.admit(second)).rejects.toThrow('capacity-unavailable');
    expect(await store.getOrigin(second.record.originId)).toBeNull();
    await store.markDispatched(claim); await store.recordOutcome({ ...claim, outcome: 'accepted', receiptJson: '{"messageId":"9"}' });
    expect((await store.admit(second)).inserted).toBe(true);
  });

  it('snapshots include old timestamps inserted before snapshot and exclude later inserts', async () => {
    const { store } = await open(); const now = Date.now();
    await store.admit(admission('first', now - 1000)); await store.admit(admission('second', now));
    const page = await store.listOrigins({ limit: 1 }); expect(page.cursor).not.toBeNull();
    await store.admit(admission('late-old-clock', now - 500));
    const rest = await store.listOrigins({ limit: 1, cursor: page.cursor! });
    expect(rest.records.map(row => row.record.originId)).toEqual(['origin-second']);
    expect(rest.cursor).toBeNull(); expect((await store.listOrigins()).records).toHaveLength(3);
    await expect(store.listOrigins({ limit: 1, cursor: page.cursor!, machineId: 'other' })).rejects.toThrow('invalid-cursor');
  });

  it('archives retained evidence without erasing receipts or inflating metrics', async () => {
    const { store } = await open(); const { input, claim } = await claimed(store, admission('archive', Date.now() - 2000));
    await store.markDispatched(claim); await store.recordOutcome({ ...claim, outcome: 'accepted', receiptJson: '{"messageId":"10"}' });
    const before = await store.getOrigin(input.record.originId); const counts = (await store.getMetrics()).counts;
    expect((await store.archive({ before: Date.now() })).archived).toBe(1);
    expect(await store.getOrigin(input.record.originId)).toEqual(before);
    expect((await store.getMetrics()).counts).toEqual(counts);
    expect(await store.cleanupPayloads()).toBe(1);
    expect((await store.getChild(claim.childId))?.materializations).toEqual([]);
    expect((await store.getOrigin(input.record.originId))?.attempts[0].receiptJson).toBe('{"messageId":"10"}');
  });

  it('notice reservations are one boot-owned preclaim, isolated from reclaim and ordinary dispatch', async () => {
    const { store, stateDir } = await open(); const input = admission('notice');
    const reserve = await store.reserveNotice({ admission: input, ownerBootId: 'lifeline-boot', generation: 'outage-1', alertDestinationId: 'operator-hub' });
    await expect(store.reserveNotice({ admission: input, ownerBootId: 'lifeline-boot', generation: 'outage-1', alertDestinationId: 'operator-hub' })).rejects.toThrow('notice-generation-already-reserved');
    expect(await store.reapAbandoned(Date.now() + 24 * 60 * 60_000)).toBe(0);
    expect(await store.markDispatched(reserve)).toBe(false);
    const legacy = PendingRelayStore.open('echo', stateDir); try { expect(legacy.selectClaimable(new Date().toISOString())).toEqual([]); } finally { legacy.close(); }
    expect(await store.recordNoticeOutcome({ ...reserve, ownerBootId: 'counterfeit-boot', materializationId: reserve.materializations[0].materializationId, outcome: 'accepted', receiptJson: '{"messageId":"11"}' })).toEqual({ recorded: false, reason: 'stale-fence' });
    expect(await store.recordNoticeOutcome({ ...reserve, materializationId: reserve.materializations[0].materializationId, outcome: 'outcome-unknown' })).toEqual({ recorded: true });
    expect(await store.recordNoticeOutcome({ ...reserve, materializationId: reserve.materializations[0].materializationId, outcome: 'outcome-unknown' })).toEqual({ recorded: false, reason: 'stale-fence' });
    expect((await store.getMetrics()).counts['notification:attempted']).toBe(1);
  });

  it('lost notice-owner retirement creates unavailability rather than a transferable permit', async () => {
    const { store } = await open({ maxNoticeReservations: 1 }); const first = admission('old-boot');
    const permit = await store.reserveNotice({ admission: first, ownerBootId: 'dead', generation: 'old', alertDestinationId: 'hub' });
    expect(await store.retireNoticeOwner('dead')).toBe(1);
    expect(await store.recordNoticeOutcome({ ...permit, materializationId: permit.materializations[0].materializationId, outcome: 'accepted', receiptJson: '{"id":1}' })).toEqual({ recorded: false, reason: 'stale-fence' });
    expect((await store.reserveNotice({ admission: admission('new-boot'), ownerBootId: 'new', generation: 'new', alertDestinationId: 'hub' })).ownerBootId).toBe('new');
  });

  it('the separate spool remains durable when the primary cannot even open', async () => {
    const stateDir = temporaryState(); stateDirs.push(stateDir);
    fs.mkdirSync(`${stateDir}/state`); fs.writeFileSync(resolvePendingRelayPath(stateDir, 'echo'), 'corrupt database');
    await expect(OriginStore.open({ stateDir, agentId: 'echo' }, workerUrl)).rejects.toBeInstanceOf(OriginStoreUnavailableError);
    const spool = await OriginStore.openSpool({ stateDir, agentId: 'echo' }, workerUrl); stores.push(spool);
    const input = admission('spool'); expect((await spool.putEvidence(input.record)).sink).toBe('spool');
    expect((await spool.putEvidence(input.record)).inserted).toBe(false);
    await expect(spool.admit(input)).rejects.toThrow('unknown-method');
    const db = new Database(`${stateDir}/state/telegram-origin-spool/echo/evidence.sqlite`, { readonly: true });
    try { expect(db.prepare('SELECT count(*) n FROM evidence').get()).toEqual({ n: 1 }); expect(db.prepare("SELECT name FROM sqlite_master WHERE name='entries'").get()).toBeUndefined(); } finally { db.close(); }
  });
});
