/**
 * The pairing outcome notice's delivery adapter (docs/specs/mobile-pairing-outcome-notice.md §3.4).
 *
 * Turns the ordinary automation reply path's answers into the watch store's outcome classes, reads
 * an outbox operation's outcome, and raises the per-topic attention item. Pure classification
 * (`classifyReplyAnswer`, `classifyOperationOutcome`) is exported for tests.
 */

import { PAIRING_OUTCOME_PRODUCER } from '../core/PairingOutcomeText.js';
import type { OperationResult, SendResult } from '../core/PairingOutcomeWatches.js';

export const PAIRING_OUTCOME_SEND_TIMEOUT_MS = 15_000;

/** Post one automation reply (the route answer is returned as-is). */
export type AutomationPost = (topicId: number, body: Record<string, unknown>, logicalSendId: string,
  opts: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** §3.4 answer table. `status` + parsed JSON body (null when unparseable). */
export function classifyReplyAnswer(status: number, body: Record<string, unknown> | null): SendResult {
  const b = body ?? {};
  if (status >= 200 && status < 300) {
    if (b.suppressedDuplicate === true) return { kind: 'sent' };
    if (b.recorded === true && b.delivered === false) return { kind: 'quiet' };
    return { kind: 'sent' };
  }
  const error = typeof b.error === 'string' ? b.error : `http-${status}`;
  if (error === 'telegram-origin-held') {
    if (b.delivered === true) return { kind: 'sent' };
    if (b.reason === 'notification-server-unavailable') return { kind: 'retry', error: 'notification-server-unavailable' };
    if (typeof b.operationId === 'string' && b.operationId) return { kind: 'handed-off', operationId: b.operationId };
    return { kind: 'failed', error: `held: ${typeof b.reason === 'string' ? b.reason : 'refused'}` };
  }
  if (error === 'content-dedup-unavailable' || error === 'duplicate-suppression-unrecorded') return { kind: 'retry', error };
  if (status === 409 && (error === 'standing-down' || b.standingDown === true)) return { kind: 'retry', error: 'standing-down' };
  if (status === 429 || status >= 500) {
    if (status === 503 && /not configured/i.test(error)) return { kind: 'failed', error };
    return { kind: 'retry', error };
  }
  return { kind: 'failed', error };
}

/** Map `GET /telegram/origins/operations/:id/outcome` to the watch store's result. */
export function classifyOperationOutcome(body: Record<string, unknown> | null): OperationResult {
  const outcome = body?.outcome;
  if (outcome === 'delivered' || outcome === 'partially-delivered') return 'delivered';
  if (outcome === 'not-delivered') return body?.reason === 'quiet-notification-recorded' ? 'quiet' : 'failed';
  return 'unknown';
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try { const j = await res.json(); return j && typeof j === 'object' ? j as Record<string, unknown> : null; } catch { return null; } // @silent-fallback-ok — an unparseable body is classified by its status alone
}

export interface PairingOutcomeNoticeDeps {
  post: AutomationPost;
  port: number;
  authToken: string;
  available: () => boolean;
  recentOperatorInbound: (topicId: number, withinMs: number) => string | null;
  upsertAttention: (item: { id: string; title: string; summary: string; topicId: number }) => Promise<unknown>;
  fetchFn?: typeof fetch;
}

/** The `outcomeNotice` dependency `MobilePairingService` takes. */
export function createPairingOutcomeNotice(deps: PairingOutcomeNoticeDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  return {
    available: deps.available,
    recentOperatorInbound: deps.recentOperatorInbound,
    async send(topicId: number, text: string, logicalSendId: string, anchorInboundId: string | null): Promise<SendResult> {
      const body: Record<string, unknown> = {
        text,
        metadata: { source: PAIRING_OUTCOME_PRODUCER, ...(anchorInboundId ? { inboundMessageId: anchorInboundId } : {}) },
      };
      let res: Response;
      try {
        res = await deps.post(topicId, body, logicalSendId, {
          headers: { 'X-Instar-System': 'true' }, signal: AbortSignal.timeout(PAIRING_OUTCOME_SEND_TIMEOUT_MS),
        });
      } catch (err) {
        const name = err instanceof Error ? err.constructor.name : '';
        const reason = (err as { reason?: unknown })?.reason;
        // A refusal raised before any request (e.g. automation-credential-capacity) is transient.
        if (name === 'TelegramOriginHoldError') return { kind: 'retry', error: `held: ${String(reason ?? 'before-request')}` };
        return { kind: 'retry', error: err instanceof Error ? err.message : String(err) };
      }
      return classifyReplyAnswer(res.status, await readJson(res));
    },
    async checkOperation(operationId: string): Promise<OperationResult> {
      try {
        const res = await fetchFn(`http://localhost:${deps.port}/telegram/origins/operations/${encodeURIComponent(operationId)}/outcome`, {
          headers: { Authorization: `Bearer ${deps.authToken}` }, signal: AbortSignal.timeout(PAIRING_OUTCOME_SEND_TIMEOUT_MS), redirect: 'error',
        });
        return classifyOperationOutcome(await readJson(res));
      } catch {
        return 'unknown'; // @silent-fallback-ok — an unreadable outcome keeps the entry handed-off until its deadline
      }
    },
    async escalate(topicId: number, lines: string[]): Promise<boolean> {
      try {
        await deps.upsertAttention({
          id: `mobile-pairing-outcome:${topicId}`,
          title: 'A phone pairing result could not be posted',
          summary: lines.join('\n'),
          topicId,
        });
        return true;
      } catch {
        return false; // @silent-fallback-ok — the watch store retries the upsert with backoff and reports a degradation
      }
    },
  };
}
