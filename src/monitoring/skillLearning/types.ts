/**
 * Shared contract for the Skill Learning Sentinel (spec: docs/specs/skill-learning-sentinel.md, slice 1).
 *
 * Three builders (ledger/classifier, floor/drafter, routes/console) code against THIS file so their halves
 * meet. Add fields here rather than inventing parallel shapes; keep every field documented with the spec section
 * it serves.
 */

export type SkillLearningMode = 'shadow' | 'live';

/** §3 config block (`monitoring.skillLearning`). Defaults live in src/config/ConfigDefaults.ts (slice 0). */
export interface SkillLearningConfig {
  enabled: boolean;
  mode: SkillLearningMode;
  tickMinutes: number;
  floor: { minOccurrences: number; minCorroboratedCleanRuns: number };
  defaultGate: { minSupport: number; minDistinctDays: number; minDistinctSessions: number; windowDays: number };
  shadow: { minDisagreementsSampled: number; verdictReaskDays: number };
  growthSignals: { createdPerWeekNotice: number };
  evidence: { runSliceBytesPerRun: number; promptBudgetBytes: number; transcriptScanBytes: number };
  retire: { minCorroboratedRuns: number; defaultScoreFloor: number; defaultMisfireFloor: number; defaultUnusedDays: number; measurableFloor: number };
  review: { requireDifferentFamily: boolean; minCorrectedRunsSameFamily: number; revertBreakerPer30d: number };
  llm: { maxDailyCents: number; batchSize: number };
  reconcile: { enabled: boolean };
}

export type Identity = 'verified' | 'asserted' | 'unverified-catchup';
export type RowState = 'pending' | 'classified' | 'needs-full';
export type OutcomeLabel = 'corrected' | 'redo' | 'accepted' | 'accepted-inferred' | 'weak-positive' | 'unknown';
/** Deterministic conflict reducer order (§3.6): earlier wins. */
export const OUTCOME_PRECEDENCE: readonly OutcomeLabel[] = ['corrected', 'redo', 'accepted', 'accepted-inferred', 'weak-positive', 'unknown'];
export type DropReason = 'not-user' | 'forwarded' | 'not-operator' | 'confirmation-reply';

/** Where an observed message came from; the dedupe key for request rows. */
export interface RowSource { channel: 'telegram' | 'slack'; chatId: string; messageId: string }

/** One ledger row (§3.2). Segments are append-only per machine; rows are never rewritten — a later row revises. */
export interface RequestRow {
  kind: 'request';
  eventId: string;
  source: RowSource;
  topicId: string;
  sessionName?: string;
  at: string;                 // ISO
  channel: 'telegram' | 'slack';
  identity: Identity;
  detectorCategory?: string;  // HumanAsDetectorLog category, when any
  state: RowState;
  /** Set by the classifier; absent while pending. */
  procedureKey?: string;
  paraphrase?: string;
  repeatable?: boolean;
  runId?: string;
  /** ISO: a pending/needs-full row the classifier must not pick up before this (the unreadable-text hold, §3.1); absent = now. */
  retryAfter?: string;
  machineId: string;
}

export interface OutcomeRow {
  kind: 'outcome';
  eventId: string;
  runId: string;
  revision: number;
  procedureKey: string;
  topicId: string;
  sessionName?: string;
  label: OutcomeLabel;
  provisional: boolean;
  /** Join to slice-0 telemetry (§3.9). */
  skillUsed?: {
    skill: string;
    contentHash: string;
    corroborated: boolean;
    versionUncertain: boolean;
    /** Slice 2 (§3.9 join hardening): the version row the stamp resolved to, when the VersionStore knows it. */
    version?: number;
    /** `unknown` = no stamp on the rendering; `unmatched` = a stamp no version row carries (an edited or foreign body). */
    stamp?: 'version' | 'unknown' | 'unmatched';
    /** The telemetry machine's baseline shard held a `conflicts[renderingRel]` for this skill: the operator edited the rendering. Excluded from every version score, reported separately. */
    operatorEdited?: boolean;
  };
  misfire?: boolean;
  windowStart: string;
  windowEnd?: string;
  /** The operator message that closed the window (§3.6), when one did — the classifier attributes
   *  `outcomeOfPrevRun` for that message back to this run through it (durable across restarts). */
  closedBy?: RowSource;
  /** Set by the §3.6 reducer when two rows for one (runId, revision) disagreed; the higher-ranked label is kept. */
  conflict?: boolean;
  at: string;
  machineId: string;
}

export interface VerdictRow {
  kind: 'verdict';
  eventId: string;
  procedureKey: string;
  by: 'default-rung' | 'arbiter' | 'operator';
  verdict: 'draft' | 'wait' | 'never' | 'agree' | 'disagree';
  reason?: string;
  expiresAt?: string;         // arbiter verdicts: re-ask horizon (§3.4)
  at: string;
  machineId: string;
}

/**
 * A review-triggering event (§3.6 "a flip reaches the skill"): appended when a late correction flips a
 * provisional run, or when a reviewer pass is requested. Slice 3 consumes; slice 1 only writes `improve`.
 */
export interface EventRow {
  kind: 'event';
  eventId: string;
  /**
   * `improve` / `reviewer` — a reviewer pass is requested (slice 1/2). Slice 3A adds the bounded-revert signals the
   * attention module (3C) consumes: `revert-refused` (N+1 was left `pending`, item 1) and `revert-breaker`
   * (`review.revertBreakerPer30d` reverts on one key ⇒ locked, item 5).
   */
  event: 'improve' | 'reviewer' | 'revert-refused' | 'revert-breaker';
  runId: string;
  procedureKey: string;
  /** The learned skill the flipped run used, when the §3.9 join saw one. */
  skill?: string;
  reason?: string;
  at: string;
  machineId: string;
}

export type LedgerRow = RequestRow | OutcomeRow | VerdictRow | EventRow;

/** Read side of the ledger, as the floor/drafter and the routes consume it. 1A implements; 1B/1C consume. */
export interface LedgerReader {
  /** All request rows for a key, newest first, bounded (cache keeps ≤200 per key). */
  requestsForKey(procedureKey: string): RequestRow[];
  /** Reduced outcome per run (latest revision, precedence-reduced on conflict). */
  outcomesForKey(procedureKey: string): OutcomeRow[];
  /** Latest unexpired verdict per author, if any. */
  verdictsForKey(procedureKey: string): VerdictRow[];
  /** Every key with ≥1 classified request, with counts. */
  keys(): Array<{ procedureKey: string; requests: number; verifiedRequests: number; lastAt: string }>;
  pendingCount(): number;
  /** Review events for a key (`improve` flips, reviewer requests), newest first. Slice 3 consumes. */
  eventsForKey(procedureKey: string): EventRow[];
}

export interface LedgerWriter {
  append(row: LedgerRow): void;        // fsync'd append to this machine's current segment
}

/** The status snapshot `GET /skills/learned` returns (§3.10). 1B's sentinel produces; 1C's route serializes. */
export interface SkillLearningStatus {
  machine: string;
  enabled: boolean;
  mode: SkillLearningMode;
  counts: { requests: number; verified: number; keys: number; proposals: number; skills: number };
  channels: { telegram: 'measured' | 'unmeasurable'; slack: 'support-only' | 'unmeasurable'; app: 'unmeasurable' };
  pendingBacklog: number;
  classifierFailures24h: number;
  abortedUnreachable24h: number;
  filtered: Record<DropReason | 'slack-asserted', number>;
  skills: LearnedSkillSummary[];
  proposals: ProposalSummary[];
  pending: PendingSummary[];   // slice 2 (commit protocol)
  /** Slice 3 (§3.8): canonicals under `skill-learning/retired/<name>/`, with the renderings each machine archived. */
  retired: RetiredSummary[];
  /** Slice 3 (§3.8): a locked (`operator-owned`) learned canonical whose rendering is STILL on this machine — listed until the tick archives it. */
  lockLeftRendering?: Array<{ name: string; layouts: string[]; state?: string }>;
  /** Slice 3 (§3.8): a retired skill whose rendering this machine could not archive (the skill is reported active, never silently gone). */
  retireBlocked?: Array<{ name: string; layout: string; reason: string }>;
  /** Slice 3: the last `retire-all` tap on this machine and the date its hold is reviewed (drafting pauses until then). */
  retireAll?: { at: string; actor: string; reArmReviewAt: string; retired: number } | null;
  lastTickAt?: string;
  llmSpendCentsToday?: number;
  /** True on a machine that does not hold the operator-messaging lease: it observes, never drafts or finalizes (§3.2 single writer). */
  observeOnly?: boolean;
  /** Messages that reached a seam link while no filter was installed (SeamFilter.skillLearningUnlinkedMessages) — visible, never silent. */
  unlinkedMessages?: number;
  /** Slice 2, post-sync epoch reconciliation on this machine (durable counts): lower-epoch bodies demoted to proposals, and equal-epoch splits locked. */
  epochSuperseded?: number;
  splitBrain?: number;
}

export interface LearnedSkillSummary {
  name: string;
  state: 'proposal' | 'learned' | 'locked' | 'retired';
  score: number | null;
  uses: number;
  accepted: number;
  acceptedInferred: number;
  corrected: number;
  unknown: number;
  weakPositive: number;
  measurableRate: number | null;
  misfires: number;
  version: number;
  /** The CURRENT version row's reviewer family (`same-as-author` marks a same-family-held patch, §3.7). */
  reviewerFamily?: string;
  lastUsedAt?: string;
  locked: boolean;
  /** Uses whose rendering the operator had edited (baseline conflict): counted here, EXCLUDED from every score above (slice 2, §3.9). */
  operatorEdited: number;
  /** The 7-day "new" label (§3.5): an `active` skill created/confirmed inside the last 7 days, computed at read time. */
  isNew: boolean;
  /** Slice 3A: uses of a version reviewed `same-as-author` (§3.7 hold) — counted here, EXCLUDED from the score/accepted/corrected fields above (the rung-2 metric). */
  sameFamilyExcluded?: number;
  /** Slice 3B (§3.8): a RETIRED skill whose rendering this machine could not archive — reported active here, never silently gone. */
  retireBlocked?: boolean;
  /** Slice 3A: the version rows (every machine, tombstones folded) with per-version scores — on the by-name read (`GET /skills/learned/:name`). */
  versions?: LearnedVersionSummary[];
}

/** Slice 3A (§3.7): one version row as `GET /skills/learned/:name` lists it, with its §3.6 per-version score. */
export interface LearnedVersionSummary {
  version: number;
  txId: string;
  fileHash: string;
  bodyHash: string;
  epoch: number;
  at: string;
  op: string;
  state: LearnedCanonicalState;
  machineId: string;
  authorFamily?: string;
  reviewerFamily?: string;
  /** On a `revert` row: hash(N+1), the body the revert rejected. */
  rejectedBodyHash?: string;
  /** The correction event ids a patch's hunks answered (§3.7 "which correction it answers"). */
  citedCorrections: string[];
  /** On a `revert` row: the txId of the rejected version row. */
  revertOf?: string;
  /** On a `revert` row: the counts the trigger saw — corrected / corroborated runs on N+1, and N's corrected rate. */
  uncertainty?: { nCorrected: number; nRuns: number; prevRate: number | null };
  void: boolean;
  superseded: boolean;
  /** §3.6 per-version counts (uses of THIS body: `skillUsed.contentHash` = the body hash; operator-edited and version-uncertain uses excluded). */
  uses: number;
  accepted: number;
  acceptedInferred: number;
  corrected: number;
  score: number | null;
}

export interface ProposalSummary {
  name: string;
  key: string;
  arbiterOnly: boolean;
  createdAt: string;
  reviewerFamily?: string;
  /** `superseded` / `split-brain`: a body the post-sync epoch reconciliation (deviation (t)) demoted to a proposal (slice 2). */
  pendingReason?: 'one-family' | 'superseded' | 'split-brain';
  /** Shadow comparison label (§3.4): which rung alone would have drafted; null = both agreed. */
  disagreement?: 'arbiter-only' | 'default-only' | null;
  verdict?: { by: 'operator'; verdict: 'agree' | 'disagree'; reason?: string; at: string };
  paraphrases: string[];
  description: string;
}

/** `proposal.json` sidecar next to a proposal's SKILL.md (§3.5). */
export interface ProposalSidecar {
  name: string;
  key: string;
  arbiterOnly: boolean;
  reviewerFamily?: string;
  pendingReason?: 'one-family' | 'superseded' | 'split-brain';
  createdAt: string;
  evidence: { sources: RowSource[]; runIds: string[] };
  draftKind: 'new' | 'patch' | 'covered-by';
  description: string;
  paraphrases: string[];
  /** Shadow comparison label (§3.4): 'arbiter-only' (default would wait), 'default-only' (arbiter said wait/never), null = agreed. `arbiterOnly` === (disagreement === 'arbiter-only'). */
  disagreement?: 'arbiter-only' | 'default-only' | null;
  /** The operator's shadow tap (§3.4), written by `recordOperatorVerdict`; mirrored on ProposalSummary. */
  verdict?: { by: 'operator'; verdict: 'agree' | 'disagree'; reason?: string; at: string };
}

/** A skill waiting for the operator's confirm/reject tap (§3.5 `pending` canonical state; slice 2). */
export interface PendingSummary {
  name: string;
  description: string;
  paraphrases: string[];
  reviewerFamily?: string;
  /** Slice 3A adds `same-family` (a §3.7 patch held for the operator's tap) and `revert-refused` (N+1 left pending because its rollback failed validation). */
  pendingReason?: 'one-family' | 'rung-unproven' | 'same-family' | 'revert-refused' | 'restored';
  /** Slice 3B (`restored`): shown when the skill had been retired for harm — the operator sees why before confirming the restore. */
  harmReason?: string;
  /** sha256 of the canonical SKILL.md raw bytes at the time of the snapshot. */
  fileHash: string;
  createdAt: string;
  version: number;
}

/** Why a skill was retired (§3.8): the evidence class behind the verdict. */
export type RetireKind = 'score' | 'misfire' | 'unused' | 'operator' | 'retire-all';

/** A retired skill as `GET /skills/learned` lists it (slice 3, §3.8 / §3.10). */
export interface RetiredSummary {
  name: string;
  /** Plain words: the reviewer's (or the operator's, or the default rung's) reason. */
  reason: string;
  kind: RetireKind;
  retiredAt: string;
  /** Retired for harm (a corrected-rate / score verdict): shown on restore; a learning was posted. */
  harm?: boolean;
  by: 'reviewer' | 'default-rung' | 'operator';
  /** The version the retire row carries. */
  version: number;
  /** The reviewer family that judged it, when a reviewer did. */
  reviewerFamily?: string;
  /** The family that authored the retired version (the restore reviewer must differ). */
  authorFamily?: string;
  /** Per machine id: the layouts whose rendering that machine archived under `retired/<name>/renderings/<machineId>/`. */
  renderingsArchived: Record<string, string[]>;
  /** The archive directory relative to the state dir (where the operator finds the bytes). */
  archiveDir: string;
}

/** Slice 3B: a journaled directory move that carries NO version row — a rendering archive, a set-aside, a history move. Recovery completes/reverses it without touching the version store. */
export type ArchiveMoveOp = 'archive-rendering';

/** Operations the six-step commit protocol (§3.5 tail) journals. */
export type CommitOp = 'create' | 'patch' | 'revert' | 'confirm' | 'reject' | 'lock' | 'unlock';

export type CommitResult =
  | { ok: true; txId: string; fileHash: string; version: number; epoch: number; fence: 'git' | 'local'; /** Non-blocking notes, e.g. `reject-left-rendering:<layout>` when a rendering of the rejected name survives. */ detail?: string }
  | {
      ok: false;
      reason:
        | 'aborted'
        | 'aborted-unreachable'
        | 'not-holder'
        | 'user-edit-conflict'
        | 'unknown-provenance'
        | 'preflight-conflict'
        | 'render-failed'
        | 'invalid';
      detail?: string;
    };

/** The commit protocol as the sentinel (2B) and the routes (2A/2C) consume it; CommitProtocol.ts implements. */
export interface CommitProtocolLike {
  /** `authorFamily` / `reviewerFamily` land on the version row (§3.5 table; `reviewerFamily: 'same-as-author'` marks the §3.7 hold). */
  write(op: CommitOp, name: string, newRaw: string, ctx: { expectedPrevHash: string | null; reason?: string; authorFamily?: string; reviewerFamily?: string }): Promise<CommitResult>;
  move(op: 'retire' | 'restore', name: string, fromAbs: string, toAbs: string): Promise<CommitResult>;
  recoverOwnJournal(): Promise<{ finished: number; voided: number; locked: number; foreignDangling: number }>;
}

/** Minimal interface the routes need from the running sentinel (1C depends on this, 1B implements it). */
export interface SkillLearningSentinelLike {
  status(): SkillLearningStatus;
  skill(name: string): LearnedSkillSummary | ProposalSummary | null;
  recordOperatorVerdict(name: string, verdict: 'agree' | 'disagree', reason?: string): { ok: true } | { ok: false; error: string };
  /** Slice 2: the operator's confirm tap on a `pending` skill. `forwardedFromMachine` is set when a standby proxied the tap (deviation (w)). */
  confirmPending(name: string, opts?: { forwardedFromMachine?: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Slice 2: the operator's reject tap on a `pending` skill (mirror of confirmPending). */
  rejectPending(name: string, opts?: { forwardedFromMachine?: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Slice 3 (§3.8): lock a learned canonical `operator-owned` (no further patches/renders; its rendering is archived). */
  lockSkill(name: string, opts?: SkillTapOpts): Promise<SkillTapResult>;
  /** Slice 3: the mirror tap — `operator-owned` → `active`, rendered again. */
  unlockSkill(name: string, opts?: SkillTapOpts): Promise<SkillTapResult>;
  /** Slice 3: retire by the operator's hand (archive first on every machine, canonical moved, never deleted). */
  retireSkill(name: string, opts?: SkillTapOpts): Promise<SkillTapResult>;
  /** Slice 3: restore a retired skill — moved back, re-linted, re-reviewed by a different family, held `pending`. */
  restoreSkill(name: string, opts?: SkillTapOpts): Promise<SkillTapResult>;
  /** Slice 3: retire every learned skill, with an audit row naming the actor and the re-arm review date (now + 14 d). */
  retireAll(opts?: SkillTapOpts): Promise<SkillTapResult & { retired?: string[]; refused?: Array<{ name: string; error: string }> }>;
}

export interface SkillTapOpts { forwardedFromMachine?: string; reason?: string }
export type SkillTapResult = { ok: true; detail?: string } | { ok: false; error: string };

/** Directory layout (§4). All under config.stateDir. */
export const SKILL_LEARNING_PATHS = {
  ledgerDir: 'skill-learning/ledger',
  proposalsDir: 'skill-learning/proposals',
  journalDir: 'skill-learning/journal',             // slice 0 reconciler rows + slice 2 commit rows (per machine)
  renderedBaselinesDir: 'skill-learning/rendered-baselines',
  versionsDir: 'skill-learning/versions',           // slice 2/3
  retiredDir: 'skill-learning/retired',             // slice 3
  rejectedDir: 'skill-learning/rejected',           // slice 2: archived canonicals of rejected pending skills (`<name>/<txId>/`)
  cacheDb: 'state/skill-learning.db',
  log: 'logs/skill-learning.jsonl',
} as const;

/** Canonical frontmatter `instar-learned-state` values (spec §3.5). */
export type LearnedCanonicalState = 'proposal' | 'pending' | 'active' | 'operator-owned' | 'retired';

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

// ─── Slice 3: attention items 1–6 (§3.10) ───────────────────────────────────

/**
 * The condition signals the sentinel hands `SkillLearningAttention.tick` every tick (§3.10 items 1–6). The
 * sentinel derives them from durable state (the log tail, the ledger, the proposals and canonical layouts); the
 * attention controller never reads those itself, so a test can drive every item from this one object.
 */
export interface SkillLearningSignals {
  /** The tick's clock (ms). */
  at: number;
  /** §3.2 single writer: heals and notices run on the lease holder only. */
  holdsLease: boolean;
  /** `mode === 'live'` (3A): items 1/2 heal through live writes, so in shadow mode they are governed `shadow`; items 3–6 are unaffected. */
  live: boolean;
  /** The lease epoch (the heal gates' fence); null when no coordinator exists (single-machine agents, fence `local`). */
  epoch: number | null;
  /** Item 1: learned skills the retirer retired for harm (3B), with the version the bounded revert targets. */
  harmRetired: Array<{ skill: string; version: number; reason?: string }>;
  /** Item 2: a wanted draft the reviewer struck for index cost (§3.9), with the measurement it cited. */
  indexCostTooHigh: Array<{ key: string; name?: string; indexBytes: number | null; claudeHeadroomChars: number | null; at: string }>;
  /** Item 3: consecutive drafter refusals per procedure key since its last successful draft. */
  refusalStreaks: Record<string, number>;
  /** Item 4: classifier model calls and failures inside the last 24 h (`calls24h` null = no call count available yet). */
  classifier: { calls24h: number | null; failures24h: number };
  /** Item 5 (unmeasured): every active learned skill with its measurable rate and corroborated/total uses. */
  skills: Array<{ name: string; measurableRate: number | null; uses: number; corroborated: number; locked: boolean }>;
  /** Item 5 (revert breaker, 3A): keys whose `revert-breaker` EventRow fired, newest first per key. */
  revertBreakers: Array<{ key: string; skill?: string; reason?: string; at: string }>;
  /** Item 5 (equal-epoch split-brain, deviation (t)): the skills the versions phase demoted. */
  splitBrain: Array<{ name: string; detail?: string }>;
  /** Item 6: proposals + skills created in the last 7 days, with the arbiter's label (the "reasons" the spec shows). */
  createdLast7d: Array<{ name: string; kind: 'proposal' | 'skill'; arbiterOnly: boolean; disagreement?: 'arbiter-only' | 'default-only' | null; createdAt: string }>;
}

/** The outcome an injected heal reports back (3A's revert, 3B's retire proposal, the two family swaps). */
export type SkillLearningHealOutcome =
  | { healed: true; detail?: string }
  /** `terminal`: the heal ran but its own judgment says notifying is the only step left (item 1: the reverted version
   *  is harmful too; item 2: nothing is retirable) — the episode notifies NOW instead of retrying. */
  | { healed: false; reason: string; detail?: string; terminal?: boolean };

/** The heals 3A/3B provide (fakes in tests). Each is bounded by its own caller; the attention gate bounds the attempts. */
export interface SkillLearningHeals {
  /** Item 1 — 3A Reverter: bounded revert of the harm-retired skill to the version before `version`. */
  revertFirst?(input: { skill: string; version: number }): Promise<SkillLearningHealOutcome>;
  /** Item 2 — 3B Retirer via the reviewer: propose retiring the lowest-scored unused learned skill to make room for `key`'s draft. */
  retireLowestUnused?(input: { key: string; indexBytes: number | null; claudeHeadroomChars: number | null }): Promise<SkillLearningHealOutcome>;
  /** Item 3: swap the drafter family for `key` once (the controller never asks twice inside one episode). */
  swapDrafterFamily?(input: { key: string; streak: number }): Promise<SkillLearningHealOutcome>;
  /** Item 4: the bounded classifier failure swap (once per episode). */
  swapClassifierFamily?(input: { failures24h: number; calls24h: number; rate: number }): Promise<SkillLearningHealOutcome>;
}

/** The observation the attention controller raises (TelegramAdapter.createAttentionItem's subset it uses). */
export interface SkillLearningAttentionObservation {
  id: string;
  conditionKey: string;
  category: 'skill-learning';
  priority: 'HIGH' | 'NORMAL';
  title: string;
  summary: string;
  needsUser: boolean;
  silent: boolean;
  sourceContext: 'skill-learning-sentinel';
}

/** What the sentinel's `attention` phase calls each tick. */
export interface SkillLearningAttentionLike {
  tick(signals: SkillLearningSignals): Promise<unknown>;
}
