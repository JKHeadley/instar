// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Unit tests — MeteredSpendGate (routing-control-room-spend Increment B, Layer 3).
 *
 * The FAIL-CLOSED matrix, pinned case by case: not-live (deny-by-default) ·
 * frozen · no-cap-slice (wrong machine) · lease-liveness-unconfirmed (self-fence)
 * · unbounded-reservation · unknown-price (incl. observed-never-gate-eligible,
 * S2-2) · implausible-price (typo floor) · stale-price fail-closed vs
 * book-conservative-max · invalid-cap · cap-exceeded (strict >, both caps) —
 * plus the admit path booking cached-as-full-input worst case (FD-19) and the
 * per-door billed-token mapping (Gemini thinking-token trap).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MeteredSpendLedger } from '../../src/core/MeteredSpendLedger.js';
import { RoutingSpendCapsStore } from '../../src/core/RoutingSpendCapsStore.js';
import { RoutingPriceAuthority } from '../../src/core/routingPriceAuthority.js';
import { MeteredSpendGate, MoneyGateRefusal, billedOutputTokens } from '../../src/core/MeteredSpendGate.js';

let projectDir: string;
let stateDir: string;
let clock: number;
const now = () => clock;

function seedManifest(opts: { stale?: boolean; low?: boolean; staleMode?: string; conservativeMax?: { inPerMtok: number; outPerMtok: number } | null; observedOnly?: boolean } = {}): void {
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  const effectiveAt = opts.stale ? '2026-01-01T00:00:00.000Z' : '2026-07-01T00:00:00.000Z';
  const point = { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: opts.low ? 0.0001 : 5, outPerMtok: opts.low ? 0.0001 : 30, effectiveAt };
  fs.writeFileSync(
    path.join(projectDir, 'scripts', 'routing-prices.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      doors: {
        'openrouter-api': {
          freshnessSlaDays: 45,
          ...(opts.staleMode ? { staleMode: opts.staleMode } : {}),
          ...(opts.conservativeMax === null ? {} : { conservativeMax: opts.conservativeMax ?? { inPerMtok: 10, outPerMtok: 60 } }),
        },
      },
      points: opts.observedOnly ? [] : [point],
    }),
  );
  if (opts.observedOnly) {
    // The OBSERVED cache holds a perfectly valid point — it must STILL not be gate-eligible (S2-2).
    fs.writeFileSync(path.join(stateDir, 'routing-prices.observed.json'), JSON.stringify({ points: [point] }));
  }
}

function mkGate(opts: {
  armed?: boolean; machineId?: string; designated?: string; leaseAgo?: number | null;
  frozen?: boolean; caps?: { lifetimeCapUsd: number; dailyCapUsd: number } | null;
} = {}) {
  const ledger = new MeteredSpendLedger({ stateDir, now });
  const capsStore = new RoutingSpendCapsStore({ stateDir, now });
  if (opts.caps !== null) {
    capsStore.adjustCaps('test', capsStore.version(), 'metered_openrouter_bench', 'openrouter', opts.caps ?? { lifetimeCapUsd: 60, dailyCapUsd: 25 });
  }
  if (opts.armed !== false) {
    capsStore.setGoLive('test', capsStore.version(), 'openrouter-api', {
      enabled: true,
      keyRef: 'metered_openrouter_bench',
      designatedMachineId: opts.designated ?? 'm1',
    });
  }
  // gemini-payg §2/§5: every non-probe door needs a door policy naming its callers
  // (deny by default, re-checked under the reservation lock). Limits here are wide so
  // this matrix keeps exercising the parent gate's own checks.
  capsStore.setDoorPolicy('test', capsStore.version(), 'openrouter-api', {
    perCallCeilingUsd: 1000, provisionalCeilingUsd: 1000, e2MonthSharePct: 0, e2DayCapUsd: 0, e1PassesPerRound: 0,
    keyGeneration: null, meteredCallers: { callers: ['doorway-liveness'], e3Components: [] }, throughputFloorTps: {},
    releaseState: 'armed-pending-proof', designationEpoch: 1,
  });
  capsStore.recordReleaseLive('test', 'openrouter-api', { proofReserveId: 'p', intentHash: 'h' });
  if (opts.frozen) capsStore.freeze('test', 'metered_openrouter_bench');
  const prices = new RoutingPriceAuthority({ projectDir, stateDir, now });
  const gate = new MeteredSpendGate({
    ledger,
    prices,
    capsStore,
    machineId: opts.machineId ?? 'm1',
    leaseConfirmedAgoMs: () => (opts.leaseAgo === undefined ? 0 : opts.leaseAgo),
    now,
  });
  return { gate, ledger, capsStore };
}

const REQ = { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inputTokens: 1_000_000, maxOutputTokens: 100_000, component: 'gate-matrix', caller: 'doorway-liveness' as const };

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
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-proj-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-state-'));
  clock = Date.parse('2026-07-08T10:00:00Z');
  seedManifest();
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/metered-spend-gate.test.ts' });
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/metered-spend-gate.test.ts' });
});

describe('MeteredSpendGate — fail-closed matrix', () => {
  it('admits a bounded call under cap and books the worst-case reserve', async () => {
    const { gate, ledger } = mkGate();
    const r = await gate.admit(REQ);
    // 1M in @ $5/M + 100k out @ $30/M = 5 + 3 = $8
    expect(r.reserveUsd).toBeCloseTo(8, 6);
    expect(ledger.committed('metered_openrouter_bench').committedLifetimeUsd).toBeCloseTo(8, 6);
  });

  it('not-live: deny-by-default with no go-live record', async () => {
    const { gate } = mkGate({ armed: false });
    expect((await refusal(gate.admit(REQ))).reason).toBe('not-live');
  });

  it('no-cap-slice: a machine that is not the designated metered-lease holder', async () => {
    const { gate } = mkGate({ designated: 'other-machine' });
    expect((await refusal(gate.admit(REQ))).reason).toBe('no-cap-slice');
  });

  it('lease-liveness-unconfirmed: the holder self-fences without fresh positive confirmation (N-2)', async () => {
    const never = mkGate({ leaseAgo: null });
    expect((await refusal(never.gate.admit(REQ))).reason).toBe('lease-liveness-unconfirmed');
    const staleConf = mkGate({ leaseAgo: 10 * 60 * 1000 });
    expect((await refusal(staleConf.gate.admit(REQ))).reason).toBe('lease-liveness-unconfirmed');
  });

  it('frozen: the Bearer kill switch halts new admissions', async () => {
    const { gate } = mkGate({ frozen: true });
    expect((await refusal(gate.admit(REQ))).reason).toBe('frozen');
  });

  it('invalid-cap: no caps record (or non-positive caps) admits nothing', async () => {
    const { gate } = mkGate({ caps: null });
    expect((await refusal(gate.admit(REQ))).reason).toBe('invalid-cap');
  });

  it('unbounded-reservation: a metered call without max_tokens is refused (A2-4)', async () => {
    const { gate } = mkGate();
    expect((await refusal(gate.admit({ ...REQ, maxOutputTokens: undefined }))).reason).toBe('unbounded-reservation');
    expect((await refusal(gate.admit({ ...REQ, maxOutputTokens: 0 }))).reason).toBe('unbounded-reservation');
  });

  it('unknown-price: no canonical point fails closed', async () => {
    const { gate } = mkGate();
    expect((await refusal(gate.admit({ ...REQ, modelId: 'no/such-model' }))).reason).toBe('unknown-price');
  });

  it('S2-2: an OBSERVED price point is never gate-eligible — unknown-price despite a valid observed point', async () => {
    seedManifest({ observedOnly: true });
    const { gate } = mkGate();
    expect((await refusal(gate.admit(REQ))).reason).toBe('unknown-price');
  });

  it('implausible-price: a canonical point below the code-defined provider floor fails closed (typo guard)', async () => {
    seedManifest({ low: true });
    const { gate } = mkGate();
    expect((await refusal(gate.admit(REQ))).reason).toBe('implausible-price');
  });

  it('stale + book-conservative-max (default): books at the conservativeMax, spend continues', async () => {
    seedManifest({ stale: true });
    const { gate } = mkGate();
    const r = await gate.admit(REQ);
    // conservativeMax: 1M @ $10/M + 100k @ $60/M = 10 + 6 = $16 (over-booked, the safe direction)
    expect(r.reserveUsd).toBeCloseTo(16, 6);
  });

  it('stale + fail-closed mode: refuses', async () => {
    seedManifest({ stale: true, staleMode: 'fail-closed' });
    const { gate } = mkGate();
    expect((await refusal(gate.admit(REQ))).reason).toBe('stale-price-fail-closed');
  });

  it('stale + conservative-max ABSENT: unknown-price (never books an unfloored guess)', async () => {
    seedManifest({ stale: true, conservativeMax: null });
    const { gate } = mkGate();
    expect((await refusal(gate.admit(REQ))).reason).toBe('unknown-price');
  });

  it('cap-exceeded (strict >): the daily cap refuses; committed-at-cap admits nothing more', async () => {
    const { gate } = mkGate({ caps: { lifetimeCapUsd: 60, dailyCapUsd: 10 } });
    const first = await gate.admit(REQ); // $8 of a $10 daily cap
    expect(first.reserveUsd).toBeCloseTo(8, 6);
    // While the first is still OUTSTANDING, settled($0) + 8 would fit: the caller
    // should retry shortly (gemini-payg §5 `reserves-outstanding`), not give up.
    const pending = await refusal(gate.admit(REQ));
    expect(pending.reason).toBe('reserves-outstanding');
    expect(pending.facts?.retryAfterSec).toBeGreaterThan(0);
    // Once it SETTLES at $8, settled 8 + 8 > 10 is a genuine cap-exceeded.
    await gate.settleActual(first.keyRef, first.reserveId, 8);
    expect((await refusal(gate.admit(REQ))).reason).toBe('cap-exceeded'); // 8 + 8 > 10
  });

  it('cap-exceeded: outstanding CONCURRENT reserves are visible to the second admit', async () => {
    const { gate } = mkGate({ caps: { lifetimeCapUsd: 12, dailyCapUsd: 12 } });
    const results = await Promise.allSettled([gate.admit(REQ), gate.admit(REQ)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(1); // $8 fits; the second $8 would breach $12
    expect(refused.length).toBe(1);
    // The second SEES the first's outstanding reserve (committed 8 + 8 > 12); since
    // settled 0 + 8 would fit, it is `reserves-outstanding` (gemini-payg §5).
    expect(((refused[0] as PromiseRejectedResult).reason as MoneyGateRefusal).reason).toBe('reserves-outstanding');
  });

  it('settle path: no-charge outcomes settle $0 and release headroom', async () => {
    const { gate, ledger } = mkGate({ caps: { lifetimeCapUsd: 10, dailyCapUsd: 10 } });
    const r = await gate.admit(REQ);
    await gate.settleNoCharge(r.keyRef, r.reserveId);
    expect(ledger.committed(r.keyRef).committedLifetimeUsd).toBe(0);
    await gate.admit(REQ); // headroom released — a fresh call admits
  });
});

describe('billedOutputTokens — the per-door billed-token mapping (erring HIGH)', () => {
  it('Gemini native: candidates + thoughts (the thinking-token trap)', () => {
    expect(billedOutputTokens('gemini-api', { candidatesTokenCount: 100, thoughtsTokenCount: 40 })).toBe(140);
    expect(billedOutputTokens('gemini-api', { candidatesTokenCount: 100 })).toBe(100);
  });
  it('Gemini OpenAI-compat: completion_tokens with the reasoning detail, MAX interpretation', () => {
    expect(billedOutputTokens('gemini-api', { completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 90 } })).toBe(120);
    expect(billedOutputTokens('gemini-api', { completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 90 } })).toBe(90);
  });
  it('OpenRouter/Groq: completion_tokens', () => {
    expect(billedOutputTokens('openrouter-api', { completion_tokens: 77 })).toBe(77);
    expect(billedOutputTokens('groq-api', { completion_tokens: 33 })).toBe(33);
  });
  it('unconfirmable basis → null (the caller settles WORST-CASE, never a lower unverified field)', () => {
    expect(billedOutputTokens('gemini-api', {})).toBeNull();
    expect(billedOutputTokens('openrouter-api', undefined)).toBeNull();
    expect(billedOutputTokens('unknown-door', { completion_tokens: 5 })).toBeNull();
    expect(billedOutputTokens('groq-api', { completion_tokens: -1 })).toBeNull();
  });
});
