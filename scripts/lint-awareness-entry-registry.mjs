#!/usr/bin/env node
// safe-git-allow: advisory lint runs read-only `git merge-base` and `git diff` to see which lines a change adds; no mutation, and it must work before TypeScript is compiled.
/**
 * lint-awareness-entry-registry.mjs — ADVISORY notice for awareness text added the old way.
 *
 * New agent-awareness text goes in ONE new file, `src/data/awareness/<id>.md`
 * (docs/specs/awareness-entry-registry.md). This script reads the diff against the
 * merge base and prints a notice when it adds lines inside `patchClaudeMdContent`
 * (src/core/PostUpdateMigrator.ts) or adds a `content +=` line inside
 * `generateClaudeMd` (src/scaffold/templates.ts).
 *
 * It is a cheap text signal with no authority: it ALWAYS exits 0. The PR reviewer and
 * the author decide. Without a merge base (a shallow checkout) it prints "not checked".
 *
 * Options: --root <dir> (default: the repository this script is in), --base <ref>
 * (default: the merge base of HEAD with origin/main, else main).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'lint-awareness-entry-registry';
const ENTRY_DIR = 'src/data/awareness/';

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = path.resolve(argVal('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const TARGETS = [
  {
    file: 'src/scaffold/templates.ts',
    fn: 'generateClaudeMd',
    start: /^export function generateClaudeMd\(/,
    // The function body holds template text with `}` at column 0, so its end is the next export.
    end: /^export (function|const) /,
    counts: (text) => /\bcontent\s*\+=/.test(text),
    what: 'a `content +=` line',
  },
  {
    file: 'src/core/PostUpdateMigrator.ts',
    fn: 'patchClaudeMdContent',
    start: /^\s*private patchClaudeMdContent\(/,
    end: /^\s*return \{ content, patched \};/,
    counts: (text) => text.trim() !== '',
    what: 'lines',
  },
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

function mergeBase() {
  const explicit = argVal('--base');
  for (const ref of explicit ? [explicit] : ['origin/main', 'main']) {
    try {
      const base = git(['merge-base', 'HEAD', ref]).trim();
      if (base) return base;
    } catch {
      // @silent-fallback-ok: an unknown ref or a shallow checkout has no merge base; the next ref is tried and "not checked" is printed when none works.
    }
  }
  return null;
}

/** New-file line numbers of the lines a diff adds. */
function addedLines(base, file) {
  const diff = git(['diff', '--unified=0', base, '--', file]);
  const out = [];
  let at = 0;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { at = Number(hunk[1]); continue; }
    if (at === 0 || line.startsWith('+++')) continue;
    if (line.startsWith('+')) { out.push({ line: at, text: line.slice(1) }); at += 1; }
  }
  return out;
}

/** 1-based first and last line of the function in the current file, or null. */
function functionRange(target) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(ROOT, target.file), 'utf-8').split('\n');
  } catch {
    // @silent-fallback-ok: a checkout without the file has nothing to look at; the caller treats null as "no notice".
    return null;
  }
  const first = lines.findIndex((l) => target.start.test(l));
  if (first < 0) return null;
  const rel = lines.slice(first + 1).findIndex((l) => target.end.test(l));
  return { first: first + 1, last: rel < 0 ? lines.length + 1 : first + 2 + rel };
}

function main() {
  const base = mergeBase();
  if (!base) {
    console.log(`${NAME}: not checked (no merge base with main in this checkout).`);
    return;
  }
  let notices = 0;
  for (const target of TARGETS) {
    const range = functionRange(target);
    if (!range) continue;
    let added;
    try {
      added = addedLines(base, target.file);
    } catch {
      // @silent-fallback-ok: advisory only; a diff that cannot be read is said out loud and nothing is decided on it.
      console.log(`${NAME}: not checked (${target.file} could not be compared with the merge base).`);
      continue;
    }
    const hits = added.filter((a) => a.line > range.first && a.line < range.last && target.counts(a.text));
    if (hits.length === 0) continue;
    notices += 1;
    console.log(
      `${NAME}: NOTICE (advisory, nothing fails): this change adds ${target.what} inside ${target.fn} ` +
        `(${target.file}:${hits[0].line}${hits.length > 1 ? `, and ${hits.length - 1} more` : ''}). ` +
        `New agent-awareness text goes in one new file under ${ENTRY_DIR} instead (see ${ENTRY_DIR}README.md). ` +
        `Ignore this if the change is not new awareness text.`,
    );
  }
  if (notices === 0) console.log(`${NAME}: OK (no awareness text added the old way).`);
}

try {
  main();
} catch (err) {
  // @silent-fallback-ok: advisory lint; it reports its own failure and still exits 0 by design (spec 3.6).
  console.log(`${NAME}: not checked (${err instanceof Error ? err.message : String(err)}).`);
}
process.exit(0);
