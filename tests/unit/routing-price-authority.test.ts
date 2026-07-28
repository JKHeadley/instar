/**
 * Unit tests for the reporting price authority (src/core/routingPriceAuthority.ts),
 * Layer 1 + 1b of routing-control-room-spend. Covers the as-of join (correction
 * supersede), key canonicalization, fail-closed validation (invalid points dropped),
 * UTC day-alignment, the cached-rate cost formula, subsidy REPORTING math, freshness /
 * stale, the doorClass subscription-$0 default, the metered no-matching-point (loud,
 * never $0), and the active-credit window. Read-only — asserts it never writes.
 */
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  RoutingPriceAuthority,
  canonicalModelId,
  isValidPricePoint,
  dayAlignedIso,
} from '../../src/core/routingPriceAuthority.js';

let projectDir: string;
let stateDir: string;

function writeManifest(points: unknown[], doors: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'scripts', 'routing-prices.manifest.json'),
    JSON.stringify({ schemaVersion: 1, version: 1, doors, points }),
  );
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-proj-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-state-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/routing-price-authority.test.ts' });
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/routing-price-authority.test.ts' });
});

const july = (day: string) => Date.parse(`2026-07-${day}T12:00:00Z`);

describe('canonicalModelId + isValidPricePoint + dayAlignedIso', () => {
  it('canonicalises to lowercase/trim', () => {
    expect(canonicalModelId('  OpenAI/GPT-5.5 ')).toBe('openai/gpt-5.5');
  });
  it('day-aligns to a UTC day boundary', () => {
    expect(dayAlignedIso(Date.parse('2026-07-03T18:30:00Z'))).toBe('2026-07-03T00:00:00.000Z');
  });
  it('rejects a non-day-aligned effectiveAt (FD-18)', () => {
    expect(isValidPricePoint({ door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T06:00:00.000Z' })).toBe(false);
  });
  it('rejects negative and cached>input prices (fail-closed)', () => {
    const base = { door: 'openrouter-api', modelId: 'openai/gpt-5.5', effectiveAt: '2026-07-01T00:00:00.000Z' };
    expect(isValidPricePoint({ ...base, inPerMtok: -1, outPerMtok: 30 })).toBe(false);
    expect(isValidPricePoint({ ...base, inPerMtok: 5, outPerMtok: 30, cachedInPerMtok: 6 })).toBe(false);
    expect(isValidPricePoint({ ...base, inPerMtok: 5, outPerMtok: 30, cachedInPerMtok: 0.5 })).toBe(true);
  });
});

describe('RoutingPriceAuthority as-of join', () => {
  it('picks the greatest effectiveAt <= ts and a corrects row supersedes on a tie', () => {
    writeManifest([
      { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T00:00:00.000Z', recordedAt: '2026-07-01T00:00:00.000Z' },
      { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 7, outPerMtok: 40, effectiveAt: '2026-07-03T00:00:00.000Z', recordedAt: '2026-07-03T00:00:00.000Z' },
      // a correction with the SAME effectiveAt but later recordedAt supersedes.
      { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 6, outPerMtok: 35, effectiveAt: '2026-07-03T00:00:00.000Z', recordedAt: '2026-07-04T00:00:00.000Z', corrects: 'prev' },
    ]);
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    expect(pa.resolve('openrouter-api', 'openai/gpt-5.5', july('02')).point?.inPerMtok).toBe(5);
    // On/after Jul 3 the corrected row wins (tie broken by recordedAt).
    expect(pa.resolve('openrouter-api', 'openai/gpt-5.5', july('05')).point?.inPerMtok).toBe(6);
  });

  it('canonicalises the recorded model to the manifest key (round-trip)', () => {
    writeManifest([{ door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T00:00:00.000Z' }]);
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    // A differently-cased recorded model still resolves.
    expect(pa.resolve('openrouter-api', 'OpenAI/GPT-5.5', july('05')).priceBasis).toBe('canonical');
  });

  it('drops an invalid manifest point (fail-closed) → metered no-matching-point, never $0', () => {
    writeManifest([{ door: 'groq-api', modelId: 'openai/gpt-oss-120b', inPerMtok: -5, outPerMtok: 1, effectiveAt: '2026-07-01T00:00:00.000Z' }]);
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    const res = pa.resolve('groq-api', 'openai/gpt-oss-120b', july('05'));
    expect(res.priceBasis).toBe('no-matching-point');
    const cost = pa.reportingCost(res, 1_000_000, 1_000_000, 0);
    expect(cost.grossUsd).toBe(0);
    expect(cost.unpricedTokensIn).toBe(1_000_000);
    expect(cost.unpricedTokensOut).toBe(1_000_000);
  });

  it('a CLI/subscription door is honestly $0-per-token (doorClass default)', () => {
    writeManifest([]);
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    const res = pa.resolve('claude-code', 'claude-sonnet-4-6', july('05'));
    expect(res.priceBasis).toBe('subscription-zero');
    expect(pa.reportingCost(res, 5_000_000, 5_000_000, 0).grossUsd).toBe(0);
  });
});

describe('cost formula (C2-4) + subsidy (Layer 1b, reporting-only)', () => {
  it('applies the cached rate when present, else bills cached as full input (FD-19)', () => {
    writeManifest([
      { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, cachedInPerMtok: 0.5, effectiveAt: '2026-07-01T00:00:00.000Z' },
      { door: 'openrouter-api', modelId: 'anthropic/claude-opus-4-8', inPerMtok: 5, outPerMtok: 25, effectiveAt: '2026-07-01T00:00:00.000Z' },
    ]);
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    // 1M in (of which 200k cached) + 1M out. gpt-5.5: (0.8*5)+(0.2*0.5)+(1*30) = 4 + 0.1 + 30 = 34.1
    const r1 = pa.resolve('openrouter-api', 'openai/gpt-5.5', july('05'));
    expect(pa.reportingCost(r1, 1_000_000, 1_000_000, 200_000).grossUsd).toBeCloseTo(34.1, 6);
    // opus: no cached rate → cached billed as full input. (1*5)+(1*25) = 30
    const r2 = pa.resolve('openrouter-api', 'anthropic/claude-opus-4-8', july('05'));
    expect(pa.reportingCost(r2, 1_000_000, 1_000_000, 200_000).grossUsd).toBeCloseTo(30, 6);
  });

  it('applies a discount-frac subsidy in reporting only', () => {
    writeManifest([{ door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T00:00:00.000Z', subsidy: { kind: 'discount-frac', value: 0.5 } }]);
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    const res = pa.resolve('openrouter-api', 'openai/gpt-5.5', july('05'));
    const cost = pa.reportingCost(res, 1_000_000, 1_000_000, 0); // gross = 5+30 = 35
    expect(cost.grossUsd).toBeCloseTo(35, 6);
    expect(cost.subsidyUsd).toBeCloseTo(17.5, 6);
    expect(cost.netOfSubsidyUsd).toBeCloseTo(17.5, 6);
  });
});

describe('freshness / stale + credits', () => {
  it('flags priceStale when the newest canonical point is older than the door SLA', () => {
    // effectiveAt way in the past; SLA 45d default. now = today (real clock).
    writeManifest([{ door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2020-01-01T00:00:00.000Z' }]);
    const pa = new RoutingPriceAuthority({ projectDir, stateDir, now: () => Date.parse('2026-07-05T00:00:00Z') });
    expect(pa.resolve('openrouter-api', 'openai/gpt-5.5', Date.parse('2026-07-05T00:00:00Z')).priceStale).toBe(true);
  });

  it('sums only active (non-expired) credits for a key', () => {
    writeManifest([]);
    fs.writeFileSync(path.join(stateDir, 'routing-credits.json'), JSON.stringify({
      credits: [
        { keyRef: 'metered_openrouter_bench', amountUsd: 10, grantedAt: '2026-07-01T00:00:00Z', expiresAt: '2026-07-31T00:00:00Z' },
        { keyRef: 'metered_openrouter_bench', amountUsd: 5, grantedAt: '2026-06-01T00:00:00Z', expiresAt: '2026-06-30T00:00:00Z' }, // expired
      ],
    }));
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    expect(pa.activeCreditUsd('metered_openrouter_bench', july('05'))).toBe(10);
  });

  it('rejects a credit with no expiry (REQUIRED)', () => {
    writeManifest([]);
    fs.writeFileSync(path.join(stateDir, 'routing-credits.json'), JSON.stringify({
      credits: [{ keyRef: 'metered_groq_bench', amountUsd: 10, grantedAt: '2026-07-01T00:00:00Z' }],
    }));
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    expect(pa.activeCreditUsd('metered_groq_bench', july('05'))).toBe(0);
  });
});

describe('read-only', () => {
  it('writes nothing to the project or state dirs', () => {
    writeManifest([{ door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T00:00:00.000Z' }]);
    const before = fs.readdirSync(stateDir).sort();
    const pa = new RoutingPriceAuthority({ projectDir, stateDir });
    pa.resolve('openrouter-api', 'openai/gpt-5.5', july('05'));
    pa.reloadIfChanged();
    expect(fs.readdirSync(stateDir).sort()).toEqual(before);
  });
});
