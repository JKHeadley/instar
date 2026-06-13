/**
 * WS5.3 (escalation-rides-topic) integration test — the cross-machine carry +
 * destination re-admit path, end to end against a MOCK governor.
 *
 * Spec: docs/specs/ws53-escalation-rides-topic.md.
 *
 * The flow under test:
 *   source EscalationHintStore.file(topic)              (the /pool/transfer source leg)
 *     → topic-profile pull serve-handler PEEKs the hint   (rides the acquire pull)
 *       → carrier apply-landing fires onEscalationHintLanded for the owned topic
 *         → re-admit driver calls ModelSwapService.swap(name,'escalated')
 *           → governor.admit() decides: ALLOW → escalated, REFUSE → default.
 *
 * Asserts (the named lenses, end to end):
 *  - a transfer payload carrying escalationHint + a mock governor ALLOW → the
 *    resumed session is swapped to the escalated tier.
 *  - the SAME payload + a mock governor REFUSE → the session stays default
 *    (the free-escalation-bypass invariant: no admit pass, no escalation).
 *  - a hint that lands while the topic is owned ELSEWHERE never fires the
 *    re-admit (ownership recheck guards actuation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TopicProfileTransferCarrier,
  createTopicProfilePullHandler,
  type TopicProfilePullEntry,
} from '../../src/core/TopicProfileTransferCarrier.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { EscalationHintStore } from '../../src/core/EscalationHintStore.js';
import { ModelSwapService, type ModelSwapServiceDeps } from '../../src/core/ModelSwapService.js';
import {
  DEFAULT_TIER_ESCALATION_CONFIG,
  normalizeTierEscalationConfig,
  type TierEscalationConfig,
} from '../../src/core/ModelTierEscalation.js';
import type { AdmitResult } from '../../src/core/EscalationGovernor.js';
import type { Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
const nowMs = Date.parse('2026-06-13T12:00:00Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ws53-int-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/escalation-rides-topic.test.ts' });
});

const TOPIC = '13481';
const SESSION = 'echo-topic-13481';

function cfg(): TierEscalationConfig {
  const c = normalizeTierEscalationConfig({ ...DEFAULT_TIER_ESCALATION_CONFIG, enabled: true, dryRun: false, ridesTopic: true });
  c.costGuards = { ...c.costGuards, requireQuotaHeadroom: false };
  return c;
}

const idleTail = 'bypass permissions on\n> \n';
const confirmTail = 'bypass permissions on\nset model to Fable 5 and saved as your default\n> \n';

/** A ModelSwapService driven by a mock governor verdict — the SAME service the
 *  re-admit driver uses. The session starts on the default tier. */
function swapService(admit: AdmitResult): { svc: ModelSwapService; getAdmitCalls: () => number; session: Session } {
  let admitCalls = 0;
  const session = {
    id: 'inst-dest-1',
    name: SESSION,
    tmuxSession: SESSION,
    framework: 'claude-code',
    model: 'claude-opus-4-8',
  } as unknown as Session;
  const captures = [idleTail, confirmTail, confirmTail];
  let i = 0;
  const deps: ModelSwapServiceDeps = {
    stateDir: dir,
    sessions: {
      listRunningSessions: () => [session],
      captureMeaningfulTail: () => captures[Math.min(i++, captures.length - 1)],
      sendInput: () => true,
    },
    saveSession: (s) => { (session as { model?: string }).model = s.model; },
    protectedSessions: () => [],
    getConfig: () => cfg(),
    governor: {
      admitEscalation: () => { admitCalls += 1; return admit; },
      recordInjection: () => true,
    },
    topicProfileConsult: () => ({ suppressEscalation: false, baselineModel: null }),
    canaryAttempts: 2,
    canaryIntervalMs: 0,
    wait: async () => {},
    now: () => nowMs,
  };
  return { svc: new ModelSwapService(deps), getAdmitCalls: () => admitCalls, session };
}

/** Build a carrier whose serve-handler carries the source's hint and whose
 *  landing drives `swap(SESSION,'escalated')`. ownerOf controls actuation. */
function carrierHarness(opts: {
  swap: ModelSwapService;
  owner: () => string | null;
}): { source: EscalationHintStore; pullOnce: () => Promise<void> } {
  const sourceHints = new EscalationHintStore({ filePath: path.join(dir, 'source-hints.json'), now: () => nowMs });
  const sourceStore = new TopicProfileStore({ stateFilePath: path.join(dir, 'src', 'topic-profiles.json') });
  // The serve handler the SOURCE machine answers with — peeks the source hint.
  const serve = createTopicProfilePullHandler({
    store: sourceStore,
    escalationHintPeek: (k) => sourceHints.peek(k),
  });
  const destStore = new TopicProfileStore({ stateFilePath: path.join(dir, 'dest', 'topic-profiles.json') });
  const driven: Array<{ topic: string; trigger: string }> = [];
  const carrier = new TopicProfileTransferCarrier({
    stateDir: path.join(dir, 'dest'),
    selfMachineId: 'dest',
    store: destStore,
    effectiveFramework: () => 'claude-code',
    ownerOf: () => ({ owner: opts.owner() }),
    sendPull: async (_peer, topics) => {
      const res = serve({ type: 'topic-profile-pull', topics });
      if (!res.ok) return { kind: 'unreachable', detail: res.reason };
      return { kind: 'ok', entries: res.entries as TopicProfilePullEntry[] };
    },
    onEscalationHintLanded: (topicKey, hint) => {
      driven.push({ topic: String(topicKey), trigger: hint.trigger });
      // The real driver gates on config + resolves the session; here we drive
      // the SAME swap() the production driver calls.
      void opts.swap.swap(SESSION, 'escalated');
    },
    now: () => new Date(nowMs),
  });
  return {
    source: sourceHints,
    pullOnce: async () => {
      carrier.onTopicAcquired(TOPIC, 'laptop'); // acquire from the source peer
      await carrier.flushStaged();
    },
  };
}

describe('WS5.3 escalation rides the topic (integration)', () => {
  it('ALLOW: a transferred escalated topic re-admits and swaps to the escalated tier', async () => {
    const swap = swapService({ allow: true });
    const h = carrierHarness({ swap: swap.svc, owner: () => 'dest' });
    // Source filed a hint when the escalated topic moved.
    h.source.file(TOPIC, { trigger: 'build', sourceTier: 'escalated', sourceMachineId: 'laptop' });
    await h.pullOnce();
    // The re-admit ran through the governor and swapped.
    expect(swap.getAdmitCalls()).toBe(1);
    expect((swap.session as { model?: string }).model).toBe('claude-fable-5');
  });

  it('REFUSE (bypass invariant): a refusing governor leaves the session on the default tier', async () => {
    const swap = swapService({ allow: false, reason: 'lease-capacity' });
    const h = carrierHarness({ swap: swap.svc, owner: () => 'dest' });
    h.source.file(TOPIC, { trigger: 'build', sourceTier: 'escalated' });
    await h.pullOnce();
    // The guard WAS consulted (no bypass path) and REFUSED → default tier.
    expect(swap.getAdmitCalls()).toBe(1);
    expect((swap.session as { model?: string }).model).toBe('claude-opus-4-8');
  });

  it('a hint landing while the topic is owned ELSEWHERE never fires the re-admit', async () => {
    const swap = swapService({ allow: true });
    // Ownership moved away (re-transferred) before the pull landed.
    const h = carrierHarness({ swap: swap.svc, owner: () => 'someone-else' });
    h.source.file(TOPIC, { trigger: 'build', sourceTier: 'escalated' });
    await h.pullOnce();
    // The ownership recheck skipped the landing → no re-admit, no governor call.
    expect(swap.getAdmitCalls()).toBe(0);
    expect((swap.session as { model?: string }).model).toBe('claude-opus-4-8');
  });

  it('no hint on the source → no re-admit (a non-escalated move is a no-op)', async () => {
    const swap = swapService({ allow: true });
    const h = carrierHarness({ swap: swap.svc, owner: () => 'dest' });
    // No source.file() — the moved topic was never escalated.
    await h.pullOnce();
    expect(swap.getAdmitCalls()).toBe(0);
    expect((swap.session as { model?: string }).model).toBe('claude-opus-4-8');
  });
});
