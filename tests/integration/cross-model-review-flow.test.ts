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
 *      frontmatter gets `cross-model-review: "codex-cli:gpt-5.5"`.
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
    expect(result.model).toBe('gpt-5.5');
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0].verdict).toBe('MINOR ISSUES');
    expect(result.flag).toBe('cross-model-review: codex-cli:gpt-5.5');

    // Report banner.
    expect(renderBanner(result)).toBe('## Cross-model review: codex-cli:gpt-5.5');

    // Frontmatter stamp.
    stampTag(result);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/cross-model-review:\s*"codex-cli:gpt-5\.5"/);
    expect(out).toMatch(/review-convergence:/);
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
    expect(result.flag).toBe('cross-model-review: codex-cli:gpt-5.5 (degraded: timeout)');
    // Crucially NOT unavailable — the framework IS present.
    expect(result.status).not.toBe('unavailable');

    expect(renderBanner(result)).toContain('degraded: timeout');

    // Degraded is still taggable (disclosure, not a gate).
    stampTag(result);
    const out = fs.readFileSync(specPath, 'utf-8');
    expect(out).toMatch(/cross-model-review:\s*"codex-cli:gpt-5\.5 \(degraded: timeout\)"/);
    expect(out).toMatch(/review-convergence:/);
  });
});
