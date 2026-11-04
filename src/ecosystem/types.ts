/**
 * Shared shapes for the ecosystem idea pipeline (docs/specs/ecosystem-idea-pipeline.md).
 * Everything a model wrote is untrusted text: quoted data, never instructions.
 */

export type GapVerdict = 'gap' | 'partial' | 'have-it' | 'not-for-us' | 'unverified';
export type EffectClass = 'additive-dark' | 'behaviour-changing' | 'reduces-capability';
export type IdeaStage = 'candidate' | 'gap-first' | 'gap-second' | 'goal' | 'done';
export type Band = 'now' | 'plan' | 'watch' | 'stopped' | 'unranked';
export type Maturity = 'tested-in-their-code' | 'in-code-untested' | 'prose-only';
export type SearchMode = 'hybrid' | 'word-only';

export interface EvidenceRef { path: string; startLine: number; endLine: number }

export interface GapRead {
  framework: string;
  verdict: GapVerdict;
  detail: string;
  citations: string[];
  terms: string[];
  effectClass: EffectClass;
  searchMode: SearchMode;
  truncated: boolean;
  sourceCommits: Record<string, string>;
  singleFamily: boolean;
}

export interface GoalReview {
  framework: string;
  purposeCommit: string | null;
  coherence: { effect: 'helps' | 'harms' | 'neutral'; why: string };
  trust: { effect: 'helps' | 'harms' | 'neutral'; why: string };
  unhindered: { addsLimit: boolean; namedRule: string | null; why: string };
  instar2: { status: 'in-design' | 'conflict' | 'absent' | 'unknown'; doc: string | null; workThrownAway: boolean };
  costOfNotAdopting: string;
  goalFit: 'clear' | 'some' | 'none';
  gapSize: 'large' | 'medium' | 'small';
  effort: 's' | 'm' | 'l';
  evidenceCost: 'available' | 'cheap' | 'costly';
}

export interface Sighting {
  sightingId: string;
  project: string;
  commit: string;
  claim: string;
  evidence: EvidenceRef[];
  excerpts: Array<{ path: string; text: string }>;
  maturity: Maturity;
  ageDays: number | null;
  at: string;
}

export interface Decision {
  action: 'decline' | 'start-spec' | 'later' | 'exception' | 'lower-class';
  recordHash: string;
  at: string;
  by: 'operator' | 'agent';
  ref: string;
  reason?: string;
  sessionName?: string;
  scope?: string;
  rollback?: string;
  expiresAt?: string;
  reviewAt?: string;
  effectClass?: EffectClass;
}

export interface Idea {
  id: string;
  project: string;
  sightings: Sighting[];
  stage: IdeaStage;
  firstRead: GapRead | null;
  secondRead: GapRead | null;
  verdict: GapVerdict | null;
  effectClass: EffectClass | null;
  classLoweredTo: EffectClass | null;
  goal: GoalReview | null;
  decisions: Decision[];
  launchIntent: { sessionName: string; at: string; reason: string; revision: string | null; attemptedAt: string | null; recorded: boolean } | null;
  adoption: { prediction: string; checkAt: string; at: string; ref: string } | null;
  outcome: { result: 'helped' | 'no-change' | 'harmed' | 'unknown'; evidence: string; at: string } | null;
  audit: { at: string; verdict: GapVerdict; overturned: boolean } | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface ProjectCursor {
  targetCommit: string | null;
  reviewedCommit: string | null;
  filesDone: string[];
  attempt: number;
  nextAttemptAt: string | null;
  failedCycles: number;
  cycleStartedAt: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastRunAt: string | null;
  lastRemoteHead: string | null;
  nextDueAt: string | null;
  /** Set when a cycle used all its attempts: nothing runs for this project until then. */
  cycleExhaustedUntil: string | null;
}

export interface WatchEntry { id: string; repo: string; addedBy: string; addedAt: string; reason: string }
export interface WatchProposal { repo: string; reason: string; at: string; fromIdea: string | null }

export interface RunRow {
  runId: string;
  at: string;
  endedAt: string | null;
  projects: Array<{ project: string; head: string | null; filesRead: number; candidates: number; dropped: number; outcome: string }>;
  tokensEstimated: number;
  stoppedBy: string | null;
}

export interface ModelCaller {
  framework: string;
  family: string;
  call(prompt: string, opts: { timeoutMs: number; label: string }): Promise<string>;
}

/** Thrown by the ledger when a write carries an epoch older than one already recorded. */
export class EpochFencedError extends Error {
  constructor(readonly epoch: number, readonly highEpoch: number) {
    super(`ecosystem ledger: a write from lease epoch ${epoch} was refused; epoch ${highEpoch} has been recorded`);
    this.name = 'EpochFencedError';
  }
}

export const SEED_WATCHLIST: ReadonlyArray<{ repo: string; reason: string }> = [
  { repo: 'openclaw/openclaw', reason: 'seed: audited in May 2026; four import specs came from it' },
  { repo: 'NousResearch/hermes-agent', reason: 'seed: named by the operator, 2026-11-01' },
  { repo: 'mattabate/life-distributable', reason: 'seed: deep dive 2026-11-01' },
];

export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
