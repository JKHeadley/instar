/**
 * Unit — no callsite may pair a framework LABEL with `sessions.claudePath`
 * (grok-build spec §2.0, invariant 4).
 *
 * WHY A SWEEP AND NOT NINE POINT-TESTS. This defect has now been found at NINE
 * independent sites across rounds 15, 16, 17, 20 and 22. Every previous fix was
 * written for the site in front of me, each time believing it was the last, and
 * each subsequent round found another. Round 22 alone added three — `instar
 * route`, `instar reflect` (twice), and the server's relationships fallback —
 * and the last three were found by grepping for the SHAPE after fixing the first,
 * not by any check.
 *
 * The root fact that makes the shape dangerous: `config.sessions.claudePath` does
 * NOT mean "the Claude binary". Config sets it from the CONFIGURED FRAMEWORK's
 * binary as a documented back-compat carry, so on a grok-primary agent it holds
 * grok's. Any callsite reading it while asserting a `claude-code` label therefore
 * runs one framework's program under another's name, with none of that
 * framework's controls — no forced api-key kill switch, no metered-key scrub, no
 * auth preflight, no tool deny-list, no scratch cwd, no budget record.
 *
 * `resolveFrameworkBinaryPath` is the one shared fence that resolves a genuine
 * per-framework binary or nothing. This test asserts the population that bypasses
 * it stays empty, so a TENTH site fails a check instead of waiting for someone to
 * notice in review.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walk(p);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield p;
    }
  }
}

/**
 * Blank out comments while PRESERVING line structure.
 *
 * Two bugs in the first version of this helper, both caught by the controls
 * below before the file was a minute old, and both worth naming:
 *
 *   1. It DELETED block comments, so every reported line number was computed
 *      against a shorter file and pointed at unrelated code. A finding whose
 *      location is wrong is worse than no finding — I went and read the wrong
 *      twelve lines before noticing.
 *   2. Comments must be blanked at all, because the fixes for this very defect
 *      QUOTE the broken code verbatim to explain it. Left in, the sweep finds
 *      the defect in its own documentation.
 */
function codeOnly(source: string): string {
  return source
    // Preserve one newline per line consumed, so line numbers stay truthful.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * A `binaryPath:` fed from `claudePath` — INCLUDING through a ternary.
 *
 * The first version required `claudePath` to follow `binaryPath:` immediately,
 * which matched the direct form and walked straight past
 * `binaryPath: framework === 'claude-code' ? config.sessions.claudePath : undefined`
 * — the exact shape of five of the nine known sites, including the two fixed in
 * this round. A detector narrower than the class it names is the failure this
 * whole branch keeps producing; the control caught it on the first run.
 *
 * Scoped to a single line, which is how every known instance is written, and
 * deliberately NOT matching `claudePath:` as a PROPERTY KEY — a callsite may
 * legitimately pass `claudePath` INTO the shared fence (that is how the fence
 * learns the back-compat value), and flagging that would make the honest fix
 * look like the defect.
 */
function offendingMatches(line: string): string[] {
  const idx = line.indexOf('binaryPath:');
  if (idx === -1) return [];
  const rest = line.slice(idx);
  // Remove `claudePath:` where it is a property KEY — i.e. preceded by `{`, `,`
  // or the start of the fragment. What remains is `claudePath` used as a VALUE.
  //
  // The first cut discriminated with a `(?!\s*:)` lookahead, which ALSO excluded
  // the ternary's else-colon in `... ? config.sessions.claudePath : undefined` —
  // so the detector silently skipped the very shape it was written for, and the
  // control said so on the next run. Discriminating on what PRECEDES the
  // identifier is the property that actually separates a key from a read.
  const withoutPropertyKeys = rest.replace(/(^|[{,]\s*)claudePath\s*:/g, '$1');
  if (!/\bclaudePath\b/.test(withoutPropertyKeys)) return [];
  return [line.trim()];
}

describe('claudePath impersonation sweep', () => {
  const offenders: string[] = [];
  let filesScanned = 0;

  for (const file of walk(SRC)) {
    filesScanned += 1;
    const lines = codeOnly(fs.readFileSync(file, 'utf-8')).split('\n');
    lines.forEach((line, i) => {
      for (const hit of offendingMatches(line)) {
        offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${hit}`);
      }
    });
  }

  it('CONTROL: the sweep actually scanned the source tree', () => {
    // Without this, a walk bug that yielded nothing would make the assertion
    // below pass vacuously — a guard reporting clean while inspecting zero
    // files, which is a defect this branch has already shipped once.
    expect(filesScanned).toBeGreaterThan(500);
  });

  it('CONTROL: the detector fires on BOTH real shapes, and spares the honest fix', () => {
    // The two real pre-fix lines, verbatim — the ternary form (route.ts,
    // reflect.ts) and the direct form (server.ts). The first version of this
    // detector matched only the second and would have certified the tree clean
    // while five known sites of the first shape sat in it.
    const ternary = "    binaryPath: framework === 'claude-code' ? config.sessions.claudePath : undefined,";
    const direct = '            binaryPath: config.sessions.claudePath,';
    expect(offendingMatches(ternary), 'ternary form').toHaveLength(1);
    expect(offendingMatches(direct), 'direct form').toHaveLength(1);

    // And must NOT fire on the honest fix, which passes claudePath INTO the
    // fence as a named property. Flagging that would punish the correct pattern
    // and teach the next author to route around this test.
    const fenced = '  const b = resolveFrameworkBinaryPath({ framework, claudePath: config.sessions.claudePath });';
    expect(offendingMatches(fenced), 'fenced fix must not be flagged').toHaveLength(0);
    const fencedResult = '    binaryPath: fencedBinary ?? undefined,';
    expect(offendingMatches(fencedResult), 'fence RESULT must not be flagged').toHaveLength(0);
  });

  it('CONTROL: comment blanking preserves line numbers', () => {
    // The first version deleted block comments, so every reported location was
    // wrong — and a finding that points at the wrong line costs more than it saves.
    const src = 'a\n/* two\n   lines */\nb\n';
    expect(codeOnly(src).split('\n')).toHaveLength(src.split('\n').length);
    expect(codeOnly(src).split('\n')[3]).toBe('b');
  });

  it('no callsite passes sessions.claudePath straight through as a binaryPath', () => {
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
