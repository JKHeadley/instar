/**
 * provenanceEnvelope.ts — the untrusted-data envelope serializers (ACT-562,
 * docs/specs/llm-decision-provenance-wiring.md §3.1a).
 *
 * A provenance row's free-text fields (`context`, `contextRedacted`, `reason`,
 * `decision`, `optionsPresented`, `outcome`) are QUOTED UNTRUSTED DATA, never
 * instructions, at every downstream hop. The logged context is
 * attacker-influenceable (transcript tails, outbound message bodies), and the
 * row is the explicit precondition for an LLM grader (ACT-563) + bench batteries
 * (ACT-564) that REPLAY it. There is ONE canonical serializer per surface:
 *
 *   (a) HTTP output (the read surface: readRedacted + the ?scope=pool merge) —
 *       each free-text field is HTML-escaped so a browser/dashboard renders it
 *       INERTLY. A `<script>` or a `</untrusted>`-style breakout becomes text.
 *
 *   (b) LLM replay (the future grader/bench) — the row is emitted as a JSON
 *       string literal inside a fenced data block:
 *         ```untrusted-provenance-json
 *         {"context":"<JSON-string-escaped body>", ...}
 *         ```
 *       JSON string-escaping makes a closing-delimiter injection (`"}` + fence
 *       + fake instructions) inert BY CONSTRUCTION — the payload can never break
 *       out of the JSON string it lands in. This serializer ships now even
 *       though the grader is a later increment (the read surface uses (a); the
 *       replay contract must exist for ACT-563 to build against).
 *
 * NOTHING here changes what is STORED in `contextFull` (machine-local, never
 * served) — only the SERVED forms are enveloped.
 */

/** The free-text fields that carry attacker-influenceable data (§3.1a). */
export const PROVENANCE_FREE_TEXT_FIELDS = [
  'contextRedacted',
  'reason',
  'decision',
  'optionsPresented',
  'outcome',
] as const;

/**
 * HTML-escape a single string so a browser renders it inertly (surface (a)).
 * Order matters: `&` first, so a subsequent `<`→`&lt;` is not re-escaped.
 */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Recursively HTML-escape every string inside a value (strings, arrays, plain
 * objects). Non-string leaves (numbers, booleans, null) pass through unchanged.
 * Used to envelope `optionsPresented` (a string[]) and `outcome` (an object).
 */
function htmlEscapeDeep(v: unknown): unknown {
  if (typeof v === 'string') return htmlEscape(v);
  if (Array.isArray(v)) return v.map(htmlEscapeDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = htmlEscapeDeep(val);
    return out;
  }
  return v;
}

/**
 * Envelope a served (already-redacted) provenance row for surface (a): HTML-escape
 * every free-text field in place so the HTTP consumer (dashboard) renders it inertly.
 * Returns a NEW object (never mutates the input). `contextFull` is not a served
 * field, but if a caller ever passes a row that still carries it, it is dropped
 * here as a defensive belt-and-suspenders (the read surface already omits it).
 */
export function envelopeRedactedRowForHttp<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'contextFull') continue; // never serve the machine-local full context
    out[k] = (PROVENANCE_FREE_TEXT_FIELDS as readonly string[]).includes(k) ? htmlEscapeDeep(v) : v;
  }
  return out;
}

/**
 * Envelope a row for surface (b) — LLM replay. Emits the row as a JSON string
 * inside a fenced `untrusted-provenance-json` block. The replay PROMPT (built by
 * the grader in ACT-563) states the fenced JSON is DATA to judge, never
 * instructions; JSON string-escaping alone makes a closing-delimiter injection
 * inert. Provided now so ACT-563 has a canonical contract to build against.
 */
export function envelopeRowForLlmReplay(row: Record<string, unknown>): string {
  // JSON.stringify handles all string-escaping (quotes, backslashes, control
  // chars, and — critically — a `"}` + fence payload becomes an escaped string,
  // never a delimiter). `contextFull` is dropped: replay only ever sees the
  // served (redacted) view.
  const { contextFull: _drop, ...served } = row;
  const json = JSON.stringify(served);
  return ['```untrusted-provenance-json', json, '```'].join('\n');
}
