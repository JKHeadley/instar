/**
 * The run machine's HTTP client to its borrowed helpers (docs/specs/local-verify-borrowed-unit-slices.md, F).
 * The agent's Bearer token over the pool's own addresses; every request body is already signed by
 * the caller. Every failure reads as null (the shadow client counts it and moves on); nothing here
 * ever throws into a verify.
 */
import { HELPER_LIMITS } from './helper/helperProtocol.js';
import type { HelperTarget } from './helper/helperConfig.js';

export interface HelperStatusView {
  enabled: boolean;
  paused: boolean;
  helperVersion: string;
  trees: Array<{ headSha: string; state: 'preparing' | 'ready' | 'failed'; prepMs: number | null; copyMs?: number | null; reason?: string }>;
  /** `eligibleCount` and `incompatible` are the first design's; a version 2 helper no longer reports them (0 and false). */
  learned: { entries: Array<{ file: string; retrialDue?: boolean; reason?: string }>; eligibleCount: number; incompatible: boolean };
  /** Finished slices' signed answers the status answer carried (unparsed: the caller parses and verifies each). */
  results: Array<{ seq: number; answer: unknown }>;
  sandbox?: { ownerBusy?: boolean; containment?: { ok?: boolean; reason?: string | null } | null; startMs?: number | null; peakMemMb?: number | null; image?: { imageDigest?: unknown; settingsHash?: unknown } | null };
  /** The helper's runner version (a hash of its runner and sandbox-driver source), when it names one. */
  runnerVersion?: string;
  /**
   * The answer's body exactly as received, for the whole-status signature check
   * (`verifyHelperStatus`). Not enumerable, so a view compares and serialises as before.
   */
  raw?: Record<string, unknown>;
}

export interface HelperClient {
  /** POST a signed slice or prepare request: the HTTP status and parsed body, or null on transport failure. */
  slice(h: HelperTarget, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: unknown } | null>;
  cancel(h: HelperTarget, body: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<{ status: number; body: unknown } | null>;
  learned(h: HelperTarget, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown } | null>;
  /**
   * The helper's status. `query` narrows the finished slices it carries: one verify's, after a
   * sequence number. `timeoutMs` is the request's limit (10 s when absent; the request made at the
   * start of a verify passes 2 s, spec F "Asking the helper").
   */
  status(h: HelperTarget, signal?: AbortSignal, query?: { run?: string; since?: number }, timeoutMs?: number): Promise<HelperStatusView | null>;
}

export function parseHelperStatus(v: unknown): HelperStatusView | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if (b.enabled !== true || typeof b.helperVersion !== 'string' || !Array.isArray(b.trees)) return null;
  const learned = b.learned as Record<string, unknown> | undefined;
  if (!learned || !Array.isArray(learned.entries)) return null;
  const view: HelperStatusView = {
    enabled: true,
    paused: b.paused === true,
    helperVersion: b.helperVersion,
    ...(typeof b.runnerVersion === 'string' && b.runnerVersion.length <= 200 ? { runnerVersion: b.runnerVersion } : {}),
    trees: (b.trees as unknown[]).filter((t): t is HelperStatusView['trees'][number] => !!t && typeof (t as { headSha?: unknown }).headSha === 'string' && typeof (t as { state?: unknown }).state === 'string').slice(0, 10),
    learned: {
      entries: (learned.entries as unknown[]).filter((e): e is { file: string; retrialDue?: boolean } => !!e && typeof (e as { file?: unknown }).file === 'string').slice(0, 20_000),
      eligibleCount: typeof learned.eligibleCount === 'number' ? learned.eligibleCount : 0,
      incompatible: learned.incompatible === true,
    },
    results: (Array.isArray(b.results) ? b.results as unknown[] : [])
      .filter((r): r is { seq: number; answer: unknown } => !!r && typeof (r as { seq?: unknown }).seq === 'number' && Number.isSafeInteger((r as { seq: number }).seq))
      .slice(0, HELPER_LIMITS.statusResultsMax).map((r) => ({ seq: r.seq, answer: r.answer })),
    ...(b.sandbox && typeof b.sandbox === 'object' ? { sandbox: b.sandbox as HelperStatusView['sandbox'] } : {}),
  };
  Object.defineProperty(view, 'raw', { value: b, enumerable: false });
  return view;
}

/** The sandbox image a status answer names, as one string (`<image digest>:<settings hash>`), or null when it names none. */
export function statusImageIdentity(st: HelperStatusView): string | null {
  const i = st.sandbox?.image;
  if (!i || typeof i.imageDigest !== 'string' || typeof i.settingsHash !== 'string') return null;
  if (i.imageDigest.length === 0 || i.imageDigest.length > 140 || i.settingsHash.length === 0 || i.settingsHash.length > 140) return null;
  return `${i.imageDigest}:${i.settingsHash}`;
}

/** The largest helper answer the run machine reads: the 4 MB result cap plus the answer envelope. */
export const HELPER_RESPONSE_MAX_BYTES = HELPER_LIMITS.resultMaxBytes + 64 * 1024;

/** Read a response body up to `max` bytes; null (and the request aborted) the moment it passes the cap. */
export async function readBodyCapped(r: Response, max: number, ac?: AbortController): Promise<string | null> {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > max) {
      await reader.cancel().catch(() => undefined);
      ac?.abort();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

export function makeHelperClient(authToken: string, agentId: string, fetchImpl: typeof fetch = fetch): HelperClient {
  const call = async (url: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<{ status: number; body: unknown } | null> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const onOuter = () => ac.abort();
    outer?.addEventListener('abort', onOuter, { once: true });
    try {
      const r = await fetchImpl(url, { ...init, signal: ac.signal, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${authToken}`, 'X-Instar-AgentId': agentId, 'Content-Type': 'application/json' } });
      // The run machine reads at most the helper's own result cap (plus the answer envelope), streaming:
      // past it the answer is refused without buffering any more of it.
      const text = await readBodyCapped(r, HELPER_RESPONSE_MAX_BYTES, ac);
      if (text === null) return { status: r.status, body: null };
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; } // @silent-fallback-ok: an unparseable body reads as no answer
      return { status: r.status, body };
    } catch {
      return null; // @silent-fallback-ok: unreachable or timed out; the shadow client counts it toward the breaker
    } finally {
      clearTimeout(t);
      outer?.removeEventListener('abort', onOuter);
    }
  };
  return {
    slice: (h, body, timeoutMs, signal) => call(`${h.url}/local-verify/helper-slice`, { method: 'POST', body: JSON.stringify(body) }, timeoutMs, signal),
    cancel: (h, body, signal, timeoutMs) => call(`${h.url}/local-verify/helper-slice/cancel`, { method: 'POST', body: JSON.stringify(body) }, timeoutMs ?? 15_000, signal),
    learned: (h, body, signal) => call(`${h.url}/local-verify/helper-learned`, { method: 'POST', body: JSON.stringify(body) }, 15_000, signal),
    async status(h, signal, query, timeoutMs) {
      const qs = new URLSearchParams();
      if (query?.run) qs.set('run', query.run);
      if (query?.since !== undefined) qs.set('since', String(query.since));
      const r = await call(`${h.url}/local-verify/helper-status${qs.size > 0 ? `?${qs.toString()}` : ''}`, { method: 'GET' }, timeoutMs ?? 10_000, signal);
      return r && r.status === 200 ? parseHelperStatus(r.body) : null;
    },
  };
}
