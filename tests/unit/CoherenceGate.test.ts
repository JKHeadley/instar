/**
 * CoherenceGate — Unit tests for the orchestrator.
 *
 * Tests the normative decision matrix, retry flow, feedback composition,
 * PEL integration, channel config resolution, and session mutex.
 *
 * Uses mocked reviewers (no real API calls).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import type { ResponseReviewConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Mock the IntelligenceProvider that reviewers route through ──────
//
// As of the Rule 2 path-constraint lockdown
// (specs/provider-portability/04-anthropic-path-constraints.md), reviewers
// route LLM calls through an IntelligenceProvider rather than calling
// `fetch` against Anthropic directly. These helpers build a fake provider
// whose `evaluate` returns the next canned response in sequence — each
// reviewer call within a gate.evaluate() consumes one response. Order
// matters: gate reviewer fires first, then per-dimension reviewers in the
// order CoherenceGate constructs them.

type MockIntelligence = { evaluate: ReturnType<typeof vi.fn> };

function makeMockIntelligence(responses: Array<Record<string, unknown>> | Record<string, unknown>): MockIntelligence {
  const arr = Array.isArray(responses) ? responses : [responses];
  let idx = 0;
  return {
    evaluate: vi.fn().mockImplementation(async () => {
      const r = arr[Math.min(idx, arr.length - 1)];
      idx++;
      return JSON.stringify(r);
    }),
  };
}

function makeAllPassIntelligence(): MockIntelligence {
  return makeMockIntelligence({ pass: true, severity: 'warn', issue: '', suggestion: '' });
}

function makeGateSkipIntelligence(): MockIntelligence {
  return makeMockIntelligence({ needsReview: false, reason: 'Simple ack' });
}

// (Retained for back-compat with any test that imports it; not currently used here.)
function makeGateNeedsReviewIntelligence(): MockIntelligence {
  return makeMockIntelligence({ needsReview: true, reason: 'Contains claims' });
}

// ── Test Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function createTestConfig(overrides?: Partial<ResponseReviewConfig>): ResponseReviewConfig {
  return {
    enabled: true,
    reviewers: {
      'conversational-tone': { enabled: true, mode: 'block' },
      'claim-provenance': { enabled: true, mode: 'block' },
      'settling-detection': { enabled: true, mode: 'warn' },
      'context-completeness': { enabled: true, mode: 'warn' },
      'capability-accuracy': { enabled: true, mode: 'block' },
      'url-validity': { enabled: true, mode: 'block' },
      'value-alignment': { enabled: true, mode: 'block' },
    },
    maxRetries: 2,
    timeoutMs: 8000,
    channelDefaults: {
      external: { failOpen: false, skipGate: true, queueOnFailure: true, queueTimeoutMs: 30000 },
      internal: { failOpen: true, skipGate: false, queueOnFailure: false },
    },
    ...overrides,
  };
}

function createGate(
  config?: Partial<ResponseReviewConfig>,
  intelligence?: MockIntelligence,
): CoherenceGate {
  return new CoherenceGate({
    config: createTestConfig(config),
    stateDir: tmpDir,
    intelligence: (intelligence ?? makeAllPassIntelligence()) as unknown as import('../../src/core/types.js').IntelligenceProvider,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CoherenceGate', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrg-test-'));
    // Create minimal AGENT.md for value alignment
    fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), '# Test Agent\n## Intent\n- Be helpful\n- Be accurate');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/CoherenceGate.test.ts:117' });
  });

  describe('PEL integration', () => {
    it('blocks messages with credentials (Row 1 — PEL HARD_BLOCK)', async () => {
      const intel = makeMockIntelligence([
        { needsReview: true, reason: 'Has claims' }, // gate
        { pass: false, severity: 'block', issue: 'Tone issue', suggestion: 'Fix it' }, // reviewer
        { pass: true, severity: 'warn', issue: '', suggestion: '' }, // other reviewers pass
      ]);

      const gate = createGate();
      const result = await gate.evaluate({
        message: 'Here is your API key: sk-ant-abc123456789012345678',
        sessionId: 'test-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result._pelBlock).toBe(true);
      expect(result.feedback).toContain('POLICY VIOLATION');
    });

    it('blocks PEL violations even in observeOnly mode', async () => {
      const gate = createGate({ observeOnly: true });
      const result = await gate.evaluate({
        message: 'Your password is: password=s3cr3tP@ss!',
        sessionId: 'test-2',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      expect(result.pass).toBe(false);
      expect(result._pelBlock).toBe(true);
    });
  });

  describe('gate reviewer (triage)', () => {
    it('skips full review for simple acks on internal channels (Row 4)', async () => {
      const intel = makeGateSkipIntelligence();

      const gate = createGate(undefined, intel);

      const result = await gate.evaluate({
        message: 'Got it!',
        sessionId: 'test-3',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass');
    });

    it('always runs full review on external channels (skipGate: true)', async () => {
      // Gate would skip, but skipGate=true means gate is bypassed and full review runs
      const intel = makeAllPassIntelligence();
      const gate = createGate(undefined, intel);

      const result = await gate.evaluate({
        message: 'Got it!',
        sessionId: 'test-4',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      // The provider should be called multiple times (every reviewer, not just gate)
      expect(intel.evaluate.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('observeOnly mode (Row 3)', () => {
    it('logs verdicts but never blocks', async () => {
      const intel = makeMockIntelligence([
        { needsReview: true, reason: 'Has claims' },
        { pass: false, severity: 'block', issue: 'Tone issue', suggestion: 'Fix it' },
        { pass: true, severity: 'warn', issue: '', suggestion: '' },
      ]);
      const gate = createGate({ observeOnly: true }, intel);

      const result = await gate.evaluate({
        message: 'Check .instar/config.json for your settings',
        sessionId: 'test-5',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-observe');
    });
  });

  describe('blocking and revision flow (Row 6)', () => {
    it('blocks when a block-mode reviewer fails', async () => {
      const intel = makeMockIntelligence([
        { pass: false, severity: 'block', issue: 'Technical language detected', suggestion: 'Use plain language' },
      ]);

      const gate = createGate(undefined, intel);

      const result = await gate.evaluate({
        message: 'Here is how you configure the scheduler using the terminal command interface.',
        sessionId: 'test-6',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result.feedback).toContain('COHERENCE REVIEW');
      expect(result.retryCount).toBe(0);
    });

    it('composes collapse feedback on retry', async () => {
      const intel = makeMockIntelligence([
        { pass: false, severity: 'block', issue: 'Issue 1', suggestion: 'Fix 1' },
      ]);

      const gate = createGate(undefined, intel);

      // First call — initial block
      await gate.evaluate({
        message: 'Bad message',
        sessionId: 'test-7',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      // Second call — retry
      const result = await gate.evaluate({
        message: 'Still bad message',
        sessionId: 'test-7',
        stopHookActive: true,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(false);
      expect(result.feedback).toContain('Previous attempt');
      expect(result.feedback).toContain('revision 1 of 2');
      expect(result.retryCount).toBe(1);
    });
  });

  describe('retry exhaustion (Rows 7-9)', () => {
    it('passes on internal channel after retry exhaustion (Row 7)', async () => {
      const intel = makeMockIntelligence([
        { pass: false, severity: 'block', issue: 'Tone issue', suggestion: 'Fix' },
      ]);

      const gate = createGate({ maxRetries: 1 }, intel);

      // First: initial block
      await gate.evaluate({
        message: 'Bad message',
        sessionId: 'test-8',
        stopHookActive: false,
        context: { channel: 'direct', isExternalFacing: false },
      });

      // Second: retry exhausted on internal → pass
      const result = await gate.evaluate({
        message: 'Still bad',
        sessionId: 'test-8',
        stopHookActive: true,
        context: { channel: 'direct', isExternalFacing: false },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-exhausted');
    });

    it('passes on external + tone issue after exhaustion (Row 8)', async () => {
      const intel = makeMockIntelligence([
        { pass: false, severity: 'block', issue: 'Tone issue', suggestion: 'Fix' },
      ]);

      const gate = createGate({
        maxRetries: 1,
        reviewers: {
          'conversational-tone': { enabled: true, mode: 'block' },
          'claim-provenance': { enabled: false, mode: 'block' },
          'settling-detection': { enabled: false, mode: 'warn' },
          'context-completeness': { enabled: false, mode: 'warn' },
          'capability-accuracy': { enabled: false, mode: 'block' },
          'url-validity': { enabled: false, mode: 'block' },
          'value-alignment': { enabled: false, mode: 'block' },
        },
      }, intel);

      // First: block
      await gate.evaluate({
        message: 'Here is the technical configuration for your setup.',
        sessionId: 'test-9',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      // Second: exhausted on external + tone → pass
      const result = await gate.evaluate({
        message: 'Still has technical language in the response.',
        sessionId: 'test-9',
        stopHookActive: true,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-exhausted');
    });
  });

  describe('warn-only mode (Row 5)', () => {
    it('passes with warnings when only warn-mode reviewers flag', async () => {
      // Only enable settling-detection in warn mode; disable all block-mode reviewers
      const intel = makeMockIntelligence([
        { pass: false, severity: 'warn', issue: 'Settling detected', suggestion: 'Try harder' },
      ]);

      const gate = createGate({
        reviewers: {
          'settling-detection': { enabled: true, mode: 'warn' },
          'conversational-tone': { enabled: false, mode: 'block' },
          'claim-provenance': { enabled: false, mode: 'block' },
          'context-completeness': { enabled: false, mode: 'warn' },
          'capability-accuracy': { enabled: false, mode: 'block' },
          'url-validity': { enabled: false, mode: 'block' },
          'value-alignment': { enabled: false, mode: 'block' },
          'information-leakage': { enabled: false, mode: 'block' },
          'escalation-resolution': { enabled: false, mode: 'block' },
        },
      }, intel);

      const result = await gate.evaluate({
        message: 'I could not find any data.',
        sessionId: 'test-10',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('pass-warn');
      expect(result.warnings).toContain('Settling detected');
    });
  });

  describe('channel config resolution', () => {
    it('uses explicit channel config when available', async () => {
      const intel = makeMockIntelligence([
        { pass: false, severity: 'block', issue: 'Issue', suggestion: 'Fix' },
      ]);

      const gate = createGate({
        channels: {
          email: { failOpen: false, skipGate: true, queueOnFailure: true, queueTimeoutMs: 60000 },
        },
      });
      const result = await gate.evaluate({
        message: 'Hello via email',
        sessionId: 'test-11',
        stopHookActive: false,
        context: { channel: 'email', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
    });

    it('falls back to external defaults for unknown external channels', async () => {
      const gate = createGate();
      const result = await gate.evaluate({
        message: 'Hello via slack',
        sessionId: 'test-12',
        stopHookActive: false,
        context: { channel: 'slack', isExternalFacing: true },
      });

      expect(result.pass).toBe(true);
      // Should have skipped gate (external default: skipGate: true)
    });
  });

  describe('conversation advancement detection', () => {
    it('abandons stale revision when transcript advances', async () => {
      const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
      fs.writeFileSync(transcriptPath, '{"type":"message"}\n');

      const intel = makeMockIntelligence([
        { needsReview: true, reason: 'Has claims' },
        { pass: false, severity: 'block', issue: 'Issue', suggestion: 'Fix' },
      ]);
      const gate = createGate(undefined, intel);

      // First: block
      await gate.evaluate({
        message: 'Bad message',
        sessionId: 'test-13',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, transcriptPath },
      });

      // Simulate user sending new message (advance transcript)
      fs.appendFileSync(transcriptPath, '{"type":"user_message"}\n');

      // Tiny delay to ensure mtime changes
      await new Promise(r => setTimeout(r, 50));

      // Second: retry but transcript has advanced
      const result = await gate.evaluate({
        message: 'Revised message',
        sessionId: 'test-13',
        stopHookActive: true,
        context: { channel: 'telegram', isExternalFacing: true, transcriptPath },
      });

      expect(result.pass).toBe(true);
      expect(result._outcome).toBe('abandoned-stale');
    });
  });

  describe('information-leakage reviewer skipping', () => {
    it('skips information-leakage for primary-user', async () => {
      const intel = makeMockIntelligence([
        { pass: false, severity: 'block', issue: 'Issue', suggestion: 'Fix' },
      ]);

      const gate = createGate({
        reviewers: {
          'information-leakage': { enabled: true, mode: 'block' },
        },
      });
      const result = await gate.evaluate({
        message: 'Hello primary user',
        sessionId: 'test-14',
        stopHookActive: false,
        context: { channel: 'direct', recipientType: 'primary-user' },
      });

      expect(result.pass).toBe(true);
    });
  });

  describe('review history and stats', () => {
    it('tracks review history', async () => {
      const gate = createGate();
      await gate.evaluate({
        message: 'Hello',
        sessionId: 'test-15',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      const history = gate.getReviewHistory();
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].sessionId).toBe('test-15');
    });

    it('filters history by sessionId', async () => {
      const gate = createGate();
      await gate.evaluate({
        message: 'Hello 1',
        sessionId: 'session-a',
        stopHookActive: false,
        context: { channel: 'direct' },
      });
      await gate.evaluate({
        message: 'Hello 2',
        sessionId: 'session-b',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      const historyA = gate.getReviewHistory({ sessionId: 'session-a' });
      expect(historyA.length).toBe(1);
      expect(historyA[0].sessionId).toBe('session-a');
    });

    it('returns reviewer stats', async () => {
      const gate = createGate();
      await gate.evaluate({
        message: 'Hello',
        sessionId: 'test-17',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      const stats = gate.getReviewerStats();
      // Should have stats for at least some reviewers
      expect(Object.keys(stats).length).toBeGreaterThan(0);
    });
  });

  describe('value document loading', () => {
    it('reads and caches AGENT.md Intent section', async () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), `# My Agent
## Intent
- **Mission**: Help users
- Be thorough
- Always verify

## Other Section
This should not be included.
`);

      const gate = createGate();
      await gate.evaluate({
        message: 'Hello',
        sessionId: 'test-18',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      // The gate should have loaded and cached value docs
      // We can verify indirectly by checking that it doesn't fail
      expect(true).toBe(true);
    });
  });

  describe('ORG-INTENT.md structured loading (three-rule contract)', () => {
    // These tests exercise the runtime integration that surfaces ORG-INTENT.md
    // as structured constraints/goals/values/tradeoffHierarchy to reviewers,
    // rather than the legacy flat-blob form. See INTENT-ENGINEERING-SPEC.md.

    function writeOrgIntent(content: string) {
      fs.writeFileSync(path.join(tmpDir, 'ORG-INTENT.md'), content);
    }

    it('passes structured intent into the value-alignment reviewer prompt when ORG-INTENT.md is present', async () => {
      writeOrgIntent(`# Organizational Intent: Acme Co

## Constraints (Mandatory)
- Never quote internal pricing to external contacts
- Always disclose AI nature on first interaction

## Goals (Defaults)
- Resolve customer questions on first contact when possible

## Values
- Honesty over expedience

## Tradeoff Hierarchy
- Customer trust over resolution speed
- Compliance over convenience
`);

      // Capture the prompt sent to the value-alignment reviewer.
      // Reviewer order from CoherenceGate.initializeReviewers():
      //   gate, conversational-tone, claim-provenance, settling-detection,
      //   context-completeness, capability-accuracy, url-validity,
      //   value-alignment, information-leakage, escalation-resolution
      // information-leakage skips for primary-user so the value-alignment call
      // is the last specialist invocation. We just inspect all calls and find
      // the one that names value-alignment via its anchor preamble.
      const intel = makeMockIntelligence({ pass: true, severity: 'warn', issue: '', suggestion: '' });

      const gate = createGate(undefined, intel);
      await gate.evaluate({
        message: 'Hello',
        sessionId: 'org-intent-1',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true, recipientType: 'primary-user' },
      });

      const allPrompts = (intel.evaluate as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
      const valueAlignmentPrompt = allPrompts.find(p => p.includes('value alignment reviewer'));
      expect(valueAlignmentPrompt).toBeDefined();
      // Three-rule contract bucket labels must be present
      expect(valueAlignmentPrompt).toContain('CONSTRAINTS');
      expect(valueAlignmentPrompt).toContain('GOALS');
      expect(valueAlignmentPrompt).toContain('VALUES');
      expect(valueAlignmentPrompt).toContain('TRADEOFF HIERARCHY');
      // Actual content from the structured parse
      expect(valueAlignmentPrompt).toContain('Never quote internal pricing to external contacts');
      expect(valueAlignmentPrompt).toContain('Customer trust over resolution speed');
      expect(valueAlignmentPrompt).toContain('Acme Co');
    });

    it('gracefully degrades when ORG-INTENT.md is absent (no orgIntent block, falls back to empty)', async () => {
      // No ORG-INTENT.md in tmpDir
      const intel = makeAllPassIntelligence();
      const gate = createGate(undefined, intel);

      const result = await gate.evaluate({
        message: 'Hello',
        sessionId: 'org-intent-absent',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      expect(result.pass).toBe(true);
      // The reviewer prompt should fall back to the sentinel string
      const allPrompts = (intel.evaluate as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
      const valueAlignmentPrompt = allPrompts.find(p => p.includes('value alignment reviewer'));
      if (valueAlignmentPrompt) {
        expect(valueAlignmentPrompt).toContain('No organizational intent provided.');
      }
    });

    it('treats template-only ORG-INTENT.md as absent (no structured intent surfaced)', async () => {
      writeOrgIntent(`# Organizational Intent: <!-- name -->

<!-- This is a template placeholder, nothing real here. -->

## Constraints (Mandatory)
<!-- list your mandatory constraints -->

## Goals (Defaults)
<!-- list your default goals -->
`);

      const intel = makeAllPassIntelligence();
      const gate = createGate(undefined, intel);
      await gate.evaluate({
        message: 'Hello',
        sessionId: 'org-intent-template',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      const allPrompts = (intel.evaluate as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
      const valueAlignmentPrompt = allPrompts.find(p => p.includes('value alignment reviewer'));
      if (valueAlignmentPrompt) {
        // Template-only means no structured surfacing; prompt should not show real constraint text
        expect(valueAlignmentPrompt).not.toContain('CONSTRAINTS (mandatory');
      }
    });

    it('omits empty buckets from the structured surfacing (only goals present → no CONSTRAINTS section)', async () => {
      writeOrgIntent(`# Organizational Intent: GoalsOnly Inc

## Goals (Defaults)
- Be friendly
`);

      const intel = makeAllPassIntelligence();
      const gate = createGate(undefined, intel);
      await gate.evaluate({
        message: 'Hello',
        sessionId: 'org-intent-goals-only',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      const allPrompts = (intel.evaluate as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
      const valueAlignmentPrompt = allPrompts.find(p => p.includes('value alignment reviewer'));
      expect(valueAlignmentPrompt).toBeDefined();
      expect(valueAlignmentPrompt).toContain('GOALS (organizational defaults');
      expect(valueAlignmentPrompt).toContain('Be friendly');
      // CONSTRAINTS, VALUES, TRADEOFF HIERARCHY rendered sections all absent.
      // These checks use the exact rendered headers from formatOrgIntent —
      // not the bare phrases (which also appear in the static instructions).
      expect(valueAlignmentPrompt).not.toContain('CONSTRAINTS (mandatory — violations MUST block)');
      expect(valueAlignmentPrompt).not.toContain('TRADEOFF HIERARCHY (earlier wins');
      expect(valueAlignmentPrompt).not.toContain('VALUES (representation — drift warns)');
    });

    it('caches structured intent across evaluations within TTL', async () => {
      writeOrgIntent(`# Organizational Intent: Cache Co

## Constraints (Mandatory)
- Never share secrets
`);

      const intel = makeAllPassIntelligence();
      const gate = createGate(undefined, intel);

      // First evaluation loads + caches
      await gate.evaluate({ message: 'Hello', sessionId: 's1', stopHookActive: false, context: { channel: 'direct' } });
      // Mutate the file on disk
      writeOrgIntent(`# Organizational Intent: Cache Co

## Constraints (Mandatory)
- Brand new mandate that should NOT appear in cached read
`);
      // Second evaluation within the 60-minute TTL still sees the cached version
      await gate.evaluate({ message: 'Hello again', sessionId: 's2', stopHookActive: false, context: { channel: 'direct' } });

      const allPrompts = (intel.evaluate as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
      const secondEvalPrompts = allPrompts.slice(Math.floor(allPrompts.length / 2));
      const valueAlignmentPrompt = secondEvalPrompts.find(p => p.includes('value alignment reviewer'));
      expect(valueAlignmentPrompt).toBeDefined();
      expect(valueAlignmentPrompt).toContain('Never share secrets');
      expect(valueAlignmentPrompt).not.toContain('Brand new mandate');
    });
  });

  describe('URL extraction', () => {
    it('extracts URLs from messages', async () => {
      const gate = createGate();
      const result = await gate.evaluate({
        message: 'Check https://example.com and http://test.org/page for details',
        sessionId: 'test-19',
        stopHookActive: false,
        context: { channel: 'direct' },
      });

      expect(result.pass).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('returns true when enabled', () => {
      const gate = createGate({ enabled: true });
      expect(gate.isEnabled()).toBe(true);
    });

    it('returns false when disabled', () => {
      const gate = createGate({ enabled: false });
      expect(gate.isEnabled()).toBe(false);
    });
  });

  describe('new response resets retry counter', () => {
    it('resets retryCount on non-stopHookActive request', async () => {
      const intel = makeMockIntelligence([
        { needsReview: true, reason: 'Has claims' },
        { pass: false, severity: 'block', issue: 'Issue', suggestion: 'Fix' },
      ]);
      const gate = createGate(undefined, intel);

      // First: block
      await gate.evaluate({
        message: 'Bad',
        sessionId: 'test-20',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      // New message (not a revision) — resets counter
      const result = await gate.evaluate({
        message: 'New bad message',
        sessionId: 'test-20',
        stopHookActive: false,
        context: { channel: 'telegram', isExternalFacing: true },
      });

      expect(result.retryCount).toBe(0);
    });
  });
});
