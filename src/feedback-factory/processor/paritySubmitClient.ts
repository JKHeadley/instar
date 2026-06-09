/**
 * paritySubmitClient.ts — Phase-3 dual-forward HTTP client.
 *
 * POSTs the emitter payload (buildParitySubmitPayload) to the Portal's
 * `POST /api/instar/feedback-factory/parity-submit` and parses the LOCKED
 * response shape Dawn deployed 2026-06-08:
 *
 *   { batchId, processed, matched, diverged, errors,
 *     results: [{ feedbackId, action, status, clusterId?, divergenceReason?, error? }] }
 *
 * `status` is the per-item branch predicate (Dawn: "the status field is the branch
 * predicate") — matched | diverged | not_found | error. The verdict is derived from
 * results[] (authoritative per-item), keyed by feedbackId; top-level counts are
 * surfaced for reporting.
 *
 * FAIL-CLOSED (no-silent-degradation standard): a non-2xx response, non-JSON body,
 * or a body that does not match the locked shape THROWS — the dual-forward
 * orchestration must never silently treat a failed/garbled submit as "matched/done".
 * Auth: Bearer <INSTAR_ECHO_READ_TOKEN> (Portal also accepts X-Internal-Key).
 */

import type { ParitySubmitRequest } from './paritySubmit.js';

export const DEFAULT_PARITY_SUBMIT_ENDPOINT =
  'https://dawn.bot-me.ai/api/instar/feedback-factory/parity-submit';

/** Per-item outcome status (Dawn-locked). */
export type ParityItemStatus = 'matched' | 'diverged' | 'not_found' | 'error';

const VALID_STATUSES: ReadonlySet<string> = new Set<ParityItemStatus>([
  'matched',
  'diverged',
  'not_found',
  'error',
]);

/** One result row (Dawn-locked). */
export interface ParitySubmitResultItem {
  feedbackId: string;
  action: 'merge' | 'create';
  status: ParityItemStatus;
  clusterId?: string;
  /** Present when status='diverged': "Fingerprint mismatch — Echo: …, Portal: …". */
  divergenceReason?: string;
  /** Present when status='error': the unexpected-failure message. */
  error?: string;
}

/** The full parity-submit response body (Dawn-locked). */
export interface ParitySubmitResponse {
  batchId: string;
  processed: number;
  matched: number;
  diverged: number;
  errors: number;
  results: ParitySubmitResultItem[];
}

/** Derived verdict — branch on this, keyed by feedbackId. */
export interface ParitySubmitVerdict {
  response: ParitySubmitResponse;
  /** True iff EVERY result is status='matched' (the clean done-state). */
  allMatched: boolean;
  /** Items needing attention: status 'diverged' or 'not_found' (carry divergenceReason). */
  diverged: ParitySubmitResultItem[];
  /** Items that hit an unexpected Portal-side failure (status='error'). */
  errored: ParitySubmitResultItem[];
  /** Every result keyed by feedbackId for O(1) lookup. */
  byFeedbackId: Map<string, ParitySubmitResultItem>;
}

export interface SubmitParityOptions {
  /** INSTAR_ECHO_READ_TOKEN — sent as `Authorization: Bearer <token>`. Required. */
  token: string;
  /** Override the endpoint (default = the Portal production path). */
  endpoint?: string;
  /** Inject a fetch implementation (for tests / non-global-fetch runtimes). */
  fetchImpl?: typeof fetch;
  /** Abort the request after this many ms (default 30s). */
  timeoutMs?: number;
}

/** Thrown on any fail-closed condition (HTTP error, non-JSON, shape drift). */
export class ParitySubmitError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'network' | 'parse' | 'shape',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ParitySubmitError';
  }
}

function assert(cond: unknown, kind: ParitySubmitError['kind'], message: string, detail?: unknown): asserts cond {
  if (!cond) throw new ParitySubmitError(message, kind, detail);
}

/** Validate a parsed body against the locked shape; throws ParitySubmitError('shape') on drift. */
export function parseParitySubmitResponse(data: unknown): ParitySubmitResponse {
  assert(data && typeof data === 'object', 'shape', 'parity-submit: response is not an object', data);
  const d = data as Record<string, unknown>;
  assert(typeof d.batchId === 'string', 'shape', 'parity-submit: missing/invalid batchId');
  for (const k of ['processed', 'matched', 'diverged', 'errors'] as const) {
    assert(typeof d[k] === 'number', 'shape', `parity-submit: missing/invalid count "${k}"`);
  }
  assert(Array.isArray(d.results), 'shape', 'parity-submit: results is not an array');
  const results: ParitySubmitResultItem[] = (d.results as unknown[]).map((r, i) => {
    assert(r && typeof r === 'object', 'shape', `parity-submit: results[${i}] is not an object`);
    const row = r as Record<string, unknown>;
    assert(typeof row.feedbackId === 'string', 'shape', `parity-submit: results[${i}].feedbackId missing`);
    assert(row.action === 'merge' || row.action === 'create', 'shape', `parity-submit: results[${i}].action invalid (${String(row.action)})`);
    assert(typeof row.status === 'string' && VALID_STATUSES.has(row.status), 'shape', `parity-submit: results[${i}].status unrecognized (${String(row.status)}) — contract drift`);
    const item: ParitySubmitResultItem = {
      feedbackId: row.feedbackId as string,
      action: row.action as 'merge' | 'create',
      status: row.status as ParityItemStatus,
    };
    if (typeof row.clusterId === 'string') item.clusterId = row.clusterId;
    if (typeof row.divergenceReason === 'string') item.divergenceReason = row.divergenceReason;
    if (typeof row.error === 'string') item.error = row.error;
    return item;
  });
  return {
    batchId: d.batchId as string,
    processed: d.processed as number,
    matched: d.matched as number,
    diverged: d.diverged as number,
    errors: d.errors as number,
    results,
  };
}

/** Build the derived verdict from a validated response (per-item status is authoritative). */
export function verdictFromResponse(response: ParitySubmitResponse): ParitySubmitVerdict {
  const byFeedbackId = new Map<string, ParitySubmitResultItem>();
  const diverged: ParitySubmitResultItem[] = [];
  const errored: ParitySubmitResultItem[] = [];
  for (const r of response.results) {
    byFeedbackId.set(r.feedbackId, r);
    if (r.status === 'diverged' || r.status === 'not_found') diverged.push(r);
    else if (r.status === 'error') errored.push(r);
  }
  const allMatched =
    response.results.length > 0 && response.results.every((r) => r.status === 'matched');
  return { response, allMatched, diverged, errored, byFeedbackId };
}

/**
 * POST a parity-submit batch and return the derived verdict.
 *
 * @throws ParitySubmitError — fail-closed on HTTP error / network failure / non-JSON /
 *         shape drift. The caller decides retry/escalate; a failed submit is NEVER
 *         silently treated as success.
 */
export async function submitParityBatch(
  payload: ParitySubmitRequest,
  opts: SubmitParityOptions,
): Promise<ParitySubmitVerdict> {
  assert(opts && typeof opts.token === 'string' && opts.token.length > 0, 'http', 'submitParityBatch: opts.token (INSTAR_ECHO_READ_TOKEN) is required');
  assert(payload && typeof payload.batchId === 'string' && payload.batchId.length > 0, 'shape', 'submitParityBatch: payload.batchId is required');
  const endpoint = opts.endpoint ?? DEFAULT_PARITY_SUBMIT_ENDPOINT;
  const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  assert(typeof f === 'function', 'network', 'submitParityBatch: no fetch implementation available');
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await f(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ParitySubmitError(`parity-submit network error: ${(err as Error).message}`, 'network', err);
  } finally {
    clearTimeout(timer);
  }

  assert(res.ok, 'http', `parity-submit returned HTTP ${res.status}`, res.status);

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new ParitySubmitError(`parity-submit: response was not valid JSON: ${(err as Error).message}`, 'parse', err);
  }

  return verdictFromResponse(parseParitySubmitResponse(data));
}
