/**
 * Structural wiring invariant: EVERY `new ParallelActivityIndex(...)` in src/
 * must supply `isRunning`.
 *
 * Earned 2026-08-14, twice in one hour:
 *  1. AgentServer supplied one, but it read `s.topicId` off Sessions — a field
 *     a Session does not declare — so it never returned true (fixed: PR #1870).
 *  2. `src/commands/server.ts` supplied NONE at all. `isRunning` is optional
 *     (`this.opts.isRunning?.(topicId) ?? false`), so an omitted predicate is
 *     indistinguishable from "nothing is running" — and the work queue scores
 *     topics `a.running ? 70 : 40`, so every topic was pinned at 40 forever.
 *
 * A default of `false` on an optional dependency is silent by construction: no
 * error, no warning, and the wrong answer looks exactly like the right one.
 * The only thing that can catch an omitted argument is a check that reads the
 * construction sites — so this test does that, and fails for any FUTURE site
 * that forgets, not just the two that did.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** Every .ts file under src/. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Extract the argument text of each `new ParallelActivityIndex(` occurrence by
 * scanning forward with paren depth — a regex cannot survive the nested object
 * literals and arrow bodies these arguments contain.
 */
export function constructionArgs(source: string): string[] {
  const out: string[] = [];
  const needle = 'new ParallelActivityIndex(';
  let i = source.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + needle.length - 1; // at the '('
    let start = j + 1;
    for (; j < source.length; j++) {
      const c = source[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(start, j));
    i = source.indexOf(needle, j);
  }
  return out;
}

describe('ParallelActivityIndex construction sites (wiring invariant)', () => {
  const files = sourceFiles(SRC);

  it('CONTROL: the sweep actually finds construction sites', () => {
    const total = files.reduce(
      (n, f) => n + constructionArgs(fs.readFileSync(f, 'utf8')).length,
      0,
    );
    // If this is 0 the invariant below is vacuous — a check that cannot fail.
    expect(total).toBeGreaterThan(0);
  });

  it('CONTROL: the extractor detects a site MISSING isRunning', () => {
    const args = constructionArgs(
      'const x = new ParallelActivityIndex({ stateDir: dir });',
    );
    expect(args).toHaveLength(1);
    expect(args[0]).not.toMatch(/isRunning/);
  });

  it('CONTROL: the extractor survives nested parens and arrow bodies', () => {
    const args = constructionArgs(
      'new ParallelActivityIndex({ stateDir: d, isRunning: (t) => f(g(t)).has(t) })',
    );
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/isRunning/);
  });

  it('every construction site in src/ supplies isRunning', () => {
    const missing: string[] = [];
    for (const f of files) {
      for (const args of constructionArgs(fs.readFileSync(f, 'utf8'))) {
        if (!/\bisRunning\b/.test(args)) missing.push(path.relative(SRC, f));
      }
    }
    expect(missing, `construction sites without isRunning: ${missing.join(', ')}`).toEqual([]);
  });
});
