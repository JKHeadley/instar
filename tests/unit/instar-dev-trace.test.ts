/**
 * The one trace-verification implementation (scripts/lib/instar-dev-trace.mjs),
 * shared by the instar-dev pre-commit gate and the local verifier's independent
 * review of a flagged record (directive 2026-10-22; spec
 * docs/specs/local-verify-merge-authority.md "Harness-changing PRs").
 */
import { describe, it, expect } from 'vitest';
import {
  isTracePath, traceIsComplete, traceMissingCoverage, artifactSha256, secondPassConcurred, independentReviewProblem, secondPassReviewerNamed, MIN_ARTIFACT_CHARS,
} from '../../scripts/lib/instar-dev-trace.mjs';
import { parseCodeowners, codeOwnedFiles } from '../../scripts/local-verify-floor.mjs';

const artifact = (reviewer: string) => `# Side-effects\n\n${'x'.repeat(MIN_ARTIFACT_CHARS)}\n\n## Second-pass review (if required)\n\n**Reviewer:** ${reviewer}\n**Independent read of the artifact: concur**\n\n## Evidence pointers\n`;
const ART = artifact('codey');
const trace = (over: Record<string, unknown> = {}) => ({
  phase: 'complete', artifactPath: 'upgrades/side-effects/a.md', coveredFiles: ['src/a.ts', 'scripts/safe-merge.mjs'],
  secondPass: 'true', reviewerConcurred: true, artifactSha256: artifactSha256(ART), ...over,
});

describe('trace helpers', () => {
  it('trace paths live under .instar/instar-dev-traces/ only', () => {
    expect(isTracePath('.instar/instar-dev-traces/t.json')).toBe(true);
    for (const p of ['.instar/instar-dev-traces/a/b.json', 'docs/t.json', '.instar/instar-dev-traces/t.md', null]) expect(isTracePath(p)).toBe(false);
  });
  it('coverage and completeness', () => {
    expect(traceIsComplete(trace())).toBe(true);
    expect(traceIsComplete(trace({ phase: 'draft' }))).toBe(false);
    expect(traceMissingCoverage(trace(), ['src/a.ts', 'src/b.ts'])).toEqual(['src/b.ts']);
  });
  it('a second pass counts only when it ran (true or "true") and the reviewer concurred', () => {
    expect(secondPassConcurred(trace())).toBe(true);
    expect(secondPassConcurred(trace({ secondPass: true }))).toBe(true);
    expect(secondPassConcurred(trace({ reviewerConcurred: false }))).toBe(false);
    expect(secondPassConcurred(trace({ secondPass: 'not-required' }))).toBe(false);
    expect(secondPassConcurred(trace({ reviewerConcurred: 'true' }))).toBe(false);
  });
});

describe('independentReviewProblem — both sides of every rule', () => {
  const flagged = ['scripts/safe-merge.mjs'];
  it('a concurring, covering, artifact-backed trace counts', () => {
    expect(independentReviewProblem({ trace: trace(), flaggedPaths: flagged, artifactText: ART })).toBeNull();
  });
  it.each([
    [{ trace: null, flaggedPaths: flagged, artifactText: ART }, 'trace-unparseable'],
    [{ trace: trace({ phase: 'draft' }), flaggedPaths: flagged, artifactText: ART }, 'trace-phase-draft'],
    [{ trace: trace({ reviewerConcurred: false }), flaggedPaths: flagged, artifactText: ART }, 'no-concurring-second-pass'],
    [{ trace: trace(), flaggedPaths: null, artifactText: ART }, 'flagged-paths-unknown'],
    [{ trace: trace(), flaggedPaths: ['vitest.config.ts'], artifactText: ART }, 'not-covered:vitest.config.ts'],
    [{ trace: trace({ artifactPath: '' }), flaggedPaths: flagged, artifactText: ART }, 'artifact-unnamed'],
    [{ trace: trace(), flaggedPaths: flagged, artifactText: null }, 'artifact-not-in-tree'],
    [{ trace: trace(), flaggedPaths: flagged, artifactText: 'short' }, 'artifact-stub'],
    [{ trace: trace({ artifactSha256: 'f'.repeat(64) }), flaggedPaths: flagged, artifactText: ART }, 'artifact-sha-mismatch'],
    [{ trace: trace({ artifactSha256: undefined }), flaggedPaths: flagged, artifactText: ART }, 'artifact-sha-missing'],
    [{ trace: trace({ artifactSha256: artifactSha256(artifact('required — pending')) }), flaggedPaths: flagged, artifactText: artifact('required — pending') }, 'second-pass-reviewer-missing'],
    [{ trace: trace({ artifactSha256: artifactSha256(artifact('')) }), flaggedPaths: flagged, artifactText: artifact('') }, 'second-pass-reviewer-missing'],
  ])('%# refuses with the named reason', (a, reason) => {
    expect(independentReviewProblem(a as never)).toBe(reason);
  });
});

describe('secondPassReviewerNamed — the artifact names who did the second pass', () => {
  it('a named reviewer counts; empty, placeholder, "pending" or no section does not', () => {
    expect(secondPassReviewerNamed(artifact('codey'))).toBe(true);
    for (const r of ['', 'required — pending', 'Pending', '[agent name]']) expect(secondPassReviewerNamed(artifact(r))).toBe(false);
    expect(secondPassReviewerNamed('# x\n\n**Reviewer:** codey\n')).toBe(false); // outside the section
    expect(secondPassReviewerNamed(null)).toBe(false);
  });
});

describe('CODEOWNERS parsing (the operator approval surface)', () => {
  it('owns exactly the two constitution lines of the repo file', () => {
    const rules = parseCodeowners('# c\ndocs/STANDARDS-REGISTRY.md   @JKHeadley\n.github/CODEOWNERS @JKHeadley\n')!;
    expect(codeOwnedFiles(['docs/STANDARDS-REGISTRY.md', '.github/CODEOWNERS', '.github/workflows/ci.yml', 'scripts/safe-merge.mjs', 'x/docs/STANDARDS-REGISTRY.md'], rules))
      .toEqual(['docs/STANDARDS-REGISTRY.md', '.github/CODEOWNERS']);
  });
  it('follows GitHub precedence (last match wins; an ownerless rule un-owns) and glob forms', () => {
    const rules = parseCodeowners('*.js @a\n/build/ @b\nsrc/**/x.ts @c\nsrc/free.js\n')!;
    expect(codeOwnedFiles(['a/b.js', 'build/z', 'x/build/z', 'src/a/b/x.ts', 'src/x.ts', 'src/free.js', 'src/abx.ts'], rules))
      .toEqual(['a/b.js', 'build/z', 'src/a/b/x.ts', 'src/x.ts']);
  });
  it('a non-string is unparseable', () => {
    expect(parseCodeowners(null)).toBeNull();
  });
});
