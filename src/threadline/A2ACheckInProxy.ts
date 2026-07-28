/**
 * A2ACheckInProxy — Layer 4 orchestration (THREADLINE-A2A-COHERENCE-SPEC).
 *
 * Composes the decision (A2ACheckInPolicy) + the summarizer (A2ACheckInSummarizer) into one
 * flow, with dependencies INJECTED so it is testable without the server and decoupled from the
 * exact runtime wiring:
 *
 *   decideCheckIn → (salience|heartbeat) → getHistory → buildSummaryPrompt → summarize (LLM on
 *   the shared queue's BACKGROUND lane) → guardSummary → surface (to the bound topic, else hub).
 *
 * 'none' short-circuits before any LLM spend. A guard failure drops the check-in (never surfaces
 * an unsafe summary). The server provides the real deps:
 *   - summarize  → llmQueue.enqueue('background', signal => intelligence.evaluate(prompt, {signal}))
 *   - surface    → post to the bound Telegram topic, or CollaborationSurfacer.notify for the hub
 *   - getHistory → ConversationStore / buildHistoryContext for the thread
 * and the cadence (a jittered timer per active a2a thread) calls runCheckIn().
 */

import { decideCheckIn } from './A2ACheckInPolicy.js';
import { buildSummaryPrompt, guardSummary, type SummaryKind } from './A2ACheckInSummarizer.js';

export interface CheckInDeps {
  /** Run the summarizer prompt through the LLM (server wires this to the BACKGROUND LlmQueue lane). */
  summarize: (prompt: string) => Promise<string>;
  /** Deliver the check-in to the operator — the bound topic when topicId is set, else the hub. */
  surface: (args: {
    threadId: string;
    topicId?: number;
    peerName: string;
    body: string;
    kind: SummaryKind;
  }) => Promise<void>;
  /** Recent conversation text for the thread (raw; the summarizer redacts + frames it). */
  getHistory: (threadId: string) => Promise<string> | string;
}

export interface CheckInRequest {
  threadId: string;
  peerName: string;
  /** Bound Telegram topic, if any. Absent → routed to the hub by the surface dep. */
  topicId?: number;
  conversationActive: boolean;
  hasSalientEvent: boolean;
  /** Epoch ms of the last surface to the operator for this thread (0 if never). */
  lastSurfaceAt: number;
  now: number;
  heartbeatIntervalMs: number;
  heartbeatEnabled: boolean;
}

export interface CheckInOutcome {
  surfaced: boolean;
  kind: 'salience' | 'heartbeat' | 'none';
  reason: string;
}

/**
 * Decide → summarize → guard → surface. Never throws to the caller for an ordinary skip;
 * a dep that throws propagates (the cadence loop wraps this and continues).
 */
export async function runCheckIn(req: CheckInRequest, deps: CheckInDeps): Promise<CheckInOutcome> {
  const decision = decideCheckIn({
    conversationActive: req.conversationActive,
    hasSalientEvent: req.hasSalientEvent,
    lastSurfaceAt: req.lastSurfaceAt,
    now: req.now,
    heartbeatIntervalMs: req.heartbeatIntervalMs,
    heartbeatEnabled: req.heartbeatEnabled,
  });

  if (decision.kind === 'none') {
    return { surfaced: false, kind: 'none', reason: decision.reason };
  }

  const history = String(await deps.getHistory(req.threadId));
  const prompt = buildSummaryPrompt({ peerName: req.peerName, historyText: history, kind: decision.kind });
  const raw = await deps.summarize(prompt);

  const guard = guardSummary(raw);
  if (!guard.safe) {
    // Drop the check-in: never surface an unsafe summary. (Caller may log guard.reason.)
    return { surfaced: false, kind: decision.kind, reason: `guard-blocked: ${guard.reason}` };
  }

  await deps.surface({
    threadId: req.threadId,
    topicId: req.topicId,
    peerName: req.peerName,
    body: guard.text!,
    kind: decision.kind,
  });

  return { surfaced: true, kind: decision.kind, reason: decision.reason };
}
