import { JevFirstDecision, createJevAsk, type JevFirstDeps, type JevPoint } from './JevFirstDecision.js';
import { SecretStore } from './SecretStore.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { getFeatureMetricsRecorder } from './CircuitBreakingIntelligenceProvider.js';
import type { JudgmentProvenanceLog } from './JudgmentProvenanceLog.js';

/** One production factory, shared by server boot and lifecycle tests. */
export function buildCommitmentJevFirst(input: {
  stateDir: string;
  forceFileKey?: boolean;
  developmentAgent?: boolean;
  readConfig: () => { enabled?: boolean; stage?: 'off' | 'shadow' | 'live' } | undefined;
  provenance: () => JudgmentProvenanceLog | null | undefined;
  /** Test seams; production uses the vault and pinned TypeSafe transport. */
  readKey?: () => string | null;
  askJev?: JevFirstDeps['askJev'];
}): { gateway: JevFirstDecision; getPoint: () => JevPoint } {
  const gateway = new JevFirstDecision({
    readKey: input.readKey ?? (() => {
      try {
        const key = new SecretStore({ stateDir: input.stateDir, forceFileKey: input.forceFileKey }).get('typesafe_api_key');
        return typeof key === 'string' && key ? key : null;
      } catch { return null; }
    }),
    askJev: input.askJev ?? createJevAsk(),
    recordDecision: (row) => input.provenance()?.recordDecisionFlushed(row) ?? null,
    onJevCall: (pointId, answer) => {
      getFeatureMetricsRecorder()?.record({
        feature: `jev-first-jev:${pointId}`, kind: 'llm', outcome: answer ? 'unclassified' : 'error',
        ...(answer?.tokensIn !== undefined ? { tokensIn: answer.tokensIn } : {}),
        ...(answer ? { latencyMs: answer.ms, model: answer.model } : {}), framework: 'typesafe-api',
      });
    },
    onOutcome: (pointId, reason, source, auditDisagree) => {
      getFeatureMetricsRecorder()?.record({ feature: `jev-first:${pointId}`, kind: 'event',
        outcome: source === 'jev' ? 'fired' : 'noop', verdictId: reason });
      if (auditDisagree !== null) getFeatureMetricsRecorder()?.record({
        feature: `jev-first-audit:${pointId}`, kind: 'event',
        outcome: auditDisagree ? 'fired' : 'noop', verdictId: reason,
      });
    },
  });
  const getPoint = (): JevPoint => {
    const cfg = input.readConfig();
    const enabled = resolveDevAgentGate(cfg?.enabled, { developmentAgent: input.developmentAgent });
    // The held-out commitment replay missed its precision bar. Keep this
    // caller shadow-only even if a live stage is requested in config. A later
    // promotion must change this code after the batch-level bar passes.
    const requestedStage = cfg?.stage ?? 'shadow';
    const stage = enabled ? (requestedStage === 'live' ? 'shadow' : requestedStage) : 'off';
    return {
      id: 'commitment-detect', promptId: 'commitment-batch-v1',
      question: 'Does at least one exchange show the user asking for a durable action, setting, or ongoing behavior change AND the agent explicitly agreeing to do it? A question, status update, informational answer, or bare approval is not a commitment.',
      stage,
      band: { noMax: 0.2, yesMin: 0.8 }, settleOnly: 'no',
      model: 'jev-1.13.0', timeoutMs: 1_500, maxStateBytes: 8_000,
      auditRate: 0.05, fallbackSelection: 'incumbent-no-benchmark',
    };
  };
  return { gateway, getPoint };
}
