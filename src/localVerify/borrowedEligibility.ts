/**
 * Which unit test files may go to a borrowed helper (docs/specs/local-verify-borrowed-unit-slices.md, D).
 *
 * A file may go only if it passes all three checks:
 *  1. it is not on the fixed exclude list BORROWED_EXCLUDE;
 *  2. the literal scan finds no hit in the test file or its DIRECT imports. This is a HARD SAFETY
 *     FLOOR for the owner's personal machine, on top of the sandbox walls (Chief of Staff approval
 *     2026-11-18, fold-in 2: Signal vs Authority). Every hit is returned as a counted signal
 *     (`scan-hit { file, matchedFile, line, pattern }`) and listed in the shadow report, so false
 *     blocks are visible and patterns are corrected by a code change. A hit deeper in the import
 *     closure is recorded (`scanDeepHits`) but does not exclude. A false hit costs nothing: every
 *     file runs locally anyway, and the scan never stops a run;
 *  3. it is not on that helper's learned exclude list (judgment within the floor, efficiency only).
 *
 * The scan matches call sites and string literals only, never identifiers or comments.
 *
 * Both sides use this module: the run machine to choose files, the helper to check for itself.
 * Pure apart from the injected tree reader.
 */
import path from 'node:path';
import { classifyTestPath } from './inventory.js';

/** The fixed exclude list (in code): files matching any entry never go to a helper. */
export const BORROWED_EXCLUDE: ReadonlyArray<{ id: string; re: RegExp }> = Object.freeze([
  // The Mac desktop helper (and the other desktop bridges): need the owner's real desktop.
  { id: 'desktop-helper', re: /desktop/i },
  // Chrome / CDP drivers.
  { id: 'chrome-cdp', re: /chrome|cdp/i },
  // The Codex CLI.
  { id: 'codex-tool', re: /codex/i },
  // launchd (macOS service manager).
  { id: 'launchd', re: /launchd|launchagent|launchctl|plist/i },
  // tmux-driving tests.
  { id: 'tmux', re: /tmux/i },
]);

/** The seeded known-red canary lives here (spec F). Excluded from the normal unit lane inventory. */
export const BORROWED_CANARY_DIR = 'tests/fixtures/borrowed-canary/';

export function isBorrowedCanaryFile(file: string): boolean {
  return file.startsWith(BORROWED_CANARY_DIR) && file.endsWith('.test.ts') && !file.slice(BORROWED_CANARY_DIR.length).includes('/');
}

/** A unit-lane test file (the inventory's own rule), or one of the canary fixtures. */
export function isBorrowableTestFile(file: string): boolean {
  if (isBorrowedCanaryFile(file)) return true;
  const c = classifyTestPath(file);
  return c.kind === 'laned' && c.lane === 'unit';
}

export function excludedBy(file: string): string | null {
  for (const e of BORROWED_EXCLUDE) if (e.re.test(file)) return e.id;
  return null;
}

export type ScanPattern =
  | 'spawn-launchctl' | 'spawn-osascript' | 'spawn-tmux' | 'spawn-open' | 'spawn-security'
  | 'literal-library-path' | 'literal-home-path' | 'homedir-call' | 'env-home-read'
  /** Fail-closed hits: the file (or a direct import) could not be read or resolved, or is over 1 MB. */
  | 'unreadable' | 'oversize';

export interface ScanHit { file: string; matchedFile: string; line: number; pattern: ScanPattern }

interface Lexed {
  /** Comments blanked (newlines kept); string literals intact. */
  noComments: string;
  /** Comments and string contents blanked (quotes kept). */
  codeOnly: string;
  literals: Array<{ value: string; line: number }>;
}

/** A small lexer: enough to tell comments and string literals from code in TS/JS source. */
export function lex(src: string): Lexed {
  let noComments = '';
  let codeOnly = '';
  const literals: Array<{ value: string; line: number }> = [];
  let line = 1;
  let i = 0;
  // Template literal nesting: each entry is the brace depth at which a `${` opened.
  const tplStack: number[] = [];
  let braceDepth = 0;
  const push = (ch: string, keepInCode: boolean): void => {
    noComments += ch;
    codeOnly += keepInCode || ch === '\n' ? ch : ' ';
    if (ch === '\n') line++;
  };
  const readString = (quote: string): void => {
    const startLine = line;
    push(quote, true);
    i++;
    let value = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < src.length) { push(ch, false); push(src[i + 1], false); value += src[i + 1]; i += 2; continue; }
      if (quote === '`' && ch === '$' && src[i + 1] === '{') {
        literals.push({ value, line: startLine });
        value = '';
        push('$', true); push('{', true); i += 2;
        tplStack.push(braceDepth);
        braceDepth++;
        return;
      }
      if (ch === quote) { push(ch, true); i++; literals.push({ value, line: startLine }); return; }
      if (ch === '\n' && quote !== '`') { push(ch, true); i++; literals.push({ value, line: startLine }); return; }
      push(ch, false);
      value += ch;
      i++;
    }
    literals.push({ value, line: startLine });
  };
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];
    if (ch === '/' && nx === '/') {
      while (i < src.length && src[i] !== '\n') { noComments += ' '; codeOnly += ' '; i++; }
      continue;
    }
    if (ch === '/' && nx === '*') {
      i += 2; noComments += '  '; codeOnly += '  ';
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        const c = src[i] === '\n' ? '\n' : ' ';
        noComments += c; codeOnly += c;
        if (src[i] === '\n') line++;
        i++;
      }
      if (i < src.length) { noComments += '  '; codeOnly += '  '; i += 2; }
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { readString(ch); continue; }
    if (ch === '/' && regexAllowed()) {
      // A regex literal: copied as code so a quote inside it does not open a string.
      let inClass = false;
      push(ch, true); i++;
      while (i < src.length && src[i] !== '\n') {
        const c = src[i];
        if (c === '\\' && i + 1 < src.length) { push(c, true); push(src[i + 1], true); i += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        push(c, true); i++;
        if (c === '/' && !inClass) break;
      }
      continue;
    }
    if (ch === '{') braceDepth++;
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      if (tplStack.length > 0 && tplStack[tplStack.length - 1] === braceDepth) {
        tplStack.pop();
        push('}', true); i++;
        // Resume the template literal after its `${…}`.
        resumeTemplate();
        continue;
      }
    }
    push(ch, true);
    i++;
  }
  return { noComments, codeOnly, literals };

  /** A `/` starts a regex literal after an operator or keyword position, never after a value. */
  function regexAllowed(): boolean {
    let k = noComments.length - 1;
    while (k >= 0 && /\s/.test(noComments[k])) k--;
    if (k < 0) return true;
    const last = noComments[k];
    if ('(,=:[!&|?{};+-*%<>~^'.includes(last)) return true;
    const tail = noComments.slice(Math.max(0, k - 10), k + 1);
    return /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(tail);
  }

  function resumeTemplate(): void {
    const startLine = line;
    let value = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length) { push(c, false); push(src[i + 1], false); value += src[i + 1]; i += 2; continue; }
      if (c === '$' && src[i + 1] === '{') {
        literals.push({ value, line: startLine });
        push('$', true); push('{', true); i += 2;
        tplStack.push(braceDepth);
        braceDepth++;
        return;
      }
      if (c === '`') { push(c, true); i++; literals.push({ value, line: startLine }); return; }
      push(c, false);
      value += c;
      i++;
    }
    literals.push({ value, line: startLine });
  }
}

const lineAt = (text: string, index: number): number => {
  let n = 1;
  for (let k = 0; k < index && k < text.length; k++) if (text.charCodeAt(k) === 10) n++;
  return n;
};

const SPAWN_RE = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync|fork)\s*\(\s*(['"`])\s*(launchctl|osascript|tmux|open|security)(?=[\s'"`])/g;
const HOMEDIR_RE = /\bhomedir\s*\(\s*\)/g;
const ENV_HOME_DOT_RE = /\bprocess\s*\.\s*env\s*\.\s*HOME\b/g;
const ENV_HOME_IDX_RE = /\bprocess\s*\.\s*env\s*\[\s*(['"`])HOME\1\s*\]/g;

/** Scan one source text. Returns hits with their line numbers (1-based). */
export function scanSource(text: string): Array<{ line: number; pattern: ScanPattern }> {
  const lx = lex(text);
  const out: Array<{ line: number; pattern: ScanPattern }> = [];
  for (const m of lx.noComments.matchAll(SPAWN_RE)) out.push({ line: lineAt(lx.noComments, m.index ?? 0), pattern: `spawn-${m[2]}` as ScanPattern });
  for (const lit of lx.literals) {
    if (lit.value.startsWith('~/')) out.push({ line: lit.line, pattern: 'literal-home-path' });
    else if (lit.value.includes('/Library/')) out.push({ line: lit.line, pattern: 'literal-library-path' });
  }
  for (const m of lx.codeOnly.matchAll(HOMEDIR_RE)) out.push({ line: lineAt(lx.codeOnly, m.index ?? 0), pattern: 'homedir-call' });
  for (const m of lx.codeOnly.matchAll(ENV_HOME_DOT_RE)) out.push({ line: lineAt(lx.codeOnly, m.index ?? 0), pattern: 'env-home-read' });
  for (const m of lx.noComments.matchAll(ENV_HOME_IDX_RE)) out.push({ line: lineAt(lx.noComments, m.index ?? 0), pattern: 'env-home-read' });
  return out.sort((a, b) => a.line - b.line);
}

const IMPORT_RE = /(?:^|[^\w$.])(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s*)?(['"])(\.{1,2}\/[^'"\n]+)\2|(?:\bimport|\brequire)\s*\(\s*(['"])(\.{1,2}\/[^'"\n]+)\4\s*\)/g;

/** Relative imports of a source file, resolved to repo paths (type-only imports skipped: they run no code). */
export function directImports(file: string, text: string): string[] {
  const lx = lex(text);
  const out = new Set<string>();
  for (const m of lx.noComments.matchAll(IMPORT_RE)) {
    if (m[1]) continue; // `import type … from`
    const spec = m[3] ?? m[5];
    if (!spec) continue;
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (joined.startsWith('..')) continue;
    out.add(joined);
  }
  return [...out];
}

/** The repo-path candidates a specifier may resolve to (`.js` → `.ts`, bare → `.ts` / `/index.ts`). */
export function resolutionCandidates(p: string): string[] {
  if (/\.(?:m|c)?js$/.test(p)) return [p.replace(/\.(m|c)?js$/, (_x, k) => (k ? `.${k}ts` : '.ts')), p];
  if (/\.(?:m|c)?ts$|\.json$/.test(p)) return [p];
  return [`${p}.ts`, `${p}/index.ts`, `${p}.js`];
}

export interface TreeReader {
  /**
   * The file's text at the tree under judgment, or null when the file is absent. THROWS when the
   * file cannot be read: the scan then fails closed (the file is ineligible, `unreadable`).
   */
  read(file: string): Promise<string | null>;
}

export const SCAN_LIMITS = Object.freeze({ deepFilesMax: 200, fileBytesMax: 1024 * 1024 });

export interface FileScan { hits: ScanHit[]; deepHits: ScanHit[] }

/** A cached read: its text and scan hits, or why it has no text. */
export interface ScanCacheEntry { text: string | null; hits: Array<{ line: number; pattern: ScanPattern }>; error?: 'absent' | 'unreadable' | 'oversize' }
export type ScanCache = Map<string, ScanCacheEntry>;

/**
 * Scan a test file and its direct imports (hits exclude), then the rest of its import closure up
 * to SCAN_LIMITS.deepFilesMax files (deep hits are recorded only). `cache` is shared across files
 * of one tree so a common import is read and scanned once.
 *
 * The scan is a hard floor, so it FAILS CLOSED: a test file or a direct import that cannot be
 * read, cannot be resolved, or is over 1 MB is itself a hit (`unreadable` / `oversize`, line 0), so
 * the file stays local and the hit is counted like any other.
 */
export async function scanTestFile(file: string, reader: TreeReader, cache: ScanCache = new Map()): Promise<FileScan> {
  const load = async (p: string): Promise<{ resolved: string } & ScanCacheEntry> => {
    for (const cand of resolutionCandidates(p)) {
      let c = cache.get(cand);
      if (!c) {
        let t: string | null;
        try { t = await reader.read(cand); } catch { t = null; c = { text: null, hits: [], error: 'unreadable' }; }
        if (!c) {
          if (t === null) c = { text: null, hits: [], error: 'absent' };
          else if (t.length > SCAN_LIMITS.fileBytesMax) c = { text: null, hits: [], error: 'oversize' };
          else c = { text: t, hits: scanSource(t) };
        }
        cache.set(cand, c);
      }
      if (c.error === 'absent') continue;
      return { resolved: cand, ...c };
    }
    return { resolved: p, text: null, hits: [], error: 'absent' };
  };
  const failHit = (e: ScanCacheEntry['error']): ScanPattern => (e === 'oversize' ? 'oversize' : 'unreadable');
  const hits: ScanHit[] = [];
  const deepHits: ScanHit[] = [];
  const root = await load(file);
  if (root.text === null) { hits.push({ file, matchedFile: root.resolved, line: 0, pattern: failHit(root.error) }); return { hits, deepHits }; }
  for (const h of root.hits) hits.push({ file, matchedFile: file, line: h.line, pattern: h.pattern });
  const seen = new Set<string>([root.resolved]);
  let frontier: string[] = [];
  for (const imp of directImports(root.resolved, root.text)) {
    const d = await load(imp);
    if (seen.has(d.resolved)) continue;
    seen.add(d.resolved);
    if (d.text === null) { hits.push({ file, matchedFile: d.resolved, line: 0, pattern: failHit(d.error) }); continue; }
    for (const h of d.hits) hits.push({ file, matchedFile: d.resolved, line: h.line, pattern: h.pattern });
    frontier.push(...directImports(d.resolved, d.text));
  }
  while (frontier.length > 0 && seen.size < SCAN_LIMITS.deepFilesMax) {
    const next: string[] = [];
    for (const imp of frontier) {
      if (seen.size >= SCAN_LIMITS.deepFilesMax) break;
      const d = await load(imp);
      if (seen.has(d.resolved)) continue;
      seen.add(d.resolved);
      if (d.text === null) { deepHits.push({ file, matchedFile: d.resolved, line: 0, pattern: failHit(d.error) }); continue; }
      for (const h of d.hits) deepHits.push({ file, matchedFile: d.resolved, line: h.line, pattern: h.pattern });
      next.push(...directImports(d.resolved, d.text));
    }
    frontier = next;
  }
  return { hits, deepHits };
}

export type IneligibleReason = 'not-unit' | 'excluded' | 'scan-hit' | 'learned';

export interface EligibilityVerdict {
  file: string;
  eligible: boolean;
  reason: IneligibleReason | null;
  excludeId?: string;
  hits: ScanHit[];
  deepHits: ScanHit[];
}

/**
 * Judge files against D. `learned` is the helper's learned list; `bypassLearned` holds the files a
 * signed retrial request may name (it bypasses only that one exclusion).
 */
export async function judgeEligibility(
  files: readonly string[],
  reader: TreeReader,
  learned: ReadonlySet<string>,
  opts: { bypassLearned?: ReadonlySet<string>; cache?: ScanCache } = {},
): Promise<EligibilityVerdict[]> {
  const cache = opts.cache ?? new Map();
  const out: EligibilityVerdict[] = [];
  for (const file of files) {
    if (!isBorrowableTestFile(file)) { out.push({ file, eligible: false, reason: 'not-unit', hits: [], deepHits: [] }); continue; }
    const ex = excludedBy(file);
    if (ex) { out.push({ file, eligible: false, reason: 'excluded', excludeId: ex, hits: [], deepHits: [] }); continue; }
    const scan = await scanTestFile(file, reader, cache);
    if (scan.hits.length > 0) { out.push({ file, eligible: false, reason: 'scan-hit', ...scan }); continue; }
    if (learned.has(file) && !opts.bypassLearned?.has(file)) { out.push({ file, eligible: false, reason: 'learned', ...scan }); continue; }
    out.push({ file, eligible: true, reason: null, ...scan });
  }
  return out;
}

/** Time-weighted share of unit time the scan makes ineligible (audited every run). */
export function scanIneligibleShare(verdicts: readonly EligibilityVerdict[], durations: Readonly<Record<string, number>>): number {
  let total = 0;
  let scan = 0;
  for (const v of verdicts) {
    const ms = Number.isFinite(durations[v.file]) ? durations[v.file] : 0;
    total += ms;
    if (v.reason === 'scan-hit') scan += ms;
  }
  return total > 0 ? Math.round((scan / total) * 1000) / 1000 : 0;
}
