#!/usr/bin/env node
/**
 * lint-gitleaks-allowlist-exact.mjs — the exceptions file for the pull-request
 * secret scan (`.gitleaks.toml`) may list EXACT VALUES only.
 *
 * Why: on 2026-11-21 a folder-wide exception let a planted fake token through a
 * secret scan. An exception that names a path, folder, file, rule or commit
 * excuses everything that will ever be written there; an exception that names
 * one exact value excuses that value and nothing else.
 *
 * What is accepted in `.gitleaks.toml`:
 *   - `title`, `[extend] useDefault = true` (the default gitleaks rules), and
 *   - ONE `[allowlist]` table with `description`, `regexTarget = "secret"` and
 *     `regexes`, where every regex is `^` + an escaped literal + `$`: every
 *     character is either alphanumeric, `_`, `-`, or preceded by a backslash
 *     (`\n`, `\r`, `\t` stand for those characters). Anything that can match
 *     more than one value — an unescaped `.`, `*`, `+`, `?`, `[`, `(`, `|`, a
 *     character class, a missing anchor — is refused.
 * Refused: `paths`, `commits`, `stopwords`, any `[[rules]]`, any
 * `[rules.allowlist]`, any other table, and a second allowlist.
 *
 * Usage:
 *   node scripts/lint-gitleaks-allowlist-exact.mjs            check `.gitleaks.toml`
 *   node scripts/lint-gitleaks-allowlist-exact.mjs <file>     check another file
 *   node scripts/lint-gitleaks-allowlist-exact.mjs --entry <file-holding-the-exact-value>
 *       print the one line to paste into `regexes` for the exact contents of
 *       that file (a trailing newline is dropped). The value is read from a
 *       file so it never appears in a shell history or a process list.
 *
 * Exit codes: 0 clean · 1 refused (each problem on its own line) · 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
export const DEFAULT_FILE = path.join(REPO_ROOT, '.gitleaks.toml');

const ALLOWED_TOP_KEYS = new Set(['title', 'extend', 'allowlist']);
const ALLOWED_ALLOWLIST_KEYS = new Set(['description', 'regexTarget', 'regexes']);
const FORBIDDEN_ALLOWLIST_KEYS = ['paths', 'commits', 'stopwords', 'targetRules'];

/**
 * The characters that mean something in a regular expression (RE2 and
 * JavaScript alike). Only these are escaped: RE2 refuses a backslash before a
 * letter, a space or a non-ASCII character, so everything else stays literal.
 */
const META = new Set(['\\', '.', '+', '*', '?', '(', ')', '|', '[', ']', '{', '}', '^', '$']);

/** `^` + escaped literal + `$`, one regex per exact value. */
export function regexForExactValue(value) {
  let out = '^';
  for (const c of String(value)) {
    if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (META.has(c)) out += '\\' + c;
    else out += c;
  }
  return out + '$';
}

/** The TOML line for one exact value (a basic string, so `\` and `"` are escaped). */
export function tomlLineForExactValue(value) {
  const re = regexForExactValue(value);
  return `  "${re.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}",`;
}

/**
 * Is this regex an anchored escaped literal? Pure. Returns null when it is,
 * otherwise a short reason.
 */
export function literalRegexProblem(re) {
  if (typeof re !== 'string') return 'not a string';
  if (!re.startsWith('^') || !re.endsWith('$')) return 'not anchored with ^ and $';
  const body = re.slice(1, -1);
  if (body.length === 0) return 'empty value';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      const next = body[i + 1];
      if (next === undefined) return 'trailing backslash';
      // Only a metacharacter or one of the three whitespace escapes may follow
      // a backslash: \d, \w, \s, \b and friends are classes, and RE2 refuses
      // the rest anyway.
      if (!META.has(next) && !['n', 'r', 't'].includes(next)) {
        return `\\${next} is a character class or an invalid escape, not a literal`;
      }
      i++;
      continue;
    }
    if (META.has(c)) return `unescaped '${c}' can match more than one value`;
  }
  return null;
}

/** Check a parsed config. Pure. Returns the list of problems (empty = clean). */
export function allowlistProblems(parsed) {
  const problems = [];
  if (!parsed || typeof parsed !== 'object') return ['config is not a table'];
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      problems.push(key === 'rules'
        ? 'custom [[rules]] (and their allowlists) are not allowed here; the default rules apply'
        : `unexpected top-level key "${key}"`);
    }
  }
  const ext = parsed.extend;
  if (!ext || ext.useDefault !== true) problems.push('[extend] useDefault must be true: the default gitleaks rules are the scan');
  if (ext && Object.keys(ext).some((k) => k !== 'useDefault')) problems.push('[extend] may only set useDefault');
  const al = parsed.allowlist;
  if (al === undefined) return problems; // no exceptions at all is fine
  if (Array.isArray(al)) { problems.push('more than one [allowlist]; keep exactly one'); return problems; }
  if (typeof al !== 'object') { problems.push('[allowlist] is not a table'); return problems; }
  for (const key of FORBIDDEN_ALLOWLIST_KEYS) {
    if (key in al) problems.push(`[allowlist] ${key} is refused: exceptions must name exact values, never a ${key === 'paths' ? 'path or folder' : key.replace(/s$/, '')}`);
  }
  for (const key of Object.keys(al)) {
    if (!ALLOWED_ALLOWLIST_KEYS.has(key) && !FORBIDDEN_ALLOWLIST_KEYS.includes(key)) problems.push(`[allowlist] unexpected key "${key}"`);
  }
  if (al.regexTarget !== 'secret') problems.push('[allowlist] regexTarget must be "secret" so each exception matches the found value, not its whole line');
  const regexes = al.regexes;
  if (regexes !== undefined) {
    if (!Array.isArray(regexes)) problems.push('[allowlist] regexes must be a list');
    else {
      const seen = new Set();
      regexes.forEach((re, i) => {
        const why = literalRegexProblem(re);
        if (why) problems.push(`[allowlist] regexes[${i}] is not one exact value: ${why}`);
        if (seen.has(re)) problems.push(`[allowlist] regexes[${i}] repeats an earlier entry`);
        seen.add(re);
      });
    }
  }
  return problems;
}

/** Read and check a file. Returns { ok, problems, entries }. */
export function checkFile(file = DEFAULT_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, problems: [`cannot read ${file}: ${e.message}`], entries: 0 }; }
  let parsed;
  try { parsed = parse(text); }
  catch (e) { return { ok: false, problems: [`not valid TOML: ${e.message}`], entries: 0 }; }
  const problems = allowlistProblems(parsed);
  const entries = Array.isArray(parsed?.allowlist?.regexes) ? parsed.allowlist.regexes.length : 0;
  return { ok: problems.length === 0, problems, entries };
}

function main(argv) {
  if (argv[0] === '--entry') {
    const src = argv[1];
    if (!src) { console.error('usage: --entry <file holding the exact value>'); return 2; }
    const raw = fs.readFileSync(src, 'utf8').replace(/\r?\n$/, '');
    console.log(tomlLineForExactValue(raw));
    return 0;
  }
  const file = argv[0] ? path.resolve(argv[0]) : DEFAULT_FILE;
  const r = checkFile(file);
  if (r.ok) {
    console.log(`lint-gitleaks-allowlist-exact: clean — ${r.entries} exact-value exception(s), no path, folder, rule or commit exception.`);
    return 0;
  }
  console.error(`lint-gitleaks-allowlist-exact: REFUSED ${path.relative(REPO_ROOT, file)}:`);
  for (const p of r.problems) console.error(`  - ${p}`);
  console.error('Exceptions must be exact values. Add one with: node scripts/lint-gitleaks-allowlist-exact.mjs --entry <file holding the exact value>');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exit(main(process.argv.slice(2)));
}
