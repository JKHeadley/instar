/**
 * handlers.ts — framework-agnostic feedback-receiver request handler.
 *
 * Faithful port of `handleSubmit` from the reference receiver
 * (the-portal/pages/api/instar/feedback.ts), lifted out of Next.js into a pure
 * request→response function over the FeedbackStore interface + the ported intake
 * defenses (defense.ts). The canonical front (Vercel function / Next route /
 * instar server) is a thin binding that maps its req/res to this. This is the
 * reusable "recipe"; the operated deploy supplies the framework binding + the
 * real (Prisma) store.
 *
 * Reproduces handleSubmit's EXACT order, status codes, and error messages so a
 * deployed agent's feedback sender behaves identically. Notably the reference
 * DEFAULTS an invalid `type` to 'other' (does NOT reject it) — see the note in
 * defense.ts about the superseded validateFeedbackInput helper.
 */

import {
  extractSourceIp, validateAgentFingerprint, checkHoneypot, verifySignature,
  isValidType, SEMVER_RE, AGENT_NAME_RE, NODE_VERSION_RE, FEEDBACK_ID_RE,
  type RateLimiter,
} from './defense.js';
import type { FeedbackStore } from '../store/FeedbackStore.js';

export interface FeedbackRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  remoteAddress?: string;
}

export interface FeedbackResponse {
  status: number;
  headers?: Record<string, string>;
  json: unknown;
}

export interface FeedbackHandlerDeps {
  store: FeedbackStore;
  rateLimiter: RateLimiter;
  /** Normalized webhook secret (see normalizeWebhookSecret); undefined ⇒ unsigned-but-accepted. */
  secret: string | undefined;
  /** Injected clock (ms) for the HMAC replay window. */
  now: number;
  /** Injected id generator (defaults to the reference's `fb-<base36 time>-<rand>`). */
  generateFeedbackId?: () => string;
}

function header(headers: FeedbackRequest['headers'], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function defaultFeedbackId(now: number): string {
  return `fb-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Port of handleSubmit. Returns the status/headers/json the canonical front sends back. */
export function handleFeedbackSubmit(req: FeedbackRequest, deps: FeedbackHandlerDeps): FeedbackResponse {
  const { store, rateLimiter, secret, now } = deps;
  const sourceIp = extractSourceIp(req.headers, req.remoteAddress);

  // Layer 1: rate limit.
  const rate = rateLimiter.check(sourceIp);
  if (!rate.allowed) {
    return {
      status: 429,
      headers: { 'Retry-After': String(rate.retryAfterSec) },
      json: { error: 'Rate limit exceeded', retryAfterSec: rate.retryAfterSec },
    };
  }

  // Layer 2: agent fingerprint (400, not 403 — don't reveal it's a fingerprint check).
  const fp = validateAgentFingerprint(header(req.headers, 'user-agent'), header(req.headers, 'x-instar-version'));
  if (!fp.valid) {
    return { status: 400, json: { error: 'Invalid request format' } };
  }

  // Layer 3: honeypot — silently accept without storing (don't tip off the bot).
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (checkHoneypot(body)) {
    return { status: 200, json: { id: 'fb-received', received: true } };
  }

  // Layer 3.5: HMAC signature (non-blocking — unsigned still accepted, marked unverified).
  const verified = verifySignature({
    signature: header(req.headers, 'x-instar-signature'),
    timestamp: header(req.headers, 'x-instar-timestamp'),
    body: req.body,
    secret,
    now,
  });

  // Layer 4: input validation (exact reference order + messages).
  if (!req.body || typeof req.body !== 'object') {
    return { status: 400, json: { error: 'Request body must be JSON' } };
  }
  const title = body.title;
  if (!title || typeof title !== 'string' || title.trim().length < 3) {
    return { status: 400, json: { error: 'title is required (min 3 characters)' } };
  }
  const description = body.description;
  if (!description || typeof description !== 'string' || description.trim().length < 10) {
    return { status: 400, json: { error: 'description is required (min 10 characters)' } };
  }
  // The reference DEFAULTS an invalid type to 'other' — it does not reject.
  const type = body.type && isValidType(body.type) ? body.type : 'other';

  if (body.agentName && !AGENT_NAME_RE.test(body.agentName as string)) {
    return { status: 400, json: { error: 'Invalid agentName format' } };
  }
  if (body.instarVersion && !SEMVER_RE.test(body.instarVersion as string)) {
    return { status: 400, json: { error: 'Invalid instarVersion format (expected semver)' } };
  }
  if (body.nodeVersion && !NODE_VERSION_RE.test(body.nodeVersion as string)) {
    return { status: 400, json: { error: 'Invalid nodeVersion format' } };
  }

  // feedbackId: use a valid agent-provided one, else generate.
  const provided = body.feedbackId;
  const feedbackId = typeof provided === 'string' && FEEDBACK_ID_RE.test(provided)
    ? provided
    : (deps.generateFeedbackId ?? (() => defaultFeedbackId(now)))();

  // Layer 5: dedup — idempotent on a known feedbackId.
  if (store.hasFeedback(feedbackId)) {
    return { status: 200, json: { id: feedbackId, received: true, duplicate: true } };
  }

  store.addFeedback({
    feedbackId,
    type,
    title: (title as string).trim().slice(0, 500),
    description: (description as string).trim().slice(0, 10000),
    agentName: ((body.agentName as string) || 'unknown').slice(0, 100),
    instarVersion: ((body.instarVersion as string) || 'unknown').slice(0, 20),
    nodeVersion: ((body.nodeVersion as string) || 'unknown').slice(0, 20),
    os: ((body.os as string) || 'unknown').slice(0, 100),
    context: typeof body.context === 'string' ? body.context.slice(0, 5000) : undefined,
    sourceIp,
    verified,
  });

  return { status: 200, json: { id: feedbackId, received: true } };
}
