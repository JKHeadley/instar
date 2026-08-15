/**
 * Agent-Signature Provenance routes.
 *
 * Spec anchor: docs/specs/agent-signature-provenance.md
 *
 * Routes:
 *   GET  /provenance         — status: who this agent signs as, and whether
 *                              replay defence is actually durable.
 *   POST /provenance/verify  — classify raw message bytes as human /
 *                              agent-verified / rejected.
 *
 * ── AUTHORITY BOUNDARY ────────────────────────────────────────────────────
 * These routes answer "who authored these bytes?" and nothing else. The
 * response shape carries no permission, role or trust field, so a caller
 * cannot read an authorization decision out of it. See the spec's open
 * authority question — wiring a capability to `agent-verified` would convert
 * an identity check into an authorization check, which is exactly what the
 * boundary forbids.
 *
 * ── SECRET HANDLING ───────────────────────────────────────────────────────
 * The signing key never crosses this boundary. `GET /provenance` reports the
 * PUBLIC fingerprint only; there is deliberately no route that signs on
 * request, because a sign-on-demand endpoint would let anyone holding the
 * bearer token mint messages attributed to this agent — which is the forgery
 * this whole mechanism exists to prevent.
 */

import type { Express, Request, Response } from 'express';
import { verifyMessage, DEFAULT_MAX_AGE_SECONDS } from '../../core/agentSignatureProvenance.js';
import type { SeenNonceStore } from '../../core/agentSignatureProvenance.js';

export interface RegisterProvenanceRoutesOpts {
  app: Express;
  /** This agent's id as it appears in signed tags. */
  agentId: string;
  /** Raw 32-byte Ed25519 public key for this agent, or null when unavailable. */
  publicKey: Buffer | null;
  /** Resolve any agent id to its raw public key. Unknown ids MUST return null. */
  resolvePublicKey: (agentId: string) => Buffer | null | undefined;
  /** Durable replay store. When absent, replay defence is reported as unavailable. */
  seenNonces?: SeenNonceStore;
  /** Diagnostics: live nonce count, when the store can report it. */
  nonceCount?: () => number;
  now?: () => number;
}

const MAX_BODY_BYTES = 64 * 1024;

export function registerProvenanceRoutes(opts: RegisterProvenanceRoutesOpts): void {
  const { app, agentId, publicKey, resolvePublicKey, seenNonces } = opts;
  const now = opts.now ?? (() => Date.now());

  app.get('/provenance', (_req: Request, res: Response) => {
    try {
      let nonceCount: number | null = null;
      try {
        nonceCount = opts.nonceCount ? opts.nonceCount() : null;
      } catch {
        nonceCount = null; // diagnostics must never fail the status route
      }
      res.json({
        enabled: Boolean(publicKey),
        version: 'asp1',
        agentId,
        // PUBLIC fingerprint only. Never the private key, and never a signing route.
        fingerprint: publicKey ? publicKey.toString('hex').slice(0, 32) : null,
        freshnessWindowSeconds: DEFAULT_MAX_AGE_SECONDS,
        // Honest about the guard rather than implying it: without a store there
        // is no replay defence, and callers must be able to see that.
        replayDefence: seenNonces ? 'durable' : 'unavailable',
        nonceCount,
      });
    } catch (err) {
      res.status(500).json({ error: 'provenance-status-failed', detail: (err as Error).message });
    }
  });

  app.post('/provenance/verify', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { raw?: unknown; topicId?: unknown };

      if (typeof body.raw !== 'string') {
        return res.status(400).json({ error: 'raw (string) required' });
      }
      if (Buffer.byteLength(body.raw, 'utf8') > MAX_BODY_BYTES) {
        return res.status(413).json({ error: 'raw too large', maxBytes: MAX_BODY_BYTES });
      }

      let expectedTopicId: number | undefined;
      if (body.topicId !== undefined && body.topicId !== null) {
        const t = Number(body.topicId);
        if (!Number.isSafeInteger(t)) {
          return res.status(400).json({ error: 'topicId must be an integer' });
        }
        expectedTopicId = t;
      }

      const verdict = verifyMessage({
        raw: body.raw,
        expectedTopicId,
        resolvePublicKey,
        seenNonces,
        nowSeconds: Math.floor(now() / 1000),
      });

      return res.json({
        classification: verdict.classification,
        reason: 'reason' in verdict ? verdict.reason : null,
        agentId: 'agentId' in verdict ? verdict.agentId ?? null : null,
        topicId: 'topicId' in verdict ? verdict.topicId ?? null : null,
        timestamp: 'timestamp' in verdict ? verdict.timestamp ?? null : null,
        // The body is echoed so a caller can record exactly what was classified.
        body: verdict.body,
        // Deliberate: no permission/trust/authority field. See the module header.
        topicBound: expectedTopicId !== undefined,
        replayChecked: Boolean(seenNonces),
      });
    } catch (err) {
      return res
        .status(500)
        .json({ error: 'provenance-verify-failed', detail: (err as Error).message });
    }
  });
}
