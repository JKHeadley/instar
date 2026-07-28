/**
 * Unit tests for the OFF-by-default price-refresh prober (scripts/routing-price-refresh.mjs),
 * routing-control-room-spend FD-8. Covers the pure core: OpenRouter model-list parsing
 * (per-token → per-Mtok), the FORWARD-ONLY merge (no backdate, no same-day duplicate),
 * sane-price validation, and the S2-2 STRUCTURAL guarantee that the writer NEVER
 * references the canonical manifest file (observed-cache-only). No network.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseOpenRouterModels,
  mergeForwardOnly,
  isSanePoint,
  dayAlignedIso,
  TRACKED,
} from '../../scripts/routing-price-refresh.mjs';

const NOW = Date.parse('2026-07-05T14:00:00Z');
const TODAY = dayAlignedIso(NOW); // 2026-07-05T00:00:00.000Z

describe('parseOpenRouterModels', () => {
  it('converts per-token prices to per-Mtok for TRACKED models, day-aligned, forward-only-ready', () => {
    const payload = {
      data: [
        { id: 'openai/gpt-5.5', pricing: { prompt: '0.000005', completion: '0.00003' } },
        { id: 'anthropic/claude-opus-4-8', pricing: { prompt: '0.000005', completion: '0.000025' } },
        { id: 'some/untracked-model', pricing: { prompt: '0.000001', completion: '0.000002' } },
      ],
    };
    const pts = parseOpenRouterModels(payload, NOW);
    expect(pts.map((p) => p.modelId).sort()).toEqual(['anthropic/claude-opus-4-8', 'openai/gpt-5.5']);
    const gpt = pts.find((p) => p.modelId === 'openai/gpt-5.5')!;
    expect(gpt.inPerMtok).toBeCloseTo(5, 6);
    expect(gpt.outPerMtok).toBeCloseTo(30, 6);
    expect(gpt.effectiveAt).toBe(TODAY);
    expect(gpt.corrects).toBeNull();
    expect(gpt.source).toBe('openrouter-models-api');
  });

  it('drops a model with a non-finite price (sane-price fail-closed)', () => {
    const pts = parseOpenRouterModels({ data: [{ id: 'openai/gpt-5.5', pricing: { prompt: 'not-a-number', completion: '0.00003' } }] }, NOW);
    expect(pts).toHaveLength(0);
  });
});

describe('mergeForwardOnly', () => {
  const pt = (modelId: string, effectiveAt: string, inP = 5) => ({ door: 'openrouter-api', modelId, inPerMtok: inP, outPerMtok: 30, effectiveAt, corrects: null });

  it('adds a strictly-newer point and rejects a backdated one', () => {
    const existing = [pt('openai/gpt-5.5', '2026-07-05T00:00:00.000Z')];
    const backdated = mergeForwardOnly(existing, [pt('openai/gpt-5.5', '2026-07-01T00:00:00.000Z', 7)]);
    expect(backdated.added).toHaveLength(0); // forward-only refuses a backdate
    const forward = mergeForwardOnly(existing, [pt('openai/gpt-5.5', '2026-07-06T00:00:00.000Z', 7)]);
    expect(forward.added).toHaveLength(1);
    expect(forward.points).toHaveLength(2);
  });

  it('rejects a same-day duplicate', () => {
    const existing = [pt('openai/gpt-5.5', '2026-07-05T00:00:00.000Z')];
    const dup = mergeForwardOnly(existing, [pt('openai/gpt-5.5', '2026-07-05T00:00:00.000Z', 9)]);
    expect(dup.added).toHaveLength(0);
  });

  it('drops an insane candidate before merging', () => {
    const bad = { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: -1, outPerMtok: 30, effectiveAt: '2026-07-06T00:00:00.000Z', corrects: null };
    expect(mergeForwardOnly([], [bad]).added).toHaveLength(0);
  });
});

describe('isSanePoint', () => {
  it('requires day-alignment and non-negative ranges with cached<=input', () => {
    const base = { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-05T00:00:00.000Z' };
    expect(isSanePoint(base)).toBe(true);
    expect(isSanePoint({ ...base, effectiveAt: '2026-07-05T06:00:00.000Z' })).toBe(false);
    expect(isSanePoint({ ...base, cachedInPerMtok: 6 })).toBe(false);
    expect(isSanePoint({ ...base, cachedInPerMtok: 0.5 })).toBe(true);
  });
});

describe('S2-2 — the prober writer never references the canonical manifest', () => {
  it('the prober source never names routing-prices.manifest.json (observed-cache-only)', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'routing-price-refresh.mjs'),
      'utf-8',
    );
    expect(src).not.toContain('routing-prices.manifest.json');
    expect(src).toContain('routing-prices.observed.json');
  });

  it('tracks the three metered doors', () => {
    expect(Object.keys(TRACKED).sort()).toEqual(['gemini-api', 'groq-api', 'openrouter-api']);
  });
});
