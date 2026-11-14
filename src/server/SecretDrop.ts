/**
 * SecretDrop — Secure secret submission from user to agent.
 *
 * When an agent needs a secret (API key, password, token), it creates a
 * one-time-use, time-limited URL. The user opens the link in a browser,
 * submits the secret via a clean form, and the agent receives it directly —
 * never passing through Telegram or any chat history.
 *
 * Security properties:
 * - One-time use: token destroyed after successful submission
 * - Time-limited: expires after configurable TTL (default 15 minutes)
 * - In-memory only: pending requests and secrets never touch disk
 * - CSRF protection: form includes a hidden CSRF token
 * - Rate-limited: max submissions per IP
 * - XSS-safe: all rendered content is escaped
 * - The URL token IS the auth — no login or bearer token needed
 */

import crypto from 'node:crypto';

// E2E-PAIRING: EXEMPT — this change is internal retrieval-lifetime/timer logic on
// an existing class; it adds no route and does not change the shape of the existing
// /secrets/* routes. The behavior is time-windowed (15m sliding idle, 30m absolute
// cap) and is verified deterministically by fake-timer unit tests in
// tests/unit/SecretDrop.test.ts — a real-boot E2E cannot fast-forward those windows.

// ── Types ──────────────────────────────────────────────────────────

export interface SecretField {
  /** Field identifier (e.g., "api_key", "password") */
  name: string;
  /** Human-readable label shown in the form */
  label: string;
  /** Whether to mask the input (default: true) */
  masked?: boolean;
  /** Placeholder text */
  placeholder?: string;
}

export interface SecretRequest {
  /**
   * The only site this value may be typed into, shown on the form so the person sees it. A submission
   * carrying it leaves only through the helper's --browser mode and is never persisted
   * (docs/specs/normal-chrome-linux.md, "Passwords through Secret Drop").
   */
  browserHost?: string;
  /** Unique token for the URL */
  token: string;
  /** CSRF token embedded in the form */
  csrfToken: string;
  /** What's being requested (shown in the form header) */
  label: string;
  /** Optional description/reason shown to the user */
  description?: string;
  /** Fields to collect (defaults to a single "secret" field) */
  fields: SecretField[];
  /** Telegram topic to notify on receipt */
  topicId?: number;
  /** When this request was created */
  createdAt: number;
  /** When this request expires (ms since epoch) */
  expiresAt: number;
  /** Callback fired when the secret is received */
  onReceive?: (values: Record<string, string>) => void;
  /** Agent name (shown in the form) */
  agentName: string;
  /**
   * Sealed-handoff sender authentication (R1a). When set, the submission MUST
   * carry a `_sig` field — an Ed25519 signature, by the pinned sender key, over
   * the canonical message {@link canonicalSubmitMessage} (token + declared field
   * values). A submission that is unsigned, signed by the wrong key, or whose
   * values were tampered after signing is REJECTED before storage. This closes
   * the "first-POST-wins" race on a write-only URL: possession of the URL is no
   * longer sufficient — the submitter must prove possession of the sender key.
   * Omitted for ordinary (human) Secret Drops, which stay unchanged.
   */
  senderVerification?: {
    /** Raw 32-byte Ed25519 public key of the expected sender, hex-encoded. */
    senderPubKeyHex: string;
  };
}

export interface SecretSubmission {
  /** The values submitted by the user */
  values: Record<string, string>;
  /** When the submission was received */
  receivedAt: string;
  /** The request label */
  label: string;
  /** The topic to notify */
  topicId?: number;
  /**
   * The only site this value may be typed into, shown on the form so the person sees it. A submission
   * carrying it leaves only through the helper's --browser mode and is never persisted
   * (docs/specs/normal-chrome-linux.md, "Passwords through Secret Drop").
   */
  browserHost?: string;
}

export interface CreateSecretRequestOptions {
  /** What's being requested — shown as the form title */
  label: string;
  /** Why it's needed — shown as description in the form */
  description?: string;
  /** Fields to collect. Defaults to single masked "secret" field */
  fields?: SecretField[];
  /** Telegram topic to notify on receipt */
  topicId?: number;
  /**
   * The only site this value may be typed into, shown on the form so the person sees it. A submission
   * carrying it leaves only through the helper's --browser mode and is never persisted
   * (docs/specs/normal-chrome-linux.md, "Passwords through Secret Drop").
   */
  browserHost?: string;
  /** TTL in milliseconds (default: 15 minutes) */
  ttlMs?: number;
  /** Callback when secret is received */
  onReceive?: (values: Record<string, string>) => void;
  /** Sealed-handoff sender authentication (R1a) — see {@link SecretRequest.senderVerification}. */
  senderVerification?: {
    /** Raw 32-byte Ed25519 public key of the expected sender, hex-encoded. */
    senderPubKeyHex: string;
  };
}

// ── Service ────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PENDING = 20;
const TOKEN_BYTES = 32; // 256-bit
/**
 * Sliding idle window for a stored submission: the cleanup timer is (re)armed
 * for this long on submit AND on every non-destructive retrieve, so a secret
 * that is actively being worked never expires underneath the consumer. Raised
 * from the original hard 5 min (which deleted submissions mid-flow regardless
 * of activity — the 2026-06-02 "link expired while I was using it" incident).
 */
const RECEIVED_IDLE_TTL_MS = 15 * 60 * 1000; // 15 minutes since last touch
/**
 * Absolute cap from first receipt — the sliding window can never extend a
 * stored submission past this, so even a relentlessly-polled secret is purged.
 * Bounds the in-memory plaintext lifetime regardless of retrieve activity.
 */
const RECEIVED_ABSOLUTE_MAX_MS = 30 * 60 * 1000; // 30 minutes hard cap
const STUCK_CONSUMER_GRACE_MS = 60 * 1000; // 60 seconds — emit a warning if a submission sits unconsumed past this

/**
 * Canonical message an R1a sealed-handoff sender signs (and the server verifies):
 * the one-time `token`, then each DECLARED field as `name=value`, keys sorted, all
 * joined by newlines. Deterministic on both sides so the Ed25519 signature matches
 * exactly. Binding the token prevents replaying a signature to a different request;
 * binding the values prevents post-signing tampering. The `_sig` field itself is
 * never part of the signed message (it carries the signature, not signed content).
 */
export function canonicalSubmitMessage(token: string, declaredValues: Record<string, string>): Buffer {
  const keys = Object.keys(declaredValues).sort();
  const body = keys.map((k) => `${k}=${declaredValues[k]}`).join('\n');
  return Buffer.from(`${token}\n${body}`, 'utf8');
}

/**
 * Sender-side counterpart to R1a: build a signed sealed-handoff submission body.
 * Given the one-time `token`, the declared field values, and the sender's raw
 * 32-byte Ed25519 private seed (hex), returns the values plus a `_sig` that the
 * receiver's {@link SecretDrop.submit} verifies against the pinned sender key.
 * The sender POSTs the returned object as the submission body. Keeping the signer
 * and verifier in one module guarantees they share {@link canonicalSubmitMessage}.
 */
export function buildSignedSubmission(
  token: string,
  declaredValues: Record<string, string>,
  senderEd25519SeedHex: string,
): Record<string, string> {
  const seed = Buffer.from(senderEd25519SeedHex, 'hex');
  if (seed.length !== 32) {
    throw new Error('buildSignedSubmission: sender Ed25519 seed must be 32 bytes (hex)');
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = crypto.sign(null, canonicalSubmitMessage(token, declaredValues), privateKey);
  return { ...declaredValues, _sig: sig.toString('hex') };
}

/**
 * Event emitted when a submission has been sitting in `received` for longer
 * than {@link STUCK_CONSUMER_GRACE_MS} without being explicitly consumed.
 * Consumers register a listener via {@link SecretDrop.onStuckConsumer}.
 *
 * Added 2026-05-20 after the topic-10873 incident: a buggy bridge consumer
 * called the (then-destructive) retrieve endpoint, failed to extract the
 * value, and lost the secret silently. The hardening makes retrieval
 * non-destructive by default; this event surfaces the case where a
 * non-destructive retrieve never reaches an explicit consume — a visible
 * cue that the consumer chain broke.
 */
export interface StuckConsumerEvent {
  token: string;
  label: string;
  browserHost?: string;
  topicId?: number;
  receivedAt: string;
  minutesUntilCleanup: number;
}

export class SecretDrop {
  private pending = new Map<string, SecretRequest>();
  private received = new Map<string, SecretSubmission>();
  private receivedTimers = new Map<string, NodeJS.Timeout>();
  /** Absolute cleanup deadline (ms-since-epoch) per stored submission — the
   *  sliding idle window can extend up to, but never past, this value. */
  private receivedDeadline = new Map<string, number>();
  private stuckTimers = new Map<string, NodeJS.Timeout>();
  private stuckConsumerListeners: Array<(event: StuckConsumerEvent) => void> = [];
  private cleanupTimer: NodeJS.Timeout;
  private agentName: string;

  constructor(agentName: string) {
    this.agentName = agentName;

    // Periodic cleanup of expired requests
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  /**
   * Register a listener for stuck-consumer events. Listeners are invoked
   * when a submission has been in `received` longer than the grace period
   * (60s) without being explicitly consumed. Multiple listeners may
   * register — all are invoked. Listener errors are caught and logged so
   * a single bad listener cannot block the others.
   */
  onStuckConsumer(listener: (event: StuckConsumerEvent) => void): void {
    this.stuckConsumerListeners.push(listener);
  }

  /**
   * Create a new secret request. Returns the token for URL construction.
   */
  create(options: CreateSecretRequestOptions): { token: string } {
    if (this.pending.size >= MAX_PENDING) {
      // Clean up expired first
      this.cleanup();
      if (this.pending.size >= MAX_PENDING) {
        throw new Error(`Too many pending secret requests (max ${MAX_PENDING})`);
      }
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const csrfToken = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    const fields = options.fields ?? [{
      name: 'secret',
      label: options.label,
      masked: true,
      placeholder: 'Paste your secret here',
    }];

    const request: SecretRequest = {
      token,
      csrfToken,
      label: options.label,
      description: options.description,
      fields,
      topicId: options.topicId,
      createdAt: now,
      expiresAt: now + ttlMs,
      onReceive: options.onReceive,
      agentName: this.agentName,
      senderVerification: options.senderVerification,
      browserHost: options.browserHost,
    };

    this.pending.set(token, request);
    return { token };
  }

  /**
   * Get a pending request by token. Returns null if expired or not found.
   */
  getPending(token: string): SecretRequest | null {
    const request = this.pending.get(token);
    if (!request) return null;
    if (Date.now() > request.expiresAt) {
      this.pending.delete(token);
      return null;
    }
    return request;
  }

  /**
   * Submit a secret. Validates CSRF, consumes the request (one-time use),
   * fires the callback, and stores the submission for retrieval.
   * Returns the submission on success, null on failure.
   */
  submit(token: string, csrfToken: string, values: Record<string, string>): SecretSubmission | null {
    const request = this.getPending(token);
    if (!request) return null;

    // Verify CSRF token (timing-safe)
    const ha = crypto.createHash('sha256').update(csrfToken).digest();
    const hb = crypto.createHash('sha256').update(request.csrfToken).digest();
    if (!crypto.timingSafeEqual(ha, hb)) {
      return null;
    }

    // Validate all required fields are present and non-empty
    for (const field of request.fields) {
      const value = values[field.name];
      if (!value || typeof value !== 'string' || value.trim().length === 0) {
        return null;
      }
    }

    // Strip any extra fields — only accept declared fields
    const cleanValues: Record<string, string> = {};
    for (const field of request.fields) {
      cleanValues[field.name] = values[field.name].trim();
    }

    // R1a — sealed-handoff sender authentication. When the request pins a sender
    // key, the submission must carry a valid Ed25519 `_sig` over the canonical
    // (token + declared values) message. Reject unsigned / wrong-key / tampered
    // submissions BEFORE consuming the request, so a failed attempt does not burn
    // the one-time token (a real sender can retry). No verification = unchanged
    // behavior for ordinary human Secret Drops.
    if (request.senderVerification) {
      const sigHex = values['_sig'];
      if (!sigHex || typeof sigHex !== 'string') return null;
      let verified = false;
      try {
        const pubRaw = Buffer.from(request.senderVerification.senderPubKeyHex, 'hex');
        if (pubRaw.length === 32) {
          const pub = crypto.createPublicKey({
            key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubRaw]),
            format: 'der',
            type: 'spki',
          });
          verified = crypto.verify(null, canonicalSubmitMessage(token, cleanValues), pub, Buffer.from(sigHex, 'hex'));
        }
      } catch {
        verified = false;
      }
      if (!verified) return null;
    }

    // Consume the request (one-time use)
    this.pending.delete(token);

    const submission: SecretSubmission = {
      values: cleanValues,
      receivedAt: new Date().toISOString(),
      label: request.label,
      topicId: request.topicId,
      browserHost: request.browserHost,
    };

    // Store submission for retrieval behind a SLIDING idle window.
    // The submission is NOT removed on first retrieve — callers must either
    // explicitly consume it via `consumeReceived` (or the `?consume=true`
    // route parameter) or let the idle/absolute cleanup fire.
    // Rationale (two layered lessons):
    //   1. A buggy consumer that drops the response (parse error, exception in
    //      the writer step) historically lost the value with no recovery path,
    //      so retrieval is non-destructive — the same caller can re-read.
    //   2. A fixed short window deleted the submission mid-flow even while a
    //      consumer was actively retrieving it (2026-06-02 incident: a long
    //      multi-step credential handoff kept losing the secret at the 5-min
    //      mark, forcing the user to resubmit repeatedly). The window now SLIDES
    //      on every retrieve (see `armReceivedCleanup` / `peekReceived`), capped
    //      by `RECEIVED_ABSOLUTE_MAX_MS`, so an in-use secret cannot expire.
    this.received.set(token, submission);
    this.receivedDeadline.set(token, Date.now() + RECEIVED_ABSOLUTE_MAX_MS);
    this.armReceivedCleanup(token);

    // Schedule a stuck-consumer signal: if the submission has not been
    // explicitly consumed within the grace period, emit a structured
    // event to every registered listener. This is the visible-cue half
    // of the silent-loss fix — agents that bind to topics can mirror
    // the event back to the operator who submitted the secret.
    const stuckTimer = setTimeout(() => {
      this.stuckTimers.delete(token);
      // Only fire if the submission is still in `received` (i.e. nobody
      // consumed it during the grace window).
      const stillPresent = this.received.get(token);
      if (!stillPresent) return;
      const cleanupAt = this.receivedDeadline.get(token) ?? (Date.now() + RECEIVED_IDLE_TTL_MS);
      const event: StuckConsumerEvent = {
        token,
        label: stillPresent.label,
        browserHost: stillPresent.browserHost,
        topicId: stillPresent.topicId,
        receivedAt: stillPresent.receivedAt,
        minutesUntilCleanup: Math.max(0, Math.ceil((cleanupAt - Date.now()) / 60_000)),
      };
      for (const listener of this.stuckConsumerListeners) {
        try {
          listener(event);
        } catch (err) {
          // @silent-fallback-ok — listener errors must not break the SecretDrop service
          console.error('[secret-drop] stuck-consumer listener error:', err instanceof Error ? err.message : String(err));
        }
      }
    }, STUCK_CONSUMER_GRACE_MS);
    stuckTimer.unref();
    this.stuckTimers.set(token, stuckTimer);

    // Fire callback if provided
    if (request.onReceive) {
      try {
        request.onReceive(cleanValues);
      } catch (err) {
        // @silent-fallback-ok — caller-provided callback, errors must not break submission
        console.error('[secret-drop] onReceive callback error:', err instanceof Error ? err.message : String(err));
      }
    }

    return submission;
  }

  /**
   * (Re)arm the idle cleanup timer for a stored submission. Fires after
   * {@link RECEIVED_IDLE_TTL_MS} of no activity, but never later than the
   * per-token absolute deadline in {@link receivedDeadline}. Called on submit
   * and on every {@link peekReceived}, so the window SLIDES with activity —
   * an in-use secret cannot be deleted out from under its consumer, while the
   * absolute cap still bounds total in-memory lifetime.
   */
  private armReceivedCleanup(token: string): void {
    const existing = this.receivedTimers.get(token);
    if (existing) clearTimeout(existing);

    const now = Date.now();
    const absoluteDeadline = this.receivedDeadline.get(token) ?? (now + RECEIVED_ABSOLUTE_MAX_MS);
    this.receivedDeadline.set(token, absoluteDeadline);
    // Next fire = whichever comes first: one idle window from now, or the cap.
    const fireIn = Math.max(0, Math.min(RECEIVED_IDLE_TTL_MS, absoluteDeadline - now));

    const timer = setTimeout(() => {
      this.received.delete(token);
      this.receivedTimers.delete(token);
      this.receivedDeadline.delete(token);
      const stuck = this.stuckTimers.get(token);
      if (stuck) {
        clearTimeout(stuck);
        this.stuckTimers.delete(token);
      }
    }, fireIn);
    timer.unref();
    this.receivedTimers.set(token, timer);
  }

  /**
   * Retrieve a received submission WITHOUT consuming it. Each call SLIDES the
   * idle cleanup window (see {@link armReceivedCleanup}), so a submission that
   * is actively being retrieved stays available — capped only by the absolute
   * {@link RECEIVED_ABSOLUTE_MAX_MS} deadline. Safe to call repeatedly; this is
   * the path polling/multi-step consumers should use. Consume explicitly via
   * {@link consumeReceived} only after the handoff has actually succeeded.
   *
   * @returns the submission or null if not present (never seen, already
   *   consumed, or already cleaned up past the absolute cap).
   */
  peekReceived(token: string): SecretSubmission | null {
    const submission = this.received.get(token) ?? null;
    if (submission) {
      // Slide the idle window on activity (bounded by the absolute deadline).
      this.armReceivedCleanup(token);
    }
    return submission;
  }

  /**
   * Retrieve AND consume a submission. The submission is removed from
   * the store before the function returns. Use this when the caller is
   * confident the value has been successfully handed off (parsed, stored,
   * forwarded, etc.) and a re-read would be wrong.
   *
   * @returns the submission or null if not present.
   */
  consumeReceived(token: string): SecretSubmission | null {
    const submission = this.received.get(token);
    if (!submission) return null;
    this.received.delete(token);
    this.receivedDeadline.delete(token);
    const tCleanup = this.receivedTimers.get(token);
    if (tCleanup) {
      clearTimeout(tCleanup);
      this.receivedTimers.delete(token);
    }
    const tStuck = this.stuckTimers.get(token);
    if (tStuck) {
      clearTimeout(tStuck);
      this.stuckTimers.delete(token);
    }
    return submission;
  }

  /**
   * @deprecated Use {@link peekReceived} for non-destructive reads or
   * {@link consumeReceived} for one-shot semantics. Preserved on the
   * public surface for callers that have not yet migrated; behaves
   * identically to {@link consumeReceived} so existing code keeps
   * working until migrated.
   */
  getReceived(token: string): SecretSubmission | null {
    return this.consumeReceived(token);
  }

  /**
   * List all pending requests (for the agent's management API).
   */
  listPending(): Array<{ token: string; label: string; topicId?: number; createdAt: number; expiresAt: number; expired: boolean }> {
    const now = Date.now();
    const results: Array<{ token: string; label: string; topicId?: number; createdAt: number; expiresAt: number; expired: boolean }> = [];
    for (const [token, req] of this.pending) {
      results.push({
        token,
        label: req.label,
        topicId: req.topicId,
        createdAt: req.createdAt,
        expiresAt: req.expiresAt,
        expired: now > req.expiresAt,
      });
    }
    return results;
  }

  /**
   * Cancel a pending request.
   */
  cancel(token: string): boolean {
    return this.pending.delete(token);
  }

  /**
   * Remove expired requests.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [token, req] of this.pending) {
      if (now > req.expiresAt) {
        this.pending.delete(token);
      }
    }
  }

  /**
   * Render the secret submission form as self-contained HTML.
   */
  renderForm(request: SecretRequest): string {
    // A masked field carries a show/hide (eye) toggle so the person can check
    // what they typed before sending (CMT-1250). The value never leaves the
    // page because of it: the toggle only flips the input's type locally.
    const fieldsHtml = request.fields.map(field => {
      const masked = field.masked !== false;
      const id = `field-${escapeAttr(field.name)}`;
      return `
      <div class="field">
        <label for="${id}">${escapeHtml(field.label)}</label>
        <div class="input-wrap${masked ? ' has-reveal' : ''}">
          <input
            type="${masked ? 'password' : 'text'}"
            id="${id}"
            name="${escapeAttr(field.name)}"
            placeholder="${escapeAttr(field.placeholder || '')}"
            autocomplete="off"
            spellcheck="false"
            required
          >${masked ? `
          <button type="button" class="reveal-btn" data-reveal-for="${id}" aria-controls="${id}" aria-pressed="false" aria-label="Show what you typed" title="Show what you typed">
            <svg class="eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
            <svg class="eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
          </button>` : ''}
        </div>
      </div>
    `;
    }).join('');

    const minutesLeft = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 60_000));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Secret Drop — ${escapeHtml(request.label)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f9fa;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #1a1a2e;
      padding: 1rem;
    }
    .drop-box {
      background: #fff;
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      max-width: 460px;
      width: 100%;
    }
    .agent-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: #f0edf6;
      color: #533483;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 500;
      margin-bottom: 1rem;
    }
    .agent-badge .dot {
      width: 8px; height: 8px;
      background: #27ae60;
      border-radius: 50%;
    }
    h1 {
      font-size: 1.3rem;
      margin-bottom: 0.5rem;
      color: #16213e;
    }
    .description {
      font-size: 0.9rem;
      color: #666;
      margin-bottom: 1.5rem;
      line-height: 1.5;
    }
    .expiry {
      font-size: 0.8rem;
      color: #999;
      margin-bottom: 1.5rem;
    }
    .field {
      margin-bottom: 1.25rem;
    }
    .field label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      color: #444;
      margin-bottom: 0.35rem;
    }
    .field input {
      width: 100%;
      padding: 0.7rem 0.9rem;
      font-size: 0.95rem;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      outline: none;
      transition: border-color 0.2s;
      background: #fafafa;
    }
    .field input:focus {
      border-color: #533483;
      background: #fff;
    }
    .input-wrap { position: relative; }
    .input-wrap.has-reveal input { padding-right: 3rem; }
    .reveal-btn {
      position: absolute; top: 50%; right: 0.35rem; transform: translateY(-50%);
      width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;
      background: none; border: none; border-radius: 6px; cursor: pointer; color: #888;
    }
    .reveal-btn:hover, .reveal-btn:focus-visible { color: #533483; }
    .reveal-btn:focus-visible { outline: 2px solid #533483; outline-offset: -2px; }
    .reveal-btn svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .reveal-btn .eye-closed { display: none; }
    .reveal-btn[aria-pressed="true"] .eye-open { display: none; }
    .reveal-btn[aria-pressed="true"] .eye-closed { display: block; }
    .submit-btn {
      width: 100%;
      padding: 0.8rem;
      margin-top: 0.5rem;
      background: #16213e;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    .submit-btn:hover { background: #533483; }
    .submit-btn:disabled { background: #aaa; cursor: not-allowed; }
    .security-note {
      margin-top: 1.25rem;
      padding: 0.75rem;
      background: #f8f9fa;
      border-radius: 8px;
      font-size: 0.78rem;
      color: #888;
      line-height: 1.5;
    }
    .security-note strong { color: #666; }
    .success {
      text-align: center;
      padding: 2rem 0;
    }
    .success .check {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    .success h2 {
      font-size: 1.2rem;
      color: #27ae60;
      margin-bottom: 0.5rem;
    }
    .success p {
      font-size: 0.9rem;
      color: #666;
    }
    .error-banner {
      background: #fdf0f0;
      color: #c0392b;
      padding: 0.6rem 0.9rem;
      border-radius: 6px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
      display: none;
    }
  </style>
</head>
<body>
  <div class="drop-box">
    <div id="form-view">
      <div class="agent-badge"><span class="dot"></span> ${escapeHtml(request.agentName)}</div>
      <h1>${escapeHtml(request.label)}</h1>
      ${request.description ? `<p class="description">${escapeHtml(request.description)}</p>` : ''}
      ${request.browserHost ? `<p class="description"><strong>This will be typed into ${escapeHtml(request.browserHost)}.</strong> It goes nowhere else.</p>` : ''}
      <p class="expiry">This link expires in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''} and can only be used once.</p>
      <div class="error-banner" id="error-banner"></div>
      <form id="secret-form">
        <input type="hidden" name="_csrf" value="${escapeAttr(request.csrfToken)}">
        ${fieldsHtml}
        <button type="submit" class="submit-btn" id="submit-btn">Send Securely</button>
      </form>
      <div class="security-note">
        <strong>End-to-end delivery.</strong> Your secret goes directly to ${escapeHtml(request.agentName)}'s server.
        It is not stored on disk and this link will stop working after submission.
      </div>
    </div>
    <div id="success-view" style="display:none">
      <div class="success">
        <div class="check">&#10003;</div>
        <h2>Secret Received</h2>
        <p>${escapeHtml(request.agentName)} has received your secret securely.<br>You can close this page.</p>
      </div>
    </div>
  </div>
  <script>
    document.querySelectorAll('.reveal-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.getAttribute('data-reveal-for'));
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        const word = show ? 'Hide what you typed' : 'Show what you typed';
        btn.setAttribute('aria-label', word);
        btn.setAttribute('title', word);
        input.focus();
      });
    });
    document.getElementById('secret-form').addEventListener('submit', async (e) => {
      // Re-mask before sending, so nothing stays visible on a shared screen.
      document.querySelectorAll('.reveal-btn[aria-pressed="true"]').forEach((b) => b.click());
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      const errorBanner = document.getElementById('error-banner');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      errorBanner.style.display = 'none';

      const formData = new FormData(e.target);
      const payload = {};
      for (const [key, value] of formData.entries()) {
        payload[key] = value;
      }

      try {
        const res = await fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          document.getElementById('form-view').style.display = 'none';
          document.getElementById('success-view').style.display = 'block';
        } else {
          const data = await res.json().catch(() => ({}));
          errorBanner.textContent = data.error || 'Submission failed. The link may have expired.';
          errorBanner.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Send Securely';
        }
      } catch {
        errorBanner.textContent = 'Network error. Please check your connection and try again.';
        errorBanner.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Send Securely';
      }
    });
  </script>
</body>
</html>`;
  }

  /**
   * Render an expired/not-found page.
   */
  renderExpiredPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Secret Drop — Expired</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f9fa;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #1a1a2e;
      padding: 1rem;
    }
    .box {
      background: #fff;
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.3rem; margin-bottom: 0.75rem; color: #16213e; }
    p { font-size: 0.9rem; color: #666; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">&#128683;</div>
    <h1>Link Expired or Already Used</h1>
    <p>This secret drop link is no longer valid. It may have expired or already been used. Ask the agent to generate a new one if needed.</p>
  </div>
</body>
</html>`;
  }

  /**
   * Shutdown — clean up timers and listeners.
   */
  shutdown(): void {
    clearInterval(this.cleanupTimer);
    for (const t of this.receivedTimers.values()) clearTimeout(t);
    for (const t of this.stuckTimers.values()) clearTimeout(t);
    this.receivedTimers.clear();
    this.stuckTimers.clear();
    this.receivedDeadline.clear();
    this.stuckConsumerListeners.length = 0;
    this.pending.clear();
    this.received.clear();
  }
}

// ── HTML Escaping ──────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
