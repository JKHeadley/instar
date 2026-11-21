// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * gemini-payg §8 "Release gate", §7 reconciliation, §5 notices — unit tier.
 *   - the recorder is the only path to `live`; checks run in order (d) → (a)+(e) → (c) → (b);
 *   - one durable proof reservation: a repeat (concurrent, or after a restart) returns the
 *     recorded outcome; no-charge releases the slot; uncertain keeps the charge, ≤ 3 tries;
 *   - the holder stamps the marker itself (the provider sees a registered marker object);
 *   - reconciliation drift needs one re-read ≥ 6h later; unmeasurable never counts;
 *   - notices: 100% once and held through Pacific quiet hours; a conflicting designation is
 *     immediate; lowered-limit notices coalesce per hour; the provisional card opens once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RoutingSpendCapsStore } from '../../src/core/RoutingSpendCapsStore.js';
import { GeminiPaygReleaseRecorder, type ProofCaller } from '../../src/core/geminiPaygReleaseRecorder.js';
import { GeminiPaygReconciliationStore, computeDrift } from '../../src/core/geminiPaygReconciliation.js';
import { GeminiPaygNotices, inPacificQuietHours } from '../../src/core/geminiPaygNotices.js';
import { isReleaseProofMarker } from '../../src/core/MeteredSpendGate.js';
import { doorPolicyFromSetup, buildGeminiPaygProposal } from '../../src/core/geminiPaygGoLive.js';
import type { ReservationView } from '../../src/core/MeteredSpendLedger.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-release-unit-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/gemini-payg-release-gate.test.ts' }); });

const INTENT = 'd'.repeat(64);

function armedStore(): RoutingSpendCapsStore {
  const store = new RoutingSpendCapsStore({ stateDir: dir });
  const setup = buildGeminiPaygProposal({
    designatedMachineId: 'm_studio', designatedMachineName: null, currentDesignationEpoch: 0, models: ['gemini-4-neon', 'gemini-4-hydrogen'],
    handoff: { noEchoTransfer: { attestedBy: 'a', at: '', method: 'm', sourceMessageRef: 'r' }, oneKeyArtifact: { providerKeyId: 'k', keyFingerprint: 'a'.repeat(64), readAt: '', screenshotPath: '/x', screenshotSha256: 'b'.repeat(64), keyCount: 1 }, googleSpendLimit: { kind: 'hard-cap', amountUsd: 50, readAt: '', screenshotPath: '/x', screenshotSha256: 'b'.repeat(64) }, boundTo: { designationEpoch: 1 } },
  });
  store.applyGoLiveSetup('test', INTENT, { door: 'gemini-api', keyRef: 'gemini_api_key_payg', provider: 'google', designatedMachineId: 'm_studio', caps: { monthlyCapUsd: 50, dailyCapUsd: 10, periodTimeZone: 'America/Los_Angeles' }, policy: doorPolicyFromSetup(setup) });
  return store;
}

/** A provider fake that books into an in-memory ledger the way the real money port does. */
function world(opts: { outcome?: 'ok' | 'no-charge' | 'uncertain'; verified?: boolean; multi?: boolean; recon?: boolean } = {}) {
  const store = armedStore();
  const rows = new Map<string, ReservationView>();
  let calls = 0;
  let outcome = opts.outcome ?? 'ok';
  const markers: unknown[] = [];
  const provider: ProofCaller = {
    async call(req) {
      calls++;
      markers.push(req.proofMarker);
      await new Promise((r) => setTimeout(r, 5));
      const base = { reserveId: `r${calls}`, keyRef: 'gemini_api_key_payg', door: 'gemini-api', modelId: req.model, reserveUsd: 0.01, dayEpoch: '2026-11-20', monthEpoch: '2026-11', callId: req.callId, pricePointId: `gemini-api|${req.model}|2026-11-15|1000000` };
      if (outcome === 'ok') { rows.set(req.callId, { ...base, state: 'settled', contributionUsd: 0.0002 }); return { reserveId: base.reserveId, costUsd: 0.0002, modelId: req.model }; }
      if (outcome === 'no-charge') { rows.set(req.callId, { ...base, state: 'settled', contributionUsd: 0 }); throw new Error('gemini-api refused (provider-rejected): HTTP 400'); }
      rows.set(req.callId, { ...base, state: 'provisional', contributionUsd: 0.01 });
      throw new Error('gemini-api refused (provider-failed): timeout; booked provisional');
    },
  };
  const recon = new GeminiPaygReconciliationStore(dir);
  if (opts.recon !== false) recon.append({ machineId: 'm_studio', session: 's', month: '2026-11', figureUsd: 0, unmeasurable: false, committedMonthUsd: 0 });
  const mk = () => new GeminiPaygReleaseRecorder({
    stateDir: dir, door: 'gemini-api', selfMachineId: 'm_studio',
    capsStore: () => store,
    provider: () => provider,
    ledgerLookup: (id) => rows.get(id) ?? null,
    modelsCheapestFirst: () => ['gemini-4-hydrogen', 'gemini-4-neon'],
    modelVerified: () => opts.verified !== false,
    reconciliation: () => recon,
    multiMachine: () => opts.multi === true,
    verifyLiveTest: null,
  });
  return { store, mk, calls: () => calls, setOutcome: (o: typeof outcome) => { outcome = o; }, markers };
}

describe('the release gate recorder', () => {
  it('(d) first: unverified prices block BEFORE any paid call', async () => {
    const w = world({ verified: false });
    const r = await w.mk().runProof({ forwardedFrom: null });
    expect(w.calls()).toBe(0);
    expect(r.evaluation.blocker).toMatch(/^d-prices-verified/);
    expect(w.store.read().doorPolicy?.['gemini-api']?.releaseState).toBe('armed-pending-proof');
  });

  it('one settled proof row satisfies (a)+(e); with (c) met the recorder — and only it — sets live; the holder stamped a real marker on the cheapest model', async () => {
    const w = world();
    const r = await w.mk().runProof({ forwardedFrom: null });
    expect(r.evaluation.checks.map((c) => c.id)).toEqual(['d-prices-verified', 'ae-proof-row', 'c-reconciliation']);
    expect(r.evaluation.releaseState).toBe('live');
    expect(w.store.read().doorPolicy?.['gemini-api']?.releaseState).toBe('live');
    expect(r.attempt?.modelId).toBe('gemini-4-hydrogen');
    expect(isReleaseProofMarker(w.markers[0], 'gemini-api')).toBe(true);
    expect(w.store.auditLog().some((a) => a.action === 'release-live' && a.actor.includes(`intent=${INTENT}`))).toBe(true);
  });

  it('(c) missing keeps the door armed and names it; an unmeasurable read does not count', async () => {
    const w = world({ recon: false });
    new GeminiPaygReconciliationStore(dir).append({ machineId: 'm', session: 's', month: '2026-11', figureUsd: null, unmeasurable: true, committedMonthUsd: null });
    const r = await w.mk().runProof({ forwardedFrom: null });
    expect(r.evaluation.releaseState).toBe('armed-pending-proof');
    expect(r.evaluation.blocker).toMatch(/^c-reconciliation/);
  });

  it('concurrent submissions and a restart after settlement give ONE paid call', async () => {
    const w = world({ recon: false });
    const rec = w.mk();
    await Promise.all([rec.runProof({ forwardedFrom: null }), rec.runProof({ forwardedFrom: null }), rec.runProof({ forwardedFrom: null })]);
    expect(w.calls()).toBe(1);
    await w.mk().runProof({ forwardedFrom: null }); // a new process
    expect(w.calls()).toBe(1);
  });

  it('a confirmed no-charge releases the slot; an uncertain outcome keeps its charge, ≤ 3 attempts in all', async () => {
    const w = world({ outcome: 'no-charge', recon: false });
    const rec = w.mk();
    const first = await rec.runProof({ forwardedFrom: null });
    expect(first.attempt?.state).toBe('no-charge');
    w.setOutcome('uncertain');
    for (let i = 0; i < 3; i++) expect((await rec.runProof({ forwardedFrom: null })).attempt?.state).toBe('uncertain');
    const exhausted = await rec.runProof({ forwardedFrom: null });
    expect(exhausted.evaluation.blocker).toMatch(/^proof-attempts-exhausted/);
    expect(w.calls()).toBe(4);
  });

  it('multi-machine: a local proof is refused before spending; a forwarded one satisfies (e); (b) is named when no verifier exists', async () => {
    const w = world({ multi: true });
    const local = await w.mk().runProof({ forwardedFrom: null });
    expect(local.evaluation.blocker).toMatch(/^proof-must-be-forwarded/);
    expect(w.calls()).toBe(0);
    const fwd = await w.mk().runProof({ forwardedFrom: 'm_mamapc' });
    expect(fwd.evaluation.checks.find((c) => c.id === 'ae-proof-row')?.ok).toBe(true);
    expect(fwd.evaluation.blocker).toMatch(/^b-live-test/);
    expect(w.store.read().doorPolicy?.['gemini-api']?.releaseState).toBe('armed-pending-proof');
  });

  it('an attempt left in flight by a process that ended before its reservation is released (no ledger row ⇒ nothing charged)', async () => {
    const w = world({ recon: false });
    const file = path.join(dir, 'state', 'gemini-payg-release-proof.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ intentHash: INTENT, attempts: [{ n: 1, callId: 'e'.repeat(64), state: 'in-flight', modelId: 'gemini-4-hydrogen', at: '', forwardedFrom: null }] }));
    const r = await w.mk().runProof({ forwardedFrom: null });
    expect(w.calls()).toBe(1);
    expect(r.attempt?.n).toBe(2);
    expect(r.attempt?.state).toBe('settled');
  });

  it('a price point id that does not name its door leaves (e) unmet — never compared with itself', async () => {
    const w = world();
    const rec = w.mk();
    const orig = (rec as unknown as { d: { ledgerLookup: (id: string) => ReservationView | null } }).d.ledgerLookup;
    (rec as unknown as { d: { ledgerLookup: (id: string) => ReservationView | null } }).d.ledgerLookup = (id) => { const v = orig(id); return v ? { ...v, pricePointId: 'opaque-id' } : null; };
    const r = await rec.runProof({ forwardedFrom: null });
    expect(r.evaluation.checks.find((c) => c.id === 'ae-proof-row')?.ok).toBe(false);
    expect(r.evaluation.releaseState).toBe('armed-pending-proof');
  });

  it('a read-only evaluation never records the release', async () => {
    const w = world({ recon: false });
    const rec = w.mk();
    await rec.runProof({ forwardedFrom: null });
    new GeminiPaygReconciliationStore(dir).append({ machineId: 'm', session: 's', month: '2026-11', figureUsd: 0, unmeasurable: false, committedMonthUsd: 0 });
    expect(rec.evaluate(undefined, { write: false }).blocker).toMatch(/^all-checks-pass/);
    expect(w.store.read().doorPolicy?.['gemini-api']?.releaseState).toBe('armed-pending-proof');
    expect(rec.evaluate().releaseState).toBe('live');
  });

  it('a policy write can never move a door to live (only the recorder can)', () => {
    const store = armedStore();
    const p = store.read().doorPolicy!['gemini-api'];
    expect(() => store.setDoorPolicy('x', store.read().version, 'gemini-api', { ...p, releaseState: 'live' })).toThrow(/release-proof recorder/);
  });
});

describe('invoice-drift reconciliation (reporting only)', () => {
  it('drift needs > 10% AND > $2', () => {
    expect(computeDrift(30, 25).drifted).toBe(true);
    expect(computeDrift(3, 2).drifted).toBe(false); // 33% but $1
    expect(computeDrift(52, 50).drifted).toBe(false); // $2 exactly is not over
    expect(computeDrift(null, 10).drifted).toBe(false);
  });
  it('one re-read at least 6h after the first drifted read is what notifies', () => {
    let t = Date.parse('2026-12-02T17:00:00Z');
    const store = new GeminiPaygReconciliationStore(dir, () => t);
    const a = store.append({ machineId: 'm', session: 's', month: '2026-11', figureUsd: 40, unmeasurable: false, committedMonthUsd: 30 });
    expect(a.notify).toBe(false);
    expect(a.rereadAfter).toBe(new Date(t + 6 * 3600_000).toISOString());
    t += 3 * 3600_000;
    expect(store.append({ machineId: 'm', session: 's', month: '2026-11', figureUsd: 40, unmeasurable: false, committedMonthUsd: 30 }).notify).toBe(false);
    t += 3 * 3600_000;
    expect(store.append({ machineId: 'm', session: 's', month: '2026-11', figureUsd: 40, unmeasurable: false, committedMonthUsd: 30 }).notify).toBe(true);
  });
});

describe('lane notices', () => {
  const quiet = Date.parse('2026-11-21T08:00:00Z'); // 00:00 Pacific
  const day = Date.parse('2026-11-21T18:00:00Z'); // 10:00 Pacific
  it('quiet hours are 23:00–07:30 Pacific', () => {
    expect(inPacificQuietHours(quiet)).toBe(true);
    expect(inPacificQuietHours(day)).toBe(false);
    expect(inPacificQuietHours(Date.parse('2026-11-21T15:20:00Z'))).toBe(true); // 07:20
    expect(inPacificQuietHours(Date.parse('2026-11-21T15:40:00Z'))).toBe(false); // 07:40
  });
  it('100% of the month: held through quiet hours, delivered at 07:30, once per month', async () => {
    let t = quiet;
    const sent: string[] = [];
    const n = new GeminiPaygNotices({ stateDir: dir, deliver: async (x) => { sent.push(x.dedupeKey); return true; }, now: () => t });
    expect(await n.monthFull('gemini_api_key_payg', '2026-11', 50, null)).toBe('held');
    expect(sent).toEqual([]);
    t = day;
    expect(await n.flushHeld()).toBe(1);
    expect(sent).toEqual(['spend-cap:gemini_api_key_payg:month:100:2026-11']);
    expect(await n.monthFull('gemini_api_key_payg', '2026-11', 50, null)).toBe('duplicate');
  });
  it('a conflicting designation is security class: sent at once, even in quiet hours', async () => {
    const sent: string[] = [];
    const n = new GeminiPaygNotices({ stateDir: dir, deliver: async (x) => { sent.push(x.dedupeKey); return true; }, now: () => quiet });
    expect(await n.designationConflict('gemini_api_key_payg', 3, 'stopped')).toBe('sent');
    expect(sent).toEqual(['designation-conflict:gemini_api_key_payg:3']);
  });
  it('lowered-limit notices: one per action, coalesced per hour, naming who and the restore link', async () => {
    let t = day;
    const texts: string[] = [];
    const n = new GeminiPaygNotices({ stateDir: dir, deliver: async (x) => { texts.push(x.text); return true; }, now: () => t, spendTabLink: () => 'https://agent.example/dashboard?tab=spend' });
    expect(await n.limitLowered('echo-topic-1', 'lowered daily to $5.00')).toBe('sent');
    t += 10 * 60_000;
    expect(await n.limitLowered('echo-topic-2', 'turned off second-opinion')).toBe('coalesced');
    t += 60 * 60_000;
    expect(await n.limitLowered('echo-topic-3', 'lowered month to $40.00')).toBe('sent');
    expect(texts[0]).toContain('echo-topic-1');
    expect(texts[0]).toContain('https://agent.example/dashboard?tab=spend');
    expect(texts[1]).toContain('plus 1 more change');
  });
  it('the provisional-ceiling card opens once per month and carries the prefilled plan', () => {
    const cards: Array<Record<string, unknown>> = [];
    const n = new GeminiPaygNotices({ stateDir: dir, deliver: async () => true, openCard: (c) => { cards.push(c.plan); return true; }, now: () => day });
    const card = { title: 't', need: 'n', recommendation: 'r', whyYou: 'w', doneWhen: [{ id: 'd', text: 'x' }], plan: { action: 'caps-adjust', provisionalCeilingUsd: 20, monthEpoch: '2026-11' }, link: null };
    expect(n.provisionalCeiling('2026-11', card)).toBe('sent');
    expect(n.provisionalCeiling('2026-11', card)).toBe('duplicate');
    expect(cards).toEqual([{ action: 'caps-adjust', provisionalCeilingUsd: 20, monthEpoch: '2026-11' }]);
  });
});
