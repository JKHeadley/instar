/**
 * geminiApiTransport — the ONLY network calls of the `gemini-api` metered door
 * (docs/specs/gemini-payg-metered-lane.md §1, §4.8).
 *
 * - The host is a CODE CONSTANT. There is no config or base-URL override, so a prompt can
 *   never be redirected to another endpoint. Tests inject a fake origin through the
 *   constructor only; that parameter is not reachable from config or HTTP.
 * - The key travels ONLY in the `x-goog-api-key` header: never in a URL, never in a
 *   query string, never in an error, a log line or a stack.
 * - Two operations: `countTokens` (free metadata) and `generateContent` (billed).
 * - No retries here, ever. A caller retry is a new reservation (§5 "No retries").
 * - The upstream call is NOT aborted when a client disconnects: the call completes and
 *   settles at its actual cost. Only the derived timeout ends it.
 *
 * This file is the single `scripts/lint-no-direct-llm-http.js` allowlist entry the spec
 * names for this door.
 */

export const GEMINI_API_HOST = 'generativelanguage.googleapis.com';
const GEMINI_API_ORIGIN = `https://${GEMINI_API_HOST}`;
const API_VERSION = 'v1beta';

/** Outer bound on any generateContent call (§1). */
export const GEMINI_API_MAX_TIMEOUT_MS = 900_000;
/** countTokens is metadata only; no money is at risk (§1). */
export const GEMINI_API_COUNT_TOKENS_TIMEOUT_MS = 15_000;
/** Default output throughput floor until Run 2 measures each model (§1). */
export const DEFAULT_THROUGHPUT_FLOOR_TPS = 40;

/**
 * The derived HTTP timeout: `30s + reservedOutputTokens ÷ throughputFloor`, capped at
 * 900s. A post-send timeout books a provisional charge, so it must outlast a healthy call.
 */
export function deriveGenerateTimeoutMs(reservedOutputTokens: number, throughputFloorTps: number | undefined): number {
  const floor = Number.isFinite(throughputFloorTps) && (throughputFloorTps as number) > 0 ? (throughputFloorTps as number) : DEFAULT_THROUGHPUT_FLOOR_TPS;
  const out = Number.isFinite(reservedOutputTokens) && reservedOutputTokens > 0 ? reservedOutputTokens : 0;
  return Math.min(GEMINI_API_MAX_TIMEOUT_MS, 30_000 + Math.ceil((out / floor) * 1000));
}

/** The one immutable request shape (system instruction + contents + generation config). */
export interface GeminiRequestBody {
  readonly systemInstruction?: { readonly parts: ReadonlyArray<{ readonly text: string }> };
  readonly contents: ReadonlyArray<{ readonly role: 'user' | 'model'; readonly parts: ReadonlyArray<{ readonly text: string }> }>;
  readonly generationConfig: {
    readonly maxOutputTokens: number;
    readonly temperature?: number;
    readonly thinkingConfig: { readonly thinkingBudget: number };
  };
}

/** How a generateContent attempt ended, as far as the transport can tell. */
export type GeminiTransportOutcome =
  /** HTTP 200 with a parsed body. */
  | { kind: 'ok'; status: 200; body: GeminiGenerateResponse }
  /** A request-rejection status returned before any generation (400/401/403/404/429). */
  | { kind: 'rejected'; status: number; errorCode: string | null }
  /** The request was SENT and then failed (5xx, timeout, connection drop, unparsable 200). */
  | { kind: 'post-send-failure'; status: number | null; reason: string }
  /** Nothing was sent (DNS/connect failure before the request left). */
  | { kind: 'not-sent'; reason: string };

export interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: Record<string, unknown>;
  modelVersion?: string;
}

/** Request-rejection codes: issued before generation, no usage returned (§5 settle table). */
export const PRE_GENERATION_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 429]);

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface GeminiApiTransportOptions {
  fetchImpl?: FetchLike;
  /** TEST-ONLY fake origin (e.g. http://127.0.0.1:PORT). Never read from config or HTTP. */
  testOrigin?: string;
}

/** Remove every occurrence of a secret from a string (used before anything is rethrown). */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

export class GeminiApiTransport {
  private readonly fetchImpl: FetchLike;
  private readonly origin: string;

  constructor(opts: GeminiApiTransportOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
    this.origin = opts.testOrigin ?? GEMINI_API_ORIGIN;
  }

  private url(modelId: string, op: 'countTokens' | 'generateContent'): string {
    if (!/^[a-z0-9][a-z0-9.\-]*$/i.test(modelId)) throw new Error('gemini-api: invalid model id');
    return `${this.origin}/${API_VERSION}/models/${modelId}:${op}`;
  }

  private headers(key: string): Record<string, string> {
    return { 'content-type': 'application/json', 'x-goog-api-key': key };
  }

  /**
   * Count input tokens for the EXACT request (system instruction included). Returns the
   * total, or throws a key-free error. countTokens is free metadata.
   */
  async countTokens(modelId: string, body: GeminiRequestBody, key: string): Promise<number> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), GEMINI_API_COUNT_TOKENS_TIMEOUT_MS);
    try {
      // countTokens takes the full generate request under `generateContentRequest` so the
      // system instruction is counted too.
      const payload = JSON.stringify({ generateContentRequest: { model: `models/${modelId}`, ...body } });
      const res = await this.fetchImpl(this.url(modelId, 'countTokens'), { method: 'POST', headers: this.headers(key), body: payload, signal: ctl.signal });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`gemini-api countTokens HTTP ${res.status}`);
      const parsed = JSON.parse(text) as { totalTokens?: unknown };
      const n = parsed.totalTokens;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error('gemini-api countTokens returned no totalTokens');
      return n;
    } catch (err) {
      throw new Error(redactSecret(`gemini-api countTokens failed: ${err instanceof Error ? err.message : String(err)}`, key));
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * One billed generateContent call. Never throws: every ending is classified into a
   * `GeminiTransportOutcome` the settle table maps to a booking.
   */
  async generateContent(modelId: string, body: GeminiRequestBody, key: string, timeoutMs: number): Promise<GeminiTransportOutcome> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.min(GEMINI_API_MAX_TIMEOUT_MS, Math.max(1, timeoutMs)));
    let sent = false;
    try {
      const url = this.url(modelId, 'generateContent');
      const payload = JSON.stringify(body);
      sent = true; // from here on the request may have reached Google
      const res = await this.fetchImpl(url, { method: 'POST', headers: this.headers(key), body: payload, signal: ctl.signal });
      const text = await res.text();
      if (res.status === 200) {
        try {
          return { kind: 'ok', status: 200, body: JSON.parse(text) as GeminiGenerateResponse };
        } catch {
          return { kind: 'post-send-failure', status: 200, reason: 'unparsable-200' };
        }
      }
      if (PRE_GENERATION_REJECTION_STATUSES.has(res.status)) {
        let errorCode: string | null = null;
        try {
          const e = JSON.parse(text) as { error?: { status?: unknown } };
          errorCode = typeof e.error?.status === 'string' ? e.error.status.slice(0, 64) : null;
        } catch { /* @silent-fallback-ok: the status code alone classifies a rejection */ }
        return { kind: 'rejected', status: res.status, errorCode };
      }
      return { kind: 'post-send-failure', status: res.status, reason: `http-${res.status}` };
    } catch (err) {
      const reason = redactSecret(err instanceof Error ? (err.name === 'AbortError' ? 'timeout' : err.message) : String(err), key).slice(0, 200);
      return sent ? { kind: 'post-send-failure', status: null, reason } : { kind: 'not-sent', reason };
    } finally {
      clearTimeout(t);
    }
  }
}
