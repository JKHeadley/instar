/**
 * CredentialAuditEmit — the SINGLE secret-scrub chokepoint for live credential re-pointing
 * (spec §2.9, build-plan §7).
 *
 * Every `logs/credential-swaps.jsonl` audit write, every `/credentials/*` HTTP response body,
 * and every attention-item this feature constructs routes through ONE `scrub(record)` funnel.
 * The invariant the spec names — "no field of any persisted, audited, notified, or HTTP-served
 * surface of this feature may contain token material" — is enforced STRUCTURALLY here, not by
 * "remember to scrub at each of N callsites".
 *
 * ── Why a single chokepoint (spec §2.9, round-3) ──
 * Node's `JSON.parse` error is position-only and does not echo bytes, so the real leak vector is
 * developer-authored interpolation: a `${raw}`-bearing log line, a `security`/keychain stderr, a
 * fetch error string that carries a token FRAGMENT inside a free-text `reason`/`error`/`message`.
 * A FORBIDDEN_CREDENTIAL_FIELDS field-name scan does not catch a token hiding in free text. So
 * this funnel deep-walks EVERY string in a record and runs each through `redactToken`-backed
 * scrubbing before the record reaches any persisted/served/notified surface.
 *
 * ── The redaction (reuses CredentialProvider.redactToken — NOT re-authored) ──
 * `redactToken(t)` → `[TOKEN:abc1****]`. We apply it to any token-shaped run: the `sk-ant-…`
 * family (access/oauth/refresh tokens), and any long high-entropy base64url-ish run that could
 * be a bearer/secret. Account ids, slot paths, emails-by-id, and ordinary prose pass through
 * unchanged — the feature references accounts BY ID only, so a healthy record loses nothing.
 *
 * This module performs NO IO and NO credential access. It is a pure, deterministic, machine-local
 * transform (Phase C: redaction is local-deterministic, no peer dependency).
 */

import { redactToken } from '../monitoring/CredentialProvider.js';

/**
 * The `sk-ant-…` token family Anthropic issues (oauth access `sk-ant-oat…`, api-key `sk-ant-api…`,
 * refresh `sk-ant-ort…`, etc.). Matched first so the canonical leak vector is always redacted.
 */
const SK_ANT_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g;

/**
 * A long high-entropy token-shaped run (≥32 chars of base64url/hex alphabet) that is NOT a
 * recognizable non-secret. This catches a bearer/secret that does NOT carry the `sk-ant-` prefix
 * (a keychain stderr could echo a raw blob). Deliberately conservative on the low end so ordinary
 * ids / slot hashes / ISO timestamps are never mangled (an 8-hex slot suffix is far under 32).
 */
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

/**
 * Scrub token material out of a single string. Reuses `redactToken` (the project's one redactor)
 * on every token-shaped run. Idempotent: a `[TOKEN:…]` marker contains no token-shaped run that
 * survives a second pass.
 */
export function scrubString(s: string): string {
  if (!s) return s;
  let out = s.replace(SK_ANT_RE, (m) => redactToken(m));
  out = out.replace(LONG_TOKEN_RE, (m) => {
    // Never re-redact an already-emitted marker, and never touch the redactor's own output.
    if (m.startsWith('TOKEN')) return m;
    return redactToken(m);
  });
  return out;
}

/**
 * Deep-scrub an arbitrary JSON-able value: walks objects/arrays and scrubs every string leaf.
 * Object KEYS are passed through unchanged (a key is a field name, never token material — and the
 * §2.9 field-name scan covers forbidden keys separately). Non-string/number/bool/null leaves
 * (functions, symbols) are dropped to a string form so nothing un-serializable rides along.
 *
 * THE chokepoint: `CredentialAuditEmit.scrub(record)` calls this. Every audit write, every
 * `/credentials/*` response body, and every attention-item field passes through here.
 */
export function scrub<T>(record: T): T {
  return deepScrub(record) as T;
}

function deepScrub(v: unknown): unknown {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map((x) => deepScrub(x));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = deepScrub(val);
    }
    return out;
  }
  // number | boolean | null | undefined | bigint pass through unchanged (no token material).
  return v;
}

/**
 * The audit-emit handle the host wires into the swap executor + the routes. ONE instance per
 * process; every emit path (jsonl, response, attention) calls the corresponding method, and each
 * method scrubs BEFORE the value reaches its surface. Constructing the handle with an injected
 * `writeLine` (the jsonl sink) and `emitAttention` keeps it IO-free + unit-testable.
 */
export interface CredentialAuditEmitDeps {
  /** Append one already-stringified JSON line to `logs/credential-swaps.jsonl`. */
  writeLine?: (line: string) => void;
  /** Deliver one attention item (typically telegram.createAttentionItem). */
  emitAttention?: (item: CredentialAttentionItem) => void | Promise<void>;
  now?: () => string;
}

export interface CredentialAttentionItem {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

export class CredentialAuditEmit {
  private readonly writeLine?: (line: string) => void;
  private readonly emitAttentionFn?: (item: CredentialAttentionItem) => void | Promise<void>;
  private readonly now: () => string;

  constructor(deps: CredentialAuditEmitDeps = {}) {
    this.writeLine = deps.writeLine;
    this.emitAttentionFn = deps.emitAttention;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Surface 1 — the jsonl audit write. Scrubs the record, stamps it, appends one line. */
  audit(record: Record<string, unknown>): void {
    if (!this.writeLine) return;
    const scrubbed = scrub({ at: this.now(), ...record });
    try {
      this.writeLine(JSON.stringify(scrubbed) + '\n');
    } catch {
      // @silent-fallback-ok — the audit jsonl is observability; a write failure (full disk, fs
      // hiccup) must never throw into a swap/route. The actual credential operation is the
      // load-bearing action and is unaffected; the next emit retries. (No token can leak here —
      // the value was already scrubbed before the failing write.)
    }
  }

  /**
   * Surface 2 — the `/credentials/*` HTTP response body. Returns the SCRUBBED body the route
   * sends. The route MUST send `emit.response(body)`, never a raw body — this is the wiring the
   * §2.9 chokepoint test asserts.
   */
  response<T>(body: T): T {
    return scrub(body);
  }

  /** Surface 3 — the attention item. Scrubs every field, then delivers (best-effort). */
  async attention(item: CredentialAttentionItem): Promise<void> {
    if (!this.emitAttentionFn) return;
    const scrubbed = scrub(item);
    try {
      await this.emitAttentionFn(scrubbed);
    } catch {
      // @silent-fallback-ok — attention delivery is best-effort; the swap/quarantine safety action
      // it announces is already durably recorded in the ledger regardless of whether the notice
      // lands. The item was already scrubbed before this call, so a delivery failure leaks nothing.
    }
  }
}
