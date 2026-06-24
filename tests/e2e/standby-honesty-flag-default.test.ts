// safe-fs-allow: test file — tmpdir stateDir only.
/**
 * Tier 3 (E2E "the flag is alive / correctly dark") for
 * honest-session-state-surfaces Finding (b).
 *
 * The feature adds NO routes (it is a signal-only standby WORDING change), so
 * "feature is alive" means: against the REAL ConfigDefaults + the SAME gate
 * expression server.ts uses to construct PresenceProxy
 * (resolveDevAgentGate(config.monitoring?.standbyHonestyTiers?.enabled, config)),
 *   1. a fleet agent (developmentAgent:false, defaults OMIT the flag) resolves
 *      FALSE → Tier 1/2 copy is byte-identical to today; and
 *   2. a dev agent (developmentAgent:true) resolves TRUE → the lift is live.
 *
 * Plus the wiring-integrity proof: the resolved flag actually THREADS into the
 * maybeStuckMessage decision — the ON path reaches classifyStuckSignature and
 * emits the honest message; the OFF path is a strict no-op (no honest override).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** Build the config a real agent would run with: REAL defaults applied. */
function buildAgentConfig(developmentAgent: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent, projectName: 't' };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

/** The EXACT expression server.ts uses to construct PresenceProxy. */
function resolveFlagLikeServer(config: Record<string, unknown>): boolean {
  return resolveDevAgentGate(
    (config as { monitoring?: { standbyHonestyTiers?: { enabled?: boolean } } }).monitoring?.standbyHonestyTiers?.enabled,
    config as { developmentAgent?: boolean },
  );
}

const POLICY_WEDGE = [
  '❯ msg one',
  '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).',
  '✻ Churned for 8s',
  '❯ msg two',
  '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).',
  '✻ Cogitated for 8s',
].join('\n');

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/standby-honesty-flag-default.test.ts:cleanup' }); } catch { /* ignore */ }
  }
});

function mkProxyWithFlag(flag: boolean) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-flag-'));
  cleanup.push(stateDir);
  const sent: string[] = [];
  const proxy = new PresenceProxy({
    stateDir,
    intelligence: null as any,
    agentName: 'echo',
    getProcessTree: () => [{ command: 'claude', pid: 1 }],
    isSessionAlive: () => true,
    getSessionForTopic: () => 'sess-1',
    captureSessionOutput: () => POLICY_WEDGE,
    sendMessage: async (_t: number, text: string) => { sent.push(text); },
    getAuthorizedUserIds: () => [],
    standbyHonestyTiers: flag,
  } as any);
  proxy.start();
  return { proxy, sent };
}

function seed(proxy: any, topicId: number) {
  const state = {
    topicId, sessionName: 'sess-1',
    userMessageAt: Date.now() - 5_000, userMessageText: 'hi',
    userMessageBaselineSnapshot: null,
    tier1FiredAt: null, tier1Snapshot: null, tier1SnapshotHash: null,
    tier2FiredAt: null, tier2Snapshot: null, tier2SnapshotHash: null,
    tier3FiredAt: null, tier3Assessment: null, tier3Summary: null, tier3RecheckCount: 0,
    silencedUntil: null, cancelled: false, llmCallCount: 0, lastLlmCallAt: 0,
    conversationHistory: [], lastAckText: null, lastAckAt: null,
  };
  (proxy as any).states.set(topicId, state);
  return state;
}

describe('standby honesty flag default (Finding b) — dev-gate resolution', () => {
  it('fleet agent (defaults omit the flag) resolves FALSE', () => {
    expect(resolveFlagLikeServer(buildAgentConfig(false))).toBe(false);
  });

  it('development agent resolves TRUE', () => {
    expect(resolveFlagLikeServer(buildAgentConfig(true))).toBe(true);
  });
});

describe('standby honesty flag wiring-integrity (Finding b)', () => {
  it('resolved-TRUE flag threads into maybeStuckMessage → classifyStuckSignature → honest send', async () => {
    expect(resolveFlagLikeServer(buildAgentConfig(true))).toBe(true);
    const { proxy, sent } = mkProxyWithFlag(true);
    await (proxy as any).fireTier1(800, seed(proxy, 800));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/content-policy/i); // reached classifyStuckSignature
    expect(sent[0]).not.toMatch(/actively working/i);
  });

  it('resolved-FALSE flag is a strict no-op — Tier 1 copy byte-identical to today', async () => {
    expect(resolveFlagLikeServer(buildAgentConfig(false))).toBe(false);
    const { proxy, sent } = mkProxyWithFlag(false);
    await (proxy as any).fireTier1(801, seed(proxy, 801));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('is actively working on something');
    expect(sent[0]).not.toMatch(/content-policy/i);
  });
});
