/**
 * geminiPaygRoutes — the second-opinion route of the Gemini pay-per-use lane (E2)
 * (docs/specs/gemini-payg-metered-lane.md §2 "Guarding E2", §5 refusal statuses).
 *
 *   POST /intelligence/gemini   (Bearer)
 *     { prompt, purpose, model?: 'hydrogen'|'neon', systemInstruction?, maxOutputTokens?, callId? }
 *
 * Guards, in order:
 *   - ingress: loopback peer AND no forwarding headers (cloudflared/funnel also connect
 *     from loopback, so the forwarded-header helpers decide) — else 403;
 *   - `purpose` and `prompt` required — else 400;
 *   - the calling session comes from the server's own registry: `X-Instar-Session` is
 *     checked against live sessions; an unverifiable name is recorded as
 *     `self-reported:<name>` (the shared bearer token proves no session identity);
 *   - money: the provider is built only while the money layer constructed; otherwise
 *     503 `money-layer-off`. A machine that is not the designated spender forwards
 *     (multi-machine slice) or, with no forwarder, refuses `no-cap-slice` — never a local
 *     spend.
 *
 * Every refusal reason maps to its own status and plain message (`refusalStatus`) and is
 * passed back unchanged, never laundered into a generic error.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { hasForwardingHeaders } from './mobileBrowserDevices.js';
import { GeminiApiRefusal, type GeminiApiProvider, type GeminiCallRequest } from '../providers/metered/gemini-api/GeminiApiProvider.js';

/** Request bodies over this are refused before any work (§5 `request-too-large`). */
export const GEMINI_ROUTE_MAX_BODY_BYTES = 1_500_000;

export interface GeminiRefusalHttp {
  status: number;
  message: string;
  extras?: Record<string, unknown>;
}

/** Fallback status map, used until the money layer's own map is wired (it wins when present). */
export function defaultGeminiRefusalHttp(reason: string): GeminiRefusalHttp {
  const table: Record<string, [number, string]> = {
    'cap-exceeded': [402, 'The Gemini spending limit for this period is reached.'],
    'e2-share-exceeded': [402, 'Second opinions have used their share of this period\'s Gemini budget.'],
    'per-call-ceiling': [402, 'This request would cost more than one Gemini call is allowed to.'],
    'provisional-ceiling': [402, 'Too many Gemini charges are uncertain right now; spending is paused.'],
    'outside-verified-tier': [422, 'This request is longer than the Gemini price range that has been verified.'],
    'unknown-price': [422, 'There is no verified price for that Gemini model.'],
    'request-too-large': [422, 'This request is too large to send.'],
    'prompt-contains-live-secret': [422, 'The request contains a live secret, so it was not sent.'],
    'reserves-outstanding': [409, 'Other Gemini calls are still settling; try again shortly.'],
    'callid-conflict': [409, 'That call id was already used for a different request.'],
    frozen: [423, 'Gemini spending is stopped.'],
    'not-live': [423, 'The Gemini lane is not switched on.'],
    'armed-pending-proof': [423, 'The Gemini lane is waiting for its first proof call.'],
    'not-allowlisted': [403, 'This kind of caller is not allowed to use the Gemini lane.'],
    'e1-pass-limit': [429, 'This review round already had its Gemini pass.'],
    'peer-version': [503, 'The spending machine runs an older version that cannot take this call.'],
    'key-generation-mismatch': [503, 'The stored Gemini key is not the approved one, so nothing was sent.'],
    'token-count-unavailable': [503, 'Gemini could not count the request, so it was not priced or sent.'],
    'holder-unreachable': [503, 'The machine that spends on Gemini cannot be reached.'],
    'lease-liveness-unconfirmed': [503, 'The spending machine has not confirmed it is still the only spender.'],
    'no-cap-slice': [503, 'This machine is not the one that spends on Gemini.'],
    'money-layer-off': [503, 'The Gemini lane is not available on this machine.'],
    'provider-rejected': [502, 'Gemini rejected the request.'],
    'provider-failed': [502, 'The Gemini call did not complete; it is counted as spent.'],
  };
  const hit = table[reason];
  return hit ? { status: hit[0], message: hit[1] } : { status: 503, message: 'The Gemini lane refused this request.' };
}

export interface GeminiPaygRouteDeps {
  /** The provider on the designated machine; null when the money layer did not construct. */
  provider: () => GeminiApiProvider | null;
  /** True when this machine is the door's designated spender. */
  isDesignatedHere: () => boolean;
  /** Forward a second-opinion to the holder (multi-machine slice). Absent ⇒ refuse no-cap-slice. */
  forward?: (req: GeminiCallRequest & { session: string }) => Promise<{ status: number; body: unknown }>;
  /** Live session registry check for the `X-Instar-Session` header. */
  isLiveSession: (name: string) => boolean;
  /** The money layer's reason → status map (wins over the default). */
  refusalHttp?: (reason: string, err: unknown) => GeminiRefusalHttp | null;
  /** Audit hook: one line per call (metadata only, never prompt text). */
  audit?: (row: Record<string, unknown>) => void;
  /**
   * Roots a reviewed spec may live under (E1): the agent home, plus the cartographer
   * root for the topic when that registry answers ok. Real paths.
   */
  reviewRoots?: () => string[];
  /**
   * The review door's state for `GET /intelligence/gemini/status`: `configured` once a
   * go-live record exists for the door; `ready` once it can admit a review here (or by
   * forwarding). Absent ⇒ not configured.
   */
  doorStatus?: () => { configured: boolean; ready: boolean; reason?: string };
  /** Forward a review to the holder (multi-machine slice). Absent ⇒ refuse no-cap-slice. */
  forwardReview?: (req: GeminiReviewBinding & { promptText: string; session: string }) => Promise<{ status: number; body: unknown }>;
}

/** The validated binding of an E1 review request to a real spec on disk. */
export interface GeminiReviewBinding {
  specRealPath: string;
  specSha256: string;
  round: number;
  run: string;
  callIdSeed: string;
}

/** Refusal reasons on which an E1 review steps down from Neon to Hydrogen (§2, D9). */
export const E1_STEP_DOWN_REASONS: ReadonlySet<string> = new Set(['cap-exceeded', 'per-call-ceiling']);

/**
 * Validate an E1 request against the disk (§2 "The spec must be real"). Pure apart from
 * fs reads. Returns the binding or a reason string.
 */
export function validateReviewRequest(
  body: Record<string, unknown>,
  roots: string[],
): { ok: true; binding: GeminiReviewBinding; promptText: string } | { ok: false; reason: string } {
  const specPath = typeof body.specPath === 'string' ? body.specPath : '';
  const specSha256 = typeof body.specSha256 === 'string' ? body.specSha256.toLowerCase() : '';
  const round = typeof body.round === 'number' && Number.isInteger(body.round) && body.round >= 1 && body.round <= 1000 ? body.round : null;
  const promptText = typeof body.promptText === 'string' ? body.promptText : '';
  const runNonce = typeof body.runNonce === 'string' && /^[a-f0-9]{8,64}$/.test(body.runNonce) ? body.runNonce : '';
  if (!specPath || !/^[a-f0-9]{64}$/.test(specSha256) || round === null || !promptText || !runNonce) return { ok: false, reason: 'bad-request' };
  let real: string;
  try { real = fs.realpathSync(specPath); } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ return { ok: false, reason: 'spec-not-found' }; }
  if (!/[\/]docs[\/]specs[\/][^\/]+\.md$/.test(real)) return { ok: false, reason: 'spec-not-under-docs-specs' };
  const realRoots = roots.map((r) => { try { return fs.realpathSync(r); } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ return null; } }).filter((r): r is string => !!r);
  if (!realRoots.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) return { ok: false, reason: 'spec-outside-allowed-roots' };
  let specText: string;
  try { specText = fs.readFileSync(real, 'utf-8'); } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ return { ok: false, reason: 'spec-not-found' }; }
  if (crypto.createHash('sha256').update(specText).digest('hex') !== specSha256) return { ok: false, reason: 'spec-sha-mismatch' };
  // The payload must carry this exact spec, under the assembler's header.
  const hdr = promptText.indexOf('--- SPEC UNDER REVIEW: ');
  if (hdr < 0 || !promptText.includes(`---\n${specText}`)) return { ok: false, reason: 'payload-not-bound-to-spec' };
  // Every inlined context doc must be one the spec lists, under the same checkout, and
  // its inlined text must be a prefix of the real file (the assembler may truncate).
  const repoRoot = path.resolve(path.dirname(real), '..', '..');
  const ctxRe = /^--- CONTEXT: (.+?) ---$/gm;
  let m: RegExpExecArray | null;
  while ((m = ctxRe.exec(promptText)) !== null) {
    const rel = m[1].trim();
    if (!specText.includes(rel)) return { ok: false, reason: 'context-not-listed-by-spec' };
    const abs = path.resolve(repoRoot, rel);
    if (!abs.startsWith(repoRoot + path.sep)) return { ok: false, reason: 'context-outside-checkout' };
    let content: string;
    try { content = fs.readFileSync(abs, 'utf-8'); } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ return { ok: false, reason: 'context-not-found' }; }
    const start = m.index + m[0].length + 1;
    const next = promptText.indexOf('\n--- ', start);
    const inlined = promptText.slice(start, next < 0 ? undefined : next);
    const probe = inlined.slice(0, Math.min(inlined.length, 4096));
    if (probe.length > 0 && !content.startsWith(probe)) return { ok: false, reason: 'context-not-bound' };
  }
  const rel = path.relative(repoRoot, real);
  return {
    ok: true,
    promptText,
    binding: { specRealPath: real, specSha256, round, run: `${rel}@${specSha256.slice(0, 8)}#${round}`, callIdSeed: runNonce },
  };
}

function sessionOf(req: Request, isLive: (n: string) => boolean): string {
  const raw = String(req.get('X-Instar-Session') ?? '').trim().slice(0, 120); // bounded-input-reviewed: a session-name attribution label for the ledger row, never prompt content
  if (!raw) return 'self-reported:unknown';
  return isLive(raw) ? raw : `self-reported:${raw}`;
}

function refusalReason(err: unknown): string | null {
  if (err instanceof GeminiApiRefusal) return err.reason;
  const r = (err as { reason?: unknown } | null)?.reason;
  return typeof r === 'string' ? r : null;
}

export function createGeminiPaygRoutes(deps: GeminiPaygRouteDeps): Router {
  const router = Router();

  router.post('/intelligence/gemini', async (req: Request, res: Response) => {
    if (!isLoopbackPeer(req.socket.remoteAddress) || hasForwardingHeaders(req.headers as Record<string, unknown>)) {
      res.status(403).json({ error: 'forbidden', reason: 'not-local', message: 'Second opinions are accepted only from this machine.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > GEMINI_ROUTE_MAX_BODY_BYTES) {
      const h = defaultGeminiRefusalHttp('request-too-large');
      res.status(h.status).json({ error: 'refused', reason: 'request-too-large', message: h.message });
      return;
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
    if (!prompt.trim() || !purpose || purpose.length > 200) {
      // A purpose is an attribution label; an over-long one is refused, never cut.
      res.status(400).json({ error: 'bad-request', message: '`prompt` and `purpose` (at most 200 characters) are required.' });
      return;
    }
    const model = typeof body.model === 'string' ? body.model : 'hydrogen';
    const session = sessionOf(req, deps.isLiveSession);
    const call: GeminiCallRequest = {
      caller: 'second-opinion',
      component: `second-opinion:${purpose}`,
      model,
      prompt,
      ...(typeof body.systemInstruction === 'string' ? { systemInstruction: body.systemInstruction } : {}),
      ...(typeof body.maxOutputTokens === 'number' ? { maxOutputTokens: body.maxOutputTokens } : {}),
      ...(typeof body.callId === 'string' && /^[a-f0-9]{16,128}$/.test(body.callId) ? { callId: body.callId } : {}),
      run: session,
    };

    if (!deps.isDesignatedHere()) {
      if (!deps.forward) {
        const h = defaultGeminiRefusalHttp('no-cap-slice');
        res.status(h.status).json({ error: 'refused', reason: 'no-cap-slice', message: h.message });
        return;
      }
      const fwd = await deps.forward({ ...call, session });
      res.status(fwd.status).json(fwd.body);
      return;
    }
    const out = await executeSecondOpinion(deps, call, session, purpose);
    res.status(out.status).json(out.body);
  });

  // The review driver's door probe (loopback only; no secrets in the answer).
  router.get('/intelligence/gemini/status', (req: Request, res: Response) => {
    if (!isLoopbackPeer(req.socket.remoteAddress) || hasForwardingHeaders(req.headers as Record<string, unknown>)) {
      res.status(403).json({ configured: false, ready: false, reason: 'not-local' });
      return;
    }
    let st: { configured: boolean; ready: boolean; reason?: string } = { configured: false, ready: false, reason: 'not-configured' };
    try { st = deps.doorStatus?.() ?? st; } catch { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */ st = { configured: false, ready: false, reason: 'status-unavailable' }; }
    res.json(st);
  });

  router.post('/intelligence/gemini/review', async (req: Request, res: Response) => {
    if (!isLoopbackPeer(req.socket.remoteAddress) || hasForwardingHeaders(req.headers as Record<string, unknown>)) {
      res.status(403).json({ status: 'unavailable', reason: 'not-local', message: 'Reviews are accepted only from this machine.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(body)) > GEMINI_ROUTE_MAX_BODY_BYTES) {
      res.status(422).json({ status: 'unavailable', reason: 'request-too-large', message: defaultGeminiRefusalHttp('request-too-large').message });
      return;
    }
    const v = validateReviewRequest(body, deps.reviewRoots?.() ?? []);
    if (!v.ok) {
      res.status(400).json({ status: 'unavailable', reason: v.reason, message: 'The review request does not match a real spec on this machine.' });
      return;
    }
    const session = sessionOf(req, deps.isLiveSession);
    if (!deps.isDesignatedHere()) {
      if (!deps.forwardReview) {
        res.status(503).json({ status: 'unavailable', reason: 'no-cap-slice', message: defaultGeminiRefusalHttp('no-cap-slice').message });
        return;
      }
      const fwd = await deps.forwardReview({ ...v.binding, promptText: v.promptText, session });
      res.status(fwd.status).json(fwd.body);
      return;
    }
    const out = await executeReview(deps, v.binding, v.promptText, session);
    res.status(out.status).json(out.body);
  });

  return router;
}

export interface ExecResult { status: number; body: unknown }

/**
 * Run a second opinion on THIS machine (the designated spender). Shared by the local
 * route and by the holder's handler for a forwarded call, so both paths are one path.
 */
export async function executeSecondOpinion(deps: Pick<GeminiPaygRouteDeps, 'provider' | 'refusalHttp' | 'audit'>, call: GeminiCallRequest, session: string, purpose: string): Promise<ExecResult> {
  const provider = deps.provider();
  if (!provider) {
    const h = defaultGeminiRefusalHttp('money-layer-off');
    return { status: h.status, body: { error: 'refused', reason: 'money-layer-off', message: h.message } };
  }
  try {
    const r = await provider.call({ ...call, caller: 'second-opinion' });
    deps.audit?.({ route: 'second-opinion', session, purpose, model: r.modelId, costUsd: r.costUsd, incomplete: r.incomplete, reserveId: r.reserveId });
    return { status: 200, body: { ok: true, text: r.text, model: r.modelId, incomplete: r.incomplete, finishReason: r.finishReason, costUsd: r.costUsd, inputTokens: r.inputTokens, reserveId: r.reserveId } };
  } catch (err) { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */
    const reason = refusalReason(err);
    if (!reason) return { status: 500, body: { error: 'internal', message: 'The Gemini call failed unexpectedly.' } };
    const h = deps.refusalHttp?.(reason, err) ?? defaultGeminiRefusalHttp(reason);
    deps.audit?.({ route: 'second-opinion', session, purpose, refused: reason });
    return { status: h.status, body: { error: 'refused', reason, message: h.message, ...(h.extras ?? {}) } };
  }
}

/**
 * Run an E1 review on THIS machine with an already-validated binding and the ORIGIN's
 * payload (a forwarded review is never re-assembled from the holder's own checkout).
 * Steps down from Neon to Hydrogen only on cap-exceeded / per-call-ceiling.
 */
export async function executeReview(deps: Pick<GeminiPaygRouteDeps, 'provider' | 'refusalHttp' | 'audit'>, binding: GeminiReviewBinding, promptText: string, session: string): Promise<ExecResult> {
  const provider = deps.provider();
  if (!provider) {
    return { status: 503, body: { status: 'unavailable', reason: 'money-layer-off', message: defaultGeminiRefusalHttp('money-layer-off').message } };
  }
  const attempt = async (model: 'neon' | 'hydrogen') => provider.call({
    caller: 'spec-review',
    component: 'spec-review',
    model,
    prompt: promptText,
    run: binding.run,
    callId: crypto.createHash('sha256').update(`e1|${binding.specSha256}|${binding.round}|${binding.callIdSeed}|${model}`).digest('hex'),
    e1Slot: { specSha256: binding.specSha256, round: binding.round },
  });
  let usedModel: 'neon' | 'hydrogen' = 'neon';
  let steppedDown: string | null = null;
  try {
    let r;
    try {
      r = await attempt('neon');
    } catch (err) { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */
      const reason = refusalReason(err);
      if (!reason || !E1_STEP_DOWN_REASONS.has(reason)) throw err;
      usedModel = 'hydrogen';
      steppedDown = reason;
      r = await attempt('hydrogen');
    }
    deps.audit?.({ route: 'spec-review', session, run: binding.run, model: r.modelId, costUsd: r.costUsd, incomplete: r.incomplete, steppedDown });
    return { status: 200, body: { status: 'ok', model: r.modelId, text: r.text, incomplete: r.incomplete, finishReason: r.finishReason, costUsd: r.costUsd, steppedDownFrom: steppedDown ? 'neon' : null, steppedDownReason: steppedDown, run: binding.run } };
  } catch (err) { /* @silent-fallback-ok: fail-closed — the caller gets an explicit refusal or unknown, never a pass */
    const reason = refusalReason(err);
    if (!reason) return { status: 500, body: { status: 'degraded', reason: 'internal', message: 'The Gemini review failed unexpectedly.' } };
    const h = deps.refusalHttp?.(reason, err) ?? defaultGeminiRefusalHttp(reason);
    deps.audit?.({ route: 'spec-review', session, run: binding.run, model: usedModel, refused: reason });
    return { status: h.status, body: { status: 'unavailable', reason, message: h.message, ...(h.extras ?? {}) } };
  }
}
