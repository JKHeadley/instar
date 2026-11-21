// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Unit tests — gemini-payg slice B, the money model
 * (docs/specs/gemini-payg-metered-lane.md §2, §3, §5, §8, §10, §11).
 *
 * Covers the §11 unit bullets "Caps and ledger", "Admission order", "Price
 * authority", "Refusals", "Admission race", "Tier", "Provisional", "Calendar"
 * and "Dedupe first", plus the release-state gate, E1 pass slots, the probe
 * path, the default-chain regression and Migration Parity loads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  MeteredSpendLedger,
  periodEpochs,
  nextPeriodBoundaryMs,
} from '../../src/core/MeteredSpendLedger.js';
import {
  RoutingSpendCapsStore,
  validateCapsFile,
  type MeteredDoorPolicy,
} from '../../src/core/RoutingSpendCapsStore.js';
import { RoutingPriceAuthority } from '../../src/core/routingPriceAuthority.js';
import {
  MeteredSpendGate,
  MoneyGateRefusal,
  mintReleaseProofMarker,
  refusalHttpStatus,
  refusalPlainMessage,
  type AdmitRequest,
  type MoneyGateRefusalReason,
} from '../../src/core/MeteredSpendGate.js';
import { admitMeteredCall, preflightMeteredCall } from '../../src/core/meteredCallEntry.js';
import { runCapGateProbe } from '../../src/core/moneyLayerProbe.js';
import { NATURE_ROUTING_DEFAULT_CHAINS, METERED_ROUTING_DOORS } from '../../src/data/llmBenchCoverage.js';
import { knownMeteredKeyRefs } from '../../src/core/routingSpendView.js';

const KEY = 'gemini_api_key_payg';
const DOOR = 'gemini-api';
const LA = 'America/Los_Angeles';
const H = 'gemini-4-hydrogen';
const NEON = 'gemini-4-neon';

let projectDir: string;
let stateDir: string;
let clock: number;
const now = () => clock;

const T0 = Date.parse('2026-11-20T20:00:00Z'); // 12:00 PST

function policy(over: Partial<MeteredDoorPolicy> = {}): MeteredDoorPolicy {
  return {
    perCallCeilingUsd: 2.5,
    provisionalCeilingUsd: 10,
    e2MonthSharePct: 40,
    e2DayCapUsd: 4,
    e1PassesPerRound: 1,
    keyGeneration: null,
    meteredCallers: { callers: ['spec-review', 'second-opinion'], e3Components: [] },
    throughputFloorTps: {},
    releaseState: 'live',
    designationEpoch: 1,
    ...over,
  };
}

interface Pt { effectiveAt?: string; modelId: string; inPerMtok: number; outPerMtok: number; maxInputTokens?: number; verified?: boolean; recordedAt?: string }

function seedManifest(points: Pt[]): void {
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'scripts', 'routing-prices.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      doors: {
        [DOOR]: { freshnessSlaDays: 45, staleMode: 'fail-closed', requireVerifiedTier: true, conservativeMax: { inPerMtok: 6, outPerMtok: 30 } },
        'openrouter-api': { freshnessSlaDays: 45, staleMode: 'book-conservative-max', conservativeMax: { inPerMtok: 10, outPerMtok: 60 } },
      },
      points: points.map((p) => ({ door: DOOR, effectiveAt: '2026-11-20T00:00:00Z', ...p })),
    }),
  );
}

const DEFAULT_POINTS: Pt[] = [
  { modelId: H, inPerMtok: 1.5, outPerMtok: 7.5, maxInputTokens: 200_000, verified: true },
  { modelId: NEON, inPerMtok: 3, outPerMtok: 15, verified: false },
];

function mk(opts: { caps?: { monthlyCapUsd?: number; dailyCapUsd?: number; lifetimeCapUsd?: number; zone?: string }; policy?: Partial<MeteredDoorPolicy> | null; ttlMs?: number } = {}) {
  const capsStore = new RoutingSpendCapsStore({ stateDir, now });
  const ledger = new MeteredSpendLedger({
    stateDir,
    now,
    reserveTtlMs: opts.ttlMs ?? 60_000,
    zoneForKey: (k) => capsStore.read().caps[k]?.periodTimeZone,
  });
  const c = opts.caps ?? {};
  capsStore.adjustCaps('t', capsStore.version(), KEY, 'google', {
    monthlyCapUsd: c.monthlyCapUsd ?? 50,
    dailyCapUsd: c.dailyCapUsd ?? 10,
    lifetimeCapUsd: c.lifetimeCapUsd,
    periodTimeZone: c.zone ?? LA,
  });
  capsStore.setGoLive('t', capsStore.version(), DOOR, { enabled: true, keyRef: KEY, designatedMachineId: 'm1' });
  if (opts.policy !== null) {
    const pol = policy(opts.policy ?? {});
    // A door reaches `live` only through the recorder carrier (spec §8).
    capsStore.setDoorPolicy('t', capsStore.version(), DOOR, { ...pol, releaseState: 'armed-pending-proof' });
    if (pol.releaseState === 'live') capsStore.recordReleaseLive('recorder', DOOR, { proofReserveId: 'r-proof', intentHash: 'h' });
  }
  const prices = new RoutingPriceAuthority({ projectDir, stateDir, now });
  const gate = new MeteredSpendGate({ ledger, prices, capsStore, machineId: 'm1', leaseConfirmedAgoMs: () => 0, now });
  const deps = { capsStore, servingReady: () => true, gate };
  return { capsStore, ledger, prices, gate, deps };
}

/** A Hydrogen call reserving exactly $1.50 (0 input, 200k output+thinking at $7.50/M). */
function R(over: Partial<AdmitRequest> = {}): AdmitRequest {
  return { door: DOOR, modelId: H, inputTokens: 0, maxOutputTokens: 200_000, inputTokensCounted: true, component: 'test', caller: 'second-opinion', ...over };
}
let e1n = 0;
function E1(over: Partial<AdmitRequest> = {}): AdmitRequest {
  e1n++;
  return R({ caller: 'spec-review', e1Pass: { specSha256: 'a'.repeat(64), round: e1n }, ...over });
}

async function refusal(p: Promise<unknown>): Promise<MoneyGateRefusal> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MoneyGateRefusal);
    return err as MoneyGateRefusal;
  }
  throw new Error('expected a MoneyGateRefusal');
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payg-b-proj-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payg-b-state-'));
  clock = T0;
  e1n = 0;
  seedManifest(DEFAULT_POINTS);
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/gemini-payg-money-model.test.ts:cleanup' });
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/gemini-payg-money-model.test.ts:cleanup' });
});

// ── Caps and ledger ─────────────────────────────────────────────────

describe('caps and ledger — the period model', () => {
  it('validateCapsFile: monthly-only is valid; neither lifetime nor monthly is refused; daily is required', () => {
    const base = { version: 1, goLive: {}, leaseEpoch: 0 };
    expect(validateCapsFile({ ...base, caps: { k: { provider: 'google', monthlyCapUsd: 50, dailyCapUsd: 10, frozen: false } } })).toBeNull();
    expect(validateCapsFile({ ...base, caps: { k: { provider: 'google', dailyCapUsd: 10, frozen: false } } })).toMatch(/lifetimeCapUsd or a monthlyCapUsd/);
    expect(validateCapsFile({ ...base, caps: { k: { provider: 'google', monthlyCapUsd: 50, frozen: false } } })).toMatch(/dailyCapUsd/);
    expect(validateCapsFile({ ...base, caps: { k: { provider: 'google', monthlyCapUsd: 50, dailyCapUsd: 10, periodTimeZone: 'Mars/Olympus', frozen: false } } })).toMatch(/IANA/);
  });

  it("the gate's invalid-cap step accepts a monthly-only record (and still refuses a zero cap)", async () => {
    const { gate, capsStore } = mk();
    expect(capsStore.read().caps[KEY].lifetimeCapUsd).toBeUndefined();
    const r = await gate.admit(R());
    expect(r.reserveUsd).toBeCloseTo(1.5, 9);
    expect(r.committedMonthUsd).toBeCloseTo(1.5, 9);
    capsStore.adjustCaps('t', capsStore.version(), KEY, 'google', { monthlyCapUsd: 0, dailyCapUsd: 10 });
    expect((await refusal(gate.admit(R()))).reason).toBe('invalid-cap');
  });

  it('LA-zoned day and month across the November DST change and a month boundary', () => {
    expect(periodEpochs(Date.parse('2026-11-01T06:59:00Z'), LA)).toEqual({ dayEpoch: '2026-10-31', monthEpoch: '2026-10' });
    expect(periodEpochs(Date.parse('2026-11-01T07:00:00Z'), LA)).toEqual({ dayEpoch: '2026-11-01', monthEpoch: '2026-11' });
    // After fall-back (PST, UTC-8) local midnight is 08:00Z.
    expect(periodEpochs(Date.parse('2026-11-02T07:59:00Z'), LA).dayEpoch).toBe('2026-11-01');
    expect(periodEpochs(Date.parse('2026-11-02T08:00:00Z'), LA).dayEpoch).toBe('2026-11-02');
    expect(periodEpochs(Date.parse('2026-12-01T07:59:00Z'), LA).monthEpoch).toBe('2026-11');
    expect(periodEpochs(Date.parse('2026-12-01T08:00:00Z'), LA).monthEpoch).toBe('2026-12');
    // Reset instants: month boundary under PDT, day boundary across spring-forward.
    expect(new Date(nextPeriodBoundaryMs(Date.parse('2026-10-31T20:00:00Z'), LA, 'month')).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(new Date(nextPeriodBoundaryMs(Date.parse('2026-03-08T12:00:00Z'), LA, 'day')).toISOString()).toBe('2026-03-09T07:00:00.000Z');
    // UTC keeps the exact pre-change day.
    expect(periodEpochs(Date.parse('2026-11-20T23:59:59Z'))).toEqual({ dayEpoch: '2026-11-20', monthEpoch: '2026-11' });
  });

  it('a reservation 30 minutes before the LA month end charges the old month; the new month starts empty', async () => {
    clock = Date.parse('2026-12-01T07:30:00Z'); // 23:30 PST, 30 Nov
    const { gate, ledger } = mk();
    const r = await gate.admit(R());
    expect(ledger.reservation(r.reserveId)!.monthEpoch).toBe('2026-11');
    clock = Date.parse('2026-12-01T08:30:00Z'); // 00:30 PST, 1 Dec
    const t = ledger.committed(KEY);
    expect(t.monthEpoch).toBe('2026-12');
    expect(t.committedMonthUsd).toBe(0);
    expect(t.committedLifetimeUsd).toBeCloseTo(1.5, 9);
  });

  it('strict > on both sides of the MONTH cap', async () => {
    const { gate } = mk({ caps: { monthlyCapUsd: 3, dailyCapUsd: 100 } });
    const a = await gate.admit(E1());
    await gate.settleActual(KEY, a.reserveId, 1.5);
    const b = await gate.admit(E1()); // 1.5 + 1.5 = 3, not > 3: admitted
    await gate.settleActual(KEY, b.reserveId, 1.5);
    const r = await refusal(gate.admit(E1())); // 3 + 1.5 > 3
    expect(r.reason).toBe('cap-exceeded');
    expect(r.facts).toMatchObject({ period: 'month', capUsd: 3, settledUsd: 3, outstandingUsd: 0 });
    expect(r.facts?.resetsAt).toBe('2026-12-01T08:00:00.000Z');
  });

  it('strict > on both sides of the DAY cap, with the reset at the next LA midnight', async () => {
    const { gate } = mk({ caps: { monthlyCapUsd: 50, dailyCapUsd: 3 } });
    for (let i = 0; i < 2; i++) {
      const a = await gate.admit(E1());
      await gate.settleActual(KEY, a.reserveId, 1.5);
    }
    const r = await refusal(gate.admit(E1()));
    expect(r.reason).toBe('cap-exceeded');
    expect(r.facts).toMatchObject({ period: 'day', capUsd: 3 });
    expect(r.facts?.resetsAt).toBe('2026-11-21T08:00:00.000Z');
  });

  it('strict > on both sides of the E2 DAY share and the E2 MONTH share (pct of the monthly cap)', async () => {
    const day = mk({ policy: { e2DayCapUsd: 3 } });
    for (let i = 0; i < 2; i++) {
      const a = await day.gate.admit(R());
      await day.gate.settleActual(KEY, a.reserveId, 1.5);
    }
    const d = await refusal(day.gate.admit(R()));
    expect(d.reason).toBe('e2-share-exceeded');
    expect(d.facts?.period).toBe('day');
    // A non-E2 caller is not counted against the E2 share.
    await day.gate.admit(E1());
  });

  it('E2 month share: 6% of a $50 month is $3.00 — two $1.50 settle, the third refuses', async () => {
    const { gate } = mk({ caps: { monthlyCapUsd: 50, dailyCapUsd: 100 }, policy: { e2MonthSharePct: 6, e2DayCapUsd: 100 } });
    for (let i = 0; i < 2; i++) {
      const a = await gate.admit(R());
      await gate.settleActual(KEY, a.reserveId, 1.5);
    }
    const r = await refusal(gate.admit(R()));
    expect(r.reason).toBe('e2-share-exceeded');
    expect(r.facts).toMatchObject({ period: 'month', capUsd: 3 });
  });

  it('reserves-outstanding (retry shortly) is distinguished from cap-exceeded (settled spend is at the cap)', async () => {
    const { gate } = mk({ caps: { monthlyCapUsd: 50, dailyCapUsd: 3 } });
    const a = await gate.admit(E1());
    const b = await gate.admit(E1()); // committed 3 (both outstanding)
    const pending = await refusal(gate.admit(E1()));
    expect(pending.reason).toBe('reserves-outstanding');
    expect(pending.facts).toMatchObject({ settledUsd: 0, outstandingUsd: 3 });
    expect(pending.facts?.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(refusalHttpStatus(pending.reason)).toBe(409);
    await gate.settleActual(KEY, a.reserveId, 1.5);
    await gate.settleActual(KEY, b.reserveId, 1.5);
    expect((await refusal(gate.admit(E1()))).reason).toBe('cap-exceeded');
  });

  it('per-call ceiling: $2.50 admits, a hair over refuses per-call-ceiling (402, period call)', async () => {
    const { gate } = mk({ caps: { monthlyCapUsd: 50, dailyCapUsd: 50 } });
    await gate.admit(E1({ maxOutputTokens: 333_333 })); // $2.4999975
    const r = await refusal(gate.admit(E1({ maxOutputTokens: 333_334 })));
    expect(r.reason).toBe('per-call-ceiling');
    expect(r.facts?.period).toBe('call');
    expect(refusalHttpStatus(r.reason)).toBe(402);
  });
});

// ── Provisional ─────────────────────────────────────────────────────

describe('provisional bookings (gemini-api only)', () => {
  it('expiry books the full reserve as PROVISIONAL for gemini-api, and $0 for every other door', async () => {
    const { gate, ledger } = mk({ ttlMs: 1000 });
    const r = await gate.admit(R());
    await ledger.reserve({ keyRef: 'metered_openrouter_bench', door: 'openrouter-api', modelId: 'm', reserveUsd: 2, leaseEpoch: 0 });
    clock += 5000;
    expect(await ledger.sweepExpired()).toBe(2);
    const g = ledger.committed(KEY);
    expect(g.committedMonthUsd).toBeCloseTo(1.5, 9);
    expect(g.provisionalMonthUsd).toBeCloseTo(1.5, 9);
    expect(ledger.reservation(r.reserveId)!.state).toBe('provisional');
    expect(ledger.committed('metered_openrouter_bench').committedLifetimeUsd).toBe(0); // today's $0 fold, unchanged
  });

  it('a late settle keeps max(provisional, actual): a lower actual never returns headroom, a higher one books only the excess', async () => {
    const { gate, ledger } = mk();
    const lo = await gate.admit(E1());
    await gate.settleProvisional(KEY, lo.reserveId);
    await gate.settleActual(KEY, lo.reserveId, 0.4);
    expect(ledger.reservation(lo.reserveId)!.contributionUsd).toBeCloseTo(1.5, 9);
    const hi = await gate.admit(E1());
    await gate.settleProvisional(KEY, hi.reserveId);
    await gate.settleActual(KEY, hi.reserveId, 2.0);
    expect(ledger.reservation(hi.reserveId)!.contributionUsd).toBeCloseTo(2.0, 9); // not 1.5 + 2.0
    await gate.settleActual(KEY, hi.reserveId, 9.0); // a second settle is a no-op
    expect(ledger.committed(KEY).committedMonthUsd).toBeCloseTo(3.5, 9);
    const rows = fs.readFileSync(path.join(stateDir, 'state', 'metered-spend-ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const late = rows.filter((x) => x.reserveId === hi.reserveId && x.kind === 'settle');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ afterProvisional: true, bookedExcessUsd: 0.5, monthEpoch: '2026-11' });
  });

  it('the provisional ceiling: four concurrent $2.50 reserves against $9 admit only three', async () => {
    const { gate } = mk({ caps: { monthlyCapUsd: 50, dailyCapUsd: 50 }, policy: { provisionalCeilingUsd: 9 } });
    const results = await Promise.allSettled([0, 1, 2, 3].map(() => gate.admit(E1({ maxOutputTokens: 333_333 }))));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason as MoneyGateRefusal);
    expect(ok).toHaveLength(3);
    expect(refused.map((r) => r.reason)).toEqual(['provisional-ceiling']);
  });

  it('provisional amounts count against the ceiling until the month resets', async () => {
    const { gate } = mk({ caps: { monthlyCapUsd: 50, dailyCapUsd: 50 }, policy: { provisionalCeilingUsd: 3 } });
    for (let i = 0; i < 2; i++) {
      const a = await gate.admit(E1());
      await gate.settleProvisional(KEY, a.reserveId);
    }
    expect((await refusal(gate.admit(E1()))).reason).toBe('provisional-ceiling');
  });
});

// ── Admission order ─────────────────────────────────────────────────

describe('admission order (§2) through the caller-facing entry', () => {
  it('a missing caller refuses not-allowlisted (403)', async () => {
    const { deps } = mk();
    const req = R();
    delete (req as Partial<AdmitRequest>).caller;
    const r = await refusal(admitMeteredCall(deps, req));
    expect(r.reason).toBe('not-allowlisted');
    expect(refusalHttpStatus(r.reason)).toBe(403);
  });

  it('a caller not on the door policy, and a door with no policy, both refuse', async () => {
    const { deps } = mk();
    expect((await refusal(admitMeteredCall(deps, R({ caller: 'doorway-liveness' })))).reason).toBe('not-allowlisted');
    expect((await refusal(admitMeteredCall(deps, R({ caller: 'probe' })))).reason).toBe('not-allowlisted');
  });

  it('a door with no caller policy refuses every caller (deny by default)', async () => {
    const bare = mk({ policy: null });
    expect((await refusal(admitMeteredCall(bare.deps, R()))).reason).toBe('not-allowlisted');
  });

  it('E3 (nature-routing) components are checked against the door list', async () => {
    const { deps } = mk({ policy: { meteredCallers: { callers: ['nature-routing'], e3Components: ['AllowedSorter'] } } });
    expect((await refusal(admitMeteredCall(deps, R({ caller: 'nature-routing', component: 'OtherSorter' })))).reason).toBe('not-allowlisted');
    const ok = await admitMeteredCall(deps, R({ caller: 'nature-routing', component: 'AllowedSorter' }));
    expect(ok.reserveId).toBeTruthy();
  });

  it('freeze and not-live refuse before the caller check, in that order', async () => {
    const { deps, capsStore } = mk();
    expect((await refusal(admitMeteredCall({ ...deps, servingReady: () => false }, R({ caller: undefined as never })))).reason).toBe('not-live');
    capsStore.freeze('op', KEY);
    expect((await refusal(admitMeteredCall(deps, R({ caller: undefined as never })))).reason).toBe('frozen');
  });

  it('preflight refuses an exhausted caller before any token count (the key is never used)', async () => {
    const { deps, gate, ledger } = mk({ policy: { e2DayCapUsd: 1.5 } });
    const a = await gate.admit(R());
    await gate.settleActual(KEY, a.reserveId, 1.5);
    let keyUsed = false;
    const run = async () => {
      const pre = await preflightMeteredCall(deps, R());
      if (pre.kind === 'proceed') keyUsed = true; // the provider would count tokens here
    };
    const r = await refusal(run());
    expect(r.reason).toBe('e2-share-exceeded');
    expect(keyUsed).toBe(false);
    expect(ledger.committed(KEY).outstandingReserveUsd).toBe(0);
    // A non-exhausted caller proceeds.
    expect((await preflightMeteredCall(deps, E1())).kind).toBe('proceed');
  });

  it('admission race: a caller disabled while the token count is paused is refused UNDER THE LOCK', async () => {
    const { gate, capsStore, ledger } = mk();
    const pending = gate.admit(R()); // pre-lock checks pass synchronously; the booking waits on the lock
    capsStore.disableCaller('bearer:op', DOOR, { caller: 'second-opinion' });
    const r = await refusal(pending);
    expect(r.reason).toBe('not-allowlisted');
    expect(ledger.committed(KEY).committedMonthUsd).toBe(0);
  });

  it('a cap lowered while the call is being prepared is honoured under the lock', async () => {
    const { gate, capsStore } = mk();
    const pending = gate.admit(E1());
    capsStore.lowerCaps('bearer:op', KEY, { dailyCapUsd: 1 });
    expect((await refusal(pending)).reason).toBe('cap-exceeded');
  });
});

// ── Release state ───────────────────────────────────────────────────

describe('release state (§8): armed-pending-proof', () => {
  it('refuses every ordinary caller with armed-pending-proof (423)', async () => {
    const { deps } = mk({ policy: { releaseState: 'armed-pending-proof' } });
    const r = await refusal(admitMeteredCall(deps, E1()));
    expect(r.reason).toBe('armed-pending-proof');
    expect(refusalHttpStatus(r.reason)).toBe(423);
  });

  it('the proof marker is refused from request input: no marker, a forged object, or a request field', async () => {
    const { deps } = mk({ policy: { releaseState: 'armed-pending-proof' } });
    const proofReq = { door: DOOR, modelId: NEON, inputTokens: 10, maxOutputTokens: 64, inputTokensCounted: true, component: 'release-proof', caller: 'release-proof' as const };
    expect((await refusal(admitMeteredCall(deps, proofReq))).reason).toBe('not-allowlisted');
    const forged = { door: DOOR, intentHash: 'x' } as never;
    expect((await refusal(admitMeteredCall(deps, proofReq, { proofMarker: forged }))).reason).toBe('not-allowlisted');
    expect((await refusal(admitMeteredCall(deps, { ...proofReq, proofMarker: forged } as never))).reason).toBe('not-allowlisted');
  });

  it('the minted marker admits the single proof call, priced from the unverified point at conservativeMax', async () => {
    const { deps } = mk({ policy: { releaseState: 'armed-pending-proof' } });
    const marker = mintReleaseProofMarker(DOOR, 'intent-hash');
    const proofReq = { door: DOOR, modelId: NEON, inputTokens: 10, maxOutputTokens: 64, inputTokensCounted: true, component: 'release-proof', caller: 'release-proof' as const };
    const ok = await admitMeteredCall(deps, proofReq, { proofMarker: marker });
    expect(ok.bookedInPerMtok).toBe(6);
    expect(ok.bookedOutPerMtok).toBe(30);
    // A marker for another door does not count.
    const other = mintReleaseProofMarker('openrouter-api', 'intent-hash');
    expect((await refusal(admitMeteredCall(deps, proofReq, { proofMarker: other }))).reason).toBe('not-allowlisted');
  });

  it('once live, the release-proof caller is closed and an unverified model refuses outside-verified-tier', async () => {
    const { deps } = mk();
    const marker = mintReleaseProofMarker(DOOR, 'h');
    const proofReq = { door: DOOR, modelId: NEON, inputTokens: 10, maxOutputTokens: 64, inputTokensCounted: true, component: 'release-proof', caller: 'release-proof' as const };
    expect((await refusal(admitMeteredCall(deps, proofReq, { proofMarker: marker })))).toMatchObject({ reason: 'not-allowlisted' });
    expect((await refusal(admitMeteredCall(deps, E1({ modelId: NEON })))).reason).toBe('outside-verified-tier');
  });

  it('PROBE_DOOR is unaffected by the lease self-fence: a pool holder whose echo is not yet confirmed still passes its boot probe, while the metered door self-fences', async () => {
    // Found by the user-role live test on a real two-machine pair: the boot probe ran
    // before the first designation echo and left the money layer probe-failed.
    for (const leaseAgo of [null, 10 * 60_000]) {
      const capsStore = new RoutingSpendCapsStore({ stateDir, now });
      capsStore.ensureProbeDoor('m1');
      capsStore.adjustCaps('t', capsStore.version(), KEY, 'google', { monthlyCapUsd: 50, dailyCapUsd: 10, periodTimeZone: LA });
      capsStore.setGoLive('t', capsStore.version(), DOOR, { enabled: true, keyRef: KEY, designatedMachineId: 'm1' });
      capsStore.setDoorPolicy('t', capsStore.version(), DOOR, { ...policy(), releaseState: 'armed-pending-proof' });
      const ledger = new MeteredSpendLedger({ stateDir, now, zoneForKey: (k) => capsStore.read().caps[k]?.periodTimeZone });
      const prices = new RoutingPriceAuthority({ projectDir, stateDir, now });
      const gate = new MeteredSpendGate({ ledger, prices, capsStore, machineId: 'm1', leaseConfirmedAgoMs: () => leaseAgo, now });
      const verdict = await runCapGateProbe(gate, capsStore.read());
      expect(verdict).toMatchObject({ passed: true });
      expect((await refusal(gate.admit(R()))).reason).toBe('lease-liveness-unconfirmed');
    }
  });

  it('PROBE_DOOR is unaffected: runCapGateProbe still passes beside a gemini door policy', async () => {
    const { gate, capsStore } = mk();
    capsStore.ensureProbeDoor('m1');
    const verdict = await runCapGateProbe(gate, capsStore.read());
    expect(verdict.passed).toBe(true);
  });
});

// ── E1 pass slots ───────────────────────────────────────────────────

describe('E1 pass slots (one pass per (specSha256, round), reserved under the lock)', () => {
  const pass = { specSha256: 'b'.repeat(64), round: 7 };
  it('three concurrent same-key calls admit exactly one', async () => {
    const { gate } = mk();
    const results = await Promise.allSettled([0, 1, 2].map(() => gate.admit(R({ caller: 'spec-review', e1Pass: pass }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const reasons = results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as MoneyGateRefusal).reason);
    expect(reasons).toEqual(['e1-pass-limit', 'e1-pass-limit']);
    expect(refusalHttpStatus('e1-pass-limit')).toBe(429);
  });

  it('a confirmed no-charge settle releases the slot; a provisional outcome keeps it', async () => {
    const { gate } = mk();
    const a = await gate.admit(R({ caller: 'spec-review', e1Pass: pass }));
    await gate.settleNoCharge(KEY, a.reserveId);
    const b = await gate.admit(R({ caller: 'spec-review', e1Pass: pass }));
    await gate.settleProvisional(KEY, b.reserveId);
    expect((await refusal(gate.admit(R({ caller: 'spec-review', e1Pass: pass })))).reason).toBe('e1-pass-limit');
  });

  it('a spec-review call without its pass key refuses', async () => {
    const { deps } = mk();
    expect((await refusal(admitMeteredCall(deps, R({ caller: 'spec-review' })))).reason).toBe('not-allowlisted');
  });
});

// ── Dedupe first ────────────────────────────────────────────────────

describe('dedupe first (§5 step 6)', () => {
  it('a lost acknowledgment on the last affordable call returns the existing call, not a cap refusal — even frozen, even after restart', async () => {
    const { deps, capsStore } = mk({ caps: { monthlyCapUsd: 50, dailyCapUsd: 1.5 } });
    const first = await admitMeteredCall(deps, E1({ callId: 'call-1', requestSha256: 's1' }));
    const again = await admitMeteredCall(deps, E1({ callId: 'call-1', requestSha256: 's1' }));
    expect(again).toMatchObject({ reserveId: first.reserveId, deduped: true });
    capsStore.freeze('op', KEY);
    const frozenAgain = await admitMeteredCall(deps, E1({ callId: 'call-1', requestSha256: 's1' }));
    expect(frozenAgain.reserveId).toBe(first.reserveId);
    // Restart: a fresh ledger folds the callId from rows.
    const ledger2 = new MeteredSpendLedger({ stateDir, now });
    expect(ledger2.lookupCall('call-1')!.reserveId).toBe(first.reserveId);
  });

  it('same callId with a different request digest refuses callid-conflict (409)', async () => {
    const { deps } = mk();
    await admitMeteredCall(deps, E1({ callId: 'call-2', requestSha256: 's1' }));
    const r = await refusal(admitMeteredCall(deps, E1({ callId: 'call-2', requestSha256: 's2' })));
    expect(r.reason).toBe('callid-conflict');
    expect(refusalHttpStatus(r.reason)).toBe(409);
  });

  it('two concurrent submissions of one callId book once', async () => {
    const { gate, ledger } = mk();
    const [a, b] = await Promise.all([gate.admit(E1({ callId: 'c3', requestSha256: 'd3' })), gate.admit(R({ caller: 'spec-review', e1Pass: { specSha256: 'c'.repeat(64), round: 1 }, callId: 'c3', requestSha256: 'd3' }))]);
    expect(a.reserveId).toBe(b.reserveId);
    expect(ledger.committed(KEY).committedMonthUsd).toBeCloseTo(1.5, 9);
  });
});

describe('second-pass review folds', () => {
  it('a callId resubmission without a digest, or for another door, is a conflict — never a returned call', async () => {
    const { deps, ledger } = mk();
    await admitMeteredCall(deps, E1({ callId: 'cx', requestSha256: 'dx' }));
    expect((await refusal(admitMeteredCall(deps, E1({ callId: 'cx' })))).reason).toBe('callid-conflict');
    const other = ledger.lookupCall('cx')!;
    await expect(
      ledger.reserve({ keyRef: 'metered_openrouter_bench', door: 'openrouter-api', modelId: 'm', reserveUsd: 1, leaseEpoch: 0, callId: 'cx', requestSha256: 'dx' }),
    ).rejects.toThrow(/already bound/);
    expect(other.door).toBe(DOOR);
  });

  it('a pre-change $0 expiry row on gemini-api still folds to $0 (provisional is the row flag, not the door name)', () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const rows = [
      { ts: '2026-11-20T01:00:00.000Z', keyRef: 'old', door: DOOR, modelId: 'm', kind: 'reserve', reserveId: 'r1', costUsd: 1.5, leaseEpoch: 0 },
      { ts: '2026-11-20T01:30:00.000Z', keyRef: 'old', door: DOOR, modelId: 'm', kind: 'expire', reserveId: 'r1', costUsd: 0, leaseEpoch: 0 },
    ];
    fs.writeFileSync(path.join(stateDir, 'state', 'metered-spend-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(new MeteredSpendLedger({ stateDir, now }).committed('old').committedLifetimeUsd).toBe(0);
  });

  it('a hard breach on one limit wins over reserves-outstanding on another', async () => {
    // Yesterday's still-outstanding reserve sits in THIS month but not today.
    seedManifest([{ modelId: H, inPerMtok: 1.5, outPerMtok: 7.5, maxInputTokens: 200_000, verified: true, effectiveAt: '2026-11-15T00:00:00Z' }]);
    clock = T0 - 86_400_000;
    const { gate } = mk({ caps: { monthlyCapUsd: 5, dailyCapUsd: 2.5 }, ttlMs: 3 * 86_400_000 });
    await gate.admit(E1({ maxOutputTokens: 320_000 })); // $2.40, 19 Nov, left outstanding
    clock = T0;
    const a = await gate.admit(E1({ maxOutputTokens: 320_000 }));
    await gate.settleActual(KEY, a.reserveId, 2.0); // today settled $2.00
    // month: committed 4.40 + 0.75 > 5 but settled 2.00 + 0.75 fits → outstanding;
    // day: settled 2.00 + 0.75 > 2.5 → HARD. The hard one must be reported.
    const r = await refusal(gate.admit(E1({ maxOutputTokens: 100_000 })));
    expect(r.reason).toBe('cap-exceeded');
    expect(r.facts?.period).toBe('day');
  });

  it('staleness is per selected point: a fresh Hydrogen point does not keep a stale Neon point usable', async () => {
    seedManifest([
      { modelId: H, inPerMtok: 1.5, outPerMtok: 7.5, maxInputTokens: 200_000, verified: true },
    ]);
    // Add a VERIFIED Neon point that is 60 days old (past the 45-day window).
    const mp = path.join(projectDir, 'scripts', 'routing-prices.manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    m.points.push({ door: DOOR, modelId: NEON, inPerMtok: 3, outPerMtok: 15, maxInputTokens: 200_000, verified: true, effectiveAt: '2026-09-21T00:00:00Z' });
    fs.writeFileSync(mp, JSON.stringify(m));
    const { gate } = mk();
    expect((await refusal(gate.admit(E1({ modelId: NEON, maxOutputTokens: 1000 })))).reason).toBe('stale-price-fail-closed');
    await gate.admit(E1({ maxOutputTokens: 1000 })); // Hydrogen is fresh
  });

  it('a policy write can never move a door to live; only the recorder carrier can, and only from armed-pending-proof', () => {
    const { capsStore } = mk({ policy: { releaseState: 'armed-pending-proof' } });
    expect(() => capsStore.setDoorPolicy('op', capsStore.version(), DOOR, policy({ releaseState: 'live' }))).toThrow(/release-proof recorder/);
    capsStore.recordReleaseLive('recorder', DOOR, { proofReserveId: 'r', intentHash: 'h' });
    expect(capsStore.read().doorPolicy![DOOR].releaseState).toBe('live');
    expect(() => capsStore.recordReleaseLive('recorder', DOOR, { proofReserveId: 'r', intentHash: 'h' })).toThrow(/not armed-pending-proof/);
    // A live door may stay live through a policy write.
    capsStore.setDoorPolicy('op', capsStore.version(), DOOR, policy({ e2MonthSharePct: 30 }));
  });

  it('the gate re-checks the caller under the lock for every door but the probe (a door with no policy refuses)', async () => {
    const { gate } = mk({ policy: null });
    expect((await refusal(gate.admit(E1()))).reason).toBe('not-allowlisted');
  });
});

// ── Price authority + tier ──────────────────────────────────────────

describe('price authority and tiers', () => {
  it('verified:false is treated exactly like stale', () => {
    const prices = new RoutingPriceAuthority({ projectDir, stateDir, now });
    const neon = prices.resolve(DOOR, NEON, clock);
    expect(neon.priceStale).toBe(true);
    expect(neon.priceUnverified).toBe(true);
    expect(neon.priceAgeStale).toBe(false);
    expect(prices.resolve(DOOR, H, clock).priceStale).toBe(false);
  });

  it('tier: both sides of a boundary with the manifest insertion order REVERSED; above the top verified tier refuses', async () => {
    seedManifest([
      { modelId: H, inPerMtok: 3, outPerMtok: 15, maxInputTokens: 1_000_000, verified: true },
      { modelId: H, inPerMtok: 1.5, outPerMtok: 7.5, maxInputTokens: 200_000, verified: true },
    ]);
    const { gate } = mk({ caps: { monthlyCapUsd: 50, dailyCapUsd: 50 }, policy: { perCallCeilingUsd: 50 } });
    const at = await gate.admit(E1({ inputTokens: 200_000, maxOutputTokens: 1000 }));
    expect(at.bookedInPerMtok).toBe(1.5);
    const over = await gate.admit(E1({ inputTokens: 200_001, maxOutputTokens: 1000 }));
    expect(over.bookedInPerMtok).toBe(3);
    expect(over.pricePointId).not.toBe(at.pricePointId);
    const out = await refusal(gate.admit(E1({ inputTokens: 1_000_001, maxOutputTokens: 1000 })));
    expect(out.reason).toBe('outside-verified-tier');
    expect(refusalHttpStatus(out.reason)).toBe(422);
  });

  it('an uncounted input refuses token-count-unavailable (no estimated fallback)', async () => {
    const { gate } = mk();
    expect((await refusal(gate.admit(E1({ inputTokensCounted: false })))).reason).toBe('token-count-unavailable');
  });

  it('settle uses the RESERVED price point, not a later manifest correction', async () => {
    const { gate, ledger } = mk();
    const r = await gate.admit(E1({ inputTokens: 1000, maxOutputTokens: 1000 }));
    expect(ledger.reservation(r.reserveId)!.pricePointId).toBe(r.pricePointId);
    // A correction lands after admission (same tier, later record).
    seedManifest([{ modelId: H, inPerMtok: 100, outPerMtok: 100, maxInputTokens: 200_000, verified: true, recordedAt: '2026-11-20T12:00:00Z' }]);
    const booked = await gate.settleFromUsage(KEY, r.reserveId, { promptTokens: 1_000_000, billedOutputTokens: 1_000_000 });
    expect(booked).toBeCloseTo(1.5 + 7.5, 9);
  });
});

// ── Refusals ────────────────────────────────────────────────────────

describe('refusals: status, plain message, and the forwarding round trip', () => {
  const table: Array<[MoneyGateRefusalReason, number]> = [
    ['not-allowlisted', 403], ['armed-pending-proof', 423], ['per-call-ceiling', 402], ['outside-verified-tier', 422],
    ['token-count-unavailable', 503], ['prompt-contains-live-secret', 422], ['provisional-ceiling', 402],
    ['e1-pass-limit', 429], ['key-generation-mismatch', 503], ['request-too-large', 422], ['callid-conflict', 409],
    ['e2-share-exceeded', 402], ['reserves-outstanding', 409],
    ['cap-exceeded', 402], ['unknown-price', 422], ['frozen', 423], ['not-live', 423],
  ];
  it.each(table)('%s → %i with a plain message', (reason, status) => {
    expect(refusalHttpStatus(reason)).toBe(status);
    const msg = refusalPlainMessage(reason);
    expect(msg.length).toBeGreaterThan(20);
    expect(msg).not.toMatch(/[a-z]+-[a-z]+-[a-z]+/); // no reason-code jargon in the plain message
  });

  it('every reason survives the wire unchanged, facts included', () => {
    for (const [reason] of table) {
      const orig = new MoneyGateRefusal(reason, 'd', KEY, DOOR, { period: 'month', settledUsd: 1, outstandingUsd: 2, capUsd: 50, resetsAt: '2026-12-01T08:00:00.000Z', retryAfterSec: 5 });
      const wire = JSON.parse(JSON.stringify(orig.toWire()));
      expect(wire.status).toBe(refusalHttpStatus(reason));
      const back = MoneyGateRefusal.fromWire(wire);
      expect(back.reason).toBe(reason);
      expect(back.facts).toEqual(orig.facts);
      expect(back.keyRef).toBe(KEY);
    }
    expect(MoneyGateRefusal.fromWire({ reason: 'made-up' }).reason).toBe('ledger-error'); // unknown is never a pass
  });
});

// ── Caps store mutators ─────────────────────────────────────────────

describe('caps store: PIN to add, Bearer to remove', () => {
  it('setDoorPolicy needs the plan version (a PIN-path release); a stale version is refused', () => {
    const { capsStore } = mk();
    const v = capsStore.version();
    expect(() => capsStore.setDoorPolicy('op', v - 1, DOOR, policy({ e2MonthSharePct: 60 }))).toThrow(/version drift/);
    expect(() => capsStore.setDoorPolicy('op', v, DOOR, policy({ meteredCallers: { callers: ['release-proof'], e3Components: [] } }))).toThrow(/non-listable caller/);
  });

  it('lowerCaps is reduce-only and bumps leaseEpoch but never designationEpoch', () => {
    const { capsStore } = mk();
    const before = capsStore.read();
    expect(() => capsStore.lowerCaps('bearer', KEY, { monthlyCapUsd: 60 })).toThrow(/PIN action/);
    const after = capsStore.lowerCaps('bearer', KEY, { monthlyCapUsd: 40, door: DOOR, perCallCeilingUsd: 1 });
    expect(after.caps[KEY].monthlyCapUsd).toBe(40);
    expect(after.doorPolicy![DOOR].perCallCeilingUsd).toBe(1);
    expect(after.leaseEpoch).toBe(before.leaseEpoch + 1);
    expect(after.doorPolicy![DOOR].designationEpoch).toBe(before.doorPolicy![DOOR].designationEpoch);
    expect(() => capsStore.lowerCaps('bearer', KEY, { door: DOOR, provisionalCeilingUsd: 11 })).toThrow(/PIN action/);
  });

  it('disableCaller and lowerShare only ever reduce', () => {
    const { capsStore } = mk();
    expect(capsStore.disableCaller('bearer', DOOR, { caller: 'second-opinion' }).doorPolicy![DOOR].meteredCallers.callers).toEqual(['spec-review']);
    expect(() => capsStore.lowerShare('bearer', DOOR, 50)).toThrow(/PIN action/);
    expect(capsStore.lowerShare('bearer', DOOR, 10).doorPolicy![DOOR].e2MonthSharePct).toBe(10);
  });

  it('the period zone is fixed once the door is live', () => {
    const { capsStore } = mk();
    expect(() => capsStore.adjustCaps('op', capsStore.version(), KEY, 'google', { monthlyCapUsd: 50, dailyCapUsd: 10, periodTimeZone: 'UTC' })).toThrow(/fixed while door/);
    // Unchanged zone is fine.
    capsStore.adjustCaps('op', capsStore.version(), KEY, 'google', { monthlyCapUsd: 60, dailyCapUsd: 10 });
    expect(capsStore.read().caps[KEY].periodTimeZone).toBe(LA);
  });
});

// ── Calendar ────────────────────────────────────────────────────────

describe('calendar: a zone change never moves an existing commitment', () => {
  it('a reservation outstanding across midnight keeps its charged period through settle', async () => {
    let zone = 'UTC';
    clock = Date.parse('2026-11-20T23:30:00Z');
    const ledger = new MeteredSpendLedger({ stateDir, now, zoneForKey: () => zone });
    const h = await ledger.reserve({ keyRef: KEY, door: DOOR, modelId: H, reserveUsd: 1, leaseEpoch: 0, periodTimeZone: zone });
    expect(h.dayEpoch).toBe('2026-11-20');
    zone = 'Asia/Tokyo'; // 08:30 on the 21st there
    clock = Date.parse('2026-11-21T00:30:00Z');
    await ledger.settle(KEY, h.reserveId, 0.8);
    expect(ledger.reservation(h.reserveId)!.dayEpoch).toBe('2026-11-20');
    const rows = fs.readFileSync(path.join(stateDir, 'state', 'metered-spend-ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[1]).toMatchObject({ kind: 'settle', dayEpoch: '2026-11-20' });
    expect(ledger.committed(KEY).committedDayUsd).toBe(0); // today (Tokyo 21st) holds nothing
    expect(ledger.committed(KEY).committedLifetimeUsd).toBeCloseTo(0.8, 9);
  });
});

// ── Registry + Migration Parity ─────────────────────────────────────

describe('registry and migration parity', () => {
  it('FD-G4: the default nature chains contain no metered door', () => {
    for (const [chain, positions] of Object.entries(NATURE_ROUTING_DEFAULT_CHAINS)) {
      for (const p of positions) {
        expect(METERED_ROUTING_DOORS.has(p.door), `${chain} holds metered door ${p.door}`).toBe(false);
        expect(p.moneyGated ?? false).toBe(false);
      }
    }
  });

  it('a pre-change caps file (lifetime-only, no doorPolicy) and one holding the retired key both load unchanged', () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const old = {
      version: 3,
      caps: {
        metered_openrouter_bench: { provider: 'openrouter', lifetimeCapUsd: 60, dailyCapUsd: 25, frozen: false },
        metered_gemini_bench: { provider: 'google', lifetimeCapUsd: 40, dailyCapUsd: 15, frozen: true, frozenBy: 'x', frozenAt: '2026-07-01T00:00:00.000Z' },
      },
      goLive: {},
      leaseEpoch: 2,
    };
    fs.writeFileSync(path.join(stateDir, 'state', 'routing-spend-caps.json'), JSON.stringify(old));
    const store = new RoutingSpendCapsStore({ stateDir, now, knownKeyRefs: new Set(knownMeteredKeyRefs()) });
    expect(store.read()).toEqual(old);
  });

  it('a pre-change ledger (rows without period fields) folds to the same UTC totals', () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const rows = [
      { ts: '2026-11-20T01:00:00.000Z', keyRef: 'k', door: 'openrouter-api', modelId: 'm', kind: 'reserve', reserveId: 'r1', costUsd: 2, leaseEpoch: 0 },
      { ts: '2026-11-20T01:01:00.000Z', keyRef: 'k', door: 'openrouter-api', modelId: 'm', kind: 'settle', reserveId: 'r1', costUsd: 1.25, leaseEpoch: 0 },
      { ts: '2026-11-19T01:00:00.000Z', keyRef: 'k', door: 'openrouter-api', modelId: 'm', kind: 'reserve', reserveId: 'r0', costUsd: 3, leaseEpoch: 0 },
      { ts: '2026-11-19T01:30:00.000Z', keyRef: 'k', door: 'openrouter-api', modelId: 'm', kind: 'expire', reserveId: 'r0', costUsd: 0, leaseEpoch: 0 },
    ];
    fs.writeFileSync(path.join(stateDir, 'state', 'metered-spend-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const ledger = new MeteredSpendLedger({ stateDir, now });
    const t = ledger.committed('k');
    expect(t.committedLifetimeUsd).toBeCloseTo(1.25, 9);
    expect(t.committedDayUsd).toBeCloseTo(1.25, 9);
    expect(t.dayEpoch).toBe('2026-11-20');
    expect(t.committedMonthUsd).toBeCloseTo(1.25, 9);
  });
});
