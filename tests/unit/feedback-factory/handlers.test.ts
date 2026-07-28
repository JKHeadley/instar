/**
 * Unit tests (Tier 1) — framework-agnostic feedback receiver handler.
 *
 * Faithful port of the reference handleSubmit: exact status codes, error messages,
 * order, the type-default-to-'other', the non-blocking HMAC, dedup, and storage.
 * Clock + id generator injected for determinism; runs over InMemoryFeedbackStore.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { handleFeedbackSubmit } from '../../../src/feedback-factory/receiver/handlers.js';
import { RateLimiter, RATE_LIMITS } from '../../../src/feedback-factory/receiver/defense.js';
import { InMemoryFeedbackStore } from '../../../src/feedback-factory/store/FeedbackStore.js';

const NOW = 1_000_000_000_000;
const UA = { 'user-agent': 'instar/1.3.0' };
const okBody = { type: 'bug', title: 'a real title', description: 'a sufficiently long description' };

function mk(overrides: Partial<Parameters<typeof handleFeedbackSubmit>[1]> = {}) {
  const store = new InMemoryFeedbackStore();
  const rateLimiter = new RateLimiter(RATE_LIMITS, () => NOW);
  return {
    store,
    deps: { store, rateLimiter, secret: 'sec', now: NOW, generateFeedbackId: () => 'fb-generated-1', ...overrides },
  };
}

describe('handleFeedbackSubmit', () => {
  it('429 when rate-limited (Retry-After set)', async () => {
    const { deps } = mk();
    for (let i = 0; i < RATE_LIMITS.perHour; i++) deps.rateLimiter.check('1.1.1.1');
    const r = await handleFeedbackSubmit({ headers: { ...UA, 'x-forwarded-for': '1.1.1.1' }, body: okBody }, deps);
    expect(r.status).toBe(429);
    expect(r.headers?.['Retry-After']).toBeDefined();
  });

  it('400 (generic) when the agent fingerprint is missing', async () => {
    const { deps } = mk();
    const r = await handleFeedbackSubmit({ headers: { 'user-agent': 'curl/8' }, body: okBody }, deps);
    expect(r).toMatchObject({ status: 400, json: { error: 'Invalid request format' } });
  });

  it('silently 200s a honeypot hit without storing', async () => {
    const { store, deps } = mk();
    const r = await handleFeedbackSubmit({ headers: UA, body: { ...okBody, website: 'x' } }, deps);
    expect(r).toMatchObject({ status: 200, json: { id: 'fb-received', received: true } });
    expect(store.hasFeedback('fb-generated-1')).toBe(false);
  });

  it('400s with the exact reference messages for title/description', async () => {
    const { deps } = mk();
    expect((await handleFeedbackSubmit({ headers: UA, body: { ...okBody, title: 'ab' } }, deps)).json)
      .toEqual({ error: 'title is required (min 3 characters)' });
    expect((await handleFeedbackSubmit({ headers: UA, body: { ...okBody, description: 'too short' } }, deps)).json)
      .toEqual({ error: 'description is required (min 10 characters)' });
  });

  it('DEFAULTS an invalid type to "other" (does NOT reject) — the fidelity fix', async () => {
    const { store, deps } = mk();
    const r = await handleFeedbackSubmit({ headers: UA, body: { ...okBody, type: 'nonsense' } }, deps);
    expect(r.status).toBe(200);
    expect(store.getUnprocessedFeedback()[0].type).toBe('other');
  });

  it('400s on malformed agentName / instarVersion / nodeVersion', async () => {
    const { deps } = mk();
    expect((await handleFeedbackSubmit({ headers: UA, body: { ...okBody, agentName: '!!' } }, deps)).json)
      .toEqual({ error: 'Invalid agentName format' });
    expect((await handleFeedbackSubmit({ headers: UA, body: { ...okBody, instarVersion: 'x.y' } }, deps)).json)
      .toEqual({ error: 'Invalid instarVersion format (expected semver)' });
    expect((await handleFeedbackSubmit({ headers: UA, body: { ...okBody, nodeVersion: 'abc' } }, deps)).json)
      .toEqual({ error: 'Invalid nodeVersion format' });
  });

  it('stores on success, marking unverified when there is no signature', async () => {
    const { store, deps } = mk();
    const r = await handleFeedbackSubmit({ headers: UA, body: okBody }, deps);
    expect(r).toMatchObject({ status: 200, json: { id: 'fb-generated-1', received: true } });
    const stored = store.getUnprocessedFeedback()[0];
    expect(stored.feedbackId).toBe('fb-generated-1');
    expect(stored.verified).toBe(false);
  });

  it('marks verified:true with a valid HMAC signature', async () => {
    const { store, deps } = mk();
    const ts = String(NOW - 1000);
    const sig = createHmac('sha256', 'sec').update(`${ts}.${JSON.stringify(okBody)}`).digest('hex');
    await handleFeedbackSubmit({ headers: { ...UA, 'x-instar-signature': sig, 'x-instar-timestamp': ts }, body: okBody }, deps);
    expect(store.getUnprocessedFeedback()[0].verified).toBe(true);
  });

  it('honors a valid agent-provided feedbackId and is idempotent on dedup', async () => {
    const { deps } = mk();
    const body = { ...okBody, feedbackId: 'fb-abc123' };
    const first = await handleFeedbackSubmit({ headers: UA, body }, deps);
    expect(first.json).toMatchObject({ id: 'fb-abc123', received: true });
    const second = await handleFeedbackSubmit({ headers: UA, body }, deps);
    expect(second.json).toMatchObject({ id: 'fb-abc123', received: true, duplicate: true });
  });

  it('400s a non-object body', async () => {
    const { deps } = mk();
    expect((await handleFeedbackSubmit({ headers: UA, body: 'not json' }, deps)).json)
      .toEqual({ error: 'Request body must be JSON' });
  });
});
