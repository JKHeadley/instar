/**
 * Minimal real-orchestrator deps for route/E2E tests of the topic-profile
 * spawn path: the orchestrator is REAL; only the tmux/session surface is a
 * recording fake.
 */
import type {
  OrchestratorConfig,
  TopicProfileOrchestratorDeps,
} from '../../src/core/TopicProfileOrchestrator.js';
import type { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import type { ResolvedTopicProfile } from '../../src/core/TopicProfileResolver.js';

export interface OrchestratorRecorder {
  sessions: Map<string, string>;
  kills: string[];
  spawns: Array<{ topicKey: string; method: string; replacedSessionName?: string }>;
  disclosures: string[];
  audits: Array<Record<string, unknown>>;
}

export function makeOrchestratorDeps(opts: {
  store: TopicProfileStore;
  resolveProfile: (topicKey: string) => ResolvedTopicProfile;
  stateFilePath: string;
  rec: OrchestratorRecorder;
  cfg?: Partial<OrchestratorConfig>;
}): TopicProfileOrchestratorDeps {
  const { rec } = opts;
  return {
    store: opts.store,
    resolveProfile: opts.resolveProfile,
    sessions: {
      getSessionForTopic: (k) => (rec.sessions.has(k) ? { sessionName: rec.sessions.get(k)!, cwd: '/tmp' } : null),
      listTopicSessions: () => [...rec.sessions].map(([topicKey, sessionName]) => ({ topicKey, sessionName })),
      readIdle: () => 'confirmed-idle',
      killForResume: async (n) => { rec.kills.push(n); return true; },
      killFresh: async (n) => { rec.kills.push(n); return true; },
      spawn: async (topicKey, _resolved, directive) => {
        rec.spawns.push({ topicKey, method: directive.method, replacedSessionName: directive.replacedSessionName });
        return { ok: true };
      },
    },
    claudeResume: { ready: () => false, resumeId: () => null, park: () => {}, unpark: () => true },
    codexResume: { get: () => null, captureAtKill: async () => ({ outcome: 'none', candidateCount: 0 }), park: () => {}, unpark: () => true },
    escalation: { activeMarker: () => null, listMarkerTopics: () => [], clearMarkerAndReleaseLease: () => {} },
    inFlightSwap: { swap: async () => ({ status: 'noop' as const }) },
    autonomousActive: () => false,
    isProtectedSession: () => false,
    codexFence: () => null,
    verification: () => ({
      inFlightSwapConfirmedRecently: false,
      thinkingOffOnResumeVerified: false,
      thinkingLevelResumeVerified: false,
      crossModelResumeVerified: false,
      claudeThinkingControlAvailable: false,
    }),
    getConfig: () => ({
      enabled: true,
      dryRun: false,
      respawnDebounceMs: 20,
      frameworkSwitchDebounceMs: 40,
      maxConcurrentProfileRespawns: 2,
      spawnFailureBreakerThreshold: 3,
      switchNowConfirmTtlMs: 300_000,
      ...opts.cfg,
    }),
    disclose: (_t, text) => rec.disclosures.push(text),
    audit: (e) => rec.audits.push(e),
    stateFilePath: opts.stateFilePath,
  } as TopicProfileOrchestratorDeps;
}

export function newRecorder(): OrchestratorRecorder {
  return { sessions: new Map(), kills: [], spawns: [], disclosures: [], audits: [] };
}
