/**
 * SlackMrkdwnFormatter — server-side formatter that converts agent-authored
 * GitHub-flavored markdown into Slack mrkdwn on outbound sends (roadmap 0.1).
 *
 * Mirrors the TelegramMarkdownFormatter pattern (src/messaging/
 * TelegramMarkdownFormatter.ts): default ON ('mrkdwn'), config rollback to
 * 'legacy-passthrough' (byte-for-byte), per-call `_formatMode` opt-out for
 * callers that already produce mrkdwn.
 *
 * Wired at the single SlackAdapter outbound chokepoint (formattedApiCall) so
 * every chat.postMessage / chat.update / chat.postEphemeral send funnels
 * through it. See applySlackFormatter() below.
 *
 * Conversion contract (GFM → mrkdwn):
 *   **bold**        → *bold*
 *   __bold__        → *bold*
 *   *italic*        → _italic_        (tight word-boundary rule; `3*5` untouched)
 *   _italic_        → _italic_        (already mrkdwn — passes through)
 *   ***both***      → *_both_*
 *   ~~strike~~      → ~strike~
 *   `code`          → `code`          (content &<> escaped, otherwise verbatim)
 *   ```fenced```    → ```fenced```    (language tag dropped; content escaped)
 *   [text](url)     → <url|text>      (scheme allowlist; unsafe → literal)
 *   # Heading       → *Heading*       (Slack has no headings)
 *   - bullet        → • bullet
 *   1. numbered     → 1. numbered     (passes through — reads natively)
 *   > quote         → > quote         (preserved; Slack renders quotes)
 *   | tables |      → fenced code block (Slack has no tables)
 *   --- / *** / ___ → ─ rule line
 *   emoji + :shortcodes: untouched
 *
 * Escaping: Slack's API contract requires `&`, `<`, `>` HTML-entity-escaped in
 * the text payload; Slack decodes exactly these three entities everywhere
 * (including code blocks), so we escape ONCE per segment — prose and code
 * segment contents alike — and never re-process extracted segments (sentinel
 * placeholders make double-escaping structurally impossible).
 */

import { escapeMrkdwn } from './sanitize.js';

export type SlackFormatMode = 'mrkdwn' | 'legacy-passthrough';

export interface SlackFormatResult {
  /** The rendered mrkdwn output (or the raw input, for `legacy-passthrough`). */
  text: string;
  /** The mode actually applied. */
  modeApplied: SlackFormatMode;
  /** Conversion was bypassed (input > 32KB ReDoS guard); raw text returned. */
  conversionSkipped: boolean;
  /** For `legacy-passthrough`: the formatter declined to transform the bytes. */
  legacyPassthrough: boolean;
}

/** 32KB hard cap. Above this, markdown conversion is skipped (ReDoS defense). */
export const MAX_INPUT_LENGTH = 32_768;

/** Max chars scanned forward in the balanced-paren URL walker. */
const URL_SCAN_MAX = 2048;

// ─── Placeholder sentinels ──────────────────────────────────────────────────
// Same scheme as TelegramMarkdownFormatter: Supplementary-PUA-B
// (U+100000..U+10FFFD) — near-zero real-world usage. We strip this range from
// input BEFORE inserting any sentinel, so collision is structurally impossible.

const PUA_B_START = 0x100000;
const BLOCK_SIZE = 0x4000; // 16384 entries per kind — plenty
const SENTINEL_CLOSE = String.fromCodePoint(0x10fffd);

const KIND_PRE = 0; // fenced code blocks (rendered ```…```)
const KIND_TABLE = 1; // tables (rendered as fenced code blocks)
const KIND_CODE = 2; // inline code spans
const KIND_RAW = 3; // already-final mrkdwn (bold/heading output) — spliced verbatim

function makeSentinel(kind: number, n: number): string {
  if (n < 0 || n >= BLOCK_SIZE) {
    throw new Error(`sentinel index out of range: ${n}`);
  }
  const code = PUA_B_START + kind * BLOCK_SIZE + n;
  return SENTINEL_CLOSE + String.fromCodePoint(code) + SENTINEL_CLOSE;
}

function decodeSentinelCodepoint(cp: number): { kind: number; n: number } | null {
  const offset = cp - PUA_B_START;
  if (offset < 0) return null;
  const kind = Math.floor(offset / BLOCK_SIZE);
  const n = offset % BLOCK_SIZE;
  if (kind > 3) return null;
  return { kind, n };
}

/** Strip the entire Supplementary-PUA-B range from user input. */
function stripPuaB(s: string): string {
  return s.replace(/[\u{100000}-\u{10FFFD}]/gu, '');
}

/** Strip NUL bytes. Always step 0. */
function stripNul(s: string): string {
  return s.replace(/\x00/g, '');
}

// ─── URL safety ─────────────────────────────────────────────────────────────

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * Check a URL against the scheme allowlist using WHATWG URL parsing.
 * Returns the trimmed URL string on success, or null on reject.
 * javascript:, data:, file: etc. are refused — the link stays literal text.
 */
function isSafeUrl(raw: string): string | null {
  const trimmed = raw.replace(/^[\s\x00-\x1f]+/, '');
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase().replace(':', '');
  if (!SAFE_SCHEMES.has(scheme)) return null;
  return trimmed;
}

// ─── Extraction: fenced code, tables, inline code ──────────────────────────

interface Segments {
  pre: string[];
  table: string[];
  code: string[];
  raw: string[];
}

/**
 * Extract fenced code blocks. Replaces each with a PUA sentinel. Content is
 * &<>-escaped (Slack decodes these entities inside code blocks) and re-fenced
 * without the language tag (mrkdwn has no syntax highlighting).
 */
function extractFencedCode(text: string, pre: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const start = i + 3;
      const end = text.indexOf('```', start);
      if (end === -1) {
        // No closing fence — emit literal backticks, keep scanning.
        out.push('```');
        i += 3;
        continue;
      }
      // Optional language tag on the opening line (skip to first \n).
      let contentStart = start;
      const nl = text.indexOf('\n', start);
      if (nl !== -1 && nl < end) {
        contentStart = nl + 1;
      }
      let inner = text.slice(contentStart, end);
      // Trim ONE trailing newline so the closing fence hugs the content.
      if (inner.endsWith('\n')) inner = inner.slice(0, -1);
      const idx = pre.length;
      pre.push('```' + '\n' + escapeMrkdwn(inner) + '\n' + '```');
      out.push(makeSentinel(KIND_PRE, idx));
      i = end + 3;
    } else {
      out.push(text[i]);
      i++;
    }
  }
  return out.join('');
}

/**
 * Extract markdown table blocks (pipe rows + an alignment separator row).
 * Slack has no table rendering — the whole block becomes a fenced code block
 * so columns keep their monospace alignment.
 */
function extractTables(text: string, table: string[]): string {
  const lines = text.split('\n');
  const isRow = (s: string) => /^\s*\|.{1,2000}\|\s*$/.test(s);
  const isSep = (s: string) => /^\s*\|[\s\-:|]{1,2000}\|\s*$/.test(s);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isRow(lines[i])) {
      const block: string[] = [];
      let hasSep = false;
      let j = i;
      while (j < lines.length && isRow(lines[j])) {
        if (isSep(lines[j])) {
          hasSep = true;
        } else {
          block.push(lines[j]);
        }
        j++;
      }
      if (hasSep && block.length > 0) {
        const escaped = block.map(escapeMrkdwn).join('\n');
        const idx = table.length;
        table.push('```' + '\n' + escaped + '\n' + '```');
        out.push(makeSentinel(KIND_TABLE, idx));
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/** Extract inline code spans (`x`). Non-greedy, newline-bounded. */
function extractInlineCode(text: string, code: string[]): string {
  return text.replace(/`([^`\n]{1,500})`/g, (_m, inner: string) => {
    const idx = code.length;
    code.push('`' + escapeMrkdwn(inner) + '`');
    return makeSentinel(KIND_CODE, idx);
  });
}

// ─── Blockquotes ────────────────────────────────────────────────────────────

/**
 * Restore blockquote markers that the prose escape turned into `&gt;`.
 * Runs AFTER escapeMrkdwn: a leading run of `&gt;` on a line was a GFM quote
 * marker — Slack needs the literal `>` there to render the quote bar.
 */
function restoreBlockquotes(text: string): string {
  return text.replace(/^((?:&gt;\s?)+)/gm, (run) => run.replace(/&gt;/g, '>'));
}

// ─── Emphasis / headings / bullets / rules / links ──────────────────────────

/**
 * Tight italic boundary — same rule as the Telegram formatter: requires a
 * word-boundary-like context on both sides so `3*5`, `f(x) = x * y`, `a*b*c`
 * are untouched. Bounded quantifier (ReDoS defense).
 */
const TIGHT_ITALIC = /(^|[\s(,.;:!?])\*(?!\s)([^*\n]{1,200}?)(?<!\s)\*(?=$|[\s),.;:!?])/g;

/**
 * Order is load-bearing (the mrkdwn output alphabet overlaps the GFM input
 * alphabet, unlike Telegram HTML):
 *   1. tight italic *x* → _x_ FIRST — it cannot match `**`/`***` runs (its
 *      content class excludes '*'), and running it first means it can never
 *      re-match the single-asterisk output of the bold conversions.
 *   2. bold-italic / bold / __bold__ are then emitted as RAW sentinels so no
 *      later pass (or a second formatter application) can re-interpret them.
 *      Because RAW content is spliced verbatim, links INSIDE the emphasis
 *      (`**see [docs](url)**`) are converted at emission time — the main
 *      convertLinks pass never sees RAW content. (The Telegram formatter keeps
 *      emphasis output inline so its later link pass covers this case; the
 *      sentinel approach must do it here instead.)
 *   3. strikethrough last (its alphabet '~' is disjoint).
 */
function applyEmphasis(text: string, raw: string[]): string {
  const emitRaw = (mrkdwn: string): string => {
    const idx = raw.length;
    raw.push(mrkdwn);
    return makeSentinel(KIND_RAW, idx);
  };
  // 1. Tight italic (asterisk form). Underscore italic `_x_` is already valid
  //    mrkdwn and passes through untouched. Italic output stays INLINE, so
  //    links inside italic are handled by the main convertLinks pass.
  text = text.replace(TIGHT_ITALIC, (_m, lead: string, inner: string) => `${lead}_${inner}_`);
  // 2a. Bold-italic (triple asterisk).
  text = text.replace(/\*\*\*([^*\n]{1,200}?)\*\*\*/g, (_m, inner: string) =>
    emitRaw(`*_${convertLinks(inner)}_*`));
  // 2b. Bold (double asterisk).
  text = text.replace(/\*\*([^*\n]{1,200}?)\*\*/g, (_m, inner: string) =>
    emitRaw(`*${convertLinks(inner)}*`));
  // 2c. Bold (double underscore — GFM strong). Word-boundary constrained:
  //     GFM underscore emphasis never applies intraword (`my__var__name`).
  text = text.replace(
    /(^|[\s(,.;:!?])__(?!\s)([^_\n]{1,200}?)(?<!\s)__(?=$|[\s),.;:!?])/gm,
    (_m, lead: string, inner: string) => `${lead}${emitRaw(`*${convertLinks(inner)}*`)}`,
  );
  // 3. Strikethrough.
  text = text.replace(/~~([^~\n]{1,200}?)~~/g, '~$1~');
  return text;
}

/**
 * Headings → one bold line (Slack has no headings). Any emphasis markers the
 * earlier passes left INSIDE the title (as RAW sentinels) splice back inside
 * the bold wrapper — mrkdwn tolerates `*a *b* c*` poorly, so we strip nested
 * bold sentinels back to their inner text via the raw store when the whole
 * title is a single RAW bold; otherwise we wrap as-is (best-effort, same
 * spirit as the Telegram formatter's <b> wrap).
 */
function applyHeadings(text: string, raw: string[]): string {
  // Whitespace classes are [ \t] (never \s): a trailing \s* would swallow the
  // newline AND the blank line after the heading under the /m flag.
  return text.replace(/^(#{1,6})[ \t]+(.{1,2000}?)[ \t]*#*[ \t]*$/gm, (_m, _h: string, title: string) => {
    // If the entire title is exactly one RAW sentinel (e.g. `# **Bold**`),
    // unwrap it so we don't emit nested bold markers.
    const soleRaw = title.match(/^\u{10FFFD}([\u{100000}-\u{10FFFC}])\u{10FFFD}$/u);
    if (soleRaw) {
      const dec = decodeSentinelCodepoint(soleRaw[1].codePointAt(0)!);
      if (dec && dec.kind === KIND_RAW) {
        const inner = raw[dec.n] ?? '';
        // raw entries for bold are `*…*` already — reuse verbatim.
        if (inner.startsWith('*') && inner.endsWith('*')) return inner;
      }
    }
    const idx = raw.length;
    // Heading titles become RAW (spliced verbatim), so links inside a heading
    // (`# See [docs](url)`) must be converted here — the main convertLinks
    // pass never sees RAW content.
    raw.push(`*${convertLinks(title)}*`);
    return makeSentinel(KIND_RAW, idx);
  });
}

/** Bullets → • (indent preserved). Numbered lists pass through as-is. */
function applyBullets(text: string): string {
  return text.replace(/^(\s{0,20})[-*+]\s+/gm, '$1• ');
}

/** Horizontal rules → a light box-drawing line (Slack has no <hr>). */
function applyHorizontalRules(text: string): string {
  return text.replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '──────────');
}

/**
 * `[text](url)` → `<url|text>` with a balanced-paren URL scanner (Wikipedia
 * URLs with parens parse correctly). Runs on post-escape text, so the URL's
 * `&` is already `&amp;` — exactly what Slack's link syntax requires. A `|`
 * inside the URL is %-encoded (it would terminate the link); unsafe schemes
 * leave the whole construct as literal text.
 */
function convertLinks(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '[') {
      out.push(ch);
      i++;
      continue;
    }
    // Find matching ] on the same line, bounded length.
    let j = i + 1;
    let foundClose = -1;
    const maxTextEnd = Math.min(text.length, i + 1 + 500);
    while (j < maxTextEnd) {
      const c = text[j];
      if (c === '\n') break;
      if (c === ']') {
        foundClose = j;
        break;
      }
      j++;
    }
    if (foundClose === -1 || text[foundClose + 1] !== '(') {
      out.push(ch);
      i++;
      continue;
    }
    const visibleText = text.slice(i + 1, foundClose);
    // Walk the URL with paren balance.
    let k = foundClose + 2;
    let depth = 1;
    const urlStart = k;
    const scanEnd = Math.min(text.length, urlStart + URL_SCAN_MAX);
    let urlEnd = -1;
    while (k < scanEnd) {
      const c = text[k];
      if (c === '\n') break;
      if (c === '\\' && k + 1 < scanEnd) {
        k += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          urlEnd = k;
          break;
        }
      }
      k++;
    }
    if (urlEnd === -1) {
      out.push(text.slice(i, foundClose + 2));
      i = foundClose + 2;
      continue;
    }
    const rawUrl = text.slice(urlStart, urlEnd);
    const safeUrl = isSafeUrl(rawUrl);
    if (safeUrl === null) {
      out.push(text.slice(i, urlEnd + 1));
      i = urlEnd + 1;
      continue;
    }
    out.push(`<${safeUrl.replace(/\|/g, '%7C')}|${visibleText}>`);
    i = urlEnd + 1;
  }
  return out.join('');
}

// ─── Splice ─────────────────────────────────────────────────────────────────

function splicePlaceholders(text: string, seg: Segments): string {
  const re = /\u{10FFFD}([\u{100000}-\u{10FFFC}])\u{10FFFD}/gu;
  // RAW entries may reference other sentinels (a heading wrapping a bold);
  // splice repeatedly until stable (bounded — nesting depth is tiny).
  for (let pass = 0; pass < 4; pass++) {
    if (!re.test(text)) break;
    re.lastIndex = 0;
    text = text.replace(re, (_m, ch: string) => {
      const cp = ch.codePointAt(0)!;
      const dec = decodeSentinelCodepoint(cp);
      if (!dec) return '';
      if (dec.kind === KIND_PRE) return seg.pre[dec.n] ?? '';
      if (dec.kind === KIND_TABLE) return seg.table[dec.n] ?? '';
      if (dec.kind === KIND_CODE) return seg.code[dec.n] ?? '';
      if (dec.kind === KIND_RAW) return seg.raw[dec.n] ?? '';
      return '';
    });
    re.lastIndex = 0;
  }
  return text;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

function convertMarkdownToMrkdwn(text: string): string {
  const seg: Segments = { pre: [], table: [], code: [], raw: [] };

  // 1. Extract literal segments (never re-processed → no double-escaping).
  text = extractFencedCode(text, seg.pre);
  text = extractTables(text, seg.table);
  text = extractInlineCode(text, seg.code);
  // 2. Escape remaining prose ONCE (&, <, > — Slack's three specials).
  text = escapeMrkdwn(text);
  // 3. Restore blockquote markers the escape consumed.
  text = restoreBlockquotes(text);
  // 4. Emphasis (italic → bold family → strike; see order note).
  text = applyEmphasis(text, seg.raw);
  // 5. Headings → bold line.
  text = applyHeadings(text, seg.raw);
  // 6. Horizontal rules (before bullets: a `***` rule must not become `• `).
  text = applyHorizontalRules(text);
  // 7. Bullets → •.
  text = applyBullets(text);
  // 8. Links → <url|text>.
  text = convertLinks(text);
  // 9. Splice literal segments back.
  return splicePlaceholders(text, seg);
}

/**
 * Format text for a Slack send.
 *
 * `'mrkdwn'` (default): convert GFM → mrkdwn per the contract above.
 * `'legacy-passthrough'`: byte-for-byte unchanged — the rollback mode AND the
 * per-call opt-out for callers that already author mrkdwn.
 */
export function formatForSlack(
  text: string,
  mode: SlackFormatMode = 'mrkdwn',
): SlackFormatResult {
  if (mode === 'legacy-passthrough') {
    return {
      text,
      modeApplied: 'legacy-passthrough',
      conversionSkipped: false,
      legacyPassthrough: true,
    };
  }

  // Step 0: strip NUL, then PUA-B (sentinel-collision defense).
  let working = stripNul(text);
  working = stripPuaB(working);

  // ReDoS guard: oversized input skips conversion (raw bytes preserved —
  // exactly today's pre-formatter behavior).
  if (working.length > MAX_INPUT_LENGTH) {
    return {
      text,
      modeApplied: 'mrkdwn',
      conversionSkipped: true,
      legacyPassthrough: false,
    };
  }

  return {
    text: convertMarkdownToMrkdwn(working),
    modeApplied: 'mrkdwn',
    conversionSkipped: false,
    legacyPassthrough: false,
  };
}

// ─── Wire-up helper (the single outbound chokepoint contract) ───────────────

/** Slack Web API methods whose `text` is a user-visible message body. */
const SEND_METHODS = new Set(['chat.postMessage', 'chat.update', 'chat.postEphemeral']);

/**
 * Shared formatter wire-up used by SlackAdapter.formattedApiCall — the Slack
 * sibling of applyTelegramFormatter. Pure function for testability.
 *
 * - Non-send methods pass through unchanged.
 * - `params._formatMode` is the per-call override (stripped before the HTTP
 *   call): `'legacy-passthrough'` = "my bytes are already mrkdwn, don't touch".
 * - Block Kit sends (`params.blocks`) pass through — blocks are authored
 *   deliberately; `text` is only the notification fallback.
 * - `params.mrkdwn === false` passes through — the caller asked Slack for
 *   plain text; converting would be nonsense.
 * - Mode resolution: per-call → config → `'mrkdwn'` (default ON, post-cutover;
 *   rollback via `formatMode: 'legacy-passthrough'` in the slack messaging
 *   config block).
 */
export function applySlackFormatter(
  method: string,
  params: Record<string, unknown>,
  configMode: SlackFormatMode | undefined,
): {
  outgoingParams: Record<string, unknown>;
  didFormat: boolean;
} {
  const callerMode = (params as { _formatMode?: SlackFormatMode })._formatMode;
  // Strip internal flags before sending to the Slack API.
  const stripped: Record<string, unknown> = { ...params };
  delete (stripped as { _formatMode?: SlackFormatMode })._formatMode;

  const mode: SlackFormatMode = callerMode ?? configMode ?? 'mrkdwn';

  if (
    !SEND_METHODS.has(method) ||
    mode === 'legacy-passthrough' ||
    typeof stripped.text !== 'string' ||
    stripped.blocks !== undefined ||
    stripped.mrkdwn === false
  ) {
    return { outgoingParams: stripped, didFormat: false };
  }

  const result = formatForSlack(stripped.text, mode);
  return {
    outgoingParams: { ...stripped, text: result.text },
    didFormat: !result.legacyPassthrough && !result.conversionSkipped,
  };
}
