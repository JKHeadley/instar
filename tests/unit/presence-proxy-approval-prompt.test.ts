// safe-fs-allow: test file — tmpdir stateDir only.

/**
 * PresenceProxy — framework approval-prompt is NEVER surfaced to the user.
 *
 * Spec: docs/specs/framework-permission-prompt-robustness.md
 *
 * When the live pane is a framework approval MENU (glyph/❯-cursor-led numbered
 * option + a generic blocking affordance), `classifyStuckSignature` returns
 * `approval-prompt-waiting`. PresenceProxy suppresses that class UNCONDITIONALLY —
 * the PermissionPromptAutoResolver auto-clears the prompt, and a genuinely
 * un-clearable one raises a Terminal Attention defect (the sole surface). So the
 * standby NEVER posts a user-facing "still working" / "stuck" line for it.
 *
 * These tests pin BOTH ends of that contract:
 *   - the classifier labels the prompt `approval-prompt-waiting`;
 *   - PresenceProxy.fireTier1 / fireTier2 send NOTHING for such a pane (and do NOT
 *     fall through to the "actively working" copy).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import { classifyStuckSignature } from '../../src/monitoring/StuckSignatureClassifier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The real Claude Code Bash-classifier approval prompt at the genuine pane bottom.
const APPROVAL_PROMPT = [
  '⏺ Bash(cd /tmp && echo hi > out.txt)',
  'Compound command contains cd with output redirection — manual approval required',
  'to prevent path resolution bypass.',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No',
  '  Esc to cancel',
].join('\n');

interface Sent { topicId: number; text: string; opts?: any; }

function mkProxy(overrides: Record<string, unknown> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-approval-prompt-'));
  const sent: Sent[] = [];
  const config: any = {
    stateDir,
    intelligence: null, // force the deterministic (no-LLM) fallback path
    agentName: 'echo',
    getProcessTree: () => [{ command: 'claude', pid: 4242 }],
    isSessionAlive: () => true,
    getSessionForTopic: () => 'sess-1',
    captureSessionOutput: () => APPROVAL_PROMPT,
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
    userMessageText: 'are you still there?',
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

describe('classifyStuckSignature — approval-prompt-waiting', () => {
  it('labels a glyph-led approval menu with a blocking affordance as approval-prompt-waiting', () => {
    const stuck = classifyStuckSignature(APPROVAL_PROMPT);
    expect(stuck?.kind).toBe('approval-prompt-waiting');
  });
});

describe('PresenceProxy — approval-prompt is never surfaced', () => {
  let cleanup: string[] = [];
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    for (const d of cleanup) {
      try {
        SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/presence-proxy-approval-prompt.test.ts:cleanup' });
      } catch { /* ignore */ }
    }
    vi.restoreAllMocks();
  });

  it('Tier 1: an approval-prompt pane sends NOTHING (no "actively working" fall-through)', async () => {
    const { proxy, sent, stateDir } = mkProxy();
    cleanup.push(stateDir);
    const state = seedState(proxy, 400);
    await (proxy as any).fireTier1(400, state);

    expect(sent).toHaveLength(0);
  });

  it('Tier 2: an approval-prompt pane sends NOTHING (no "is still working" fall-through)', async () => {
    const { proxy, sent, stateDir } = mkProxy();
    cleanup.push(stateDir);
    const state = seedState(proxy, 401, { tier1Fired: true });
    await (proxy as any).fireTier2(401, state);

    expect(sent).toHaveLength(0);
  });
});
