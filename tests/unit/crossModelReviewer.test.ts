// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Unit tests for crossModelReviewer (Step B of the tiered development process).
 *
 * Covers, per docs/specs/codex-crossreview-stepB-spec.md §Testing:
 *   - Detection: true/false branches (not-installed, not-authed,
 *     apikey-forbidden via env + auth.json shape, available).
 *   - Registry: walk returns the first available framework; unavailable →
 *     specific reason.
 *   - The 3 fallback states (unavailable / degraded / skipped-abbreviated).
 *   - Driver parse: well-formed verdict vs unparseable → one raw finding.
 *   - Prompt assembly + the size budget (full spec always included; context
 *     truncated with a loud note when it overflows).
 *
 * NO real codex spawns — detection uses injected inputs, invocation uses a
 * stubbed provider override.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectCodexReviewer,
  detectCrossModelReviewer,
  SUPPORTED_REVIEWER_FRAMEWORKS,
  parseReviewerReply,
  assembleReviewerPrompt,
  orderContextDeterministically,
  buildCrossModelFlag,
  aggregateRoundOutcomes,
  classifyReviewFailure,
  runCrossModelReview,
  CONTEXT_BUDGET_BYTES,
  CONTEXT_PRIORITY_SUBSTRINGS,
  REVIEW_TIMEOUT_MS,
  type ReviewerResult,
} from '../../src/core/crossModelReviewer.js';

// ── helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossmodel-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAuth(json: unknown): string {
  const p = path.join(tmpDir, 'auth.json');
  fs.writeFileSync(p, JSON.stringify(json), 'utf-8');
  return p;
}

const OAUTH_AUTH = { tokens: { access_token: 'oauth-access-token-value' } };

// A stub provider that returns a canned reply (or throws a canned error).
function stubProvider(reply: string) {
  return { evaluate: async () => reply };
}
function throwingProvider(err: Error) {
  return {
    evaluate: async () => {
      throw err;
    },
  };
}

// ── Detection ──────────────────────────────────────────────────────────────

describe('detectCodexReviewer', () => {
  it('returns codex-not-installed when the binary is missing', () => {
    const r = detectCodexReviewer({ codexPathDetected: null, env: {} });
    expect(r).toEqual({ available: false, reason: 'codex-not-installed' });
  });

  it('returns available with model when binary present + OAuth access_token present', () => {
    const authPath = writeAuth(OAUTH_AUTH);
    const r = detectCodexReviewer({
      codexPathDetected: '/usr/bin/codex',
      authJsonPath: authPath,
      env: {},
    });
    expect(r.available).toBe(true);
    expect(r.framework).toBe('codex-cli');
    // capable tier → gpt-5.5 per models.ts (the concrete id stays owned there).
    expect(r.model).toBe('gpt-5.5');
  });

  it('returns codex-not-authed when auth.json is missing', () => {
    const r = detectCodexReviewer({
      codexPathDetected: '/usr/bin/codex',
      authJsonPath: path.join(tmpDir, 'does-not-exist.json'),
      env: {},
    });
    expect(r).toEqual({ available: false, reason: 'codex-not-authed' });
  });

  it('returns codex-not-authed when auth.json is malformed', () => {
    const p = path.join(tmpDir, 'auth.json');
    fs.writeFileSync(p, '{ this is not json', 'utf-8');
    const r = detectCodexReviewer({
      codexPathDetected: '/usr/bin/codex',
      authJsonPath: p,
      env: {},
    });
    expect(r).toEqual({ available: false, reason: 'codex-not-authed' });
  });

  it('returns codex-not-authed when auth.json lacks tokens.access_token', () => {
    const authPath = writeAuth({ tokens: {} });
    const r = detectCodexReviewer({
      codexPathDetected: '/usr/bin/codex',
      authJsonPath: authPath,
      env: {},
    });
    expect(r).toEqual({ available: false, reason: 'codex-not-authed' });
  });

  it('returns codex-auth-apikey-forbidden when OPENAI_API_KEY is set in env (Rule-1 reuse)', () => {
    const authPath = writeAuth(OAUTH_AUTH);
    const r = detectCodexReviewer({
      codexPathDetected: '/usr/bin/codex',
      authJsonPath: authPath,
      env: { OPENAI_API_KEY: 'sk-live-something' },
    });
    expect(r).toEqual({ available: false, reason: 'codex-auth-apikey-forbidden' });
  });

  it('returns codex-auth-apikey-forbidden when auth.json is API-key shape (sk-)', () => {
    const authPath = writeAuth({ OPENAI_API_KEY: 'sk-abcdef1234567890' });
    const r = detectCodexReviewer({
      codexPathDetected: '/usr/bin/codex',
      authJsonPath: authPath,
      env: {},
    });
    expect(r).toEqual({ available: false, reason: 'codex-auth-apikey-forbidden' });
  });

  it('never throws on any input', () => {
    expect(() => detectCodexReviewer({ codexPathDetected: undefined, env: {} })).not.toThrow();
  });
});

// ── Registry walk ────────────────────────────────────────────────────────

describe('detectCrossModelReviewer (registry walk)', () => {
  it('has codex as the first registry entry (the order IS the preference order)', () => {
    expect(SUPPORTED_REVIEWER_FRAMEWORKS.length).toBeGreaterThanOrEqual(1);
    expect(SUPPORTED_REVIEWER_FRAMEWORKS[0].id).toBe('codex-cli');
  });

  it('returns the first available framework', () => {
    const authPath = writeAuth(OAUTH_AUTH);
    const r = detectCrossModelReviewer({
      codexPathDetected: '/usr/bin/codex',
      authJsonPath: authPath,
      env: {},
      geminiPathDetected: null,
    });
    expect(r.available).toBe(true);
    expect(r.framework).toBe('codex-cli');
  });

  it('returns the specific preference-leader (codex) reason when nothing is available', () => {
    const r = detectCrossModelReviewer({
      codexPathDetected: null,
      geminiPathDetected: null,
      env: {},
    });
    expect(r.available).toBe(false);
    // the preference-leader's own reason surfaces, not a generic one.
    expect(r.reason).toBe('codex-not-installed');
  });
});

// ── Fallback states ──────────────────────────────────────────────────────

describe('buildCrossModelFlag (fallback states)', () => {
  it('builds the unavailable flag with a reason', () => {
    const f = buildCrossModelFlag('unavailable', 'codex-not-installed');
    expect(f.status).toBe('unavailable');
    expect(f.flag).toBe('cross-model-review: unavailable');
    expect(f.reason).toBe('codex-not-installed');
  });

  it('builds the skipped-abbreviated flag (distinct from unavailable)', () => {
    const f = buildCrossModelFlag('skipped-abbreviated');
    expect(f.status).toBe('skipped-abbreviated');
    expect(f.flag).toBe('cross-model-review: skipped-abbreviated');
  });

  it('builds the degraded-all-rounds flag (spec-level aggregate, F2)', () => {
    const f = buildCrossModelFlag('degraded-all-rounds', 'rate-limited');
    expect(f.status).toBe('degraded-all-rounds');
    expect(f.flag).toBe('cross-model-review: degraded-all-rounds');
    expect(f.reason).toBe('rate-limited');
  });
});

// ── Spec-level aggregation across rounds (F2) ────────────────────────────

describe('aggregateRoundOutcomes (F2 — one final spec-level flag)', () => {
  const ok = (model = 'gpt-5.5'): ReviewerResult => ({
    status: 'ok',
    framework: 'codex-cli',
    model,
    flag: `cross-model-review: codex-cli:${model}`,
  });
  const degraded = (reason: string): ReviewerResult => ({
    status: 'degraded',
    framework: 'codex-cli',
    model: 'gpt-5.5',
    reason,
    flag: `cross-model-review: codex-cli:gpt-5.5 (degraded: ${reason})`,
  });
  const unavailable = (reason = 'codex-not-installed'): ReviewerResult => ({
    status: 'unavailable',
    reason,
    flag: 'cross-model-review: unavailable',
  });

  it('any successful round → the clean codex-cli flag (one real opinion is enough)', () => {
    const f = aggregateRoundOutcomes([degraded('timeout'), ok(), degraded('rate-limited')]);
    expect(f.status).toBe('available');
    expect(f.flag).toBe('cross-model-review: codex-cli:gpt-5.5');
  });

  it('uses the LAST successful round flag when multiple rounds succeed', () => {
    const f = aggregateRoundOutcomes([ok('gpt-5.4'), ok('gpt-5.5')]);
    expect(f.flag).toBe('cross-model-review: codex-cli:gpt-5.5');
  });

  it('framework present every round but ZERO succeeded → degraded-all-rounds (as loud as unavailable)', () => {
    const f = aggregateRoundOutcomes([degraded('timeout'), degraded('rate-limited')]);
    expect(f.status).toBe('degraded-all-rounds');
    expect(f.flag).toBe('cross-model-review: degraded-all-rounds');
    // last degraded reason carried through for the -reason field
    expect(f.reason).toBe('rate-limited');
  });

  it('all rounds unavailable (no framework ever) → unavailable, NOT degraded-all-rounds', () => {
    const f = aggregateRoundOutcomes([unavailable(), unavailable()]);
    expect(f.status).toBe('unavailable');
    expect(f.flag).toBe('cross-model-review: unavailable');
    expect(f.reason).toBe('codex-not-installed');
  });

  it('skippedAbbreviated wins over everything (author opted out)', () => {
    const f = aggregateRoundOutcomes([ok(), degraded('timeout')], { skippedAbbreviated: true });
    expect(f.status).toBe('skipped-abbreviated');
    expect(f.flag).toBe('cross-model-review: skipped-abbreviated');
  });

  it('empty rounds → unavailable (nothing was recorded)', () => {
    const f = aggregateRoundOutcomes([]);
    expect(f.status).toBe('unavailable');
    expect(f.reason).toBe('no-rounds-recorded');
  });

  it('a single degraded round (framework present, never succeeded) → degraded-all-rounds', () => {
    const f = aggregateRoundOutcomes([degraded('timeout')]);
    expect(f.status).toBe('degraded-all-rounds');
    expect(f.reason).toBe('timeout');
  });
});

describe('classifyReviewFailure (degraded reasons)', () => {
  it('classifies rate-limit / circuit-breaker errors as rate-limited', () => {
    expect(classifyReviewFailure(new Error('LLM circuit breaker is open'))).toBe('rate-limited');
    expect(classifyReviewFailure(new Error('429 Too Many Requests'))).toBe('rate-limited');
    expect(classifyReviewFailure(new Error('usage limit reached'))).toBe('rate-limited');
  });

  it('classifies timeouts as timeout', () => {
    expect(classifyReviewFailure(new Error('Command timed out'))).toBe('timeout');
    expect(classifyReviewFailure(new Error('ETIMEDOUT'))).toBe('timeout');
  });

  it('falls back to generic error', () => {
    expect(classifyReviewFailure(new Error('Codex CLI error: nonzero exit'))).toBe('error');
    expect(classifyReviewFailure('weird non-error throw')).toBe('error');
  });
});

describe('runCrossModelReview — the three outcome states', () => {
  const assembled = { promptText: 'PROMPT', truncated: false, bytes: 6 };

  it('unavailable: no framework → status unavailable, never throws/blocks', async () => {
    const r = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: null, geminiPathDetected: null, env: {} },
    });
    expect(r.status).toBe('unavailable');
    expect(r.flag).toBe('cross-model-review: unavailable');
    expect(r.reason).toBe('codex-not-installed');
  });

  it('ok: available + provider returns a structured review → status ok with findings', async () => {
    const authPath = writeAuth(OAUTH_AUTH);
    const r = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: stubProvider(
        'Verdict: SERIOUS ISSUES\n- §2 the timeout default is too low.\n- §3 registry typing.',
      ),
    });
    expect(r.status).toBe('ok');
    expect(r.framework).toBe('codex-cli');
    expect(r.model).toBe('gpt-5.5');
    expect(r.verdict).toBe('SERIOUS ISSUES');
    expect(r.findings).toHaveLength(1);
    expect(r.findings![0].reviewer).toBe('cross-model:codex-cli:gpt-5.5');
    expect(r.flag).toBe('cross-model-review: codex-cli:gpt-5.5');
  });

  it('degraded: available but the provider throws → status degraded, does NOT collapse to unavailable', async () => {
    const authPath = writeAuth(OAUTH_AUTH);
    const r = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: throwingProvider(new Error('Command timed out after 120000ms')),
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('timeout');
    expect(r.flag).toBe('cross-model-review: codex-cli:gpt-5.5 (degraded: timeout)');
  });

  it('degraded: rate-limited provider error classifies as rate-limited', async () => {
    const authPath = writeAuth(OAUTH_AUTH);
    const r = await runCrossModelReview({
      assembled,
      detectInputs: { codexPathDetected: '/usr/bin/codex', authJsonPath: authPath, env: {} },
      providerOverride: throwingProvider(new Error('circuit breaker open — usage limit')),
    });
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('rate-limited');
  });

  it('uses REVIEW_TIMEOUT_MS as the default and 120s is the spec value', () => {
    expect(REVIEW_TIMEOUT_MS).toBe(120_000);
  });
});

// ── Driver parse ────────────────────────────────────────────────────────

describe('parseReviewerReply', () => {
  const tag = 'cross-model:codex-cli:gpt-5.5';

  it('parses a well-formed reply into a structured finding', () => {
    const f = parseReviewerReply(
      'Verdict: MINOR ISSUES\n- §4 wording could be tighter.',
      tag,
    );
    expect(f.verdict).toBe('MINOR ISSUES');
    expect(f.unstructured).toBeUndefined();
    expect(f.reviewer).toBe(tag);
    expect(f.body).toContain('§4');
  });

  it('handles markdown-decorated verdict lines (**Verdict: CLEAN**)', () => {
    const f = parseReviewerReply('**Verdict: CLEAN** — looks good.', tag);
    expect(f.verdict).toBe('CLEAN');
  });

  it('prefers the most specific verdict (SERIOUS over the substring ISSUES)', () => {
    const f = parseReviewerReply('Verdict: SERIOUS ISSUES', tag);
    expect(f.verdict).toBe('SERIOUS ISSUES');
  });

  it('captures an unparseable reply as exactly one raw finding (never zero, never thrown)', () => {
    const f = parseReviewerReply('I think this design is mostly fine, no clear verdict here.', tag);
    expect(f.verdict).toBe('UNKNOWN');
    expect(f.unstructured).toBe(true);
    expect(f.body).toContain('unstructured external review');
  });

  it('captures an empty reply as one raw finding', () => {
    const f = parseReviewerReply('   ', tag);
    expect(f.verdict).toBe('UNKNOWN');
    expect(f.unstructured).toBe(true);
    expect(f.body).toContain('empty reviewer reply');
  });
});

// ── Prompt assembly + budget ─────────────────────────────────────────────

describe('assembleReviewerPrompt', () => {
  const template = 'Review the spec at {SPEC_PATH}. Be terse.';
  const specMarkdown = '# Spec\n\nThis is the spec body.';

  it('substitutes {SPEC_PATH} and includes the full spec', () => {
    const a = assembleReviewerPrompt({
      reviewerTemplate: template,
      specMarkdown,
      specPath: 'docs/specs/foo.md',
    });
    expect(a.promptText).toContain('Review the spec at docs/specs/foo.md');
    expect(a.promptText).toContain('This is the spec body.');
    expect(a.truncated).toBe(false);
  });

  it('inlines referenced context under CONTEXT headers', () => {
    const a = assembleReviewerPrompt({
      reviewerTemplate: template,
      specMarkdown,
      specPath: 'docs/specs/foo.md',
      context: [
        { path: 'docs/a.md', content: 'alpha content' },
        { path: 'docs/b.md', content: 'beta content' },
      ],
    });
    expect(a.promptText).toContain('--- CONTEXT: docs/a.md ---');
    expect(a.promptText).toContain('alpha content');
    expect(a.promptText).toContain('--- CONTEXT: docs/b.md ---');
    expect(a.promptText).toContain('beta content');
    expect(a.truncated).toBe(false);
  });

  it('truncates context that overflows the budget and adds a loud note', () => {
    const bigDoc = 'X'.repeat(5000);
    const a = assembleReviewerPrompt({
      reviewerTemplate: template,
      specMarkdown,
      specPath: 'docs/specs/foo.md',
      context: [
        { path: 'docs/big1.md', content: bigDoc },
        { path: 'docs/big2.md', content: bigDoc },
      ],
      budgetBytes: 1024, // tiny budget forces truncation
    });
    expect(a.truncated).toBe(true);
    expect(a.promptText).toContain('referenced context was TRUNCATED');
    // The spec is ALWAYS included even when context is dropped.
    expect(a.promptText).toContain('This is the spec body.');
  });

  it('always includes the full spec even when context alone exceeds the budget', () => {
    const huge = 'Y'.repeat(200_000);
    const a = assembleReviewerPrompt({
      reviewerTemplate: template,
      specMarkdown,
      specPath: 'docs/specs/foo.md',
      context: [{ path: 'docs/huge.md', content: huge }],
      budgetBytes: 2048,
    });
    expect(a.promptText).toContain('This is the spec body.');
    expect(a.truncated).toBe(true);
  });

  it('defaults to the 60KB context budget', () => {
    expect(CONTEXT_BUDGET_BYTES).toBe(60 * 1024);
  });

  // ── F4 — deterministic truncation: priority order + NAMED dropped docs ──

  it('orders constitutional/lessons context FIRST regardless of caller order, then drops the rest deterministically', () => {
    const big = 'Z'.repeat(4000);
    // Pass the constitutional doc LAST in caller order; it must still be kept
    // (sorted first) while the earlier ordinary docs get dropped.
    const a = assembleReviewerPrompt({
      reviewerTemplate: template,
      specMarkdown,
      specPath: 'docs/specs/foo.md',
      context: [
        { path: 'docs/ordinary-a.md', content: big },
        { path: 'docs/ordinary-b.md', content: big },
        { path: 'docs/signal-vs-authority.md', content: 'CONSTITUTIONAL-MARKER ' + big },
      ],
      budgetBytes: 4500, // room for the header + ~one doc
    });
    expect(a.truncated).toBe(true);
    // The priority doc was KEPT even though it was passed last.
    expect(a.promptText).toContain('--- CONTEXT: docs/signal-vs-authority.md ---');
    expect(a.promptText).toContain('CONSTITUTIONAL-MARKER');
  });

  it('NAMES the dropped docs in the truncation note (not just "truncated")', () => {
    const big = 'Q'.repeat(4000);
    const a = assembleReviewerPrompt({
      reviewerTemplate: template,
      specMarkdown,
      specPath: 'docs/specs/foo.md',
      context: [
        { path: 'docs/signal-vs-authority.md', content: 'short kept doc' },
        { path: 'docs/partial-one.md', content: big },
        { path: 'docs/dropped-two.md', content: big },
        { path: 'docs/dropped-three.md', content: big },
      ],
      // Budget holds the header + spec + the short priority doc, then cuts the
      // first big doc mid-document and fully omits the rest.
      budgetBytes: 800,
    });
    expect(a.truncated).toBe(true);
    // The note must name which doc was partial and which were fully omitted.
    expect(a.promptText).toContain('PARTIAL (cut mid-document): docs/partial-one.md');
    expect(a.promptText).toContain('FULLY OMITTED:');
    expect(a.promptText).toContain('docs/dropped-two.md');
    expect(a.promptText).toContain('docs/dropped-three.md');
    // The kept priority doc must NOT appear in the dropped list.
    expect(a.promptText).not.toMatch(/FULLY OMITTED:[^\n]*signal-vs-authority/);
  });

  it('is deterministic — identical inputs produce byte-identical prompts (including the drop list)', () => {
    const big = 'D'.repeat(4000);
    const mk = () =>
      assembleReviewerPrompt({
        reviewerTemplate: template,
        specMarkdown,
        specPath: 'docs/specs/foo.md',
        context: [
          { path: 'docs/x.md', content: big },
          { path: 'docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md', content: big },
          { path: 'docs/y.md', content: big },
        ],
        budgetBytes: 5000,
      });
    expect(mk().promptText).toBe(mk().promptText);
  });
});

describe('orderContextDeterministically (F4)', () => {
  it('sorts constitutional/lessons docs ahead, preserving caller order within each group (stable)', () => {
    const ordered = orderContextDeterministically([
      { path: 'docs/zeta.md', content: '' },
      { path: 'docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md', content: '' },
      { path: 'docs/alpha.md', content: '' },
      { path: 'docs/signal-vs-authority.md', content: '' },
    ]);
    // signal-vs-authority is priority index 0, lessons doc is index 1 →
    // signal first, then lessons, then the two ordinary docs in caller order.
    expect(ordered.map((d) => d.path)).toEqual([
      'docs/signal-vs-authority.md',
      'docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md',
      'docs/zeta.md',
      'docs/alpha.md',
    ]);
  });

  it('is a pure function — does not mutate the input array', () => {
    const input = [
      { path: 'docs/a.md', content: '' },
      { path: 'docs/signal-vs-authority.md', content: '' },
    ];
    const snapshot = input.map((d) => d.path);
    orderContextDeterministically(input);
    expect(input.map((d) => d.path)).toEqual(snapshot);
  });

  it('exposes a non-empty, stable priority list with the constitutional docs', () => {
    expect(CONTEXT_PRIORITY_SUBSTRINGS.length).toBeGreaterThan(0);
    expect(CONTEXT_PRIORITY_SUBSTRINGS).toContain('signal-vs-authority');
  });
});
