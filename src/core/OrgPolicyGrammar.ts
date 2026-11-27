/**
 * The one standard form of an organization's AI policy (SEC-077, SEC-078).
 *
 * Three readers show or apply a published policy: the agent (this file), the join page
 * (site/src/pages/join.astro) and the Mac app (InstarMac/MacOrganization.swift). When each read
 * loose Markdown its own way, a person could approve one set of rules on the join screen while the
 * agent applied another, and characters nobody can see could ride into the rules file. So a policy
 * is accepted only in one strict form, every reader checks that form the same way, and a policy
 * with a character a person can't see is refused:
 *
 *   ## Purpose
 *   A plain line.
 *
 *   ## Never
 *   - A rule.
 *
 *   ## Ask first
 *   - A rule.
 *
 *   ## Normally
 *   - A rule.
 *
 * Sections appear in that order, each at most once, empty ones left out, one blank line between
 * sections, no trailing newline, no spaces at either end of a line. The shared cases every reader is
 * tested against are in tests/fixtures/org-policy-vectors.json.
 */

import { parsePolicy, type ParsedPolicy } from './OrgPack.js';

export const POLICY_SECTIONS = [
  ['Purpose', 'purpose'], ['Never', 'never'], ['Ask first', 'askFirst'], ['Normally', 'normally'],
] as const;
type SectionKey = (typeof POLICY_SECTIONS)[number][1];

/**
 * Characters a reader can't see, or that change how text reads: control and format characters
 * (zero-width, direction overrides, tag characters), private-use and surrogate code points, line
 * and paragraph separators, unassigned code points and non-characters, every default-ignorable code
 * point, and characters that draw nothing (U+2800 blank Braille, U+1D159 null notehead). A newline
 * is checked separately.
 */
export const HIDDEN_CHAR = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u{1D159}]/u;

/** An accent or other combining mark: refused at the start of a line or after a space, where it has no letter to sit on. */
const MARK = /\p{M}/u;
const SPACE = /\s/u;

/**
 * The first hidden character in `s` (newlines allowed when `allowNewline`), or null. Also refuses a
 * combining mark with no letter before it, so every reader splits lines the same way.
 */
export function hiddenCharIn(s: string, allowNewline = false): { line: number; codePoint: string } | null {
  let line = 1;
  let prev: string | null = null;
  for (const ch of s) {
    if (ch === '\n' && allowNewline) { line++; prev = null; continue; }
    if (HIDDEN_CHAR.test(ch) || (MARK.test(ch) && (prev === null || SPACE.test(prev)))) {
      return { line, codePoint: 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0') };
    }
    prev = ch;
  }
  return null;
}

/**
 * Markup that changes how the rules file reads further down: an HTML comment hides every line until it
 * closes (OrgIntentManager strips comments), and a code fence swallows the lines after it. Refused
 * anywhere in a policy.
 */
const STRUCTURAL_MARKUP = /<!--|-->|```|~~~/;

/** A purpose line that a Markdown reader could take for a heading, a list item or a quote. */
const PURPOSE_LOOKS_STRUCTURAL = /^(?:#|[-*+>]|\d+[.)]|\*\*)/;

export type GrammarRefusal =
  | 'hidden-character' | 'not-normalized' | 'unknown-heading' | 'repeated-heading' | 'text-before-heading'
  | 'not-a-rule-line' | 'empty-rule' | 'spaces-around-line' | 'purpose-looks-like-markup' | 'markup-not-allowed' | 'not-standard-layout';

/** The standard text for a parsed policy (only the four sections are written). */
export function emitPolicy(p: Pick<ParsedPolicy, SectionKey>): string {
  const blocks: string[] = [];
  for (const [heading, key] of POLICY_SECTIONS) {
    const items = p[key];
    if (!items.length) continue;
    blocks.push([`## ${heading}`, ...items.map((i) => (key === 'purpose' ? i : `- ${i}`))].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Reads a policy that must already be in the standard form. Every reader implements exactly this.
 * Returns the four sections, or the first reason it isn't standard.
 */
export function readStandardPolicy(text: string):
  { ok: true; parsed: ParsedPolicy } | { ok: false; reason: GrammarRefusal; line?: number } {
  if (hiddenCharIn(text, true)) return { ok: false, reason: 'hidden-character', line: hiddenCharIn(text, true)!.line };
  if (text.normalize('NFC') !== text) return { ok: false, reason: 'not-normalized' };
  const out: ParsedPolicy = { purpose: [], never: [], askFirst: [], normally: [], other: [], unplaced: [] };
  const seen = new Set<SectionKey>();
  let cur: SectionKey | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    if (line === '') continue;
    if (line !== line.trim()) return { ok: false, reason: 'spaces-around-line', line: n };
    if (STRUCTURAL_MARKUP.test(line)) return { ok: false, reason: 'markup-not-allowed', line: n };
    if (line.startsWith('## ')) {
      const hit = POLICY_SECTIONS.find(([h]) => h === line.slice(3));
      if (!hit) return { ok: false, reason: 'unknown-heading', line: n };
      if (seen.has(hit[1])) return { ok: false, reason: 'repeated-heading', line: n };
      seen.add(hit[1]); cur = hit[1];
      continue;
    }
    if (cur === null) return { ok: false, reason: 'text-before-heading', line: n };
    if (cur === 'purpose') {
      if (PURPOSE_LOOKS_STRUCTURAL.test(line)) return { ok: false, reason: 'purpose-looks-like-markup', line: n };
      out.purpose.push(line);
      continue;
    }
    if (!line.startsWith('- ')) return { ok: false, reason: 'not-a-rule-line', line: n };
    const item = line.slice(2);
    if (!item) return { ok: false, reason: 'empty-rule', line: n };
    if (item !== item.trim()) return { ok: false, reason: 'spaces-around-line', line: n };
    out[cur].push(item);
  }
  if (emitPolicy(out) !== text) return { ok: false, reason: 'not-standard-layout' };
  return { ok: true, parsed: out };
}

/** Plain words for a refusal, for the admin drafting the policy. */
export function grammarRefusalWords(reason: GrammarRefusal, line?: number): string {
  const at = line ? ` (line ${line})` : '';
  switch (reason) {
    case 'hidden-character': return `The policy has a character nobody can see${at}. Retype that line.`;
    case 'not-normalized': return 'The policy has characters in an unusual encoding. Retype it.';
    case 'unknown-heading': return `Only these headings are allowed: Purpose, Never, Ask first, Normally${at}.`;
    case 'repeated-heading': return `A heading appears twice${at}. Put all its rules under one heading.`;
    case 'text-before-heading': return `Text comes before the first heading${at}. Put every line under Purpose, Never, Ask first or Normally.`;
    case 'not-a-rule-line': return `Under Never, Ask first and Normally, each rule is one line starting with "- "${at}.`;
    case 'empty-rule': return `A rule is empty${at}.`;
    case 'spaces-around-line': return `A line has extra spaces at its start or end${at}.`;
    case 'purpose-looks-like-markup': return `A Purpose line starts like a heading or a list${at}. Write it as a plain sentence.`;
    case 'markup-not-allowed': return `A line has a comment marker (<!-- or -->) or a code fence (\`\`\` or ~~~)${at}. Write it as plain text.`;
    case 'not-standard-layout': return 'The sections are out of order or spaced differently. Use Purpose, Never, Ask first, Normally, with one blank line between them.';
  }
}

/**
 * Turns a drafted policy (loose Markdown) into the standard form, or says why it can't. Used only
 * when the admin drafts; what is published, shown and applied is always the standard text.
 */
export function standardizePolicy(markdown: string):
  { ok: true; text: string; parsed: ParsedPolicy } | { ok: false; error: GrammarRefusal | 'lines-outside-sections'; detail: string } {
  const src = markdown.replace(/\r\n?/g, '\n');
  const hidden = hiddenCharIn(src, true);
  if (hidden) return { ok: false, error: 'hidden-character', detail: `${grammarRefusalWords('hidden-character', hidden.line)} (${hidden.codePoint})` };
  const loose = parsePolicy(src.normalize('NFC'));
  const outside = [...loose.unplaced, ...loose.other.flatMap((o) => [o.heading, ...o.lines])];
  if (outside.length) {
    return { ok: false, error: 'lines-outside-sections', detail: `Put every line under Purpose, Never, Ask first or Normally. Not placed: ${outside.slice(0, 5).map((l) => `"${l.slice(0, 80)}"`).join(', ')}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}.` };
  }
  const text = emitPolicy(loose);
  const strict = readStandardPolicy(text);
  if (!strict.ok) return { ok: false, error: strict.reason, detail: grammarRefusalWords(strict.reason, strict.line) };
  return { ok: true, text, parsed: strict.parsed };
}
