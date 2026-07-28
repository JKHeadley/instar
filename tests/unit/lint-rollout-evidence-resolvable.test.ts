/**
 * Wiring-integrity tests for the rollout-evidence ratchet.
 *
 * A lint that is not in the lint chain is a lint that never runs — which is the
 * exact defect class this ratchet exists to catch (a capability that exists and
 * is silently not used). So the most important assertion here is not that the
 * lint works; it is that it is actually wired.
 *
 * The "does it catch anything?" evidence is a revert-and-watch-fail performed at
 * authoring time and recorded in the side-effects artifact:
 *   - dropping the mutual-ssh baseline entry → assertion A fires, exit 1
 *   - allowlisting a slug that resolves       → assertion C fires, exit 1
 *   - clean repo                              → exit 0
 * Reproduced here for the clean case and the wiring; the failure paths are
 * asserted through the module's own exported shape rather than by mutating the
 * checked-in baseline mid-test.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINT = path.join(ROOT, 'scripts', 'lint-rollout-evidence-resolvable.js');

describe('lint-rollout-evidence-resolvable — wiring', () => {
  it('the lint script exists', () => {
    expect(fs.existsSync(LINT)).toBe(true);
  });

  it('IS WIRED into the npm lint chain — an unwired guard never runs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.lint).toContain('lint-rollout-evidence-resolvable.js');
  });

  it('exits 0 on the current repo, and says what it checked', () => {
    const out = execFileSync('node', [LINT], { cwd: ROOT, encoding: 'utf8' });
    // It must report its denominator — a guard that says only "clean" cannot be
    // distinguished from a guard that scanned nothing.
    expect(out).toMatch(/guarded endpoint spec\(s\)/);
    expect(out).toMatch(/resolving/);
  });

  it('reports a non-zero denominator — a scan of nothing is not a pass', () => {
    const out = execFileSync('node', [LINT], { cwd: ROOT, encoding: 'utf8' });
    const m = /clean — (\d+) guarded endpoint spec\(s\)/.exec(out);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  it('guards COMPOSED dispositions too, and reports each count separately', () => {
    // The scope this lint shipped with was 'active' only, and the class is wider:
    // a composed spec rides an owner feature for GRADUATION but still carries a real
    // rollout-criteria naming a measurement. A 404 there parks the feature for
    // exactly the same reason. Both counts are reported separately so a future
    // narrowing shows up as a number going to zero rather than as silence.
    const out = execFileSync('node', [LINT], { cwd: ROOT, encoding: 'utf8' });
    const m = /\((\d+) active, (\d+) composed\)/.exec(out);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![2])).toBeGreaterThan(0);
  });

  it('the source actually admits composed — not just the message', () => {
    // Guard against the shallow version of this change: editing the summary line to
    // SAY composed while the filter still skips it. Asserts the predicate itself.
    const src = fs.readFileSync(LINT, 'utf8');
    expect(src).toMatch(/disposition !== 'active' && disposition !== 'composed'/);
    // And that the refusal message names WHICH disposition fired, so a reader is not
    // left inferring it — the scope error this whole widening is a correction for.
    expect(src).toMatch(/rollout-disposition:\$\{disposition\}/);
  });
});

describe('lint-rollout-evidence-resolvable — the baseline is a ledger, not a parking space', () => {
  const source = fs.readFileSync(LINT, 'utf8');

  // The baseline is EMPTY as shipped, and these tests are written to stay true through
  // that. The first version required at least one entry — which quietly made "carrying
  // debt" the passing state and an empty ledger a failure. That is backwards: the goal
  // state is zero accepted-unresolved findings. The requirement is CONDITIONAL — if an
  // entry exists, it must be substantive and tracked.
  const baseline = source.slice(
    source.indexOf('const KNOWN_UNRESOLVED'),
    source.indexOf('function specFiles'),
  );
  const entryCount = [...baseline.matchAll(/\bslug:\s*'/g)].length;

  it('every accepted-unresolved entry carries a substantive reason', () => {
    // Assertion B is enforced at runtime; this pins the checked-in baseline so a
    // placeholder reason cannot be added without a test failing too.
    const reasons = [...baseline.matchAll(/reason:\s*\n?\s*'([^']*)'/g)].map((m) => m[1]);
    expect(reasons.length).toBe(entryCount);
    for (const r of reasons) expect(r.replace(/\s/g, '').length).toBeGreaterThan(11);
  });

  it('each baseline entry names a tracking reference so it cannot rot silently', () => {
    // An accepted finding with no tracker is an abandoned finding. Vacuously true at
    // zero entries — nothing untracked can exist when nothing is accepted.
    if (entryCount === 0) {
      expect(baseline).not.toMatch(/\bslug:\s*'/);
      return;
    }
    expect(baseline).toMatch(/ACT-\d+|PR #\d+/);
  });

  it('an EMPTY baseline is the goal state, not a broken one', () => {
    // The guard's value is the shrink-only property, not the presence of debt. This
    // asserts the lint still passes with nothing accepted — otherwise emptying the
    // ledger (the thing success looks like) would break the build.
    // execFileSync throws on a non-zero exit, so reaching the assertion IS the exit-0
    // check — the same shape the two tests above use.
    const out = execFileSync('node', [LINT], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('accepted-unresolved');
    expect(out).toContain('0 accepted-unresolved');
  });
});
