/**
 * durableSecretScrub — the ONE shared credential-pattern module + the
 * metadata-returning `scrubForStore` variant (Durable-Output Hygiene Standard,
 * "What Persists Must Be Clean" — docs/specs/durable-output-hygiene-standard.md
 * §2 "Layer B mechanics", rollout step 0).
 *
 * WHY this module exists (spec §2, round-1 MATERIAL finding): "the existing
 * scrubber" was ≥3 diverged inline copies — `scrubSecrets` (src/monitoring/
 * scrubSecrets.ts), `autonomousHeartbeatScrub` (src/monitoring/), and
 * `SecretRedactor.BUILTIN_PATTERNS` (src/core/) — already drifted on the
 * Anthropic key prefix (`sk-ant-api…` vs `sk-ant-…`). Building a FOURTH copy for
 * the durable-output safety floor would bake Class-1 drift into the floor
 * itself. This is the single authoritative pattern set; Layer B consumes it, and
 * the existing copies migrate/ratchet to it as a tracked rollout follow-up
 * (docs/specs/durable-output-hygiene-standard.md §2 rollout step 0).
 *
 * WHAT it guarantees (spec §2 "Layer B is the SECURITY FLOOR"): a deterministic,
 * best-effort SPAN redaction over model output BEFORE it persists into durable
 * storage. LLM compliance (Layer A, the prompt clause) is probabilistic; this
 * floor is not. HONEST COVERAGE (spec §1 registry text): KNOWN TOKEN SHAPES
 * ONLY — the floor catches what matches its patterns; encoded / split /
 * paraphrased secrets are only reachable by the prompt rule, and against novel
 * adversarial obfuscation this is BEST-EFFORT, never a reliable standalone
 * security control.
 *
 * FAILURE SEMANTICS (spec §2 "fail-safe-toward-redaction, never fail-open"): on
 * a scrub exception OR an input over the size bound, the whole field is replaced
 * with a typed marker (`[REDACTED:scrub-error]` / `[REDACTED:oversize]`) + a
 * preserved-length note — raw bytes NEVER land because the scrub broke. There is
 * NO runtime timeout pretense (a synchronous regex pass cannot be preempted
 * in-process): instead the pinned test asserts a worst-case timing budget on
 * pathological inputs and forbids non-linear patterns (no nested quantifiers), so
 * the budget is proven in CI, not hoped at runtime.
 *
 * TELEMETRY SAFETY (spec §2 "dry-run leak-path guard"): the returned redaction
 * metadata carries pattern-kind + offset/length ONLY — NEVER matched bytes,
 * never surrounding context. A would-redact record that quoted its match would
 * BE the Class-4 defect, reintroduced by the fix's own soak mode.
 *
 * PURE + no I/O: this module is a deterministic, unit-testable function. Config
 * gating, metrics, provenance markers, and the poisoning alarm live one layer up
 * in DurableOutputScrubber (src/monitoring/).
 */

/** A durable-secret pattern kind — the typed label on every redaction span. */
export type DurableSecretKind =
  | 'anthropic-key'
  | 'openai-key'
  | 'github-token'
  | 'slack-token'
  | 'aws-access-key'
  | 'stripe-key'
  | 'google-api-key'
  | 'telegram-bot-token'
  | 'jwt'
  | 'pem-private-key'
  | 'bearer-token'
  | 'url-embedded-credential'
  | 'labeled-secret';

/** A structural failure marker kind (fail-safe path — never a real match). */
export type DurableScrubFailureKind = 'scrub-error' | 'oversize';

/** One redacted span. offset/length are in ORIGINAL-text coordinates. NEVER
 *  carries the matched bytes (telemetry-safety, spec §2). */
export interface RedactionSpan {
  kind: DurableSecretKind | DurableScrubFailureKind;
  /** Byte/char offset in the ORIGINAL input where the redacted span began. */
  offset: number;
  /** Length (in chars) of the ORIGINAL span that was replaced. */
  length: number;
}

export interface ScrubForStoreResult {
  /** The scrubbed text — matched spans replaced with `[REDACTED:<kind>]`. */
  text: string;
  /** Structured redaction metadata (spec §2 — kind/offset/length only). */
  redactions: RedactionSpan[];
  /** True when the whole field was replaced because the input exceeded the size bound. */
  truncated?: boolean;
  /** True when the whole field was replaced because the scrub itself threw. */
  error?: boolean;
}

/** One credential pattern. `group` names the capture group whose span is
 *  redacted (default 0 = the whole match) so a labelled pair can keep its label
 *  and redact only the value. Every regex carries `gd` (global + hasIndices) so
 *  group offsets are read from `match.indices`. */
interface ScrubPattern {
  kind: DurableSecretKind;
  regex: RegExp;
  group?: number;
}

/**
 * The authoritative pattern set — the UNION of the three pre-existing copies
 * (spec Frontloaded Decision #1). ORDER MATTERS for overlap resolution: the
 * more-specific prefix patterns (anthropic before generic openai `sk-`, stripe
 * `sk_` before generic) sit earlier so the greedy first-wins overlap resolver
 * labels a span with its most-specific kind.
 *
 * LINEARITY CONTRACT (spec §2): every pattern uses SINGLE quantifiers over
 * character classes with no nesting — no `(x+)+` / `(x*)*` shapes — so a
 * pathological input cannot trigger catastrophic backtracking. The pinned test
 * (tests/unit/durableSecretScrub.test.ts) asserts both the per-kind coverage and
 * a worst-case timing budget on adversarial inputs, and forbids nested
 * quantifiers structurally.
 */
export const DURABLE_SECRET_PATTERNS: readonly ScrubPattern[] = [
  // Anthropic API keys — catches BOTH the drifted `sk-ant-api…` and `sk-ant-…`
  // shapes the three copies disagreed on (spec §2, the Anthropic-prefix drift).
  { kind: 'anthropic-key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/gd },
  // Stripe live/test keys (before the generic openai `sk-` — distinct `_` sep).
  { kind: 'stripe-key', regex: /sk_(?:live|test)_[A-Za-z0-9]{12,}/gd },
  // Generic provider keys: sk-/pk-/rk- prefixed (OpenAI + generic).
  { kind: 'openai-key', regex: /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/gd },
  // GitHub PAT / OAuth / app tokens (ghp_/gho_/ghu_/ghs_/ghr_).
  { kind: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/gd },
  // Google API keys (AIza + 35 url-safe chars).
  { kind: 'google-api-key', regex: /\bAIza[A-Za-z0-9_-]{35}/gd },
  // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs- + segments.
  { kind: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/gd },
  // AWS access key IDs (AKIA/ASIA + 16 uppercase alphanumerics).
  { kind: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gd },
  // Telegram bot tokens: <digits>:<35-char base64url-ish secret>.
  { kind: 'telegram-bot-token', regex: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/gd },
  // PEM private-key blocks. Lazy body over a RESTRICTED char class terminated by
  // a literal `-----END…` — single quantifier, no nesting, linear.
  {
    kind: 'pem-private-key',
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,8192}?-----END[A-Z ]*PRIVATE KEY-----/gd,
  },
  // JWTs: three base64url segments. Known FP suspect on dotted identifiers
  // (spec rollout step 2) — surfaced per-pattern-kind in the dry-run soak.
  { kind: 'jwt', regex: /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{16,}\b/gd },
  // Bearer tokens.
  { kind: 'bearer-token', regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/gd },
  // URLs with embedded credentials (scheme://user:pass@host) — redact the
  // credential group (group 1), keep the scheme/host structure readable.
  {
    kind: 'url-embedded-credential',
    regex: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gd,
    group: undefined, // whole match replaced; the scheme is short + re-derivable
  },
  // Labelled secret pairs (token=…, api_key: …, password "…") — redact only the
  // VALUE group so the label survives ("a <label> was redacted").
  {
    kind: 'labeled-secret',
    regex: /(?:token|secret|password|passwd|pwd|api[_-]?key)(?:["'=:\s]+)([A-Za-z0-9._-]{12,})/gid,
    group: 1,
  },
] as const;

/** Default input size bound (spec §2: 1 MB). Over this, the whole field is
 *  replaced with `[REDACTED:oversize]` (fail-safe — never persist raw bytes the
 *  scrub could not fully walk). */
export const DEFAULT_MAX_SCRUB_BYTES = 1_000_000;

export interface ScrubForStoreOptions {
  /** Input size bound in chars. Over this → whole-field `[REDACTED:oversize]`. */
  maxBytes?: number;
}

/** Build the typed marker for a redacted span. */
function markerFor(kind: RedactionSpan['kind']): string {
  return `[REDACTED:${kind}]`;
}

interface RawSpan {
  start: number;
  end: number;
  kind: DurableSecretKind;
}

/**
 * scrubForStore — the metadata-returning safety-floor scrub (spec §2).
 *
 * Replaces every matched credential span with a typed `[REDACTED:<kind>]` marker
 * and returns the structured redaction metadata (kind/offset/length ONLY, never
 * the matched bytes). Fail-safe on both edges:
 *   - input over `maxBytes` → whole field `[REDACTED:oversize]` (truncated:true);
 *   - any internal throw     → whole field `[REDACTED:scrub-error]` (error:true).
 *
 * A benign string with no matches returns `{ text: <unchanged>, redactions: [] }`.
 */
export function scrubForStore(
  input: string,
  options: ScrubForStoreOptions = {},
): ScrubForStoreResult {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SCRUB_BYTES;

  // Fail-safe edge 1: oversize. A field too large to be walked with a proven
  // timing budget is replaced wholesale rather than partially scanned.
  if (text.length > maxBytes) {
    return {
      text: `${markerFor('oversize')} (${text.length} chars withheld)`,
      redactions: [{ kind: 'oversize', offset: 0, length: text.length }],
      truncated: true,
    };
  }

  try {
    // 1. Collect every match span across all patterns over the ORIGINAL text.
    const raw: RawSpan[] = [];
    for (const { kind, regex, group } of DURABLE_SECRET_PATTERNS) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        const gi = group ?? 0;
        const indices = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices;
        const span = indices?.[gi] ?? (gi === 0 ? [m.index, m.index + m[0].length] as [number, number] : undefined);
        if (span && span[1] > span[0]) {
          raw.push({ start: span[0], end: span[1], kind });
        }
        // Guard against a zero-width match wedging the loop.
        if (m[0].length === 0) regex.lastIndex++;
      }
    }

    if (raw.length === 0) {
      return { text, redactions: [] };
    }

    // 2. Overlap resolution: sort by start asc, then longest-first; greedily
    //    accept non-overlapping spans (first/longest wins → most-specific kind).
    raw.sort((a, b) => (a.start - b.start) || (b.end - a.end));
    const accepted: RawSpan[] = [];
    let cursor = -1;
    for (const s of raw) {
      if (s.start >= cursor) {
        accepted.push(s);
        cursor = s.end;
      }
    }

    // 3. Build the scrubbed output + the metadata (original-text coordinates).
    let out = '';
    let last = 0;
    const redactions: RedactionSpan[] = [];
    for (const s of accepted) {
      out += text.slice(last, s.start) + markerFor(s.kind);
      redactions.push({ kind: s.kind, offset: s.start, length: s.end - s.start });
      last = s.end;
    }
    out += text.slice(last);

    return { text: out, redactions };
  } catch { // @silent-fallback-ok — fail-safe-toward-redaction: a scrub throw must NEVER persist raw bytes (spec §2). The whole field is withheld under a typed marker and the caller records the error via the returned error:true flag.
    return {
      text: `${markerFor('scrub-error')} (${text.length} chars withheld)`,
      redactions: [{ kind: 'scrub-error', offset: 0, length: text.length }],
      error: true,
    };
  }
}

/**
 * scrubStructured — apply the floor to every string field of a shallow record,
 * returning the scrubbed record + the union of redactions (each tagged with its
 * field). Used by structured stores (spec §2: "Scrub runs BEFORE serialization
 * where the store writes structured fields"). Non-string fields pass through
 * untouched; string-array fields are scrubbed element-wise.
 */
export interface StructuredRedactionSpan extends RedactionSpan {
  field: string;
}

export interface ScrubStructuredResult<T> {
  record: T;
  redactions: StructuredRedactionSpan[];
  truncated: boolean;
  error: boolean;
}

export function scrubStructured<T extends Record<string, unknown>>(
  record: T,
  fields: readonly (keyof T)[],
  options: ScrubForStoreOptions = {},
): ScrubStructuredResult<T> {
  const out: Record<string, unknown> = { ...record };
  const redactions: StructuredRedactionSpan[] = [];
  let truncated = false;
  let error = false;

  for (const field of fields) {
    const value = record[field];
    const fieldName = String(field);
    if (typeof value === 'string') {
      const r = scrubForStore(value, options);
      out[fieldName] = r.text;
      if (r.truncated) truncated = true;
      if (r.error) error = true;
      for (const span of r.redactions) redactions.push({ ...span, field: fieldName });
    } else if (Array.isArray(value)) {
      out[fieldName] = value.map((el) => {
        if (typeof el !== 'string') return el;
        const r = scrubForStore(el, options);
        if (r.truncated) truncated = true;
        if (r.error) error = true;
        for (const span of r.redactions) redactions.push({ ...span, field: fieldName });
        return r.text;
      });
    }
  }

  return { record: out as T, redactions, truncated, error };
}
