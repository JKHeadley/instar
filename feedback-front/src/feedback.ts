// Instar canonical feedback receiver front.
//
// TWO modes, selected by deploy-time env (structural, no code change at cutover):
//
//   - PERSISTENCE mode (Phase-3+, the Option-B receiving end): when a Vercel Blob
//     read-write token is present (FEEDBACK_INBOX_BLOB_TOKEN, falling back to the
//     store-injected BLOB_READ_WRITE_TOKEN), the FULL ported intake pipeline runs
//     (handleFeedbackSubmit — rate limit, fingerprint, honeypot, HMAC, validation,
//     dedup) and every ACCEPTED report is durably written to the Blob inbox. The
//     operated machine's InboxDrainer ingests asynchronously — no Echo machine is
//     in the intake critical path, so reports survive any machine being down.
//
//   - PHASE-0 mode (no token): the original no-traffic HMAC round-trip behavior,
//     byte-for-byte (verify-only, no persistence). This keeps the deployed front
//     inert until the cutover deploy provides the token — "dark until traffic
//     points at it".
//
// The receiver logic is imported DIRECTLY from the canonical source (zero drift —
// no vendored copy). The published `instar` package blocks subpath imports, which
// is why this front lives in-repo and imports by relative path.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  verifySignature,
  normalizeWebhookSecret,
  validateAgentFingerprint,
  checkHoneypot,
  RateLimiter,
} from '../../src/feedback-factory/receiver/defense.js';
import { handleFeedbackSubmit } from '../../src/feedback-factory/receiver/handlers.js';
import { BlobInboxStore } from '../../src/feedback-factory/receiver/BlobInboxStore.js';
import { BlobInboxClient } from '../../src/feedback-factory/inbox/BlobInboxClient.js';

function headerStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Per-warm-instance rate limiter (the reference's in-memory limiter has the same
// scope on a single deployment; a durable cross-instance backing is tracked in the
// migration spec's Phase-3 deploy notes). Module scope ⇒ survives across invocations
// of one warm function instance.
const rateLimiter = new RateLimiter();

function inboxToken(): string | undefined {
  return process.env.FEEDBACK_INBOX_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed', phase: 0 });
    return;
  }

  // Secret is normalized at load (trim) — a trailing newline in the env value physically
  // cannot cause an HMAC mismatch (structural, per spec §222).
  const secret = normalizeWebhookSecret(process.env.INSTAR_WEBHOOK_SECRET);
  if (!secret) {
    res.status(503).json({ error: 'receiver-not-configured', phase: 0 });
    return;
  }

  const token = inboxToken();
  if (token) {
    // ── PERSISTENCE mode: the full ported intake pipeline + durable Blob inbox. ──
    const store = new BlobInboxStore(
      new BlobInboxClient({ token, apiBase: process.env.FEEDBACK_INBOX_BLOB_API_BASE }),
    );
    const out = await handleFeedbackSubmit(
      {
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: req.body,
        remoteAddress: req.socket?.remoteAddress,
      },
      { store, rateLimiter, secret, now: Date.now() },
    );
    if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.status(out.status).json(out.json);
    return;
  }

  // ── PHASE-0 mode (no inbox token): verify-only, no persistence — original behavior. ──
  const ua = headerStr(req.headers['user-agent']);
  const version = headerStr(req.headers['x-instar-version']);
  const fp = validateAgentFingerprint(ua, version);
  if (!fp.valid) {
    res.status(403).json({ error: 'invalid-agent', reason: fp.reason, phase: 0 });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (checkHoneypot(body)) {
    // Honeypot tripped — silently accept (never reveal the trap), no further processing.
    res.status(200).json({ ok: true, phase: 0, accepted: false });
    return;
  }

  const ok = verifySignature({
    signature: headerStr(req.headers['x-instar-signature']),
    timestamp: headerStr(req.headers['x-instar-timestamp']),
    body,
    secret,
    now: Date.now(),
  });
  if (!ok) {
    res.status(401).json({ error: 'invalid-signature', phase: 0 });
    return;
  }

  // Phase-0: signature verified end-to-end. NO store write. Acknowledge.
  res.status(200).json({ ok: true, phase: 0, accepted: true, note: 'phase-0 verify-only; no persistence' });
}
