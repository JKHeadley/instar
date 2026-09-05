// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Integration — the cross-model review flow end-to-end (Step B).
 *
 * Proves the WIRING the unit tests don't: the convergence-review flow that
 * /spec-converge runs — detect → assemble prompt from on-disk spec+context →
 * run the cross-model reviewer → fold the result into the round → stamp the
 * frontmatter + render the report banner. The codex provider is STUBBED (no
 * real codex spawn in CI); the real `codex exec` command is already exercised
 * by the existing CodexCliIntelligenceProvider tests, so this verifies the
 * Step-B wiring, not codex itself.
 *
 * Three flows per the spec §Testing:
 *   1. codex present  → findings folded in, flag/banner read codex-cli:<model>,
 *      frontmatter gets `cross-model-review: "codex-cli:gpt-5.6-sol"`.
 *   2. codex absent   → unavailable flag, round completes internal-only,
 *      report carries the UNAVAILABLE banner, spec is STILL taggable.
 *   3. degraded       → provider rejects; flag reads `degraded: <reason>`, does
 *      NOT collapse to unavailable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectCrossModelReviewer,
  assembleReviewerPrompt,
  runCrossModelReview,
  buildCrossModelFlag,
  type ReviewerResult,
} from '../../src/core/crossModelReviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TAG_SCRIPT = path.join(
  REPO_ROOT,
  'skills',
  'spec-converge',
  'scripts',
  'write-convergence-tag.mjs',
);
const REVIEWER_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, 'skills', 'spec-converge', 'templates', 'reviewer-cross-model.md'),
  'utf-8',
);

let tmpDir: string;
let specPath: string;
let reportPath: string;
let authPath: string;

const SPEC_MARKDOWN = `# Cross-model test spec

## Problem statement
We need an external reviewer.

## Proposed design
Route it through codex.

## Decision points touched
*(none)*

## Maturation plan

- **test-agent-live:** immediately
- **dev-agent-live:** after one clean soak day
- **fleet:** after operator review
- **graduation criterion:** stated
- **dark-window:** 14d
`;

const ELI16 = 'overview '.repeat(120); // > 800 chars

// A canned structured review (what codex would return).
function stubProvider(reply: string) {
  return { evaluate: async () => reply };
}
function throwingProvider(err: Error) {
  return { evaluate: async () => { throw err; } };
}

// Render the report banner line from a ReviewerResult, mirroring how the
// skill's Phase 4 builds the banner from the returned flag.
function renderBanner(result: ReviewerResult): string {
  if (result.status === 'unavailable') {
    return `## ⚠ Cross-model review: UNAVAILABLE (${result.reason ?? 'unknown'})`;
  }
  if (result.status === 'degraded') {
    return `## ⚠ Cross-model review: ${result.framework}:${result.model} (degraded: ${result.reason})`;
  }
  return `## Cross-model review: ${result.framework}:${result.model}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossmodel-flow-'));
  specPath = path.join(tmpDir, 'cm-spec.md');
  reportPath = path.join(tmpDir, 'cm-spec-convergence.md');
  authPath = path.join(tmpDir, 'auth.json');
  fs.writeFileSync(
    specPath,
    `---\ntitle: "CM spec"\nslug: "cm-spec"\nauthor: "test"\n---\n\n${SPEC_MARKDOWN}`,
    'utf-8',
  );
  fs.writeFileSync(path.join(tmpDir, 'cm-spec.eli16.md'), ELI16, 'utf-8');
  fs.writeFileSync(reportPath, '# Convergence report\n', 'utf-8');
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: 'oauth-token' } }), 'utf-8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function stampTag(result: ReviewerResult): void {
  // Strip the `cross-model-review: ` prefix from the flag the same way the
  // skill does before handing the value to the tag writer.
  const flagValue = result.flag.replace(/^cross-model-review:\s*/, '');
  const args = [
    TAG_SCRIPT,
    '--spec', specPath,
    '--iterations', '2',
    '--report', reportPath,
    '--cross-model-review', flagValue,
  ];
  if (result.reason && result.status === 'unavailable') {
    args.push('--cross-model-reason', result.reason);
  }
  execFileSync(process.execPath, args, { encoding: 'utf-8' });
}

describe('cross-model review flow — codex PRESENT', () => {
  it('folds external findings in, flags codex-cli:<model>, stamps frontmatter + banner', async () => {
    const assembled = assembleReviewerPrompt({
      reviewerTemplate: REVIEWER_TEMPLATE,
      specMarkdown: SPEC_MARKDOWN,
      specPath: 'docs/specs/cm-spec.md',
      context: [{ path: 'docs/signal-vs-authority.md', content: 'signal vs authority doc body' }],
    });
    // The assembled prompt inlines the spec + the referenced context.
    expect(assembled.promptText).toContain('signal vs authority doc body');
    expect(assembled.promptText).toContain('We need an external reviewer.');

    const result = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: stubProvider(
        'Verdict: MINOR ISSUES\n- §"Proposed design" — name the timeout constant.',
      ),
    });

    expect(result.status).toBe('ok');
    expect(result.framework).toBe('codex-cli');
    expect(result.model).toBe('gpt-5.6-sol');
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0].verdict).toBe('MINOR ISSUES');
    expect(result.flag).toBe('cross-model-review: codex-cli:gpt-5.6-sol');

    // Report banner.
    expect(renderBanner(result)).toBe('## Cross-model review: codex-cli:gpt-5.6-sol');

    // Frontmatter stamp.
    stampTag(result);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/cross-model-review:\s*"codex-cli:gpt-5\.6-sol"/);
    expect(out).toMatch(/review-convergence:/);
  });
});

describe('cross-model review flow — load-bearing context LOST (*Never Silently Cut the Data a Decision Depends On*)', () => {
  it('REFUSES: degrades naming what was lost, and never reaches the model', async () => {
    // The 2026-08-22 case, end to end. A spec larger than the whole budget with
    // the constitutional docs attached: they cannot fit, so this is not a review.
    let providerCalls = 0;
    const assembled = assembleReviewerPrompt({
      reviewerTemplate: REVIEWER_TEMPLATE,
      specMarkdown: 'S'.repeat(80_000),
      specPath: 'docs/specs/cm-spec.md',
      context: [
        { path: 'docs/STANDARDS-REGISTRY.md', content: 'R'.repeat(40_000) },
        { path: 'docs/parent-design.md', content: 'P'.repeat(4_000) },
      ],
      budgetBytes: 60 * 1024,
    });
    expect(assembled.omittedLoadBearing).toContain('docs/STANDARDS-REGISTRY.md');

    const result = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: (() => {
        providerCalls++;
        return stubProvider('Verdict: CLEAN');
      }) as never,
    });

    // It does NOT return a verdict — the whole point. Before this change the
    // stub above would have answered CLEAN and the round would have been
    // recorded as a clean external review.
    expect(result.status).toBe('degraded');
    expect(result.verdict).toBeUndefined();
    expect(result.findings).toBeUndefined();
    // It names exactly what it could not see, rather than "context was partial".
    expect(result.reason).toContain('context-incomplete');
    expect(result.reason).toContain('docs/STANDARDS-REGISTRY.md');
    expect(result.flag).toContain('degraded: context-incomplete');
    // And it refuses BEFORE spending the model call.
    expect(providerCalls).toBe(0);
  });

  it('does NOT refuse when only ORDINARY context was dropped — the refusal stays narrow', async () => {
    // A refusal that fires whenever anything is cut is a broken pipeline. Losing
    // an ordinary referenced doc is a disclosed-partial review, which is signal.
    const assembled = assembleReviewerPrompt({
      reviewerTemplate: REVIEWER_TEMPLATE,
      specMarkdown: SPEC_MARKDOWN,
      specPath: 'docs/specs/cm-spec.md',
      context: [{ path: 'docs/ordinary-appendix.md', content: 'A'.repeat(80_000) }],
      budgetBytes: 4_000,
    });
    expect(assembled.truncated).toBe(true);
    expect(assembled.omittedLoadBearing).toEqual([]);

    const result = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: stubProvider('Verdict: MINOR ISSUES\n- §"x" — a note.'),
    });

    expect(result.status).toBe('ok');
    expect(result.verdict).toBe('MINOR ISSUES');
  });

  it('the RAISED budget admits a spec plus a REAL-SIZED parent design', async () => {
    // Sized from the real case this budget was derived for: the placement spec
    // (~147KB after the cut) with its parent design (~134KB). Under the old 60KB
    // budget the parent alone was more than twice the whole allowance.
    //
    // The registry is deliberately NOT in this context set — see the test below
    // for why it can never be.
    const assembled = assembleReviewerPrompt({
      reviewerTemplate: REVIEWER_TEMPLATE,
      specMarkdown: 'S'.repeat(80_000),
      specPath: 'docs/specs/cm-spec.md',
      context: [
        { path: 'docs/signal-vs-authority.md', content: 'A'.repeat(7_500) },
        { path: 'docs/parent-design.md', content: 'P'.repeat(134_000) },
      ],
      // No budgetBytes — the shipped default.
    });
    expect(assembled.omittedLoadBearing).toEqual([]);
    expect(assembled.promptText).toContain('PPPP');

    const result = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: stubProvider('Verdict: CLEAN'),
    });
    expect(result.status).toBe('ok');
  });

  it('a load-bearing doc LARGER THAN THE WHOLE BUDGET refuses with actionable advice, at any spec size', async () => {
    // FIXTURE REALNESS (independent review 2026-08-22, finding C3). The previous
    // version of the test above stubbed the standards registry at 40,000 bytes
    // and asserted it fitted. The real file is >450,000 — more than 1.7x the
    // ENTIRE budget — so the test certified a property the shipped configuration
    // does not have. This repo ships `lint-scrape-fixture-realness.js`; a fixture
    // an order of magnitude off the real thing is the same defect it guards.
    //
    // Sized from the real registry, and asserted with an EMPTY spec to make the
    // point that no spec size can help: the doc alone overflows.
    const registrySized = 'R'.repeat(460_000);
    const assembled = assembleReviewerPrompt({
      reviewerTemplate: REVIEWER_TEMPLATE,
      specMarkdown: 'S'.repeat(10),
      specPath: 'docs/specs/cm-spec.md',
      context: [{ path: 'docs/STANDARDS-REGISTRY.md', content: registrySized }],
    });
    expect(assembled.omittedLoadBearing).toContain('docs/STANDARDS-REGISTRY.md');
    expect(assembled.undeliverableLoadBearing).toContain('docs/STANDARDS-REGISTRY.md');

    const result = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: stubProvider('Verdict: CLEAN'),
    });
    // Refuses — and says something the reader can ACT on. "Use a smaller spec"
    // would be unfollowable advice here, which is a limit hiding behind its own
    // polite notice: the defect this whole article was earned from.
    expect(result.status).toBe('degraded');
    expect(result.reason).toContain('context-undeliverable');
    expect(result.reason).toContain('no spec size admits it');
  });

  it('the per-family path refuses too — the guard is not routed around', async () => {
    // C1: the refusal lived in `runCrossModelReview` while the skill driver
    // called `family.review(...)` directly, so it was absent from the ONLY path
    // in use. Both paths now enter the same chokepoint.
    const assembled = assembleReviewerPrompt({
      reviewerTemplate: REVIEWER_TEMPLATE,
      specMarkdown: 'S'.repeat(200_000),
      specPath: 'docs/specs/cm-spec.md',
      context: [{ path: 'docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md', content: 'L'.repeat(120_000) }],
    });
    expect(assembled.omittedLoadBearing.length).toBeGreaterThan(0);

    const result = await runCrossModelReview({
      assembled,
      family: 'codex-cli',
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: stubProvider('Verdict: CLEAN'),
    });
    expect(result.status).toBe('degraded');
    expect(result.reason).toContain('context-incomplete');
  });
});

describe('cross-model review flow — codex ABSENT', () => {
  it('returns unavailable, completes internal-only, banner reads UNAVAILABLE, spec STILL taggable (never blocks)', async () => {
    const detection = detectCrossModelReviewer({
      codexPathDetected: null,
      geminiPathDetected: null,
      env: {},
    });
    expect(detection.available).toBe(false);
    expect(detection.reason).toBe('codex-not-installed');

    const result = await runCrossModelReview({
      assembled: { promptText: 'unused', truncated: false, bytes: 6 },
      detectInputs: { codexPathDetected: null, geminiPathDetected: null, env: {} },
    });
    expect(result.status).toBe('unavailable');
    expect(result.flag).toBe('cross-model-review: unavailable');

    // Report banner shows the can't-miss UNAVAILABLE form.
    expect(renderBanner(result)).toContain('UNAVAILABLE');
    expect(renderBanner(result)).toContain('codex-not-installed');

    // Convergence is STILL taggable — the unavailable flag never blocks.
    stampTag(result);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/cross-model-review:\s*"unavailable"/);
    expect(out).toMatch(/cross-model-review-reason:\s*"codex-not-installed"/);
    expect(out).toMatch(/review-convergence:/);

    // The fallback flag helper agrees with the runtime result.
    expect(buildCrossModelFlag('unavailable', 'codex-not-installed').flag).toBe(
      'cross-model-review: unavailable',
    );
  });
});

describe('cross-model review flow — DEGRADED', () => {
  it('provider rejects → degraded flag, does NOT collapse to unavailable, still taggable', async () => {
    const result = await runCrossModelReview({
      assembled: { promptText: 'PROMPT', truncated: false, bytes: 6 },
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: throwingProvider(new Error('Codex CLI error: timed out')),
    });

    expect(result.status).toBe('degraded');
    expect(result.reason).toBe('timeout');
    expect(result.flag).toBe('cross-model-review: codex-cli:gpt-5.6-sol (degraded: timeout)');
    // Crucially NOT unavailable — the framework IS present.
    expect(result.status).not.toBe('unavailable');

    expect(renderBanner(result)).toContain('degraded: timeout');

    // Degraded is still taggable (disclosure, not a gate).
    stampTag(result);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/cross-model-review:\s*"codex-cli:gpt-5\.6-sol \(degraded: timeout\)"/);
    expect(out).toMatch(/review-convergence:/);
  });
});
