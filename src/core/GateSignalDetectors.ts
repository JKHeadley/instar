/**
 * GateSignalDetectors — §Design 8 of gate-prompts-judge-by-meaning-not-literal-lists
 * (CMT-1793, Phase 2).
 *
 * THE MIGRATION: rules B1–B7 used to LITERAL-match inside the tone-gate PROMPT
 * (a brittle filter wearing the LLM's authority — a paraphrase or an
 * unanticipated form evaded it, and the model's contextual judgment was
 * discarded). The new contract (Intelligent Prompts — An LLM Gate Must Not
 * String-Match) moves the pattern-matching OUT of the prompt: a deterministic
 * detector emits a normalized `GateSignal`, the signal is supplied to the LLM
 * as input/context, and the LLM decides IN CONTEXT what to do with it (e.g. "a
 * file path was detected at span X — is it shown for the user to act on, or
 * mentioned in passing?"). This is the same shape B8/B9/B12/B20 already use.
 *
 * SECURITY (the §Design 8 envelope + clamping contract): every emitted signal
 * is sanitized at the boundary — `kind` validated against the closed
 * `GATE_SIGNAL_KINDS` enum, `confidence` clamped to [0,1], `spans` bounded to
 * the candidate length and dropped if malformed, and `normalizedValue` length-
 * clamped. A `normalizedValue` is UNTRUSTED data describing the candidate (it
 * may itself be attacker-derived — e.g. a "path" containing envelope-breaking
 * characters), so the caller renders the signal list inside its OWN per-call
 * random boundary and the prompt treats every field as data, never an
 * instruction. These detectors NEVER block — they are signal producers; the
 * MessagingToneGate is the single authority (docs/signal-vs-authority.md).
 */

/** §Design 8: closed set of deterministic-detector signal kinds for B1–B7. */
export type GateSignalKind =
  | 'cli-command' // B1
  | 'file-path' // B2
  | 'config-key' // B3
  | 'copy-paste-code' // B4
  | 'api-endpoint' // B5
  | 'env-var' // B6
  | 'cron-or-slug'; // B7

/** The closed enum, single-sourced. A kind outside this set is rejected at sanitize. */
export const GATE_SIGNAL_KINDS: readonly GateSignalKind[] = [
  'cli-command',
  'file-path',
  'config-key',
  'copy-paste-code',
  'api-endpoint',
  'env-var',
  'cron-or-slug',
] as const;

/** Map each kind → the B-rule it informs (for prompt rendering + the ratchet). */
export const GATE_SIGNAL_KIND_TO_RULE: Record<GateSignalKind, string> = {
  'cli-command': 'B1_CLI_COMMAND',
  'file-path': 'B2_FILE_PATH',
  'config-key': 'B3_CONFIG_KEY',
  'copy-paste-code': 'B4_COPY_PASTE_CODE',
  'api-endpoint': 'B5_API_ENDPOINT',
  'env-var': 'B6_ENV_VAR',
  'cron-or-slug': 'B7_CRON_OR_SLUG',
};

/** §Design 8 normalized signal emitted by a B1–B7 deterministic detector. */
export interface GateSignal {
  kind: GateSignalKind;
  detected: boolean;
  /** Character spans (into the candidate) where the artifact was found. Bounded. */
  spans?: { start: number; end: number }[];
  /** A short, clamped textual sample of what was detected (UNTRUSTED data). */
  normalizedValue?: string;
  /** Detector self-confidence, clamped to [0,1] at emit. */
  confidence?: number;
}

/** Hard caps so an adversarial candidate can't inflate the signal payload. */
export const GATE_SIGNAL_CAPS = {
  maxSpansPerSignal: 8,
  maxNormalizedValueChars: 120,
} as const;

/**
 * Sanitize + clamp a single signal at emit (the §Design 8 security contract).
 * Returns null for a structurally invalid signal (unknown kind) so a bad
 * detector can never inject an out-of-enum kind. `candidateLen` bounds spans.
 */
export function sanitizeGateSignal(s: GateSignal, candidateLen: number): GateSignal | null {
  if (!s || typeof s !== 'object') return null;
  if (!GATE_SIGNAL_KINDS.includes(s.kind)) return null;

  const out: GateSignal = { kind: s.kind, detected: s.detected === true };

  if (typeof s.confidence === 'number' && Number.isFinite(s.confidence)) {
    out.confidence = Math.max(0, Math.min(1, s.confidence));
  }

  if (Array.isArray(s.spans)) {
    const spans = s.spans
      .filter(
        (sp) =>
          sp &&
          Number.isFinite(sp.start) &&
          Number.isFinite(sp.end) &&
          sp.start >= 0 &&
          sp.end >= sp.start &&
          sp.end <= candidateLen,
      )
      .slice(0, GATE_SIGNAL_CAPS.maxSpansPerSignal)
      .map((sp) => ({ start: Math.floor(sp.start), end: Math.floor(sp.end) }));
    if (spans.length > 0) out.spans = spans;
  }

  if (typeof s.normalizedValue === 'string' && s.normalizedValue.length > 0) {
    // Length-clamp only; the value is rendered inside the caller's own boundary
    // as untrusted data, so its content is never trusted regardless.
    out.normalizedValue = s.normalizedValue.slice(0, GATE_SIGNAL_CAPS.maxNormalizedValueChars);
  }

  return out;
}

// ── The seven deterministic detectors (B1–B7) ────────────────────────────
// Each returns at most ONE signal for its kind (detected:true with spans +
// a normalizedValue sample, or simply nothing when not detected). They are
// high-PRECISION by design: a false "detected" only adds a signal the LLM
// then judges in context (it is not a block), but needless noise dilutes the
// signal list, so each pattern targets the artifact shape, not loose prose.

function collect(
  re: RegExp,
  text: string,
  kind: GateSignalKind,
  // Optional per-match precision filter: return false to DROP a match (so a
  // false-positive shape — a hostname mistaken for a config key, plain
  // hyphenated prose mistaken for a slug — never enters the signal list).
  accept?: (matchText: string) => boolean,
): GateSignal | null {
  const spans: { start: number; end: number }[] = [];
  let first = '';
  for (const m of text.matchAll(re)) {
    if (m.index == null) continue;
    if (accept && !accept(m[0])) continue;
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (!first) first = m[0];
    if (spans.length >= GATE_SIGNAL_CAPS.maxSpansPerSignal) break;
  }
  if (spans.length === 0) return null;
  return { kind, detected: true, spans, normalizedValue: first };
}

/** B1 — a shell command (a verb the user would paste into a terminal). */
function detectCliCommand(text: string): GateSignal | null {
  // Common CLI leaders + a leading "$ " prompt. Word-boundary anchored so prose
  // like "I will run the migration" does not match.
  const re =
    /(^|\s)(\$ |sudo |npm (run |i |install|test)|pnpm \w|yarn \w|npx \w|git (push|pull|commit|checkout|rebase|merge|clone|fetch|reset)|curl |wget |bash |sh |node \S+\.(mjs|js|ts)|docker \w|kubectl \w|systemctl \w|launchctl \w|brew \w|pip install|cargo \w)/g;
  return collect(re, text, 'cli-command');
}

/** B2 — a filesystem path (absolute, home-relative, dot-relative, or src-rooted). */
function detectFilePath(text: string): GateSignal | null {
  // Require a path separator + a path-ish segment; avoid matching bare prose or URLs.
  const re =
    /(?<![\w/])(~\/[\w./-]+|\.{1,2}\/[\w./-]+|\/(?:Users|home|tmp|var|etc|opt|usr)\/[\w./-]+|(?:src|dist|tests|docs|node_modules|\.instar|\.claude|\.github)\/[\w./-]+\.[a-zA-Z]{1,5})/g;
  return collect(re, text, 'file-path');
}

/** Known TLDs used to exclude hostname-shaped tokens from the config-key detector. */
const HOSTNAME_TLD = /\.(?:com|org|net|io|dev|ai|co|gov|edu|app|sh|me|info|biz)$/i;

/** B3 — a dotted config key (e.g. messaging.toneGate.failClosedOnExhaustion). */
function detectConfigKey(text: string): GateSignal | null {
  // 3+ dotted lowerCamel/snake segments — config paths, not sentences (which
  // have spaces). Anchored so "e.g." or "a.b" prose abbreviations don't match.
  const re = /(?<![\w.])[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){2,}(?![\w.])/g;
  // Precision: drop hostname-shaped matches. A real config key
  // (messaging.toneGate.x) has a camelCase segment; a hostname is all-lowercase
  // labels ending in a known TLD (or a www. prefix) — that's prose, not a key.
  return collect(re, text, 'config-key', (v) => {
    const looksLikeHost = /^www\./i.test(v) || HOSTNAME_TLD.test(v);
    const hasCamel = /[a-z][A-Z]/.test(v);
    return !(looksLikeHost && !hasCamel);
  });
}

/** B4 — pasted code: a fenced block or an obvious code line. */
function detectCopyPasteCode(text: string): GateSignal | null {
  const fence = collect(/```[\s\S]*?```|`[^`\n]{3,}`/g, text, 'copy-paste-code');
  if (fence) return fence;
  // A line that reads like code: assignment/among braces/semicolons/arrows.
  const re = /(^|\n)\s*(const |let |var |function |=>|import |export |return |if \(|for \()/g;
  return collect(re, text, 'copy-paste-code');
}

/** B5 — an API endpoint / URL / route path. */
function detectApiEndpoint(text: string): GateSignal | null {
  const re =
    /(https?:\/\/[^\s)>\]]+|(?<![\w/])\/(?:telegram|slack|whatsapp|api|sessions|commitments|attention|coherence|pool|threadline|metrics|health|view|secrets|operations|mandate)\/[\w:./-]+)/g;
  return collect(re, text, 'api-endpoint');
}

/** B6 — an environment variable (assignment, $REF, or process.env.X). */
function detectEnvVar(text: string): GateSignal | null {
  const re = /(?<![\w])(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+\s*=|\$[A-Z][A-Z0-9_]{2,}|process\.env\.[A-Z][A-Z0-9_]*)/g;
  return collect(re, text, 'env-var');
}

/** B7 — a cron expression or an internal kebab slug / tracker id. */
function detectCronOrSlug(text: string): GateSignal | null {
  // Cron: 5 whitespace-separated fields of cron tokens.
  const cron = collect(
    /(?<!\S)(?:[\d*/,-]+\s+){4}[\d*/,-]+(?!\S)/g,
    text,
    'cron-or-slug',
  );
  if (cron) return cron;
  // Internal tracker ids / kebab slugs — the kind of internal handle a user
  // can't act on (e.g. CMT-1793, act-155). Upper tracker ids OR 3+-segment
  // lowercase kebab. Precision: the lowercase-kebab branch must contain a DIGIT,
  // so plain hyphenated English prose ("well-thought-out", "state-of-the-art",
  // "fire-and-forget") does NOT fire. (Digit-less internal slugs leaked to a
  // user are caught by the separate B20 internal-id-leak signal, not here.) The
  // uppercase tracker branch already requires a digit.
  const re = /(?<![\w-])(?:[A-Z]{2,5}-\d{2,}|[a-z0-9]+(?:-[a-z0-9]+){2,})(?![\w-])/g;
  return collect(re, text, 'cron-or-slug', (v) => /\d/.test(v));
}

const DETECTORS: ((text: string) => GateSignal | null)[] = [
  detectCliCommand,
  detectFilePath,
  detectConfigKey,
  detectCopyPasteCode,
  detectApiEndpoint,
  detectEnvVar,
  detectCronOrSlug,
];

/**
 * Run all B1–B7 detectors over a candidate and return the sanitized signal
 * list (only `detected:true` signals, each clamped per §Design 8). The list is
 * what the caller renders inside its own per-call boundary as untrusted data.
 */
export function detectGateSignals(candidate: string): GateSignal[] {
  if (typeof candidate !== 'string' || candidate.length === 0) return [];
  const len = candidate.length;
  const out: GateSignal[] = [];
  for (const detect of DETECTORS) {
    let sig: GateSignal | null = null;
    try {
      sig = detect(candidate);
    } catch {
      // @silent-fallback-ok — a detector throwing (pathological input) must
      // never break the gate; a missing signal degrades to meaning-only
      // judgment for that rule, which is the safe direction (no block lost —
      // these are signals the LLM judges, not blockers).
      sig = null;
    }
    if (!sig || !sig.detected) continue;
    const clean = sanitizeGateSignal(sig, len);
    if (clean && clean.detected) out.push(clean);
  }
  return out;
}
