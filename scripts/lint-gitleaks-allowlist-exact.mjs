#!/usr/bin/env node
// safe-git-allow: read-only `git diff --name-only` over a commit range in a CI helper; it never writes, deletes or moves anything.
/**
 * lint-gitleaks-allowlist-exact.mjs — the exceptions for the pull-request
 * secret scan may be EXACT VALUES only, and nothing else may excuse a finding.
 *
 * Why: on 2026-11-21 a folder-wide exception let a planted fake token through a
 * secret scan. An exception that names a path, folder, file, rule or commit
 * excuses everything that will ever be written there; an exception that names
 * one exact value excuses that value and nothing else.
 *
 * Three jobs, all run by `.github/workflows/secret-scan.yml` before gitleaks:
 *
 * 1. `.gitleaks.toml` is checked, and must be byte for byte the canonical rendering
 *    of its own values (`--canonical`), so it carries no comment or stray line that
 *    could hide a value no scan reads. Accepted: `title`, `[extend] useDefault = true`
 *    (the default gitleaks rules), and ONE `[allowlist]` table with
 *    `description`, `regexTarget = "secret"` and `regexes`, where every regex is
 *    `^` + an escaped literal + `$`: only the regex metacharacters
 *    `\ . + * ? ( ) | [ ] { } ^ $` may follow a backslash (plus `\n`, `\r`, `\t`),
 *    and none may appear unescaped. Refused: `paths`, `commits`, `stopwords`,
 *    `targetRules`, any `[[rules]]`, any other table, a second allowlist, a
 *    duplicate, or the default rules switched off.
 * 2. A `.gitleaksignore` file in the tree is refused: it is a commit- and
 *    file-scoped exception gitleaks reads on its own (`--gitleaks-ignore-path`).
 * 3. `--shadowed-paths <base>..<head>` lists (NUL-separated) the files that range
 *    adds or changes whose PATH gitleaks' own default allowlist, global or per rule,
 *    would skip entirely (node_modules, vendor, lockfiles, image/font/document
 *    extensions, BitBake files, octokit's README, …). The workflow scans the CONTENT
 *    of those files through `gitleaks stdin`, where no path rule applies, so the
 *    default folder exceptions cannot hide a planted value either. The repository's
 *    own `.gitleaks.toml` is excluded: its escaped entries read as keys, and the
 *    checker already polices every field of it.
 *
 * Usage:
 *   node scripts/lint-gitleaks-allowlist-exact.mjs                 check .gitleaks.toml and the tree
 *   node scripts/lint-gitleaks-allowlist-exact.mjs <file>          check another config file only
 *   node scripts/lint-gitleaks-allowlist-exact.mjs --entry <file>  print the regexes line for the
 *                                                                  exact contents of <file> (trailing
 *                                                                  newline dropped; read from a file so
 *                                                                  the value never hits a shell history)
 *   node scripts/lint-gitleaks-allowlist-exact.mjs --shadowed-paths <base>..<head>
 *   node scripts/lint-gitleaks-allowlist-exact.mjs --canonical [file]  print the one acceptable
 *                                                                  form of the file (see HEADER)
 *
 * Exit codes: 0 clean · 1 refused (each problem on its own line) · 2 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
export const DEFAULT_FILE = path.join(REPO_ROOT, '.gitleaks.toml');
export const IGNORE_FILE = '.gitleaksignore';

const ALLOWED_TOP_KEYS = new Set(['title', 'extend', 'allowlist']);
const ALLOWED_ALLOWLIST_KEYS = new Set(['description', 'regexTarget', 'regexes']);
const FORBIDDEN_ALLOWLIST_KEYS = ['paths', 'commits', 'stopwords', 'targetRules'];
/** The file's `title` and `[allowlist] description` are fixed: with them constant, the file has no free text at all. */
export const TITLE = 'instar pull-request secret scan';
export const DESCRIPTION = 'exact fixture and placeholder values only; see the header';

/**
 * The characters that mean something in a regular expression (RE2 and
 * JavaScript alike). Only these are escaped: RE2 refuses a backslash before a
 * letter, a space or a non-ASCII character, so everything else stays literal.
 */
const META = new Set(['\\', '.', '+', '*', '?', '(', ')', '|', '[', ']', '{', '}', '^', '$']);

/**
 * The `paths` of gitleaks 8.30.1's default global allowlist (config/gitleaks.toml
 * in the gitleaks repository), as JavaScript regexes: `(?i)` became the `i` flag.
 * A file whose path matches one of these is skipped by gitleaks regardless of
 * content, so the workflow scans such files' content through `gitleaks stdin`.
 * Keep this list in step with the pinned GITLEAKS_VERSION in the workflow.
 */
export const DEFAULT_PATH_ALLOWLIST = [
  /gitleaks\.toml/,
  /\.(?:bmp|gif|jpe?g|png|svg|tiff?)$/i,
  /\.(?:eot|[ot]tf|woff2?)$/i,
  /\.(?:docx?|xlsx?|pdf|bin|socket|vsidx|v2|suo|wsuo|.dll|pdb|exe|gltf)$/i,
  /go\.(?:mod|sum|work(?:\.sum)?)$/,
  /(?:^|\/)vendor\/modules\.txt$/,
  /(?:^|\/)vendor\/(?:github\.com|golang\.org\/x|google\.golang\.org|gopkg\.in|istio\.io|k8s\.io|sigs\.k8s\.io)(?:\/.*)?$/,
  /(?:^|\/)gradlew(?:\.bat)?$/,
  /(?:^|\/)gradle\.lockfile$/,
  /(?:^|\/)mvnw(?:\.cmd)?$/,
  /(?:^|\/)\.mvn\/wrapper\/MavenWrapperDownloader\.java$/,
  /(?:^|\/)node_modules(?:\/.*)?$/,
  /(?:^|\/)(?:deno\.lock|npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /(?:^|\/)bower_components(?:\/.*)?$/,
  /(?:^|\/)(?:angular|bootstrap|jquery(?:-?ui)?|plotly|swagger-?ui)[a-zA-Z0-9.-]*(?:\.min)?\.js(?:\.map)?$/,
  /(?:^|\/)javascript\.json$/,
  /(?:^|\/)(?:Pipfile|poetry)\.lock$/,
  /(?:^|\/)(?:v?env|virtualenv)\/lib(?:64)?(?:\/.*)?$/i,
  /(?:^|\/)(?:lib(?:64)?\/python[23](?:\.\d{1,2})+|python\/[23](?:\.\d{1,2})+\/lib(?:64)?)(?:\/.*)?$/i,
  /(?:^|\/)[a-z0-9_.]+-[0-9.]+\.dist-info(?:\/.+)?$/i,
  /(?:^|\/)vendor\/(?:bundle|ruby)(?:\/.*?)?$/,
  /\.gem$/,
  /verification-metadata\.xml/,
  /Database.refactorlog/,
  /(?:^|\/)\.git$/,
  // Rule-level path exceptions in the same default config (not in the global list):
  // generic-api-key skips BitBake files; github-pat and github-app-token skip octokit's README.
  /\.(?:bb|bbappend|bbclass|inc)$/,
  /(?:^|\/)@octokit\/auth-token\/README\.md$/,
];

/**
 * The repository's own exceptions file is never scanned by content: its entries are
 * escaped regex text that gitleaks reads as private keys, and the checker above
 * already polices every byte of it (fixed keys, a bounded description, exact values).
 */
export const NEVER_SHADOWED = new Set(['.gitleaks.toml']);

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

/** A TOML basic string: `\` and `"` escaped, nothing else (the values hold neither newline nor control characters). */
function tomlBasic(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The TOML line for one exact value (a basic string, so `\` and `"` are escaped). */
export function tomlLineForExactValue(value) {
  return `  ${tomlBasic(regexForExactValue(value))},`;
}

/** The TOML line for one already-escaped regex, as it appears in the file. */
function tomlLineForRegex(re) {
  return `  ${tomlBasic(re)},`;
}

/**
 * The only comment the file may carry, fixed here. The file must be byte for
 * byte what `canonicalText` renders from its parsed values, so there is no free
 * text anywhere in it (a comment could otherwise hide a value that no scan reads:
 * gitleaks skips the file by path and a TOML parser drops comments).
 */
export const HEADER = `# Exceptions for the pull-request secret scan (gitleaks).
#
# RULE: list EXACT VALUES ONLY. Each entry is one literal value, escaped for a
# regular expression and anchored at both ends, so it matches that one value and
# nothing else. Never add a path, folder, file, rule or commit exception: a
# folder-wide exception let a planted fake token through on 2026-11-21.
# scripts/lint-gitleaks-allowlist-exact.mjs refuses anything else, and the
# Secret Scan workflow runs that check before it runs gitleaks.
#
# This file has NO free text: the checker refuses it unless it is exactly what
# \`node scripts/lint-gitleaks-allowlist-exact.mjs --canonical\` prints from its
# own values (this fixed header, a fixed title and description, [extend],
# [allowlist], the regexes). So no comment, title, blank or stray line can hold a
# value that nothing scans. A value with a control character other than tab,
# newline or return cannot be listed: TOML refuses it, so the file fails closed. To add an
# exception, run
#   node scripts/lint-gitleaks-allowlist-exact.mjs --entry <file-holding-the-exact-value>
# paste the printed line into the regexes list, then run --canonical > .gitleaks.toml.
`;

/** Render the one acceptable form of the file from its parsed values. Pure. */
export function canonicalText(parsed) {
  const lines = [HEADER.replace(/\n$/, ''), '', `title = ${tomlBasic(TITLE)}`, '', '[extend]', 'useDefault = true'];
  const al = parsed.allowlist;
  if (al && typeof al === 'object' && !Array.isArray(al)) {
    lines.push('', '[allowlist]', `description = ${tomlBasic(DESCRIPTION)}`, 'regexTarget = "secret"');
    const regexes = Array.isArray(al.regexes) ? al.regexes : [];
    lines.push('regexes = [', ...regexes.map(tomlLineForRegex), ']');
  }
  return lines.join('\n') + '\n';
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
  if (parsed.title !== TITLE) problems.push(`title must be exactly "${TITLE}": it is not a place for text`);
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
  if (al.description !== DESCRIPTION) problems.push(`[allowlist] description must be exactly "${DESCRIPTION}": it is not a place for text`);
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

/** Read and check a config file. Returns { ok, problems, entries }. */
export function checkFile(file = DEFAULT_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, problems: [`cannot read ${file}: ${e.message}`], entries: 0 }; }
  let parsed;
  try { parsed = parse(text); }
  catch (e) { return { ok: false, problems: [`not valid TOML: ${e.message}`], entries: 0 }; }
  const problems = allowlistProblems(parsed);
  if (problems.length === 0 && text !== canonicalText(parsed)) {
    problems.push('the file is not in its canonical form (a comment, blank line, ordering or quoting differs), so it could carry text no scan reads; regenerate it with: node scripts/lint-gitleaks-allowlist-exact.mjs --canonical > .gitleaks.toml');
  }
  const entries = Array.isArray(parsed?.allowlist?.regexes) ? parsed.allowlist.regexes.length : 0;
  return { ok: problems.length === 0, problems, entries };
}

/** A `.gitleaksignore` anywhere gitleaks would read it (the repo root) is a hidden exception. */
export function ignoreFileProblem(repoRoot = REPO_ROOT) {
  const p = path.join(repoRoot, IGNORE_FILE);
  return fs.existsSync(p) ? `${IGNORE_FILE} is refused: it excuses findings by commit and file; remove it and list exact values in .gitleaks.toml instead` : null;
}

/** The paths (pure) that gitleaks' default allowlist would skip by path alone, less the policed exceptions file. */
export function shadowedByDefaultPaths(paths) {
  return (paths ?? []).filter((p) => !NEVER_SHADOWED.has(p) && DEFAULT_PATH_ALLOWLIST.some((re) => re.test(p)));
}

/**
 * Files added or modified in `range` (git `base..head`) that the default path
 * allowlist shadows, read from the repository the command runs in (the workflow's
 * checkout), not from wherever this script happens to live.
 */
export function shadowedChangedPaths(range, repoRoot = process.cwd()) {
  // Every change but a deletion (adds, modifications, renames, copies, type changes),
  // from the merge base so main's own movement is not re-scanned; NUL-separated so a
  // path with spaces, quotes or non-ASCII survives (core.quotePath would mangle it).
  const spec = range.includes('...') ? range : range.replace('..', '...');
  const out = execFileSync('git', ['diff', '-z', '--name-only', '--diff-filter=d', spec], { cwd: repoRoot, encoding: 'utf8' });
  return shadowedByDefaultPaths(out.split('\0').filter(Boolean));
}

function main(argv) {
  if (argv[0] === '--entry') {
    const src = argv[1];
    if (!src) { console.error('usage: --entry <file holding the exact value>'); return 2; }
    const raw = fs.readFileSync(src, 'utf8').replace(/\r?\n$/, '');
    console.log(tomlLineForExactValue(raw));
    return 0;
  }
  if (argv[0] === '--canonical') {
    const file = argv[1] ? path.resolve(argv[1]) : DEFAULT_FILE;
    const parsed = parse(fs.readFileSync(file, 'utf8'));
    const problems = allowlistProblems(parsed);
    if (problems.length) { for (const p of problems) console.error(`  - ${p}`); return 1; }
    process.stdout.write(canonicalText(parsed));
    return 0;
  }
  if (argv[0] === '--shadowed-paths') {
    const range = argv[1];
    if (!range || !range.includes('..')) { console.error('usage: --shadowed-paths <base>..<head>'); return 2; }
    // NUL-separated, for `while IFS= read -r -d '' p` in the workflow.
    for (const p of shadowedChangedPaths(range)) process.stdout.write(p + '\0');
    return 0;
  }
  const file = argv[0] ? path.resolve(argv[0]) : DEFAULT_FILE;
  const r = checkFile(file);
  const problems = [...r.problems];
  if (!argv[0]) { const ig = ignoreFileProblem(); if (ig) problems.push(ig); }
  if (problems.length === 0) {
    console.log(`lint-gitleaks-allowlist-exact: clean — ${r.entries} exact-value exception(s), no path, folder, rule, commit or ${IGNORE_FILE} exception.`);
    return 0;
  }
  console.error(`lint-gitleaks-allowlist-exact: REFUSED ${path.relative(REPO_ROOT, file)}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Exceptions must be exact values. Add one with: node scripts/lint-gitleaks-allowlist-exact.mjs --entry <file holding the exact value>');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exit(main(process.argv.slice(2)));
}
