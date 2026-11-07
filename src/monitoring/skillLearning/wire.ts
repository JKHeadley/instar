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
 *
 * Slice 2 (commit protocol): ALWAYS builds the WriterFence + VersionStore + CommitProtocol (recovery of a
 * dangling prepare must run even when the sentinel is off) and starts `recoverOwnJournal()` BEFORE the
 * reconciler's tick; the reconciler's boot gate (`holdUntilReleased`) is released when that recovery
 * settles, so the server's boot pass — which now sits AFTER this expression — always runs after recovery.
 * The protocol, the version store and the fence are handed to the sentinel through `create()`.
 */
import { SKILL_LEARNING_DEFAULTS } from '../../config/ConfigDefaults.js';
import type { IntelligenceProvider } from '../../core/types.js';
import type { IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';
import type { SessionFramework } from '../../core/FrameworkSessionStore.js';
import type { DecisionRowInput } from '../../core/JudgmentProvenanceLog.js';
import type { SkillLearningConfig } from './types.js';
import type { SkillLearningSentinel, SkillLearningAttentionItem } from '../SkillLearningSentinel.js';
import type { PreflightResult, RenderSkillOutcome } from '../LearnedSkillReconciler.js';
import { WriterFence, type WriterFenceDeps } from './WriterFence.js';
import { VersionStore } from './VersionStore.js';
import { CommitProtocol } from './CommitProtocol.js';
import { Retirer } from './Retirer.js';

/** What the commit protocol needs from the reconciler (LearnedSkillReconciler satisfies it). */
export interface ReconcilerForCommit {
  start(): void;
  preflight(name: string): Promise<PreflightResult>;
  renderSkill(name: string, txId: string): Promise<RenderSkillOutcome>;
  /** Idempotent; releases the boot gate when the reconciler was constructed with `holdUntilReleased`. */
  releaseBootGate?(): void;
  /** Slice 3B: bind the Retirer whose archive sweep runs first in every reconcile pass (under the reconciler's mutex). */
  setRetirer?(retirer: { reconcileRetiredRenderings(): ReturnType<Retirer['reconcileRetiredRenderings']> } | null): void;
  /** Slice 3B: drop the baselines of renderings the Retirer archived outside a pass. */
  forgetRenderings?(rels: string[]): Promise<void>;
}

export type FenceInput = Pick<WriterFenceDeps, 'hasCoordinator' | 'holdsLease' | 'currentEpoch' | 'leaseMediumLocal' | 'pullRebase' | 'hasRemote' | 'isGitRepo'>;

/** A non-mesh agent: sole writer, `fence: local`, epoch 0 (deviation (v)). */
export const SOLE_WRITER_FENCE: FenceInput = {
  hasCoordinator: () => false,
  holdsLease: () => true,
  currentEpoch: () => 0,
  pullRebase: () => null,
  hasRemote: () => null,
  isGitRepo: () => false,
};

export interface CommitStack {
  fence: WriterFence;
  versions: VersionStore;
  protocol: CommitProtocol;
}

/** Build the commit stack over a reconciler (production and tests share this). */
export function buildCommitStack(input: {
  projectDir: string;
  stateDir: string;
  machineId: string;
  reconciler: Pick<ReconcilerForCommit, 'preflight' | 'renderSkill'>;
  fence?: FenceInput;
  degradationReporter?: WriterFenceDeps['degradation'];
  logger?: (message: string) => void;
  now?: () => number;
}): CommitStack {
  const fence = new WriterFence({ ...(input.fence ?? SOLE_WRITER_FENCE), degradation: input.degradationReporter ?? null, logger: input.logger, now: input.now });
  const versions = new VersionStore({ stateDir: input.stateDir, machineId: input.machineId, now: input.now });
  const protocol = new CommitProtocol({ projectDir: input.projectDir, stateDir: input.stateDir, machineId: input.machineId, fence, versions, reconciler: input.reconciler, logger: input.logger, now: input.now });
  return { fence, versions, protocol };
}

type ProvenanceLike = { recordDecision(input: DecisionRowInput): string | null; status(): { counters: Record<string, number> } };
type OperatorStoreLike = { asVerifiedOperator(topicId: number | string): { uid: string } | null };

export interface StartSkillLearningInput {
  reconciler: ReconcilerForCommit;
  /** WriterFence inputs from the server (lease coordinator, git-sync, remote check). Absent = sole writer. */
  fence?: FenceInput;
  rawConfig: unknown;
  projectDir: string;
  stateDir: string;
  machineId: string;
  frameworks?: { enabled?: ReadonlyArray<IntelligenceFramework>; default?: IntelligenceFramework; overrides?: Record<string, IntelligenceFramework | undefined> };
  sharedIntelligence: IntelligenceProvider | null | undefined;
  topicMemory: { getMessagesSince(topicId: string | number, sinceIso: string, limit?: number): unknown } | null | undefined;
  /** Resolved lazily: the TelegramAdapter may not exist (no Telegram configured). */
  createAttentionItem?: (item: SkillLearningAttentionItem) => Promise<unknown> | unknown;
  /** Slice 3: cause-clear for attention items (TelegramAdapter.clearAttentionCondition with {reconcile:true}). */
  clearAttentionCondition?: (sel: { conditionKey: string }, reason: string, opts: { reconcile: true }) => unknown;
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
  /** Lazy: the MaturationLadderService lives on the AgentServer, constructed after this runs. The sentinel reads rung 2 of `monitoring.skillLearning` from it. */
  ladder?: () => { features(): ReadonlyArray<{ id: string; rung: string; next: string | null; state: string }> } | null | undefined;
  /** Slice 3B (deviation (ii)): `EvolutionManager.addLearning` on the holder — a retire for harm posts one learning. */
  addLearning?: ((learning: { title: string; category: string; description: string; source: { agent: string; platform: string; contentId?: string; discoveredAt: string }; tags: string[] }) => unknown) | null;
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
  // The commit stack exists on every machine (recovery and reads run everywhere; the fence decides writes).
  let stack: CommitStack | null = null;
  try {
    stack = buildCommitStack({ projectDir: input.projectDir, stateDir: input.stateDir, machineId: input.machineId, reconciler: input.reconciler, fence: input.fence, degradationReporter: input.degradationReporter ?? null, logger: log });
  } catch (err) {
    log(`[skill-learning] commit protocol NOT built: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Recovery of this machine's own journal precedes every reconcile pass: the reconciler's boot gate
  // releases only when it settles (success or failure — a stuck gate would silence every render).
  const recovery = stack
    ? stack.protocol.recoverOwnJournal().then(
        (r) => { if (r.finished || r.voided || r.locked || r.foreignDangling || r.deferred) log(`[skill-learning] commit journal recovered: ${r.finished} finished, ${r.voided} voided, ${r.locked} locked, ${r.deferred} deferred, ${r.foreignDangling} foreign`); },
        (err: unknown) => { log(`[skill-learning] commit journal recovery failed: ${err instanceof Error ? err.message : String(err)}`); },
      )
    : Promise.resolve();
  void recovery.finally(() => { try { input.reconciler.releaseBootGate?.(); } catch { /* @silent-fallback-ok — a reconciler without a gate has nothing to release */ } });
  const config = resolveSkillLearningConfig(input.rawConfig);
  // Slice 3B (§3.8): the Retirer exists on EVERY machine (its archive sweep runs inside the reconciler whether or
  // not the sentinel is on — a retired skill pulled by sync must leave this machine's discovery too); the holder-side
  // judgment and the taps need the sentinel, which binds the reviewer fns into it below.
  let retirer: Retirer | null = null;
  try {
    retirer = new Retirer({
      projectDir: input.projectDir, stateDir: input.stateDir, machineId: input.machineId, config,
      commitProtocol: stack?.protocol ?? null, versions: stack?.versions ?? null,
      addLearning: input.addLearning ?? null,
      forgetRenderings: (rels) => input.reconciler.forgetRenderings?.(rels),
      logger: log,
    });
    input.reconciler.setRetirer?.(retirer);
  } catch (err) {
    log(`[skill-learning] retirer NOT built: ${err instanceof Error ? err.message : String(err)}`);
  }
  try { input.reconciler.start(); } catch (err) { log(`[skill-learning] reconciler start failed: ${err instanceof Error ? err.message : String(err)}`); }
  if (!config.enabled) return null;
  try {
    const sentinel = create({
      commitProtocol: stack?.protocol ?? null,
      versionStore: stack?.versions ?? null,
      writerFence: stack?.fence ?? null,
      reconciler: input.reconciler,
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
      clearAttentionCondition: input.clearAttentionCondition,
      holdsLease: input.holdsLease,
      // Read through a thin proxy: a ladder not constructed yet answers no features ⇒ rung 2 unproven (pending, the conservative side).
      ladder: input.ladder ? { features: () => { try { return input.ladder?.()?.features() ?? []; } catch { return []; } } } : null, // @silent-fallback-ok — an unreadable ladder reads as unproven
      retirer,
      harmRetired: () => retirer?.harmRetired() ?? [],
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
