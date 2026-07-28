/**
 * Unit tests (Tier 1) — Phase-3 dual-forward client (submitParityBatch + helpers).
 *
 * Covers both sides of every decision boundary against Dawn's LOCKED response shape:
 *   - all-matched batch → allMatched=true, no diverged/errored
 *   - diverged item carries divergenceReason; not_found counts as diverged
 *   - error item → errored[]; mixed batch partitions correctly
 *   - verdict keyed by feedbackId
 *   - FAIL-CLOSED: non-2xx HTTP, non-JSON body, shape drift (unknown status / missing
 *     fields / results-not-array), network throw, missing token — each THROWS
 *     ParitySubmitError (never silently treated as success)
 *   - request: correct endpoint, Bearer auth header, JSON body = the emitter payload
 */

import { describe, it, expect } from 'vitest';
import {
  submitParityBatch,
  parseParitySubmitResponse,
  verdictFromResponse,
  ParitySubmitError,
  DEFAULT_PARITY_SUBMIT_ENDPOINT,
  type ParitySubmitResponse,
} from '../../../src/feedback-factory/processor/paritySubmitClient.js';
import type { ParitySubmitRequest } from '../../../src/feedback-factory/processor/paritySubmit.js';

const REQUEST: ParitySubmitRequest = {
  batchId: 'batch-1',
  items: [
    { feedbackId: 'fb-1', action: 'merge', clusterId: 'c-1', fingerprint: 'a1b2', similarity: 0.9 },
  ],
};

/** Build a fake fetch returning a given status + body (string or object). */
function fakeFetch(status: number, body: unknown, opts: { notJson?: boolean } = {}): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.notJson) throw new Error('Unexpected token < in JSON');
        return body;
      },
    }) as unknown as Response) as unknown as typeof fetch;
}

const OK_BODY: ParitySubmitResponse = {
  batchId: 'batch-1',
  processed: 3,
  matched: 2,
  diverged: 1,
  errors: 0,
  results: [
    { feedbackId: 'fb-1', action: 'merge', status: 'matched', clusterId: 'c-1' },
    { feedbackId: 'fb-2', action: 'create', status: 'matched', clusterId: 'c-2' },
    { feedbackId: 'fb-3', action: 'merge', status: 'diverged', clusterId: 'c-1', divergenceReason: 'Fingerprint mismatch — Echo: a1.., Portal: d4..' },
  ],
};

describe('submitParityBatch — request shape', () => {
  it('POSTs to the default endpoint with Bearer auth + JSON emitter payload', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => OK_BODY } as unknown as Response;
    }) as unknown as typeof fetch;

    await submitParityBatch(REQUEST, { token: 'tok-xyz', fetchImpl });

    expect(captured.url).toBe(DEFAULT_PARITY_SUBMIT_ENDPOINT);
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-xyz');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(captured.init?.body as string)).toEqual(REQUEST);
  });

  it('honors a custom endpoint', async () => {
    let url = '';
    const fetchImpl = (async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => OK_BODY } as unknown as Response;
    }) as unknown as typeof fetch;
    await submitParityBatch(REQUEST, { token: 't', endpoint: 'https://staging.example/parity', fetchImpl });
    expect(url).toBe('https://staging.example/parity');
  });
});

describe('submitParityBatch — verdict derivation', () => {
  it('partitions matched / diverged and keys by feedbackId', async () => {
    const v = await submitParityBatch(REQUEST, { token: 't', fetchImpl: fakeFetch(200, OK_BODY) });
    expect(v.allMatched).toBe(false); // one diverged
    expect(v.diverged.map((r) => r.feedbackId)).toEqual(['fb-3']);
    expect(v.diverged[0].divergenceReason).toContain('Fingerprint mismatch');
    expect(v.errored).toEqual([]);
    expect(v.byFeedbackId.get('fb-2')?.status).toBe('matched');
    expect(v.response.processed).toBe(3);
  });

  it('allMatched=true only when every item matched', async () => {
    const body: ParitySubmitResponse = {
      batchId: 'b', processed: 2, matched: 2, diverged: 0, errors: 0,
      results: [
        { feedbackId: 'fb-1', action: 'merge', status: 'matched', clusterId: 'c-1' },
        { feedbackId: 'fb-2', action: 'create', status: 'matched', clusterId: 'c-2' },
      ],
    };
    const v = await submitParityBatch(REQUEST, { token: 't', fetchImpl: fakeFetch(200, body) });
    expect(v.allMatched).toBe(true);
    expect(v.diverged).toEqual([]);
  });

  it('treats not_found as diverged and error as errored', async () => {
    const body: ParitySubmitResponse = {
      batchId: 'b', processed: 2, matched: 0, diverged: 1, errors: 1,
      results: [
        { feedbackId: 'fb-nf', action: 'merge', status: 'not_found' },
        { feedbackId: 'fb-er', action: 'create', status: 'error', error: 'boom' },
      ],
    };
    const v = await submitParityBatch(REQUEST, { token: 't', fetchImpl: fakeFetch(200, body) });
    expect(v.allMatched).toBe(false);
    expect(v.diverged.map((r) => r.feedbackId)).toEqual(['fb-nf']);
    expect(v.errored.map((r) => r.feedbackId)).toEqual(['fb-er']);
    expect(v.errored[0].error).toBe('boom');
  });

  it('allMatched is false for an empty results array (nothing proven)', () => {
    const v = verdictFromResponse({ batchId: 'b', processed: 0, matched: 0, diverged: 0, errors: 0, results: [] });
    expect(v.allMatched).toBe(false);
  });
});

describe('submitParityBatch — FAIL-CLOSED (never silent success)', () => {
  it('throws on non-2xx HTTP', async () => {
    await expect(submitParityBatch(REQUEST, { token: 't', fetchImpl: fakeFetch(500, '') })).rejects.toMatchObject({ kind: 'http' });
    await expect(submitParityBatch(REQUEST, { token: 't', fetchImpl: fakeFetch(404, '') })).rejects.toBeInstanceOf(ParitySubmitError);
  });

  it('throws on non-JSON body', async () => {
    await expect(submitParityBatch(REQUEST, { token: 't', fetchImpl: fakeFetch(200, null, { notJson: true }) })).rejects.toMatchObject({ kind: 'parse' });
  });

  it('throws on a network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(submitParityBatch(REQUEST, { token: 't', fetchImpl })).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws on shape drift — unknown status value (contract drift)', async () => {
    const drifted = { ...OK_BODY, results: [{ feedbackId: 'fb-1', action: 'merge', status: 'PARTIALLY_OK' }] };
    await expect(submitParityBatch(REQUEST, { token: 't', fetchImpl: fakeFetch(200, drifted) })).rejects.toMatchObject({ kind: 'shape' });
  });

  it('throws on shape drift — results not an array / missing counts', () => {
    expect(() => parseParitySubmitResponse({ batchId: 'b', processed: 0, matched: 0, diverged: 0, errors: 0, results: {} })).toThrow(/results is not an array/);
    expect(() => parseParitySubmitResponse({ batchId: 'b', results: [] })).toThrow(/count/);
    expect(() => parseParitySubmitResponse('nope')).toThrow(/not an object/);
  });

  it('throws when token is missing', async () => {
    // @ts-expect-error — exercising the runtime guard
    await expect(submitParityBatch(REQUEST, { fetchImpl: fakeFetch(200, OK_BODY) })).rejects.toBeInstanceOf(ParitySubmitError);
  });
});
