/**
 * GeminiApiProvider — the in-server, metered Gemini API door
 * (docs/specs/gemini-payg-metered-lane.md §1, §4.7, §5).
 *
 * One call, in this order (§5 "Reserve"):
 *   0. build ONE immutable request object; it is used for the secret check, the token
 *      count and the call, so what is checked is exactly what is sent;
 *   1. preflight through the money port (freeze, live, caller, release state, and an
 *      early refusal when the period is already spent) — BEFORE the key is used at all;
 *   2. exact-value live-secret check of the whole request (the ruled secrets exception);
 *      key-shaped patterns are only a recorded signal;
 *   3. countTokens on the exact request — a failure refuses `token-count-unavailable`
 *      before dispatch (no estimated fallback);
 *   4. reserve through the money port (tier selection, caps, shares, under the lock);
 *   5. generateContent with the derived timeout; never retried;
 *   6. settle by the §5 table: actual from usageMetadata, full reserve on a 200 without
 *      usage, no-charge on a pre-generation rejection, PROVISIONAL full reserve on any
 *      post-send failure.
 *
 * A client disconnect does not abort the upstream call: no caller signal is passed to
 * the transport. A response whose finishReason is not STOP is marked `incomplete`.
 * Google's text is untrusted output and is returned as data only.
 */

import crypto from 'node:crypto';
import type { IntelligenceOptions, IntelligenceProvider } from '../../../core/types.js';
import { billedOutputTokens, type ReleaseProofMarker } from '../../../core/MeteredSpendGate.js';
import { GeminiApiTransport, deriveGenerateTimeoutMs, type GeminiRequestBody, type GeminiTransportOutcome } from './geminiApiTransport.js';
import type { GeminiApiKeyReader } from './geminiApiKeyReader.js';
import { GEMINI_API_DEFAULT_SIZES, resolveGeminiApiModel, type GeminiApiModel } from './geminiApiModels.js';

export const GEMINI_API_DOOR = 'gemini-api';

export type GeminiCallerId = 'spec-review' | 'second-opinion' | 'nature-routing' | 'doorway-liveness' | 'release-proof';

/** A refusal raised by this door before or around the money gate. */
export class GeminiApiRefusal extends Error {
  constructor(public readonly reason: string, detail: string) {
    super(`gemini-api refused (${reason}): ${detail}`);
    this.name = 'GeminiApiRefusal';
  }
}

export interface GeminiReservation {
  reserveId: string;
  keyRef: string;
  reserveUsd: number;
  bookedInPerMtok: number;
  bookedOutPerMtok: number;
}

/** What the door needs from the money layer. Slice B's admission implements it. */
export interface GeminiMoneyPort {
  preflight(req: { caller: GeminiCallerId; component: string; modelId: string; callId?: string; proofMarker?: ReleaseProofMarker }): Promise<void>;
  reserve(req: {
    caller: GeminiCallerId;
    component: string;
    modelId: string;
    inputTokens: number;
    /** Output PLUS thinking — the gate prices this field alone (§5). */
    maxOutputTokens: number;
    callId?: string;
    requestSha256: string;
    run?: string;
    /** The recorder-minted marker (an in-process object; JSON can never produce one). */
    proofMarker?: ReleaseProofMarker;
    /** E1 only: the (spec hash, round) pass slot, reserved under the same lock (§2). */
    e1Slot?: { specSha256: string; round: number };
  }): Promise<GeminiReservation>;
  settleActual(keyRef: string, reserveId: string, usd: number): Promise<void>;
  settleNoCharge(keyRef: string, reserveId: string): Promise<void>;
  settleProvisional(keyRef: string, reserveId: string): Promise<void>;
  throughputFloorTps?(modelId: string): number | undefined;
}

export interface GeminiCallRequest {
  caller: GeminiCallerId;
  component: string;
  /** A model label (`neon`, `hydrogen`) or exact id. Unknown → refused, never defaulted. */
  model: string;
  prompt: string;
  systemInstruction?: string;
  maxOutputTokens?: number;
  thinkingBudget?: number;
  temperature?: number;
  callId?: string;
  run?: string;
  /**
   * INTERNAL: minted only by the release-proof recorder (`mintReleaseProofMarker`), never
   * from request input — every route rebuilds its call from an allowlist that has no such
   * field, and a JSON value can never be a registered marker object.
   */
  proofMarker?: ReleaseProofMarker;
  /** E1 only: the (spec hash, round) pass slot (§2 "one pass per round"). */
  e1Slot?: { specSha256: string; round: number };
}

export type SettleBooking =
  | { kind: 'actual'; usd: number }
  | { kind: 'full-reserve' }
  | { kind: 'no-charge' }
  | { kind: 'provisional' };

/** The §5 settle table as a pure function (unit-tested row by row). */
export function settleBookingFor(outcome: GeminiTransportOutcome, res: Pick<GeminiReservation, 'bookedInPerMtok' | 'bookedOutPerMtok'>): SettleBooking {
  if (outcome.kind === 'ok') {
    const usage = outcome.body.usageMetadata;
    const prompt = usage && typeof usage['promptTokenCount'] === 'number' && Number.isFinite(usage['promptTokenCount']) ? (usage['promptTokenCount'] as number) : null;
    const out = billedOutputTokens(GEMINI_API_DOOR, usage);
    if (prompt === null || out === null) return { kind: 'full-reserve' };
    return { kind: 'actual', usd: (prompt / 1e6) * res.bookedInPerMtok + (out / 1e6) * res.bookedOutPerMtok };
  }
  if (outcome.kind === 'rejected') return { kind: 'no-charge' };
  if (outcome.kind === 'not-sent') return { kind: 'no-charge' };
  return { kind: 'provisional' };
}

export interface GeminiCallResult {
  text: string;
  modelId: string;
  finishReason: string | null;
  /** finishReason other than STOP (for example MAX_TOKENS): never a clean result. */
  incomplete: boolean;
  inputTokens: number;
  usage: Record<string, unknown> | null;
  reserveId: string;
  booking: SettleBooking;
  costUsd: number;
  requestSha256: string;
}

export interface GeminiApiProviderOptions {
  money: GeminiMoneyPort;
  keyReader: Pick<GeminiApiKeyReader, 'withKey'>;
  transport?: GeminiApiTransport;
  /** Exact live secret values (vault + credential env) for the prompt check. */
  liveSecretValues: () => Iterable<string>;
  /** Signal-only hook for key-SHAPED text (never blocks, §4.7). */
  onKeyShapedSignal?: (count: number) => void;
}

const KEY_SHAPED = /AIza[0-9A-Za-z_\-]{30,}|sk-[A-Za-z0-9_\-]{20,}|ghp_[A-Za-z0-9]{30,}/g;
/** Values shorter than this are not treated as secrets for the exact-value scan (noise). */
const MIN_SECRET_LEN = 12;

/** Build the ONE immutable request object (§1). */
export function buildGeminiRequest(model: GeminiApiModel, req: GeminiCallRequest): GeminiRequestBody {
  const sizes = GEMINI_API_DEFAULT_SIZES[req.caller as keyof typeof GEMINI_API_DEFAULT_SIZES] ?? GEMINI_API_DEFAULT_SIZES['second-opinion'];
  const maxOut = clampPositiveInt(req.maxOutputTokens, sizes.maxOutputTokens);
  const thinking = clampNonNegInt(req.thinkingBudget, sizes.thinkingBudget);
  const body: GeminiRequestBody = {
    ...(req.systemInstruction ? { systemInstruction: { parts: [{ text: req.systemInstruction }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    generationConfig: {
      maxOutputTokens: maxOut,
      ...(typeof req.temperature === 'number' && Number.isFinite(req.temperature) ? { temperature: req.temperature } : {}),
      thinkingConfig: { thinkingBudget: thinking },
    },
  };
  void model;
  return deepFreeze(body);
}

function clampPositiveInt(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt;
}
function clampNonNegInt(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
}
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** The exact bytes that are checked and sent; its digest binds a forwarded payload. */
export function requestSha256(modelId: string, body: GeminiRequestBody): string {
  return crypto.createHash('sha256').update(JSON.stringify({ modelId, body })).digest('hex');
}

/** Exact-value check: does any live secret value appear in the request text? */
export function requestContainsLiveSecret(body: GeminiRequestBody, values: Iterable<string>): boolean {
  // Scan the RAW strings, not JSON: escaping would hide a secret containing a quote,
  // a backslash or a control character.
  const text = [
    ...(body.systemInstruction?.parts ?? []).map((p) => p.text),
    ...body.contents.flatMap((c) => c.parts.map((p) => p.text)),
  ].join('\n');
  for (const v of values) {
    if (typeof v === 'string' && v.length >= MIN_SECRET_LEN && text.includes(v)) return true;
  }
  return false;
}

export class GeminiApiProvider implements IntelligenceProvider {
  readonly frameworkId = GEMINI_API_DOOR;
  private readonly transport: GeminiApiTransport;

  constructor(private readonly opts: GeminiApiProviderOptions) {
    this.transport = opts.transport ?? new GeminiApiTransport();
  }

  /**
   * IntelligenceProvider adapter. Only for callers that already carry a caller id in
   * their attribution; anything else is refused (`not-allowlisted`) — the door is never
   * an ambient provider.
   */
  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const attribution = (options as { attribution?: { component?: string; caller?: GeminiCallerId; model?: string } } | undefined)?.attribution;
    if (!attribution?.caller || !attribution.component) {
      throw new GeminiApiRefusal('not-allowlisted', 'the gemini-api door needs an explicit caller and component');
    }
    const r = await this.call({
      caller: attribution.caller,
      component: attribution.component,
      model: attribution.model ?? 'hydrogen',
      prompt,
      ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
      ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
    });
    return r.text;
  }

  /** One metered call through the full §5 order. */
  async call(req: GeminiCallRequest): Promise<GeminiCallResult> {
    const model = resolveGeminiApiModel(req.model);
    if (!model) throw new GeminiApiRefusal('unknown-price', `unknown Gemini model '${String(req.model).slice(0, 40)}'`);
    const body = buildGeminiRequest(model, req);
    const sha = requestSha256(model.id, body);

    // 1) Preflight — before the key is touched.
    await this.opts.money.preflight({ caller: req.caller, component: req.component, modelId: model.id, ...(req.callId ? { callId: req.callId } : {}), ...(req.proofMarker ? { proofMarker: req.proofMarker } : {}) });

    // 2) Exact-value live-secret check (refuses); key-shaped text is a signal only.
    if (requestContainsLiveSecret(body, this.opts.liveSecretValues())) {
      throw new GeminiApiRefusal('prompt-contains-live-secret', 'the request contains a live secret value');
    }
    const shaped = JSON.stringify(body).match(KEY_SHAPED)?.length ?? 0;
    if (shaped > 0) {
      try { this.opts.onKeyShapedSignal?.(shaped); } catch { /* @silent-fallback-ok: signal-only */ }
    }

    return this.opts.keyReader.withKey(async (key) => {
      // 3) Count input tokens on the exact request.
      let inputTokens: number;
      try {
        inputTokens = await this.transport.countTokens(model.id, body, key);
      } catch {
        throw new GeminiApiRefusal('token-count-unavailable', 'countTokens failed, so the call cannot be priced — refused before dispatch');
      }

      // 4) Reserve (tier, caps, shares, under the lock).
      const reservedOut = body.generationConfig.maxOutputTokens + body.generationConfig.thinkingConfig.thinkingBudget;
      const reservation = await this.opts.money.reserve({
        caller: req.caller,
        component: req.component,
        modelId: model.id,
        inputTokens,
        maxOutputTokens: reservedOut,
        requestSha256: sha,
        ...(req.callId ? { callId: req.callId } : {}),
        ...(req.run ? { run: req.run } : {}),
        ...(req.proofMarker ? { proofMarker: req.proofMarker } : {}),
        ...(req.e1Slot ? { e1Slot: req.e1Slot } : {}),
      });

      // 5) The one billed call. Never retried; never aborted by a client disconnect.
      const timeoutMs = deriveGenerateTimeoutMs(reservedOut, this.opts.money.throughputFloorTps?.(model.id));
      const outcome = await this.transport.generateContent(model.id, body, key, timeoutMs);

      // 6) Settle by the table.
      const booking = settleBookingFor(outcome, reservation);
      let costUsd = 0;
      if (booking.kind === 'actual') {
        costUsd = booking.usd;
        await this.opts.money.settleActual(reservation.keyRef, reservation.reserveId, booking.usd);
      } else if (booking.kind === 'full-reserve') {
        costUsd = reservation.reserveUsd;
        await this.opts.money.settleActual(reservation.keyRef, reservation.reserveId, reservation.reserveUsd);
      } else if (booking.kind === 'no-charge') {
        await this.opts.money.settleNoCharge(reservation.keyRef, reservation.reserveId);
      } else {
        costUsd = reservation.reserveUsd;
        await this.opts.money.settleProvisional(reservation.keyRef, reservation.reserveId);
      }

      if (outcome.kind !== 'ok') {
        const why = outcome.kind === 'rejected' ? `HTTP ${outcome.status}${outcome.errorCode ? ` ${outcome.errorCode}` : ''}` : outcome.reason;
        throw new GeminiApiRefusal(outcome.kind === 'rejected' ? 'provider-rejected' : 'provider-failed', `Gemini call did not complete (${why}); booked ${booking.kind}`);
      }
      const cand = outcome.body.candidates?.[0];
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
      const finishReason = typeof cand?.finishReason === 'string' ? cand.finishReason : null;
      return {
        text,
        modelId: model.id,
        finishReason,
        incomplete: finishReason !== 'STOP',
        inputTokens,
        usage: outcome.body.usageMetadata ?? null,
        reserveId: reservation.reserveId,
        booking,
        costUsd,
        requestSha256: sha,
      };
    });
  }
}
