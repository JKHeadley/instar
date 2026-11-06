/**
 * Production wiring for the Skill Learning Sentinel (spec docs/specs/skill-learning-sentinel.md, slice 1).
 *
 * ONE expression for server.ts. `startServer` sits at TypeScript's control-flow-analysis limit (TS2563), so
 * the boot path may not grow by a single statement: this helper replaces the reconciler's `start()` call and
 * returns the sentinel (or null) so the server can bind it through its constructor options.
 *
 * Behaviour:
 *  - always starts the learned-skill reconciler (slice 0; its own kill switch is read live inside it);
 *  - when `monitoring.skillLearning.enabled` is true, builds the sentinel through `SkillLearningSentinel.create`
 *    over lazily-resolved seams (the judgment-provenance log and the topic-operator store are constructed later in
 *    boot; both are read through thin proxies so a missing log fails CLOSED — `recordDecision` → null — and a
 *    missing store answers "not operator");
 *  - never throws: a construction failure is logged + reported as a degradation and the feature stays dark.
 */
import { SKILL_LEARNING_DEFAULTS } from '../../config/ConfigDefaults.js';
import type { IntelligenceProvider } from '../../core/types.js';
import type { IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';
import type { SessionFramework } from '../../core/FrameworkSessionStore.js';
import type { DecisionRowInput } from '../../core/JudgmentProvenanceLog.js';
import type { SkillLearningConfig } from './types.js';
import type { SkillLearningSentinel, SkillLearningAttentionItem } from '../SkillLearningSentinel.js';

type ProvenanceLike = { recordDecision(input: DecisionRowInput): string | null; status(): { counters: Record<string, number> } };
type OperatorStoreLike = { asVerifiedOperator(topicId: number | string): { uid: string } | null };

export interface StartSkillLearningInput {
  reconciler: { start(): void };
  rawConfig: unknown;
  projectDir: string;
  stateDir: string;
  machineId: string;
  frameworks?: { enabled?: ReadonlyArray<IntelligenceFramework>; default?: IntelligenceFramework; overrides?: Record<string, IntelligenceFramework | undefined> };
  sharedIntelligence: IntelligenceProvider | null | undefined;
  topicMemory: { getMessagesSince(topicId: string | number, sinceIso: string, limit?: number): unknown } | null | undefined;
  /** Resolved lazily: the TelegramAdapter may not exist (no Telegram configured). */
  createAttentionItem?: (item: SkillLearningAttentionItem) => Promise<unknown> | unknown;
  slack?: { onMessageLogged: ((entry: never) => void) | null } | null;
  /** Lazy: the AgentServer (and its TopicOperatorStore) is constructed after this runs. */
  operatorStore: () => OperatorStoreLike | null | undefined;
  /** Lazy: JudgmentProvenanceLog is constructed later in boot. */
  provenance: () => ProvenanceLike | null | undefined;
  userManager?: { listUsers(): Array<{ permissions: string[]; channels: Array<{ type: string; identifier: string }> }> } | null;
  slackTopicId?: (channelId: string) => string;
  findSession?: (sessionName: string) => { claudeSessionId?: string; framework?: SessionFramework } | undefined;
  degradationReporter?: { report(event: { feature: string; primary: string; fallback: string; reason: string; impact: string }): void } | null;
  featureEvidence?: { record(featureId: string, input: never): string | null } | null;
  holdsLease?: () => boolean;
  logger?: (message: string) => void;
}

export function resolveSkillLearningConfig(raw: unknown): SkillLearningConfig {
  const cfg = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const monitoring = (cfg.monitoring && typeof cfg.monitoring === 'object') ? (cfg.monitoring as Record<string, unknown>) : {};
  const block = (monitoring.skillLearning && typeof monitoring.skillLearning === 'object') ? (monitoring.skillLearning as Record<string, unknown>) : {};
  const d = SKILL_LEARNING_DEFAULTS as unknown as SkillLearningConfig;
  const sub = <K extends keyof SkillLearningConfig>(k: K): SkillLearningConfig[K] => {
    const v = block[k as string];
    const base = d[k];
    if (base && typeof base === 'object' && v && typeof v === 'object') return { ...(base as object), ...(v as object) } as SkillLearningConfig[K];
    return (v === undefined ? base : v) as SkillLearningConfig[K];
  };
  return {
    enabled: block.enabled === true,
    mode: block.mode === 'live' ? 'live' : 'shadow',
    tickMinutes: typeof block.tickMinutes === 'number' ? block.tickMinutes : d.tickMinutes,
    floor: sub('floor'), defaultGate: sub('defaultGate'), shadow: sub('shadow'), growthSignals: sub('growthSignals'),
    evidence: sub('evidence'), retire: sub('retire'), review: sub('review'), llm: sub('llm'), reconcile: sub('reconcile'),
  };
}

/** Synchronous: the sentinel's own `start()` opens its ledger cache off the boot path. */
export function startSkillLearning(
  input: StartSkillLearningInput,
  create: (deps: Parameters<typeof SkillLearningSentinel.create>[0]) => SkillLearningSentinel,
): SkillLearningSentinel | null {
  const log = input.logger ?? (() => {});
  try { input.reconciler.start(); } catch (err) { log(`[skill-learning] reconciler start failed: ${err instanceof Error ? err.message : String(err)}`); }
  const config = resolveSkillLearningConfig(input.rawConfig);
  if (!config.enabled) return null;
  try {
    const sentinel = create({
      projectDir: input.projectDir,
      stateDir: input.stateDir,
      machineId: input.machineId,
      config,
      frameworks: input.frameworks,
      sharedIntelligence: input.sharedIntelligence ?? null,
      topicMemory: input.topicMemory ? { getMessagesSince: input.topicMemory.getMessagesSince.bind(input.topicMemory) as never } : null,
      slack: input.slack as never,
      topicOperatorStore: {
        asVerifiedOperator: (topicId) => {
          try { return input.operatorStore()?.asVerifiedOperator(topicId) ?? null; } catch { return null; } // @silent-fallback-ok — no store yet ⇒ not operator (conservative)
        },
      },
      userManager: input.userManager ?? null,
      slackTopicId: input.slackTopicId,
      findSession: input.findSession,
      provenanceLog: {
        // Fail CLOSED while the log is not constructed yet: a null id discards the verdict and the row stays pending.
        recordDecision: (row) => { try { return input.provenance()?.recordDecision(row) ?? null; } catch { return null; } }, // @silent-fallback-ok — null = not recorded
        status: () => { try { return input.provenance()?.status() ?? { counters: {} }; } catch { return { counters: {} }; } }, // @silent-fallback-ok
      },
      degradationReporter: input.degradationReporter ?? null,
      featureEvidence: input.featureEvidence as never,
      createAttentionItem: input.createAttentionItem,
      holdsLease: input.holdsLease,
      logger: log,
    } as Parameters<typeof SkillLearningSentinel.create>[0]);
    sentinel.start();
    log(`[skill-learning] sentinel started (mode=${config.mode}, tick=${config.tickMinutes}m)`);
    return sentinel;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[skill-learning] sentinel NOT started: ${reason}`);
    try {
      input.degradationReporter?.report({ feature: 'monitoring.skillLearning', primary: 'SkillLearningSentinel', fallback: 'dark (not constructed)', reason, impact: 'skill learning observes nothing on this machine until the next boot' });
    } catch { /* @silent-fallback-ok — reporting is best-effort */ }
    return null;
  }
}
