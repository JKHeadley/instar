// node --test metered-funnel.test.mjs — gate logic, both sides of every boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateCheck, settleCost, MODEL_LIST_URLS } from './metered-funnel.mjs';

test('every call provider has a paired model-list endpoint (catalog scanner coverage)', () => {
  // The `models` command (catalog scanner read path) must cover every provider
  // the `call` command supports — a provider without a list endpoint would
  // silently fall out of the recurring new-model scan.
  for (const provider of ['openrouter', 'openai', 'groq', 'deepinfra', 'anthropic']) {
    assert.ok(MODEL_LIST_URLS[provider]?.url?.startsWith('https://'), `missing model-list endpoint for ${provider}`);
  }
});

const PRICE = { inPerMtok: 1.0, outPerMtok: 5.0 };
const CAPS = { lifetimeCapUsd: 5, dailyCapUsd: 2, frozen: false, provider: 'openrouter' };
const SPENT0 = { lifetimeUsd: 0, dailyUsd: 0 };
const CALL = { maxTokens: 256, promptTokensEst: 1000 };
// est = 1000/1e6*1 + 256/1e6*5 = 0.00228

test('allows a normal call under budget', () => {
  const v = gateCheck({ caps: CAPS, spent: SPENT0, price: PRICE, ...CALL });
  assert.equal(v.allow, true);
  assert.ok(v.estCostUsd > 0.002 && v.estCostUsd < 0.003);
});

test('refuses at exactly the lifetime cap boundary', () => {
  const v = gateCheck({ caps: CAPS, spent: { lifetimeUsd: 5 - 0.001, dailyUsd: 0 }, price: PRICE, ...CALL });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'lifetime-cap');
});

test('allows just under the lifetime cap', () => {
  const v = gateCheck({ caps: CAPS, spent: { lifetimeUsd: 5 - 0.01, dailyUsd: 0 }, price: PRICE, ...CALL });
  assert.equal(v.allow, true);
});

test('refuses at the daily cap even with lifetime headroom', () => {
  const v = gateCheck({ caps: CAPS, spent: { lifetimeUsd: 0, dailyUsd: 2 - 0.001 }, price: PRICE, ...CALL });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'daily-cap');
});

test('refuses frozen key (kill switch)', () => {
  const v = gateCheck({ caps: { ...CAPS, frozen: true }, spent: SPENT0, price: PRICE, ...CALL });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'frozen');
});

test('refuses unknown price — never assumes cheap', () => {
  const v = gateCheck({ caps: CAPS, spent: SPENT0, price: undefined, ...CALL });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'unknown-price');
});

test('refuses partial price object', () => {
  const v = gateCheck({ caps: CAPS, spent: SPENT0, price: { inPerMtok: 1 }, ...CALL });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'unknown-price');
});

test('refuses missing caps entry (key not in caps file)', () => {
  const v = gateCheck({ caps: undefined, spent: SPENT0, price: PRICE, ...CALL });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'no-caps-configured');
});

test('refuses zero/negative/NaN caps', () => {
  for (const bad of [0, -1, NaN, 'x']) {
    const v = gateCheck({ caps: { ...CAPS, lifetimeCapUsd: bad }, spent: SPENT0, price: PRICE, ...CALL });
    assert.equal(v.allow, false, `lifetimeCapUsd=${bad}`);
  }
});

test('refuses unreadable ledger (fail closed)', () => {
  const v = gateCheck({ caps: CAPS, spent: null, price: PRICE, ...CALL });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'ledger-unreadable');
});

test('refuses invalid max-tokens and prompt estimate', () => {
  assert.equal(gateCheck({ caps: CAPS, spent: SPENT0, price: PRICE, maxTokens: 0, promptTokensEst: 10 }).allow, false);
  assert.equal(gateCheck({ caps: CAPS, spent: SPENT0, price: PRICE, maxTokens: 100, promptTokensEst: -1 }).allow, false);
  assert.equal(gateCheck({ caps: CAPS, spent: SPENT0, price: PRICE, maxTokens: 100, promptTokensEst: NaN }).allow, false);
});

test('settleCost uses actual usage when parseable (openai shape)', () => {
  const s = settleCost({ usage: { prompt_tokens: 1000, completion_tokens: 100 }, price: PRICE, estCostUsd: 0.5 });
  assert.equal(s.basis, 'actual');
  assert.ok(Math.abs(s.costUsd - (0.001 + 0.0005)) < 1e-9);
});

test('settleCost uses actual usage when parseable (anthropic shape)', () => {
  const s = settleCost({ usage: { input_tokens: 500, output_tokens: 50 }, price: PRICE, estCostUsd: 0.5 });
  assert.equal(s.basis, 'actual');
  assert.equal(s.tokensIn, 500);
});

test('settleCost books WORST CASE on unparseable usage', () => {
  for (const usage of [undefined, {}, { prompt_tokens: 'x' }, { prompt_tokens: -5, completion_tokens: 1 }]) {
    const s = settleCost({ usage, price: PRICE, estCostUsd: 0.123 });
    assert.equal(s.basis, 'worst-case-estimate', JSON.stringify(usage));
    assert.equal(s.costUsd, 0.123);
  }
});
