// Instar canonical feedback receiver front — Phase-0 (no-traffic, HMAC round-trip).
//
// Phase-0 scope (per docs/specs/feedback-factory-migration.md §211 row 0): stand the
// receiver up on Vercel with the SAME shared secret and NO live traffic — success =
// "deploy healthy + secret HMAC round-trips". It therefore exercises ONLY the canonical
// defense layer (verifySignature + agent-fingerprint + honeypot) and does NOT write to
// any store. handleFeedbackSubmit (which needs a FeedbackStore) is wired in Phase 3,
// once Dawn's Q2b write-path (Portal API seams) is resolved.
//
// The receiver logic is imported DIRECTLY from the canonical source (zero drift — no
// vendored copy). The published `instar` package blocks subpath imports, which is why
// this front lives in-repo and imports by relative path.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  verifySignature,
  normalizeWebhookSecret,
  validateAgentFingerprint,
  checkHoneypot,
} from '../../src/feedback-factory/receiver/defense.js';

function headerStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
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

  // Phase-0: signature verified end-to-end. NO store write (that is Phase 3). Acknowledge.
  res.status(200).json({ ok: true, phase: 0, accepted: true, note: 'phase-0 verify-only; no persistence' });
}
