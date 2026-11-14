/**
 * Awareness entry registry (docs/specs/awareness-entry-registry.md).
 *
 * A feature adds its agent-awareness text as ONE data file,
 * `src/data/awareness/<id>.md`, and never edits `templates.ts` or
 * `PostUpdateMigrator.ts` for it. This module reads that directory once per
 * process (synchronously, the first time it is asked), checks every entry, and
 * renders the eligible ones as one `## Feature notes` section that the three
 * document builders append as their last step. The migrator runs in the new
 * process after an update, so "once per process" always sees the installed
 * package's entries.
 *
 * LEAF MODULE: it may import only node built-ins and `claudeMdLayout.ts` (which
 * itself imports only `node:crypto`). Nothing here is compiled from an entry,
 * so there is no stale build output and no list of entries anywhere.
 */

import fs from 'node:fs';
import { parseAwarenessUnits, normaliseTitle } from '../scaffold/claudeMdLayout.js';

/** Shared prefix of BOTH marker lines; forbidden inside an entry. */
export const AWARENESS_REGISTRY_MARKER_NAME = 'instar:awareness-registry';
/** What a mirror slice must stop at: any marker line, start or end. */
export const AWARENESS_REGISTRY_MARKER_PREFIX = `<!-- ${AWARENESS_REGISTRY_MARKER_NAME}:`;
export const AWARENESS_REGISTRY_START_PREFIX = `${AWARENESS_REGISTRY_MARKER_PREFIX}start`;
export const AWARENESS_REGISTRY_END_PREFIX = `${AWARENESS_REGISTRY_MARKER_PREFIX}end`;
export const AWARENESS_REGISTRY_START =
  `${AWARENESS_REGISTRY_START_PREFIX} — rewritten by instar on every update; do not edit -->`;
export const AWARENESS_REGISTRY_END = `${AWARENESS_REGISTRY_END_PREFIX} -->`;

export const AWARENESS_REGISTRY_HEADING = '## Feature notes';
const SECTION_INTRO = 'Notes added by individual features, one per entry.';

/** Degradation feature name (server start) and the prefix of every migrator error row. */
export const AWARENESS_REGISTRY_FEATURE = 'awareness.entry-registry';

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KNOWN_KEYS = new Set(['title', 'requires']);
const KNOWN_REQUIRES = new Set(['telegram']);
/** Port used for the load-time render checks; the substitution is digits only, so any port parses the same. */
const CHECK_PORT = 4040;

export interface AwarenessContext {
  port: number;
  hasTelegram: boolean;
}

export interface AwarenessEntry {
  /** File name without `.md`. */
  id: string;
  title: string;
  requires: 'telegram' | null;
  /** Body with `{{port}}` not yet substituted. */
  body: string;
}

export interface AwarenessEntryError {
  /** The entry id, a file name that is not a valid id, or `*` for the directory or the section as a whole. */
  id: string;
  reason: string;
}

export type RegistryBlockState =
  | { state: 'none' }
  | { state: 'well-formed'; start: number; end: number }
  | { state: 'broken'; reason: string };

export interface WithRegistryResult {
  /** The document to use. Identical (same string) to the input when nothing changed. */
  content: string;
  changed: boolean;
  /** The document's markers are damaged: nothing was changed, the caller reports it. */
  broken: boolean;
}

export interface AwarenessRegistry {
  /** The valid entries whose `requires` is satisfied, sorted by id. */
  eligibleEntries(ctx: AwarenessContext): AwarenessEntry[];
  /** `''` when no entry is eligible, else the `## Feature notes` section ending in one newline. */
  renderSection(ctx: AwarenessContext): string;
  /**
   * Remove a well-formed marked block, then append the section at the end.
   * `markers: true` is idempotent (the block is found again by its marker lines).
   * `markers: false` is NOT: the bare section carries nothing that tells it from an
   * operator's own `## Feature notes` heading, so it is never looked for. Call it ONCE,
   * on a document that does not yet hold the bare section (buildCanonicalClaudeMd's last step).
   */
  withRegistry(doc: string, ctx: AwarenessContext, opts: { markers: boolean }): WithRegistryResult;
  /** Every entry left out, and why. Fixed once the directory has been read. */
  errors(): AwarenessEntryError[];
  /** The error rows this channel has not been handed yet (de-duplicated by id and reason). */
  takeUnreportedErrors(channel: string): AwarenessEntryError[];
}

// ── Finding a block (spec 3.3.1) ─────────────────────────────────────

interface LineSpan { start: number; end: number; text: string }

function linesOf(doc: string): LineSpan[] {
  const out: LineSpan[] = [];
  let at = 0;
  while (at <= doc.length) {
    const nl = doc.indexOf('\n', at);
    const end = nl < 0 ? doc.length : nl + 1;
    let text = doc.slice(at, nl < 0 ? doc.length : nl);
    // CRLF-tolerant: a marker line in a CRLF file still counts.
    if (text.endsWith('\r')) text = text.slice(0, -1);
    out.push({ start: at, end, text });
    if (nl < 0) break;
    at = end;
  }
  return out;
}

/** The fence rule of `parseAwarenessUnits`, so "outside a code fence" means the same thing in both. */
function fenceStep(fence: { ch: string; len: number } | null, line: string): { ch: string; len: number } | null {
  const trimmed = line.trimStart();
  const fm = /^(`{3,}|~{3,})/.exec(trimmed);
  if (!fm) return fence;
  const ch = fm[1][0];
  const len = fm[1].length;
  if (!fence) return { ch, len };
  if (ch === fence.ch && len >= fence.len && trimmed.slice(len).trim() === '') return null;
  return fence;
}

function isMarkerLine(text: string, prefix: string): boolean {
  return text.startsWith(prefix) && text.trimEnd().endsWith('-->');
}

/**
 * Locate the registry block. A marker counts only as a whole line that starts
 * with the marker prefix, outside a code fence. Three states: none,
 * well-formed (start line through end line, including its newline), broken.
 */
export function findRegistryBlock(doc: string): RegistryBlockState {
  if (!doc.includes(AWARENESS_REGISTRY_MARKER_PREFIX)) return { state: 'none' };
  const starts: LineSpan[] = [];
  const ends: LineSpan[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of linesOf(doc)) {
    if (!fence) {
      if (isMarkerLine(line.text, AWARENESS_REGISTRY_START_PREFIX)) starts.push(line);
      else if (isMarkerLine(line.text, AWARENESS_REGISTRY_END_PREFIX)) ends.push(line);
    }
    fence = fenceStep(fence, line.text);
  }
  if (starts.length === 0 && ends.length === 0) return { state: 'none' };
  if (starts.length > 1 || ends.length > 1) return { state: 'broken', reason: 'more than one start or end marker line' };
  if (starts.length === 0) return { state: 'broken', reason: 'an end marker line without a start marker line' };
  if (ends.length === 0) return { state: 'broken', reason: 'a start marker line without an end marker line' };
  if (ends[0].start < starts[0].start) return { state: 'broken', reason: 'the end marker line comes before the start marker line' };
  return { state: 'well-formed', start: starts[0].start, end: ends[0].end };
}

/**
 * Remove a well-formed block. The inverse of the append in `withRegistry`: the
 * blank line that was put before the block goes with it. A document with no
 * block, or a broken one, is returned as the same string.
 */
export function withoutRegistryBlock(doc: string): string {
  const found = findRegistryBlock(doc);
  if (found.state !== 'well-formed') return doc;
  let before = doc.slice(0, found.start);
  const after = doc.slice(found.end);
  if (before.endsWith('\r\n\r\n')) before = before.slice(0, -2);
  else if (before.endsWith('\n\n')) before = before.slice(0, -1);
  return before + after;
}

/** Stands in for a held block while a caller's own steps run. Not a start or end marker line. */
const HELD_LINE = `<!-- ${AWARENESS_REGISTRY_MARKER_NAME}-held -->`;

/**
 * Take a well-formed block out of a document for the duration of a caller's own
 * steps (so entry text cannot take part in their `includes(marker)` tests), leaving a
 * one-line stand-in at its place. `restore` puts the ORIGINAL block bytes back where
 * the stand-in now is, so a later `withRegistry` that reports broken has changed
 * nothing. A document with no block, or a broken one, is held as the same string.
 */
export function holdRegistryBlock(doc: string): { text: string; restore(text: string): string } {
  const found = findRegistryBlock(doc);
  if (found.state !== 'well-formed') return { text: doc, restore: text => text };
  const block = doc.slice(found.start, found.end);
  const hadNewline = block.endsWith('\n');
  return {
    text: doc.slice(0, found.start) + HELD_LINE + (hadNewline ? '\n' : '') + doc.slice(found.end),
    restore(text) {
      const at = text.indexOf(HELD_LINE);
      // The stand-in is gone only if a caller's step removed it; the block is then kept at the end.
      if (at < 0) return appendAtEnd(text, block);
      let end = at + HELD_LINE.length;
      if (hadNewline) {
        if (text.startsWith('\r\n', end)) end += 2;
        else if (text[end] === '\n') end += 1;
      }
      return text.slice(0, at) + block + text.slice(end);
    },
  };
}

/** `doc` + exactly one blank line + `section`; the text already in `doc` is kept byte for byte. */
function appendAtEnd(doc: string, section: string): string {
  if (doc === '') return section;
  const sep = /\n\r?\n$/.test(doc) ? '' : doc.endsWith('\n') ? '\n' : '\n\n';
  return doc + sep + section;
}

// ── Reading and checking entries (spec 3.1, 3.5) ─────────────────────

function renderBody(entry: AwarenessEntry, port: number): string {
  return entry.body.split('{{port}}').join(String(port));
}

function renderEntry(entry: AwarenessEntry, port: number): string {
  return `**${entry.title}** — ${renderBody(entry, port)}\n\n`;
}

function renderSectionOf(entries: AwarenessEntry[], port: number): string {
  if (entries.length === 0) return '';
  const text = `${AWARENESS_REGISTRY_HEADING}\n\n${SECTION_INTRO}\n\n${entries.map(e => renderEntry(e, port)).join('')}`;
  return text.replace(/\n+$/, '\n');
}

function wrapInMarkers(section: string): string {
  return `${AWARENESS_REGISTRY_START}\n${section}${AWARENESS_REGISTRY_END}\n`;
}

function parseEntryFile(id: string, raw: string): { entry: AwarenessEntry } | { reason: string } {
  let text = raw.replace(/\r\n/g, '\n');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n');
  if (lines[0] !== '---') return { reason: 'the file must start with a front-matter block (a line holding only ---)' };
  const close = lines.indexOf('---', 1);
  if (close < 0) return { reason: 'the front-matter block is not closed by a line holding only ---' };
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, close)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) return { reason: `front-matter line has no colon: "${line}"` };
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!KNOWN_KEYS.has(key)) return { reason: `unknown front-matter key "${key}" (only title and requires are allowed)` };
    if (fields.has(key)) return { reason: `front-matter key "${key}" is given twice` };
    fields.set(key, value);
  }
  const title = fields.get('title');
  if (!title) return { reason: 'the front matter needs a non-empty title' };
  if (title.includes('**')) return { reason: 'the title may not contain **' };
  if (title.includes('—')) return { reason: 'the title may not contain an em dash' };
  if (title.includes('{{')) return { reason: 'the title may not contain {{ (a title takes no placeholder)' };
  const requiresRaw = fields.get('requires');
  if (requiresRaw !== undefined && !KNOWN_REQUIRES.has(requiresRaw)) {
    return { reason: `unknown requires value "${requiresRaw}" (the only value is telegram)` };
  }
  const bodyLines = lines.slice(close + 1);
  while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
  if (bodyLines.length === 0) return { reason: 'the body is empty' };
  const body = bodyLines.join('\n');
  const placeholder = /\{\{(?!port\}\})[^}]*\}\}|\{\{(?![^}]*\}\})/.exec(body);
  if (placeholder) return { reason: `unknown placeholder "${placeholder[0].slice(0, 40)}" (the only placeholder is {{port}})` };
  const first = bodyLines[0];
  if (/^\s/.test(first) || /^(`{3,}|~{3,}|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(first)) {
    return { reason: 'the first line of the body must be prose (it follows the title on the same line, so a code fence, list, heading, quote or table cannot start there)' };
  }
  let fence: { ch: string; len: number } | null = null;
  for (const line of bodyLines) fence = fenceStep(fence, line);
  if (fence) return { reason: 'a code fence in the body is never closed' };
  const entry: AwarenessEntry = { id, title, requires: requiresRaw === 'telegram' ? 'telegram' : null, body };
  const rendered = renderEntry(entry, CHECK_PORT);
  if (rendered.includes(AWARENESS_REGISTRY_MARKER_NAME)) {
    return { reason: `the entry may not contain "${AWARENESS_REGISTRY_MARKER_NAME}"` };
  }
  const units = parseAwarenessUnits(rendered);
  if (units.length !== 2 || units[0].text !== '' || units[1].level !== 0 || units[1].title !== normaliseTitle(title)) {
    return { reason: 'the entry must read as exactly one section under its title (no heading and no second bold lead-in at the start of a line in the body, and a title of at least two characters without *)' };
  }
  return { entry };
}

interface Loaded { entries: AwarenessEntry[]; errors: AwarenessEntryError[] }

function loadDirectory(dirUrl: URL): Loaded {
  const errors: AwarenessEntryError[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dirUrl, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name).sort();
  } catch (err) {
    // @silent-fallback-ok: not silent — recorded as the one error row a missing directory gets, which the server and the migrator report.
    return { entries: [], errors: [{ id: '*', reason: `the awareness entry directory could not be read: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  let entries: AwarenessEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const id = name.slice(0, -'.md'.length);
    if (!ID_RE.test(id)) {
      errors.push({ id: name, reason: 'the file name must be lower-case letters, digits and single hyphens, ending in .md' });
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(new URL(name, dirUrl), 'utf-8');
    } catch (err) {
      // @silent-fallback-ok: not silent — the entry is left out and its error row is reported by the server and the migrator.
      errors.push({ id, reason: `the file could not be read: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const parsed = parseEntryFile(id, raw);
    if ('reason' in parsed) errors.push({ id, reason: parsed.reason });
    else entries.push(parsed.entry);
  }
  // Titles are unique ignoring case; BOTH entries of a clashing pair are left out.
  const byTitle = new Map<string, AwarenessEntry[]>();
  for (const e of entries) {
    const key = normaliseTitle(e.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), e]);
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    for (const e of group) {
      errors.push({ id: e.id, reason: `its title "${e.title}" is also the title of ${group.filter(o => o !== e).map(o => o.id).join(', ')}` });
    }
  }
  entries = entries.filter(e => byTitle.get(normaliseTitle(e.title))!.length === 1);
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // The section as a whole: wrapped in markers, the finder sees one well-formed block spanning it.
  for (const hasTelegram of [true, false]) {
    const eligible = entries.filter(e => e.requires !== 'telegram' || hasTelegram);
    if (eligible.length === 0) continue;
    const block = wrapInMarkers(renderSectionOf(eligible, CHECK_PORT));
    const found = findRegistryBlock(block);
    if (found.state !== 'well-formed' || found.start !== 0 || found.end !== block.length) {
      errors.push({ id: '*', reason: 'the rendered section does not read back as one well-formed block; no entry is rendered' });
      entries = [];
      break;
    }
  }
  return { entries, errors };
}

function buildRegistry(load: () => Loaded): AwarenessRegistry {
  let loaded: Loaded | null = null;
  const get = (): Loaded => (loaded ??= load());
  const handed = new Map<string, Set<string>>();
  const registry: AwarenessRegistry = {
    eligibleEntries(ctx) {
      return get().entries.filter(e => e.requires !== 'telegram' || ctx.hasTelegram);
    },
    renderSection(ctx) {
      return renderSectionOf(registry.eligibleEntries(ctx), ctx.port);
    },
    withRegistry(doc, ctx, opts) {
      const found = findRegistryBlock(doc);
      if (found.state === 'broken') return { content: doc, changed: false, broken: true };
      const section = registry.renderSection(ctx);
      const stripped = withoutRegistryBlock(doc);
      const next = section === '' ? stripped : appendAtEnd(stripped, opts.markers ? wrapInMarkers(section) : section);
      if (section !== '' && opts.markers) {
        // Read the result back. A document that ends inside an unclosed code fence (or whose
        // old block sits inside one) hides the marker lines from the finder, so the next
        // update would append a second block. Such a document is broken: change nothing.
        const back = findRegistryBlock(next);
        if (back.state !== 'well-formed' || back.end !== next.length) return { content: doc, changed: false, broken: true };
      }
      return next === doc ? { content: doc, changed: false, broken: false } : { content: next, changed: true, broken: false };
    },
    errors() {
      return get().errors.map(e => ({ ...e }));
    },
    takeUnreportedErrors(channel) {
      const seen = handed.get(channel) ?? new Set<string>();
      handed.set(channel, seen);
      const out: AwarenessEntryError[] = [];
      for (const e of get().errors) {
        const key = `${e.id}\u0000${e.reason}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...e });
      }
      return out;
    },
  };
  return registry;
}

/** A registry over any directory of entry files (tests pass a temporary directory). Read lazily, once. */
export function createRegistry(dirUrl: URL): AwarenessRegistry {
  return buildRegistry(() => loadDirectory(dirUrl));
}

/** A registry with no entries and no errors: what `buildCanonicalClaudeMd({ registry: false })` passes on. */
export function emptyRegistry(): AwarenessRegistry {
  return buildRegistry(() => ({ entries: [], errors: [] }));
}

/** The package's own entries. The same relative path from `src/awareness/` and `dist/awareness/`. */
export const AWARENESS_ENTRY_DIR_URL = new URL('../../src/data/awareness/', import.meta.url);

let real: AwarenessRegistry | null = null;
/** The registry over the installed package's `src/data/awareness/`, read once per process. */
export function defaultRegistry(): AwarenessRegistry {
  return (real ??= createRegistry(AWARENESS_ENTRY_DIR_URL));
}

export function eligibleEntries(ctx: AwarenessContext): AwarenessEntry[] {
  return defaultRegistry().eligibleEntries(ctx);
}

export function renderRegistrySection(ctx: AwarenessContext): string {
  return defaultRegistry().renderSection(ctx);
}

export function withRegistry(doc: string, ctx: AwarenessContext, opts: { markers: boolean }): WithRegistryResult {
  return defaultRegistry().withRegistry(doc, ctx, opts);
}

/** The real registry's error list. */
export function registryErrors(): AwarenessEntryError[] {
  return defaultRegistry().errors();
}

/** One line per error row, for the migrator's `result.errors`. Each row is handed out once per process. */
export function unreportedRegistryErrorLines(registry: AwarenessRegistry = defaultRegistry(), channel = 'migrator'): string[] {
  return registry.takeUnreportedErrors(channel).map(e => `${AWARENESS_REGISTRY_FEATURE}: ${e.id}: ${e.reason} (left out of the feature notes)`);
}

export interface AwarenessRegistryDegradation {
  feature: string;
  primary: string;
  fallback: string;
  reason: string;
  impact: string;
}

/** Degradation events for the server to report at start. Each row is handed out once per process. */
export function unreportedRegistryDegradations(registry: AwarenessRegistry = defaultRegistry(), channel = 'server'): AwarenessRegistryDegradation[] {
  return registry.takeUnreportedErrors(channel).map(e => ({
    feature: AWARENESS_REGISTRY_FEATURE,
    primary: 'Add every feature note to the agent instructions',
    fallback: 'The note is left out; every other note is still written.',
    reason: `${e.id}: ${e.reason}`,
    impact: 'The agent is not told about one feature until the entry file is fixed.',
  }));
}
