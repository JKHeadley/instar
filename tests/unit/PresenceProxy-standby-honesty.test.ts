// safe-fs-allow: test file — tmpdir stateDir only.

/**
 * honest-session-state-surfaces Finding (b) — Tier1/Tier2 standby honesty lift.
 *
 * The Tier-3 honest stuck classifier (rate-limited / policy-wedge / context-wedge
 * / context-too-long) is lifted into Tier 1 (~20s) and Tier 2 (~2min) behind the
 * dev-gated `standbyHonestyTiers` flag. These tests pin:
 *   - Flag ON: a stuck pane surfaces the REAL reason, NOT "actively working" /
 *     "still working", at Tier 1 AND Tier 2 — and the tier schedule is unchanged.
 *   - Flag ON + recovery sentinel owns the voice: NO message this fire (one-voice
 *     silent-suppress) — and crucially NOT a fall-through to the "working" copy.
 *   - Flag ON + NOT stuck: the lift returns null, the LLM/hardcoded path runs
 *     unchanged (additive, not a replacement).
 *   - Flag OFF (fleet default): byte-identical-to-today hardcoded copy for a
 *     stuck pane.
 *   - No-leak: only the verbatim classifier message is emitted — pane-derived
 *     secrets/paths never reach the outbound line.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUP_ERROR =
  '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).';
const POLICY_WEDGE = [
  '❯ msg one', AUP_ERROR, '✻ Churned for 8s',
  '❯ msg two', AUP_ERROR, '✻ Cogitated for 8s',
].join('\n');

const RATE_LIMIT = [
  '❯ did you get my messages?',
  "You've hit your session limit · resets 10:30pm (America/Los_Angeles)",
  '✻ Cooked for 0s',
].join('\n');

const THINKING_WEDGE = [
  '❯ msg one',
  '⏺ API Error: 400 thinking blocks in the latest assistant message cannot be modified',
  '✻ Cooked for 0s',
  '❯ msg two',
  '⏺ API Error: 400 thinking blocks in the latest assistant message cannot be modified',
  '✻ Cooked for 0s',
].join('\n');

const CONTEXT_TOO_LONG = 'This conversation is too long. Press esc twice to go up a few messages.\n❯';

const WORKING_PANE = [
  '⏺ Reading src/foo.ts',
  '⏺ Editing src/bar.ts',
  '✻ Crunching (12s · esc to interrupt)',
].join('\n');

interface Sent { topicId: number; text: string; opts?: any; }

function mkProxy(overrides: Record<string, unknown> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-standby-honesty-'));
  const sent: Sent[] = [];
  const config: any = {
    stateDir,
    intelligence: null, // force the deterministic (no-LLM) fallback path
    agentName: 'echo',
    getProcessTree: () => [{ command: 'claude', pid: 4242 }],
    isSessionAlive: () => true,
    getSessionForTopic: () => 'sess-1',
    captureSessionOutput: () => RATE_LIMIT,
    sendMessage: async (topicId: number, text: string, opts: any) => { sent.push({ topicId, text, opts }); },
    getAuthorizedUserIds: () => [],
    standbyHonestyTiers: true,
    ...overrides,
  };
  const proxy = new PresenceProxy(config);
  proxy.start();
  return { proxy, sent, stateDir, config };
}

function seedState(proxy: any, topicId: number, opts: { tier1Fired?: boolean } = {}) {
  const state = {
    topicId, sessionName: 'sess-1',
    userMessageAt: Date.now() - 5_000,
    userMessageText: 'did you get my messages?',
    userMessageBaselineSnapshot: null,
    tier1FiredAt: opts.tier1Fired ? Date.now() - 4_000 : null,
    tier1Snapshot: null, tier1SnapshotHash: null,
    tier2FiredAt: null, tier2Snapshot: null, tier2SnapshotHash: null,
    tier3FiredAt: null, tier3Assessment: null, tier3Summary: null, tier3RecheckCount: 0,
    silencedUntil: null, cancelled: false, llmCallCount: 0, lastLlmCallAt: 0,
    conversationHistory: [], lastAckText: null, lastAckAt: null,
  };
  proxy.states.set(topicId, state);
  return state;
}

describe('PresenceProxy standby honesty (Finding b) — Tier 1', () => {
  let cleanup: string[] = [];
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    for (const d of cleanup) {
      try {
        SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/PresenceProxy-standby-honesty.test.ts:cleanup' });
      } catch { /* ignore */ }
    }
    vi.restoreAllMocks();
  });

  // NOTE: rate-limit panes are already honestly handled by the pre-existing
  // detectQuotaExhaustion short-circuit at every tier (it runs BEFORE this
  // lift). The lift's incremental value is the WEDGE set (policy / context-wedge
  // / context-too-long), which quota does NOT catch and which today fall through
  // to "actively working". So these honest-reason tests use a wedge pane.
  it('flag ON, policy-wedge pane: surfaces the honest reason, NOT "actively working" — and Tier 2 is still scheduled', async () => {
    const { proxy, sent, stateDir } = mkProxy({ captureSessionOutput: () => POLICY_WEDGE });
    cleanup.push(stateDir);
    const schedSpy = vi.spyOn(proxy as any, 'scheduleTier');
    const state = seedState(proxy, 200);
    await (proxy as any).fireTier1(200, state);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/content-policy/i);
    expect(sent[0].text).not.toMatch(/actively working|is active but/i);
    // Scheduling is never gated — Tier 2 still fires on cadence.
    expect(schedSpy).toHaveBeenCalledWith(200, 2, expect.any(Number));
  });

  it('flag ON, stuck pane + recovery sentinel owns the voice: sends NOTHING this fire (silent-suppress, NOT "working") — Tier 2 still scheduled', async () => {
    const { proxy, sent, stateDir } = mkProxy({
      captureSessionOutput: () => POLICY_WEDGE,
      isStuckRecoveryActive: () => true,
    });
    cleanup.push(stateDir);
    const schedSpy = vi.spyOn(proxy as any, 'scheduleTier');
    const state = seedState(proxy, 201);
    await (proxy as any).fireTier1(201, state);

    expect(sent).toHaveLength(0); // one voice — and no "actively working" fallback
    expect(schedSpy).toHaveBeenCalledWith(201, 2, expect.any(Number));
  });

  it('flag ON, NOT stuck (normal working pane): falls through to the UNCHANGED fallback copy', async () => {
    const { proxy, sent, stateDir } = mkProxy({ captureSessionOutput: () => WORKING_PANE });
    cleanup.push(stateDir);
    const state = seedState(proxy, 202);
    await (proxy as any).fireTier1(202, state);

    expect(sent).toHaveLength(1);
    // LLM is null → catch → the EXACT pre-change Tier-1 fallback string.
    expect(sent[0].text).toContain('is actively working on something');
  });

  it('flag OFF (fleet default): a wedge pane STILL produces the byte-identical "actively working" copy', async () => {
    const { proxy, sent, stateDir } = mkProxy({
      captureSessionOutput: () => POLICY_WEDGE,
      standbyHonestyTiers: false,
    });
    cleanup.push(stateDir);
    const state = seedState(proxy, 203);
    await (proxy as any).fireTier1(203, state);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('is actively working on something');
    expect(sent[0].text).not.toMatch(/content-policy/i);
  });

  it('flag ON, no-leak: the emitted Tier-1 line is the verbatim classifier message — no seeded secret/path', async () => {
    // A wedge pane carrying a fake secret + absolute path in its scrollback.
    const LEAKY_WEDGE = [
      '❯ ANTHROPIC secret sk-test-DEADBEEFcafef00dbaadf00dDEADBEEF1234',
      '❯ /Users/justin/.instar/agents/echo/secrets/leak.env',
      ...POLICY_WEDGE.split('\n'),
    ].join('\n');
    const { proxy, sent, stateDir } = mkProxy({ captureSessionOutput: () => LEAKY_WEDGE });
    cleanup.push(stateDir);
    const state = seedState(proxy, 204);
    await (proxy as any).fireTier1(204, state);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/content-policy/i);
    expect(sent[0].text).not.toContain('DEADBEEF');
    expect(sent[0].text).not.toContain('/Users/justin');
    expect(sent[0].text).not.toContain('leak.env');
  });
});

describe('PresenceProxy standby honesty (Finding b) — Tier 2', () => {
  let cleanup: string[] = [];
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    for (const d of cleanup) {
      try {
        SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/PresenceProxy-standby-honesty.test.ts:cleanup' });
      } catch { /* ignore */ }
    }
    vi.restoreAllMocks();
  });

  // Wedge set only — rate-limit is intercepted by the pre-existing
  // detectQuotaExhaustion short-circuit before this lift (and that path
  // deliberately does NOT schedule Tier 3, which is pre-existing behavior).
  it.each([
    ['policy-wedge', POLICY_WEDGE, /content-policy/i],
    ['context-wedge', THINKING_WEDGE, /stuck-context/i],
    ['context-too-long', CONTEXT_TOO_LONG, /too long/i],
  ] as const)('flag ON, %s at Tier 2: honest "2-minute update" reason, NOT "is still working" — Tier 3 still scheduled', async (_kind, pane, expected) => {
    const { proxy, sent, stateDir } = mkProxy({ captureSessionOutput: () => pane });
    cleanup.push(stateDir);
    const schedSpy = vi.spyOn(proxy as any, 'scheduleTier');
    const state = seedState(proxy, 300, { tier1Fired: true });
    await (proxy as any).fireTier2(300, state);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/2-minute update/);
    expect(sent[0].text).toMatch(expected);
    expect(sent[0].text).not.toMatch(/is still working/i);
    expect(schedSpy).toHaveBeenCalledWith(300, 3, expect.any(Number));
  });

  it('flag ON, recovery sentinel owns the voice at Tier 2: NOTHING this fire, Tier 3 still scheduled', async () => {
    const { proxy, sent, stateDir } = mkProxy({
      captureSessionOutput: () => POLICY_WEDGE,
      isStuckRecoveryActive: () => true,
    });
    cleanup.push(stateDir);
    const schedSpy = vi.spyOn(proxy as any, 'scheduleTier');
    const state = seedState(proxy, 301, { tier1Fired: true });
    await (proxy as any).fireTier2(301, state);

    expect(sent).toHaveLength(0);
    expect(schedSpy).toHaveBeenCalledWith(301, 3, expect.any(Number));
  });

  it('flag OFF (fleet default): a wedge pane STILL produces the byte-identical "is still working" copy', async () => {
    const { proxy, sent, stateDir } = mkProxy({
      captureSessionOutput: () => POLICY_WEDGE,
      standbyHonestyTiers: false,
    });
    cleanup.push(stateDir);
    const state = seedState(proxy, 302, { tier1Fired: true });
    await (proxy as any).fireTier2(302, state);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/is still working/i);
    expect(sent[0].text).not.toMatch(/content-policy/i);
  });
});

describe('PresenceProxy standby honesty (Finding b) — server.ts wiring (dev-gate)', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const serverSrc = fs2.readFileSync(
    path2.join(process.cwd(), 'src/commands/server.ts'),
    'utf-8',
  );

  it('server.ts wires standbyHonestyTiers through resolveDevAgentGate into PresenceProxy', () => {
    expect(serverSrc).toContain('standbyHonestyTiers: resolveDevAgentGate(');
    const block = serverSrc.slice(serverSrc.indexOf('standbyHonestyTiers: resolveDevAgentGate('));
    expect(block.slice(0, 160)).toContain('monitoring?.standbyHonestyTiers?.enabled');
  });
});
