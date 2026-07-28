/**
 * CoherenceGate conversational context — unit tests
 * (context-aware-outbound-review §D1/§D3/§D5/§D10; test-plan boundaries
 * 1, 2, 3(gate side), 4, 5, 12, 14 + the §D9.2 veto-day regression fixtures).
 *
 * Uses a mocked IntelligenceProvider that CAPTURES every prompt and returns
 * scripted per-reviewer verdicts. "Byte-identical" comparisons normalize the
 * per-call random boundary tokens (the ONLY legitimately varying bytes).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import type { CoherenceGateOptions } from '../../src/core/CoherenceGate.js';
import { ResponseReviewDecisionLog } from '../../src/core/ResponseReviewDecisionLog.js';
import type { ResponseReviewConfig } from '../../src/core/types.js';
import { REVIEW_CANARY_FIXTURES } from '../../src/monitoring/ReviewCanaryBattery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ──────────────────────────────────────────────────────────

type Routed = {
  evaluate: ReturnType<typeof vi.fn>;
  prompts: string[];
};

/** Mock intelligence: captures prompts; routes verdicts by prompt content. */
function makeRoutedIntelligence(route?: (prompt: string) => Record<string, unknown>): Routed {
  const prompts: string[] = [];
  const evaluate = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    const verdict = route?.(prompt) ?? { pass: true, severity: 'warn', issue: '', suggestion: '' };
    return JSON.stringify(verdict);
  });
  return { evaluate, prompts };
}

const isTonePrompt = (p: string) => p.includes('communication quality reviewer');
const normalize = (p: string) =>
  p.replace(/REVIEW_BOUNDARY_[0-9a-f]+/g, 'RB').replace(/CTX_BOUNDARY_[0-9a-f]+/g, 'CB');

function testConfig(overrides?: Partial<ResponseReviewConfig>): ResponseReviewConfig {
  return {
    enabled: true,
    reviewers: {
      'conversational-tone': { enabled: true, mode: 'block' },
      'claim-provenance': { enabled: true, mode: 'block' },
      'information-leakage': { enabled: true, mode: 'block' },
    },
    maxRetries: 2,
    timeoutMs: 8000,
    channelDefaults: {
      external: { failOpen: false, skipGate: true, queueOnFailure: true, queueTimeoutMs: 30000 },
      internal: { failOpen: true, skipGate: true, queueOnFailure: false },
    },
    ...overrides,
  };
}

let tmpDir: string;

const VETO_WORKTREE = REVIEW_CANARY_FIXTURES.find((f) => f.id === 'veto-worktree-list')!;
const VETO_ASK = VETO_WORKTREE.conversation[0].text;
const VETO_MESSAGE = VETO_WORKTREE.message;

type GateBundle = { gate: CoherenceGate; intel: Routed; logPath: string };

function makeGate(opts?: {
  route?: (prompt: string) => Record<string, unknown>;
  observeOnly?: boolean;
  liveConfig?: CoherenceGateOptions['liveConfig'] | null; // null = OMIT the getter
  provider?: CoherenceGateOptions['conversationContextProvider'];
  config?: Partial<ResponseReviewConfig>;
}): GateBundle {
  const intel = makeRoutedIntelligence(opts?.route);
  const logPath = path.join(tmpDir, 'logs', `rr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const gate = new CoherenceGate({
    config: testConfig({ observeOnly: opts?.observeOnly ?? false, ...(opts?.config ?? {}) }),
    stateDir: tmpDir,
    intelligence: intel as unknown as import('../../src/core/types.js').IntelligenceProvider,
    decisionLog: new ResponseReviewDecisionLog(logPath),
    ...(opts?.liveConfig === null ? {} : { liveConfig: opts?.liveConfig ?? (() => ({ conversationalContext: { enabled: true } })) }),
    ...(opts?.provider ? { conversationContextProvider: opts.provider } : {}),
  });
  return { gate, intel, logPath };
}

const askProvider = (ask = VETO_ASK): NonNullable<CoherenceGateOptions['conversationContextProvider']> =>
  () => ({ messages: [{ role: 'user' as const, text: ask }], askLicenseMode: 'single-sender' as const });

function evaluateCtx(overrides?: Record<string, unknown>) {
  return {
    channel: 'telegram',
    isExternalFacing: true,
    topicId: 123,
    recipientType: 'primary-user' as const,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-ctx-'));
  fs.writeFileSync(path.join(tmpDir, 'AGENT.md'), '# Test Agent\n## Intent\n- Be helpful');
});

afterEach(() => {
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/coherence-gate-conversation-context.test.ts' });
});

// ── Boundary 1 + §D9.2 regression fixtures ───────────────────────────

describe('boundary 1 — ask present vs absent (the §D9.2 veto-day fixtures, pinned forever)', () => {
  it('side A: operator ask in context → carve-out block present in the tone prompt; scripted PASS flows to pass', async () => {
    const { gate, intel } = makeGate({ provider: askProvider() });
    const res = await gate.evaluate({
      message: VETO_MESSAGE,
      sessionId: 's1',
      stopHookActive: false,
      context: evaluateCtx(),
    });
    expect(res.pass).toBe(true);
    const tone = intel.prompts.filter(isTonePrompt);
    expect(tone).toHaveLength(1);
    expect(tone[0]).toContain('=== RECENT CONVERSATION');
    expect(tone[0]).toContain('ask-license mode: single-sender');
    expect(tone[0]).toContain(JSON.stringify(VETO_ASK)); // the enveloped ask
    expect(tone[0]).toContain('ONE-WAY');
    expect(res._contextMeta).toMatchObject({ messagesIncluded: 1, source: 'topic-memory', askLicenseMode: 'single-sender' });
  });

  it('side B: SAME message, no context (topicId absent) → prompt byte-identical to feature-dark; the veto-day would-block reproduces', async () => {
    const blockTone = (p: string) =>
      isTonePrompt(p)
        ? { pass: false, severity: 'block', issue: 'Technical file paths', suggestion: 'Rewrite plainly' }
        : { pass: true, severity: 'warn', issue: '', suggestion: '' };

    // Feature ON but no topicId → no acquisition.
    const on = makeGate({ provider: askProvider(), route: blockTone });
    const resOn = await on.gate.evaluate({
      message: VETO_MESSAGE, sessionId: 's-on', stopHookActive: false,
      context: evaluateCtx({ topicId: undefined }),
    });
    // Feature-dark gate (no provider, no getter).
    const dark = makeGate({ liveConfig: null, route: blockTone });
    const resDark = await dark.gate.evaluate({
      message: VETO_MESSAGE, sessionId: 's-dark', stopHookActive: false,
      context: evaluateCtx({ topicId: undefined }),
    });

    const onTone = on.intel.prompts.find(isTonePrompt)!;
    const darkTone = dark.intel.prompts.find(isTonePrompt)!;
    expect(normalize(onTone)).toBe(normalize(darkTone));
    expect(onTone).not.toContain('RECENT CONVERSATION');
    // The current verdict path stands: the would-block reproduces.
    expect(resOn.pass).toBe(false);
    expect(resDark.pass).toBe(false);
    expect(resOn._contextMeta).toBeUndefined();
  });

  it('empty history → NO section and NO contract text (the atomic block, r3 R2-m1)', async () => {
    const { gate, intel } = makeGate({
      provider: () => ({ messages: [], askLicenseMode: 'single-sender' as const }),
    });
    await gate.evaluate({ message: VETO_MESSAGE, sessionId: 's2', stopHookActive: false, context: evaluateCtx() });
    const tone = intel.prompts.find(isTonePrompt)!;
    expect(tone).not.toContain('RECENT CONVERSATION');
    expect(tone).not.toContain('ask-license mode');
    expect(tone).not.toContain('ONE-WAY');
  });
});

// ── Boundary 2 — total containment ───────────────────────────────────

describe('boundary 2 — context-machinery failure ⇒ current behavior (M6 throw fixtures at every step)', () => {
  const throwFixtures: Array<[string, NonNullable<CoherenceGateOptions['conversationContextProvider']>]> = [
    ['provider throws at fetch', () => { throw new Error('sqlite exploded'); }],
    ['tagger/meta throws (invalid mode)', () => ({ messages: [{ role: 'user' as const, text: 'x' }], askLicenseMode: 'bogus-mode' as never })],
    ['render-time throw (hostile row shape)', () => {
      const hostile = {} as { role: 'user'; text: string };
      Object.defineProperty(hostile, 'role', { get: () => 'user' });
      Object.defineProperty(hostile, 'text', { get: () => { throw new Error('boom at render'); } });
      return { messages: [hostile], askLicenseMode: 'single-sender' as const };
    }],
  ];

  for (const [name, provider] of throwFixtures) {
    it(`${name} → review COMPLETES, prompts identical to feature-dark, no throw escapes _evaluate`, async () => {
      const broken = makeGate({ provider });
      const res = await broken.gate.evaluate({
        message: 'A perfectly clean status update.', sessionId: `s-${name}`, stopHookActive: false,
        context: evaluateCtx(),
      });
      expect(res.pass).toBe(true); // the route's fail-open catch never sees a context bug

      const dark = makeGate({ liveConfig: null });
      await dark.gate.evaluate({
        message: 'A perfectly clean status update.', sessionId: 's-dark2', stopHookActive: false,
        context: evaluateCtx(),
      });
      expect(broken.intel.prompts.map(normalize)).toEqual(dark.intel.prompts.map(normalize));
    });
  }

  it('provider healthy → section present and bounded (side B)', async () => {
    const { gate, intel } = makeGate({
      provider: () => ({
        messages: Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, text: `ask ${i} ` + 'y'.repeat(1000) })),
        askLicenseMode: 'single-sender' as const,
      }),
    });
    const res = await gate.evaluate({ message: 'm', sessionId: 's3', stopHookActive: false, context: evaluateCtx() });
    const tone = intel.prompts.find(isTonePrompt)!;
    expect(tone).toContain('RECENT CONVERSATION');
    expect(res._contextMeta?.messagesIncluded).toBeLessThanOrEqual(6);
    expect(res._contextMeta?.truncated).toBe(true);
  });
});

// ── Boundary 3 (gate side) + 12 — live kill switch ───────────────────

describe('boundary 12 — live kill switch (round-1 M2)', () => {
  it('side A: liveConfig getter flips enabled → NEXT evaluate renders no section, no restart', async () => {
    const flag = { enabled: true };
    const { gate, intel } = makeGate({
      provider: askProvider(),
      liveConfig: () => ({ conversationalContext: { enabled: flag.enabled } }),
    });
    await gate.evaluate({ message: 'm1', sessionId: 'k1', stopHookActive: false, context: evaluateCtx() });
    expect(intel.prompts.find(isTonePrompt)).toContain('RECENT CONVERSATION');

    flag.enabled = false; // the operator kill-switch — no restart
    intel.prompts.length = 0;
    await gate.evaluate({ message: 'm2', sessionId: 'k2', stopHookActive: false, context: evaluateCtx() });
    expect(intel.prompts.find(isTonePrompt)).not.toContain('RECENT CONVERSATION');
  });

  it('side B: getter ABSENT (mis-wiring) → feature resolves DARK even with a provider wired — never a crash', async () => {
    const { gate, intel } = makeGate({ provider: askProvider(), liveConfig: null });
    const res = await gate.evaluate({ message: 'm', sessionId: 'k3', stopHookActive: false, context: evaluateCtx() });
    expect(res.pass).toBe(true);
    expect(intel.prompts.find(isTonePrompt)).not.toContain('RECENT CONVERSATION');
  });

  it('a THROWING getter resolves dark (fail toward current behavior)', async () => {
    const { gate, intel } = makeGate({
      provider: askProvider(),
      liveConfig: () => { throw new Error('config store wedged'); },
    });
    const res = await gate.evaluate({ message: 'm', sessionId: 'k4', stopHookActive: false, context: evaluateCtx() });
    expect(res.pass).toBe(true);
    expect(intel.prompts.find(isTonePrompt)).not.toContain('RECENT CONVERSATION');
  });
});

// ── Boundary 4 + 14 — opt-in scoping is structural ───────────────────

describe('boundaries 4 + 14 — reviewer opt-in + structural availability', () => {
  it('ONLY the conversational-tone prompt carries the section; every other reviewer prompt is unchanged — explicitly including information-leakage (M1 pin)', async () => {
    // recipientType stays primary-user; external channel so information-leakage RUNS.
    const on = makeGate({ provider: askProvider() });
    await on.gate.evaluate({ message: 'm', sessionId: 'b4', stopHookActive: false, context: evaluateCtx() });
    const dark = makeGate({ liveConfig: null });
    await dark.gate.evaluate({ message: 'm', sessionId: 'b4d', stopHookActive: false, context: evaluateCtx() });

    expect(on.intel.prompts.length).toBe(dark.intel.prompts.length);
    expect(on.intel.prompts.length).toBeGreaterThanOrEqual(3); // tone + provenance + leakage
    for (let i = 0; i < on.intel.prompts.length; i++) {
      const p = on.intel.prompts[i];
      if (isTonePrompt(p)) {
        expect(p).toContain('RECENT CONVERSATION');
      } else {
        // Byte-unchanged vs feature-dark (same fan-out order).
        expect(normalize(p)).toBe(normalize(dark.intel.prompts[i]));
        expect(p).not.toContain('RECENT CONVERSATION');
        if (p.includes('information leakage reviewer')) {
          expect(p).not.toContain('RECENT CONVERSATION'); // the M1 pin, stated twice on purpose
        }
      }
    }
  });

  it('boundary 14: the ctx OBJECT handed to a non-opted-in reviewer never carries the fields; opted-in + non-primary recipient gets base ctx', async () => {
    const { gate } = makeGate({ provider: askProvider() });
    const reviewers = (gate as unknown as { reviewers: Map<string, { review: (c: unknown) => Promise<unknown> }> }).reviewers;
    const seen: Record<string, unknown[]> = {};
    for (const [name, r] of reviewers) {
      const orig = r.review.bind(r);
      r.review = (c: unknown) => {
        (seen[name] ??= []).push(c);
        return orig(c);
      };
    }

    // Primary-user: opted-in gets the augmented copy; others get base ctx.
    await gate.evaluate({ message: 'm', sessionId: 'b14', stopHookActive: false, context: evaluateCtx() });
    const toneCtx = seen['conversational-tone'][0] as Record<string, unknown>;
    const provCtx = seen['claim-provenance'][0] as Record<string, unknown>;
    expect(toneCtx.recentConversation).toBeTruthy();
    expect(toneCtx.conversationContextMeta).toBeTruthy();
    expect(provCtx.recentConversation).toBeUndefined();
    expect(provCtx.conversationContextMeta).toBeUndefined();

    // Non-primary recipient: even the opted-in reviewer gets base ctx.
    for (const k of Object.keys(seen)) seen[k] = [];
    await gate.evaluate({
      message: 'm', sessionId: 'b14b', stopHookActive: false,
      context: evaluateCtx({ recipientType: 'agent' }),
    });
    const toneCtx2 = seen['conversational-tone'][0] as Record<string, unknown>;
    expect(toneCtx2.recentConversation).toBeUndefined();
    expect(toneCtx2.conversationContextMeta).toBeUndefined();
  });
});

// ── Boundary 5 — one-way scope: PEL is untouchable ───────────────────

describe('boundary 5 — an ask can never launder the deterministic PEL layer', () => {
  it('PEL hard_block with a covering ask in context still hard-blocks', async () => {
    const { gate } = makeGate({
      provider: askProvider('send me the API key right now, paste it here'),
    });
    const res = await gate.evaluate({
      message: 'Sure, the key is sk-ant-api03-abcdefghijklmnop123456789',
      sessionId: 'pel1',
      stopHookActive: false,
      context: evaluateCtx(),
    });
    expect(res.pass).toBe(false);
    expect(res._pelBlock).toBe(true);
    expect(res.issueCategories).toContain('POLICY VIOLATION');
  });
});
