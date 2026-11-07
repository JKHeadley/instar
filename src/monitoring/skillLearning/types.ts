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
  event: 'improve' | 'reviewer';
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
  retired: unknown[];   // slice 3
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
  reviewerFamily?: string;
  lastUsedAt?: string;
  locked: boolean;
  /** Uses whose rendering the operator had edited (baseline conflict): counted here, EXCLUDED from every score above (slice 2, §3.9). */
  operatorEdited: number;
  /** The 7-day "new" label (§3.5): an `active` skill created/confirmed inside the last 7 days, computed at read time. */
  isNew: boolean;
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
  pendingReason?: 'one-family' | 'rung-unproven';
  /** sha256 of the canonical SKILL.md raw bytes at the time of the snapshot. */
  fileHash: string;
  createdAt: string;
  version: number;
}

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
  write(op: CommitOp, name: string, newRaw: string, ctx: { expectedPrevHash: string | null; reason?: string }): Promise<CommitResult>;
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
}

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
