/**
 * Unit tests (Tier 1) — framework-agnostic dispatch request handlers.
 *
 * Faithful port of handleList + handleCreate: exact auth, status codes, messages,
 * the version-compat filter, and create-dedup. Clock + id injected for determinism.
 */

import { describe, it, expect } from 'vitest';
import { handleDispatchList, handleDispatchCreate } from '../../../src/feedback-factory/dispatch/handlers.js';
import { InMemoryFeedbackStore } from '../../../src/feedback-factory/store/FeedbackStore.js';

const NOW = 1_700_000_000_000;
const KEY = 'internal-key';
const UA = { 'user-agent': 'instar/1.3.0' };

function freshStore() {
  const store = new InMemoryFeedbackStore();
  return store;
}
const create = (store: InMemoryFeedbackStore, body: Record<string, unknown>, id: string) =>
  handleDispatchCreate({ headers: { 'x-internal-key': KEY }, body }, { store, internalKey: KEY, now: NOW, generateDispatchId: () => id });

describe('handleDispatchList', () => {
  it('400s when the agent fingerprint (instar/ UA) is missing', () => {
    const r = handleDispatchList({ headers: { 'user-agent': 'curl/8' }, query: {} }, { store: freshStore(), now: NOW });
    expect(r).toMatchObject({ status: 400, json: { error: 'Invalid request format' } });
  });

  it('lists active dispatches with count + asOf', () => {
    const store = freshStore();
    create(store, { type: 'lesson', title: 'a lesson title', content: 'a sufficiently long body' }, 'dsp-1');
    const r = handleDispatchList({ headers: UA, query: {} }, { store, now: NOW });
    expect(r.status).toBe(200);
    expect((r.json as any).count).toBe(1);
    expect((r.json as any).asOf).toBe(new Date(NOW).toISOString());
  });

  it('applies the version-compat filter (a min-version dispatch is hidden from older agents)', () => {
    const store = freshStore();
    create(store, { type: 'lesson', title: 'needs v1.4.0+', content: 'only for new agents', minVersion: '1.4.0' }, 'dsp-min');
    const newAgent = handleDispatchList({ headers: { 'user-agent': 'instar/1.4.0', 'x-instar-version': '1.4.0' }, query: {} }, { store, now: NOW });
    const oldAgent = handleDispatchList({ headers: { 'user-agent': 'instar/1.3.0', 'x-instar-version': '1.3.0' }, query: {} }, { store, now: NOW });
    expect((newAgent.json as any).count).toBe(1);
    expect((oldAgent.json as any).count).toBe(0);
  });

  it('filters by type', () => {
    const store = freshStore();
    create(store, { type: 'lesson', title: 'lesson one', content: 'body body body' }, 'd1');
    create(store, { type: 'security', title: 'security one', content: 'body body body' }, 'd2');
    const r = handleDispatchList({ headers: UA, query: { type: 'security' } }, { store, now: NOW });
    expect((r.json as any).dispatches.map((d: any) => d.dispatchId)).toEqual(['d2']);
  });
});

describe('handleDispatchCreate', () => {
  it('401 without the internal key', () => {
    const r = handleDispatchCreate({ headers: {}, body: {} }, { store: freshStore(), internalKey: KEY, now: NOW });
    expect(r).toMatchObject({ status: 401, json: { error: 'Authentication required' } });
  });

  it('accepts Bearer form of the internal key', () => {
    const store = freshStore();
    const r = handleDispatchCreate(
      { headers: { authorization: `Bearer ${KEY}` }, body: { type: 'lesson', title: 'ok title', content: 'long enough body' } },
      { store, internalKey: KEY, now: NOW, generateDispatchId: () => 'dsp-x' },
    );
    expect(r.status).toBe(201);
  });

  it('validates title/content/type/version with exact messages', () => {
    const store = freshStore();
    const hk = (body: Record<string, unknown>) => handleDispatchCreate({ headers: { 'x-internal-key': KEY }, body }, { store, internalKey: KEY, now: NOW });
    expect(hk({ type: 'lesson', title: 'ab', content: 'long enough body' }).json).toEqual({ error: 'title is required (min 3 characters)' });
    expect(hk({ type: 'lesson', title: 'ok title', content: 'short' }).json).toEqual({ error: 'content is required (min 10 characters)' });
    expect((hk({ type: 'nope', title: 'ok title', content: 'long enough body' }).json as any).error).toContain('type must be one of:');
    expect(hk({ type: 'lesson', title: 'ok title', content: 'long enough body', minVersion: 'x.y' }).json).toEqual({ error: 'minVersion must be valid semver' });
  });

  it('creates (201) then dedups by title (200 duplicate)', () => {
    const store = freshStore();
    const body = { type: 'lesson', title: 'dedup me', content: 'long enough body here' };
    const first = create(store, body, 'dsp-a');
    expect(first).toMatchObject({ status: 201, json: { dispatchId: 'dsp-a', created: true } });
    const second = create(store, body, 'dsp-b');
    expect(second).toMatchObject({ status: 200, json: { dispatchId: 'dsp-a', created: false, duplicate: true } });
  });
});
