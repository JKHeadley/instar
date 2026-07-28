/**
 * ResponseReviewDecisionLog + CoherenceGate §D8 writing + §D9.4
 * counterfactual re-review — unit tests (context-aware-outbound-review;
 * test-plan boundaries 10 and 11, both sides).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import type { CoherenceGateOptions } from '../../src/core/CoherenceGate.js';
import { ResponseReviewDecisionLog } from '../../src/core/ResponseReviewDecisionLog.js';
import type { ResponseReviewConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrdl-'));
  fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), '# Test Agent\n## Intent\n- Be helpful');
});

afterEach(() => {
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/response-review-decision-log.test.ts' });
});

const isTonePrompt = (p: string) => p.includes('communication quality reviewer');

function makeIntel(route?: (p: string) => Record<string, unknown>) {
  const prompts: string[] = [];
  return {
    prompts,
    evaluate: vi.fn(async (p: string) => {
      prompts.push(p);
      return JSON.stringify(route?.(p) ?? { pass: true, severity: 'warn', issue: '', suggestion: '' });
    }),
  };
}

function config(overrides?: Partial<ResponseReviewConfig>): ResponseReviewConfig {
  return {
    enabled: true,
    reviewers: {
      // Exactly TWO reviewers enabled so LLM-call counts are deterministic
      // (a reviewer absent from config defaults to ENABLED).
      'conversational-tone': { enabled: true, mode: 'block' },
      'claim-provenance': { enabled: true, mode: 'block' },
      'settling-detection': { enabled: false, mode: 'block' },
      'context-completeness': { enabled: false, mode: 'block' },
      'capability-accuracy': { enabled: false, mode: 'block' },
      'url-validity': { enabled: false, mode: 'block' },
      'value-alignment': { enabled: false, mode: 'block' },
      'information-leakage': { enabled: false, mode: 'block' },
      'escalation-resolution': { enabled: false, mode: 'block' },
    },
    maxRetries: 2,
    timeoutMs: 8000,
    channelDefaults: {
      external: { failOpen: false, skipGate: true, queueOnFailure: true },
      internal: { failOpen: true, skipGate: true, queueOnFailure: false },
    },
    ...overrides,
  };
}

const blockTone = (p: string) =>
  isTonePrompt(p)
    ? { pass: false, severity: 'block', issue: 'Technical detail leak', suggestion: 'Plain words' }
    : { pass: true, severity: 'warn', issue: '', suggestion: '' };

const askProvider: NonNullable<CoherenceGateOptions['conversationContextProvider']> = () => ({
  messages: [{ role: 'user', text: 'send me the worktree list' }],
  askLicenseMode: 'single-sender',
});

function readRows(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function ctx(overrides?: Record<string, unknown>) {
  return {
    channel: 'telegram',
    isExternalFacing: true,
    topicId: 55,
    recipientType: 'primary-user' as const,
    ...overrides,
  };
}

// ── Boundary 10 — the durable decision log ───────────────────────────

describe('boundary 10 — §D8 decision log', () => {
  it('every evaluate outcome appends one schema row; textHead is scrubbed and ≤ 200 chars', async () => {
    const logPath = path.join(tmpDir, 'logs', 'rr.jsonl');
    const intel = makeIntel(blockTone);
    const gate = new CoherenceGate({
      config: config({ observeOnly: true }),
      stateDir: tmpDir,
      intelligence: intel as never,
      decisionLog: new ResponseReviewDecisionLog(logPath),
      liveConfig: () => ({ conversationalContext: { enabled: true } }),
      conversationContextProvider: askProvider,
    });

    // A PEL-missable token shape (no sk- prefix, no Bearer prefix) that the
    // scrubber's long-token redactor still catches — the row must reach the
    // reviewer path (not pel-block) AND persist scrubbed.
    const bareToken = 'a1b2c3d4'.repeat(5);
    const longMessage = `Here is the worktree list plus a leaked blob ${bareToken} — ` + 'x'.repeat(400);
    await gate.evaluate({ message: longMessage, sessionId: 'd1', stopHookActive: false, context: ctx() });

    const rows = readRows(logPath).filter((r) => !r.counterfactual);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      channel: 'telegram',
      topicId: 55,
      outcome: 'pass-observe',
      llmVerdict: 'BLOCK',
      observeOnly: true,
      gateSkipped: false,
      retryCount: 0,
    });
    expect(Array.isArray(row.violations)).toBe(true);
    expect((row.violations as Array<{ reviewer: string }>)[0].reviewer).toBe('conversational-tone');
    expect(row.contextMeta).toMatchObject({ messagesIncluded: 1, source: 'topic-memory', askLicenseMode: 'single-sender' });
    const textHead = row.textHead as string;
    expect(textHead.length).toBeLessThanOrEqual(200);
    expect(textHead).not.toContain(bareToken);
    // a would-block is llmVerdict BLOCK + observeOnly true — the flip-evidence shape
    expect(typeof row.t).toBe('string');
  });

  it('a PASS outcome also appends a row (the §D9.3 denominator needs all outcomes)', async () => {
    const logPath = path.join(tmpDir, 'logs', 'rr2.jsonl');
    const gate = new CoherenceGate({
      config: config({ observeOnly: true }),
      stateDir: tmpDir,
      intelligence: makeIntel() as never,
      decisionLog: new ResponseReviewDecisionLog(logPath),
    });
    await gate.evaluate({ message: 'Clean ack.', sessionId: 'd2', stopHookActive: false, context: ctx() });
    const rows = readRows(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'pass-observe', llmVerdict: 'PASS' });
    expect(rows[0].contextMeta).toBeUndefined(); // feature dark here — meta honestly absent
  });

  it('write failure is swallowed — the verdict and delivery are unaffected (side B)', async () => {
    // Point the log INSIDE a regular file so mkdir/append must fail.
    const blocker = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const gate = new CoherenceGate({
      config: config({ observeOnly: true }),
      stateDir: tmpDir,
      intelligence: makeIntel() as never,
      decisionLog: new ResponseReviewDecisionLog(path.join(blocker, 'nested', 'rr.jsonl')),
    });
    const res = await gate.evaluate({ message: 'Still delivers.', sessionId: 'd3', stopHookActive: false, context: ctx() });
    expect(res.pass).toBe(true);
  });

  it('rotates when the file exceeds maxBytes (bounded on-disk footprint)', () => {
    const logPath = path.join(tmpDir, 'logs', 'rot.jsonl');
    const log = new ResponseReviewDecisionLog(logPath, { maxBytes: 200 });
    for (let i = 0; i < 10; i++) log.append({ i, pad: 'z'.repeat(50) });
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThan(400);
  });
});

// ── Boundary 11 — counterfactual re-review ───────────────────────────

describe('boundary 11 — §D9.4 counterfactual re-review', () => {
  it('side A: watch-mode would-block by the opted-in reviewer with context → exactly ONE context-stripped re-review, counterfactual row with shared pairId', async () => {
    const logPath = path.join(tmpDir, 'logs', 'cf.jsonl');
    const intel = makeIntel(blockTone);
    const gate = new CoherenceGate({
      config: config({ observeOnly: true }),
      stateDir: tmpDir,
      intelligence: intel as never,
      decisionLog: new ResponseReviewDecisionLog(logPath),
      liveConfig: () => ({ conversationalContext: { enabled: true } }),
      conversationContextProvider: askProvider,
    });

    const callsBefore = intel.evaluate.mock.calls.length;
    await gate.evaluate({ message: 'technical thing', sessionId: 'cf1', stopHookActive: false, context: ctx() });

    await vi.waitFor(() => {
      const cf = readRows(logPath).filter((r) => r.counterfactual === true);
      expect(cf).toHaveLength(1);
    });

    const rows = readRows(logPath);
    const original = rows.find((r) => r.outcome === 'pass-observe')!;
    const cf = rows.find((r) => r.counterfactual === true)!;
    expect(typeof original.pairId).toBe('string');
    expect(cf.pairId).toBe(original.pairId); // the shared pairId links the pair
    expect(cf.reviewer).toBe('conversational-tone');
    expect(cf.flagged).toBe(true); // the mocked reviewer blocks with or without context
    // Exactly ONE extra LLM call beyond the fan-out (2 reviewers) — the
    // counterfactual re-review of THAT reviewer.
    await vi.waitFor(() => {
      expect(intel.evaluate.mock.calls.length - callsBefore).toBe(3);
    });
    // The counterfactual prompt is CONTEXT-STRIPPED.
    const cfPrompt = intel.prompts[intel.prompts.length - 1];
    expect(cfPrompt.includes('communication quality reviewer')).toBe(true);
    expect(cfPrompt).not.toContain('RECENT CONVERSATION');
  });

  const settle = async () => {
    // Give any (wrong) fire-and-forget counterfactual time to land.
    await new Promise((r) => setTimeout(r, 50));
  };

  it('side B: under enforcement (observeOnly false) the counterfactual NEVER fires', async () => {
    const logPath = path.join(tmpDir, 'logs', 'cf2.jsonl');
    const intel = makeIntel(blockTone);
    const gate = new CoherenceGate({
      config: config({ observeOnly: false }),
      stateDir: tmpDir,
      intelligence: intel as never,
      decisionLog: new ResponseReviewDecisionLog(logPath),
      liveConfig: () => ({ conversationalContext: { enabled: true } }),
      conversationContextProvider: askProvider,
    });
    await gate.evaluate({ message: 'technical thing', sessionId: 'cf2', stopHookActive: false, context: ctx() });
    await settle();
    expect(readRows(logPath).filter((r) => r.counterfactual === true)).toHaveLength(0);
    expect(intel.evaluate.mock.calls.length).toBe(2); // fan-out only, zero extra
  });

  it('side B: feature dark → no counterfactual', async () => {
    const logPath = path.join(tmpDir, 'logs', 'cf3.jsonl');
    const intel = makeIntel(blockTone);
    const gate = new CoherenceGate({
      config: config({ observeOnly: true }),
      stateDir: tmpDir,
      intelligence: intel as never,
      decisionLog: new ResponseReviewDecisionLog(logPath),
    });
    await gate.evaluate({ message: 'technical thing', sessionId: 'cf3', stopHookActive: false, context: ctx() });
    await settle();
    expect(readRows(logPath).filter((r) => r.counterfactual === true)).toHaveLength(0);
  });

  it('side B: a block driven SOLELY by a non-opted-in reviewer → no counterfactual (round-2 L2 precision)', async () => {
    const logPath = path.join(tmpDir, 'logs', 'cf4.jsonl');
    const blockProvenance = (p: string) =>
      p.includes('communication quality reviewer')
        ? { pass: true, severity: 'warn', issue: '', suggestion: '' }
        : { pass: false, severity: 'block', issue: 'Unsupported claim', suggestion: 'Cite it' };
    const intel = makeIntel(blockProvenance);
    const gate = new CoherenceGate({
      config: config({ observeOnly: true }),
      stateDir: tmpDir,
      intelligence: intel as never,
      decisionLog: new ResponseReviewDecisionLog(logPath),
      liveConfig: () => ({ conversationalContext: { enabled: true } }),
      conversationContextProvider: askProvider,
    });
    await gate.evaluate({ message: 'claimy thing', sessionId: 'cf4', stopHookActive: false, context: ctx() });
    await settle();
    expect(readRows(logPath).filter((r) => r.counterfactual === true)).toHaveLength(0);
    expect(intel.evaluate.mock.calls.length).toBe(2);
  });

  it('side B: a canary-tagged evaluation → no counterfactual (r4 — the battery carries its own baseline arm)', async () => {
    const logPath = path.join(tmpDir, 'logs', 'cf5.jsonl');
    const intel = makeIntel(blockTone);
    const gate = new CoherenceGate({
      config: config({ observeOnly: true }),
      stateDir: tmpDir,
      intelligence: intel as never,
      decisionLog: new ResponseReviewDecisionLog(logPath),
      liveConfig: () => ({ conversationalContext: { enabled: true } }),
      conversationContextProvider: askProvider,
    });
    await gate.evaluate({
      message: 'technical thing', sessionId: 'cf5', stopHookActive: false, context: ctx(),
      telemetry: { canary: true, fixtureId: 'cred-prose-ask/with-context' },
    });
    await settle();
    const rows = readRows(logPath);
    expect(rows.filter((r) => r.counterfactual === true)).toHaveLength(0);
    // …but the evaluation row IS canary-tagged by the writer (tag plumbing).
    const evalRow = rows.find((r) => r.outcome === 'pass-observe')!;
    expect(evalRow.canary).toBe(true);
    expect(evalRow.fixtureId).toBe('cred-prose-ask/with-context');
  });
});
