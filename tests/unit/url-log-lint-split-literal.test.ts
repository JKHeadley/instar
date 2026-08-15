import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error — plain JS lint script, no types
import { collapseConcatenation, scanForCredentialedUrlLogs } from '../../scripts/lint-no-direct-url-log.js';

/**
 * `lint-no-direct-url-log` exists because of the 2026-05-27 incident: `instar
 * join` logged a clone URL containing a live GitHub token.
 *
 * Its credentialed-URL check matched a single line, so the leak survived being
 * written across a concatenation:
 *
 *   const u = "https://user:" + "tok@github.com/x.git";   // invisible
 *   const u = "https://user:tok@github.com/x.git";        // flagged
 *
 * Both build the same string and leak the same token. Splitting a literal is
 * ordinary tidying, not an evasion, so the guard could be disarmed by accident.
 *
 * WHY ONLY THIS HALF IS WIDENED. The lint has two patterns and they are not the
 * same kind of thing. A `user:pass@` inside a URL literal IS the prohibited
 * fact, so teaching the matcher to see the string the code actually builds is a
 * real closure. The sibling pattern matches five variable NAMES logged through
 * `console.*` — that is one spelling correlated with the behaviour, and growing
 * the name list would make a finer net without making it more of a policy. It
 * is left alone deliberately and declared in the lint's own header.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const LINT = path.join(ROOT, 'scripts', 'lint-no-direct-url-log.js');
const OP = 'tests/unit/url-log-lint-split-literal.test.ts';

/**
 * Run the real scanner over a THROWAWAY tree containing `body`. Returns 1 if it
 * would fail the build, 0 otherwise — the same two values the CLI exits with.
 *
 * An earlier version of this planted the probe at `src/core/__urlLogLintProbe.ts`
 * and deleted it afterwards. That was wrong twice over, and CI caught it:
 * SourceTreeGuard refuses ANY delete inside the instar source tree (the
 * 2026-04-22 incident class), and a probe file sitting in `src/` is visible to
 * every other suite running concurrently. Scanning a temp tree removes both.
 */
function lintWith(body: string): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urllog-lint-'));
  try {
    const core = path.join(dir, 'src', 'core');
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(path.join(core, 'probe.ts'), `${body}\n`);
    return scanForCredentialedUrlLogs(path.join(dir, 'src'), dir).length > 0 ? 1 : 0;
  } finally {
    // Outside the source tree, so the funnel permits it — and it is still the
    // funnel, because the destructive-op rule applies to test code too.
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  }
}

describe('THE DEFECT — a credentialed URL split across a concatenation', () => {
  it('flags a two-piece split', () => {
    expect(lintWith('const u = "https://user:" + "tok@github.com/x.git"; console.log(u);')).toBe(1);
  });

  it('flags a three-piece split', () => {
    expect(lintWith('const u = "https://" + "user:" + "tok@github.com/x.git"; console.log(u);')).toBe(1);
  });

  it('flags a split written with single quotes', () => {
    expect(lintWith("const u = 'https://user:' + 'tok@github.com/x.git'; console.log(u);")).toBe(1);
  });
});

describe('CONTROLS — must still be caught (the fix removes no coverage)', () => {
  it('still flags the one-piece credentialed literal', () => {
    expect(lintWith('const u = "https://user:tok@github.com/x.git"; console.log(u);')).toBe(1);
  });

  it('still flags a template-literal interpolation', () => {
    expect(lintWith('const p = "t"; const u = `https://user:${p}@github.com/x.git`; console.log(u);')).toBe(1);
  });

  it('still flags a risky URL variable logged through console', () => {
    expect(lintWith('console.log(cloneUrl);')).toBe(1);
  });
});

describe('ANTI-OVER-BLOCK — this lint fails builds, so correct code must pass', () => {
  // Each of these is verified to behave IDENTICALLY under the shipped lint, so
  // the fix is proven to introduce no new false positives rather than asserted to.
  it('does not flag an ordinary concatenated URL with no credentials', () => {
    expect(lintWith('const u = "https://api." + "example.com/v1"; console.log(u);')).toBe(0);
  });

  it('does not flag concatenated prose that merely contains a colon and an at-sign', () => {
    expect(lintWith('const m = "contact: " + "ops@example.com"; console.log(m);')).toBe(0);
  });

  it('does not fold across a variable operand — nothing is invented', () => {
    // The fold must never assume what a variable holds. `"https://user:" +
    // secret + "@h/x"` is NOT joined into a credentialed literal, because that
    // would be the lint guessing at a runtime value.
    expect(lintWith('const u = "https://user:" + secret + "@h/x"; console.log(u);')).toBe(0);
  });

  it('leaves the REAL repository clean — scanner defaults, nothing planted', () => {
    // The decisive anti-over-block control, and it is stronger than the version
    // it replaces: it asserts the actual tree is clean under the real defaults,
    // instead of asserting a temp tree containing one inert line is clean.
    expect(scanForCredentialedUrlLogs()).toEqual([]);
  });

  it('the shipped CLI still exits 0 on the clean tree', () => {
    // Keeps the exit-code path covered now that the cases above drive the
    // exported scanner directly. Plants nothing.
    expect(() => execFileSync(process.execPath, [LINT], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('the fold itself, pinned', () => {
  it('joins adjacent double-quoted literals', () => {
    expect(collapseConcatenation('const u = "ab" + "cd";')).toContain('"abcd"');
  });

  it('joins adjacent single-quoted literals', () => {
    expect(collapseConcatenation("const u = 'ab' + 'cd';")).toContain("'abcd'");
  });

  it('joins a chain of three', () => {
    expect(collapseConcatenation('const u = "a" + "b" + "c";')).toContain('"abc"');
  });

  it('does not join across a variable', () => {
    const out = collapseConcatenation('const u = "a" + v + "c";');
    expect(out).not.toContain('"ac"');
  });

  it('leaves a line with no concatenation untouched', () => {
    const line = 'const u = "https://example.com";';
    expect(collapseConcatenation(line)).toBe(line);
  });

  it('is not fooled into inventing text — output length never exceeds input', () => {
    // A fold that GREW the line would mean it was synthesising content rather
    // than joining existing literals.
    const line = 'const u = "aa" + "bb" + "cc";';
    expect(collapseConcatenation(line).length).toBeLessThanOrEqual(line.length);
  });
});
