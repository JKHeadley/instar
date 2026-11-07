/**
 * SkillLearningSentinel — procedural memory: repeated requests become skills
 * that earn their keep (docs/specs/skill-learning-sentinel.md, slice 1:
 * observe → floor → rung/arbiter → draft → lint → cross-family review →
 * shadow proposal). Ships OFF (`monitoring.skillLearning.enabled`); in slice 1
 * `mode: shadow` is the only acting mode: every draft lands under
 * `<stateDir>/skill-learning/proposals/<name>/` — a directory no framework
 * discovers — and NOTHING is written under `.instar/skills`, `.claude/skills`
 * or `.agents/skills`.
 *
 * Slice 2 — `mode: live` (read LIVE from config each tick): a validated draft
 * goes through the injected commit protocol (`CommitProtocolLike.write('create')`,
 * §3.5 tail — fence, version row, canonical temp+rename, preflight, render via
 * the reconciler, journal commit; the sentinel never touches a skills directory
 * itself). While rung 2 of the ladder is unproven the canonical is written
 * `instar-learned-state: pending` (unrendered) until the operator's one tap
 * (`confirmPending` / `rejectPending`); once rung 2 has held, `active` with a
 * 7-day "new" label computed at read time. A one-family draft is `pending` at
 * every rung. The arbiter ACTS (its dissent governs) only after its shadow pair
 * beat the default rung on ≥ `shadow.minDisagreementsSampled` operator-sampled
 * disagreements; before that the default rung acts and arbiter-only drafts stay
 * shadow proposals so the sample keeps growing. Shadow mode never calls the
 * protocol (the only call site is behind the live branch). The §3.9 index cost
 * is measured each tick (IndexCost) and handed to the drafter and reviewer; a
 * reviewer cost strike is LOGGED (`kind: 'index-cost'`) and accepted.
 *
 * Tick (every `tickMinutes`): ledger ingest → classifier tick (1A's, through
 * an injected `{tick()}`) → outcome windows close → per key: floor (§3.3) →
 * default rung + arbiter (§3.4, both logged) → RunSlice evidence → drafter →
 * structural lint + semantic flags → cross-family review → proposal write.
 * Every phase failure is reported to DegradationReporter and counted; a tick
 * never throws out. LLM calls go through the sentinel's OWN LlmQueue
 * (`maxConcurrent: 1`, `maxDailyCents: llm.maxDailyCents`); an admission
 * refusal is counted and the key is retried next tick. Every judgment is
 * recorded through JudgmentProvenanceLog (`arbiter: true`); an unrecorded
 * judgment is discarded (fail closed, §3).
 *
 * Self-action posture (registered as `skill-learning-tick` in
 * src/testing/selfActionRegistry.ts): one classify/draft batch per
 * `llm.batchSize` keys per tick; every key reaches a durable verdict row
 * (draft → proposal exists; wait/never/refused → an unexpired VerdictRow holds
 * it until the re-ask horizon), so with an empty backlog a tick makes ZERO
 * calls. The growth notice is a SIGNAL (attention item, silent) at most once
 * per 7-day window — never a refusal (§3.3 "growth signal, not a wall").
 */
/* @self-action-controller: skill-learning-tick */
/* @self-action-controller: skill-learning-live-write */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { featureEvidence as sharedFeatureEvidence, type FeatureEvidenceInput } from './FeatureEvidenceLog.js';
import { buildIntelligenceProvider, type IntelligenceFramework } from '../core/intelligenceProviderFactory.js';
import type { IntelligenceProvider } from '../core/types.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import { resolveFrameworkTranscriptPath, type SessionFramework } from '../core/FrameworkSessionStore.js';
import { HumanAsDetectorLog } from './HumanAsDetectorLog.js';
import { Ledger } from './skillLearning/Ledger.js';
import { Outcomes } from './skillLearning/Outcomes.js';
import { Classifier } from './skillLearning/Classifier.js';
import { SeamFilter, installSkillLearningSeamFilter, skillLearningUnlinkedMessages, type AttachSeamsInput } from './skillLearning/SeamFilter.js';
import { LlmQueue, LlmQueueAdmissionError } from './LlmQueue.js';
import { scrubSecrets } from './scrubSecrets.js';
import { buildBoundedContext, type DecisionRowInput } from '../core/JudgmentProvenanceLog.js';
import { evaluateFloor, type FloorResult } from './skillLearning/Floor.js';
import { buildArbiterPrompt, decideKey, parseArbiterOutput, type ArbiterContext, type ArbiterDecision } from './skillLearning/Arbiter.js';
import { readRunSlice, renderOutline, type RunSlice } from './skillLearning/RunSlice.js';
import {
  buildDrafterPrompt, buildReviewPrompt, familyOfFramework, parseDrafterOutput, parseReviewOutput, parseSkillDoc, pickReviewer,
  renderProposalSkillMd, validateDraftAction, validSkillName,
  type CleanRunEvidence, type ExistingSkill, type FamilyProvider, type ParsedSkillDoc,
} from './skillLearning/Drafter.js';
import { lintDraft, DRAFT_BODY_MAX_CHARS } from './skillLearning/Lint.js';
import { measureIndexCost, renderIndexCostLine, type IndexCostReading } from './skillLearning/IndexCost.js';
import {
  SKILL_LEARNING_PATHS,
  type CommitProtocolLike, type EventRow, type LearnedCanonicalState, type LearnedSkillSummary, type LedgerReader, type LedgerWriter,
  type OutcomeRow, type PendingSummary, type ProposalSidecar, type ProposalSummary, type RequestRow, type RowSource,
  type SkillLearningConfig, type SkillLearningMode, type SkillLearningSentinelLike, type SkillLearningStatus, type VerdictRow,
} from './skillLearning/types.js';

export const SKILL_LEARNING_FEATURE = 'monitoring.skillLearning';
const COMPONENT_DRAFTER = 'skillLearning.drafter';
const COMPONENT_REVIEWER = 'skillLearning.reviewer';
const WEEK_MS = 7 * 86_400_000;
const LEARNED_ORIGIN_KEY = 'instar-learned-origin';
const LEARNED_STATE_KEY = 'instar-learned-state';
const LEARNED_ACTIVATED_KEY = 'instar-learned-activated';
/** Display sidecars for `pending` canonicals (paraphrases, reviewer family, evidence) — the durable record is the frontmatter state. */
const PENDING_SIDECAR_DIR = 'skill-learning/pending';
/** The 7-day "new" label window (§3.5). */
const NEW_LABEL_MS = 7 * 86_400_000;

/** The attention-item shape the sentinel raises (TelegramAdapter.createAttentionItem's observation subset). */
export interface SkillLearningAttentionItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  conditionKey: string;
  silent: true;
}

export interface SkillLearningDegradationEvent {
  feature: string; primary: string; fallback: string; reason: string; impact: string;
}

export interface JudgmentRecorder {
  recordDecision(input: DecisionRowInput): string | null;
  isRecordingLive(): boolean;
}

export interface SkillLearningSentinelDeps {
  config: SkillLearningConfig;
  /** The `.instar` directory (SKILL_LEARNING_PATHS are relative to it). */
  stateDir: string;
  /** The agent home: holds `.instar/skills`, `.claude/skills`, `.agents/skills`. */
  projectDir: string;
  machineId: string;
  ledger: LedgerReader & LedgerWriter;
  /** 1A's seam catch-up (TopicMemory watermark), when wired. */
  ingest?: { ingestNew(): Promise<void> | void };
  /** 1A's batch classifier tick, when wired (decoupled through this seam). */
  classifier?: { tick(): Promise<unknown> | unknown };
  /** 1A's outcome-window closer, when wired. */
  outcomes?: { close(): Promise<void> | void };
  /** 1A's filter + classifier counters, merged into status(). */
  counters?: () => Partial<Pick<SkillLearningStatus, 'filtered' | 'classifierFailures24h' | 'abortedUnreachable24h' | 'pendingBacklog'>>;
  /** Reachable model families, preference order; the first is the drafter, a different one reviews. */
  families: () => ReadonlyArray<FamilyProvider>;
  /** The transcript file for a run's session; null when unknown. */
  transcriptPath: (run: { sessionName?: string; topicId: string; runId: string }) => string | null;
  /** The operator's message text for a ledger source (TopicMemory by source); null when unavailable. */
  operatorMessage: (source: RowSource) => string | null;
  /** Verified operator-authored correction-class messages for a corrected run (scrubbed by the sentinel). */
  correctionMessages?: (runId: string, procedureKey: string) => string[];
  /** `GET /preferences/session-context` block — injected, never fetched from inside. */
  preferencesBlock?: () => string | null;
  createAttentionItem?: (item: SkillLearningAttentionItem) => Promise<unknown> | unknown;
  degradation?: { report(event: SkillLearningDegradationEvent): void } | null;
  provenance: JudgmentRecorder;
  /** Measured skill-index bytes (§3.9), when the server measures it (superseded by `indexCost`; kept for callers that only know bytes). */
  indexBytes?: () => number | null;
  /** The §3.9 measurement for this tick; default: the real rendered index under `projectDir` (IndexCost). */
  indexCost?: () => IndexCostReading | null;
  /**
   * Slice 2: the six-step commit protocol (§3.5 tail). Null = no live writes are possible: a `live` tick reports a
   * degradation and falls back to a shadow proposal. NEVER called in shadow mode.
   */
  commitProtocol?: CommitProtocolLike | null;
  /** The acting mode, read LIVE (the ladder flips it in config without a restart being the only path). Default: the construction config. */
  mode?: () => SkillLearningMode;
  /**
   * Has rung 2 (live with pending/confirm) held on the ladder? While false every new skill is written `pending`.
   * Default: false — an unreadable ladder is treated as unproven (the conservative side).
   */
  rungTwoProven?: () => boolean;
  /**
   * Slice 2: the version store — the hash chain confirm/reject fence against (§3.5 step 3) and the post-sync
   * epoch reconciliation the `versions` tick phase runs on EVERY machine. Null: taps fence against the on-disk
   * hash (reported in the log row) and the phase is skipped.
   */
  versionStore?: VersionStoreLike | null;
  /** Injectable queue (tests); default: the sentinel's own. */
  queue?: LlmQueue;
  /** Feature-evidence sink; default: the process-wide `featureEvidence`. */
  evidence?: { record(featureId: string, input: FeatureEvidenceInput): string | null } | null;
  /** Owned sub-components' lifecycle (ledger cache, seam filter), run by start()/stop(). `create()` fills this. */
  bound?: { start(): void; stop(): void };
  /** `skillLearningUnlinkedMessages()` — messages a seam link saw while no filter was installed. */
  unlinkedMessages?: () => number;
  /**
   * Does this machine hold the operator-messaging lease (§3.2 single writer)? When false the sentinel is
   * observe-only: no key evaluation, no drafting, no growth notice (the holder does those). Default true.
   */
  holdsLease?: () => boolean;
  now?: () => number;
  logger?: (message: string) => void;
}

/** Everything `SkillLearningSentinel.create` needs from the server; the sentinel owns every sub-component it builds. */
/** The frameworks that may serve the drafter/reviewer: grok-build is excluded from internal routing (its spec) and pi-cli is untrusted for review. */
export type DrafterFramework = 'claude-code' | 'codex-cli' | 'gemini-cli';

export interface SkillLearningCreateInput {
  projectDir: string;
  stateDir: string;
  machineId: string;
  config: SkillLearningConfig;
  /** Framework routing inputs (config `enabledFrameworks`, the default framework, `componentFrameworks.overrides`). */
  frameworks?: { enabled?: ReadonlyArray<IntelligenceFramework>; default?: IntelligenceFramework; overrides?: Record<string, IntelligenceFramework | undefined> };
  /** The shared router — the classifier's (1A) door. The drafter/reviewer use per-framework providers (see `families`). */
  sharedIntelligence: IntelligenceProvider | null;
  topicMemory: Pick<TopicMemory, 'getMessagesSince'> | null;
  telegram?: { createAttentionItem?(item: SkillLearningAttentionItem): Promise<unknown> } | null;
  slack?: AttachSeamsInput['slack'];
  topicOperatorStore: { asVerifiedOperator(topicId: number | string): { uid: string } | null };
  userManager?: { listUsers(): Array<{ permissions: string[]; channels: Array<{ type: string; identifier: string }> }> } | null;
  /** Slack channel id → the synthetic numeric topic id TopicMemory stores the channel under (server-local helper). */
  slackTopicId?: (channelId: string) => string;
  hasOutstandingConfirmation?: (topicId: string) => boolean;
  /** Default: `HumanAsDetectorLog.getInstance()`; pass null to disable. */
  detector?: { classify(text: string): { category: string } | null } | null;
  /** `StateManager.findSessionByTmux` projection (transcript location for RunSlice + the §3.9 join). */
  findSession?: (sessionName: string) => { claudeSessionId?: string; framework?: SessionFramework } | undefined;
  sessionClockEnd?: (topicId: string) => string | null;
  /** Operator-messaging lease probe (§3.2 single writer). Default: always the holder (single-machine agents). */
  holdsLease?: () => boolean;
  provenanceLog: { recordDecision(input: DecisionRowInput): string | null; status(): { counters: Record<string, number> } } | null;
  degradationReporter?: { report(event: SkillLearningDegradationEvent): void } | null;
  featureEvidence?: { record(featureId: string, input: FeatureEvidenceInput): string | null } | null;
  createAttentionItem?: (item: SkillLearningAttentionItem) => Promise<unknown> | unknown;
  preferencesBlock?: () => string | null;
  /** Test seam: per-framework provider builder (default `buildIntelligenceProvider({ framework })`). */
  buildProvider?: (framework: DrafterFramework) => IntelligenceProvider | null;
  /** Slice 2: the commit protocol (CommitProtocol.ts, built by the server/wire). Null ⇒ live mode cannot write (degradation + shadow fallback). */
  commitProtocol?: CommitProtocolLike | null;
  /** Slice 2: the maturation ladder's feature views — the default `rungTwoProven` reader (`monitoring.skillLearning` at `fleet`, or `ready-to-advance` towards it). */
  ladder?: { features(): ReadonlyArray<{ id: string; rung: string; next: string | null; state: string }> } | null;
  /** Slice 2: override of the rung-2 reader (tests / an operator-pinned answer). */
  rungTwoProven?: () => boolean;
  /** Slice 2: live `mode` reader; default reads `<stateDir>/config.json` → `monitoring.skillLearning.mode` on every tick. */
  readMode?: () => SkillLearningMode | null;
  /** Slice 2: §3.9 join hardening — the version row a rendering stamp (body hash) belongs to (VersionStore.rows across machines). */
  versionLookup?: ((skill: string, bodyHash: string) => { version: number } | null) | null;
  /** Slice 2: the VersionStore itself (what wire.ts hands over); `versionLookup` is derived from it, and the hash chain + epoch reconciliation read it. */
  versionStore?: VersionStoreLike | null;
  /** Slice 2: §3.9 index-cost measurement override (tests); default measures the real rendered index. */
  indexCost?: () => IndexCostReading | null;
  logger?: (message: string) => void;
  now?: () => number;
}

export interface TickSummary {
  at: string;
  keysSeen: number;
  floorPassed: number;
  drafted: number;
  refused: number;
  held: number;
  arbiterCalls: number;
  phaseFailures: string[];
  admissionRefusals: number;
  /** True when this tick skipped the keys/growth phases because the machine does not hold the lease. */
  observeOnly: boolean;
}

type RefusalReason =
  | 'evidence-cut' | 'no-family' | 'unrecorded' | 'unparseable' | 'review' | 'admission'
  | `lint:${string}` | `action:${string}` | 'provider-error' | 'invalid-name' | `commit:${string}`;

/** Where a validated draft lands: the shadow proposals directory, or the canonical layout through the commit protocol. */
type DraftTarget = 'proposal' | 'canonical';

/** One effective version row as the sentinel reads it (2A's VersionStore `EffectiveVersionRow` subset). */
export interface VersionRowLike { txId: string; version: number; fileHash: string; bodyHash: string; epoch: number; machineId: string; at: string; void?: boolean; superseded?: boolean }

/** `VersionStore.reconcileAfterSync` outcome (deviation (t)); the sentinel performs the body-level consequence. */
export type SyncReconcileOutcomeLike =
  | { kind: 'no-rows' }
  | { kind: 'in-sync'; winner: VersionRowLike }
  | { kind: 'superseded'; winner: VersionRowLike; loser: VersionRowLike; tombstoned: number }
  | { kind: 'split-brain'; epoch: number; candidates: VersionRowLike[] }
  | { kind: 'unknown-hash'; winner: VersionRowLike; onDiskFileHash: string };

/** The version store as the sentinel consumes it (2A's VersionStore implements; tests use an in-memory fake). */
export interface VersionStoreLike {
  rows(name: string): ReadonlyArray<VersionRowLike>;
  /** The hash every confirm/reject/lock fences against: the last live version row's fileHash (spec §3.5 step 3). */
  expectedPrevHash(name: string): string | null;
  reconcileAfterSync(name: string, onDiskFileHash: string | null): SyncReconcileOutcomeLike;
}

/** The display sidecar beside a `pending` canonical (`<stateDir>/skill-learning/pending/<name>.json`). */
interface PendingSidecar {
  name: string;
  key: string;
  description: string;
  paraphrases: string[];
  reviewerFamily?: string;
  pendingReason: 'one-family' | 'rung-unproven';
  createdAt: string;
  evidence: { sources: RowSource[]; runIds: string[] };
  disagreement?: 'arbiter-only' | 'default-only' | null;
  arbiterOnly: boolean;
}

interface SentinelState {
  growthNoticeAt?: string;
  /** Post-sync epoch reconciliation (durable per machine): one consequence per `(name, on-disk fileHash)`, and the counts status() shows. */
  versions?: { handled: Record<string, string>; epochSuperseded: number; splitBrain: number; locked: number };
}

interface LoadedProposal { sidecar: ProposalSidecar; dir: string }

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { SafeFsExecutor.safeRmSync(tmp, { force: true, operation: 'skill-learning-sentinel:temp-cleanup' }); } catch { /* @silent-fallback-ok — best-effort temp cleanup after a failed write */ }
    throw err;
  }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; } // @silent-fallback-ok — absent/corrupt state reads as none; callers handle null
}

/** Flat metadata values of a canonical/rendered SKILL.md, or null when it is not a skill. */
function skillMeta(text: string): { doc: ParsedSkillDoc; learned: boolean } | null {
  const doc = parseSkillDoc(text);
  if (!doc) return null;
  const origin = doc.metadata[LEARNED_ORIGIN_KEY];
  return { doc, learned: typeof origin === 'string' && origin.trim().length > 0 };
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

/** The §3.9 stamp → version resolver over a VersionStore: the newest non-void row carrying that body hash. */
export function versionLookupFromStore(store: Pick<VersionStoreLike, 'rows'> | null | undefined): ((skill: string, bodyHash: string) => { version: number } | null) | null {
  if (!store) return null;
  return (skill, bodyHash) => {
    const rows = store.rows(skill);
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r.void && r.bodyHash === bodyHash) return { version: r.version };
    }
    return null;
  };
}

/**
 * Re-emit a canonical SKILL.md with its flat metadata patched (state flips, activation stamp) and everything
 * else — name, description, the other metadata keys, the body — preserved byte-for-byte where YAML allows.
 */
function withLearnedMetadata(raw: string, patch: Record<string, string>): string | null {
  const m = String(raw ?? '').replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  let fm: unknown;
  try { fm = yaml.load(m[1], { schema: yaml.FAILSAFE_SCHEMA, json: false }); } catch { return null; } // @silent-fallback-ok — a malformed frontmatter cannot be patched; the caller refuses
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null;
  const f = { ...(fm as Record<string, unknown>) };
  const metadata = (f.metadata && typeof f.metadata === 'object' && !Array.isArray(f.metadata)) ? { ...(f.metadata as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) metadata[k] = v;
  f.metadata = metadata;
  const dumped = yaml.dump(f, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
  return `---\n${dumped}---\n${m[2]}`;
}

export class SkillLearningSentinel implements SkillLearningSentinelLike {
  private readonly deps: SkillLearningSentinelDeps;
  private readonly cfg: SkillLearningConfig;
  private readonly queue: LlmQueue;
  private readonly evidence: { record(featureId: string, input: FeatureEvidenceInput): string | null };
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastTickAt: string | undefined;
  private lastTick: TickSummary | null = null;
  private readonly counters = {
    ticks: 0, tickFailures: 0, admissionRefusals: 0, arbiterOutages: 0, draftsWritten: 0, draftsRefused: 0,
    reviewsPassed: 0, reviewsFailed: 0, oneFamilyHolds: 0, coveredByHandwritten: 0, improveEvents: 0, growthNotices: 0,
    // Slice 2 (live mode).
    liveCreates: 0, pendingCreates: 0, confirms: 0, rejects: 0, commitRefusals: 0, arbiterGoverned: 0, costStrikes: 0, liveFallbacks: 0,
    epochSuperseded: 0, splitBrain: 0, versionLocks: 0,
  };
  /** In-process dedupe of once-per-key notices (covered-by-handwritten); the log row is the durable record. */
  private readonly notedCovered = new Set<string>();
  /** Last logged arbiter-promotion verdict (the row is written when it changes, not every tick). */
  private lastPromoted: boolean | null = null;
  /** This tick's §3.9 measurement (taken once per tick, handed to the arbiter, drafter and reviewer). */
  private tickIndexCost: IndexCostReading | null = null;
  /** Per-name serialization of confirm/reject taps: a double tap sees the first tap's result, never a stale-hash conflict. */
  private readonly pendingOps = new Map<string, Promise<unknown>>();

  constructor(deps: SkillLearningSentinelDeps) {
    this.deps = deps;
    this.cfg = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? (() => {});
    this.queue = deps.queue ?? new LlmQueue({ maxConcurrent: 1, maxDailyCents: Math.max(0, deps.config.llm.maxDailyCents) });
    this.evidence = deps.evidence ?? sharedFeatureEvidence;
  }

  // ─── Paths ──────────────────────────────────────────────────────────

  get proposalsDir(): string { return path.join(this.deps.stateDir, SKILL_LEARNING_PATHS.proposalsDir); }
  get logPath(): string { return path.join(this.deps.stateDir, SKILL_LEARNING_PATHS.log); }
  get pendingSidecarDir(): string { return path.join(this.deps.stateDir, PENDING_SIDECAR_DIR); }
  private get canonicalRoot(): string { return path.join(this.deps.projectDir, '.instar', 'skills'); }

  /** The acting mode, read live. An unreadable reader falls back to the construction config. */
  mode(): SkillLearningMode {
    try { return this.deps.mode?.() === 'live' ? 'live' : (this.deps.mode ? 'shadow' : this.cfg.mode); } catch { return this.cfg.mode; } // @silent-fallback-ok — an unreadable mode reads as configured at construction
  }

  /** Rung 2 held on the ladder? Unreadable ⇒ false (pending is the conservative side). */
  rungTwoProven(): boolean {
    try { return this.deps.rungTwoProven?.() === true; } catch { return false; } // @silent-fallback-ok — an unreadable ladder reads as unproven
  }
  /** Per-machine (the directory is git-synced; a shared name would conflict between machines). */
  private get statePath(): string { return path.join(this.deps.stateDir, 'skill-learning', `sentinel-state.${this.deps.machineId}.json`); }

  private holdsLease(): boolean {
    try { return this.deps.holdsLease ? this.deps.holdsLease() !== false : true; } catch { return false; } // @silent-fallback-ok — an unreadable lease reads as "not the holder": observe-only is the safe side
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    try { this.deps.bound?.start(); } catch (err) { // @silent-fallback-ok — logged on the next line; the sentinel still starts its tick so the backlog stays visible, never silently dark
      this.log(`[SkillLearningSentinel] bound start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const minutes = Number.isFinite(this.cfg.tickMinutes) && this.cfg.tickMinutes > 0 ? this.cfg.tickMinutes : 10;
    this.timer = setInterval(() => { void this.tick(); }, minutes * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.deps.bound?.stop(); } catch (err) {
      this.log(`[SkillLearningSentinel] bound stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Tick ───────────────────────────────────────────────────────────

  async tick(): Promise<TickSummary> {
    const summary: TickSummary = { at: new Date(this.now()).toISOString(), keysSeen: 0, floorPassed: 0, drafted: 0, refused: 0, held: 0, arbiterCalls: 0, phaseFailures: [], admissionRefusals: 0, observeOnly: false };
    if (this.running) return summary;
    this.running = true;
    this.counters.ticks++;
    try {
      await this.phase('ingest', summary, async () => { await this.deps.ingest?.ingestNew(); });
      // Every machine, not lease-gated: a read of the synced version shards plus tombstones/locks of bodies
      // this machine holds (idempotent per (name, on-disk hash); see reconcileVersions).
      await this.phase('versions', summary, async () => { await this.reconcileVersions(); });
      await this.phase('classifier', summary, async () => { await this.deps.classifier?.tick(); });
      await this.phase('outcomes', summary, async () => { await this.deps.outcomes?.close(); });
      await this.phase('index-cost', summary, async () => { this.tickIndexCost = this.measureIndexCost(); });
      if (this.holdsLease()) {
        await this.phase('keys', summary, async () => { await this.evaluateKeys(summary); });
        await this.phase('growth', summary, async () => { await this.checkGrowthSignal(); });
      } else {
        summary.observeOnly = true;          // the lease holder drafts; this machine observes (§3.2 single writer)
      }
      this.lastTickAt = summary.at;
      this.lastTick = summary;
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async phase(name: string, summary: TickSummary, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) { // @silent-fallback-ok — recorded in summary.phaseFailures + logged + DegradationReporter below; a failed phase never aborts the tick (each phase is independent and retried next tick)
      const message = err instanceof Error ? err.message : String(err);
      summary.phaseFailures.push(name);
      this.counters.tickFailures++;
      this.deps.degradation?.report({
        feature: 'SkillLearningSentinel',
        primary: `tick phase "${name}"`,
        fallback: 'phase skipped this tick; the next tick retries from durable state',
        reason: message.slice(0, 300),
        impact: 'Skill learning lags one tick; nothing is lost (the ledger is append-only).',
      });
      this.appendLog({ kind: 'tick-failure', phase: name, error: message.slice(0, 300) });
      this.log(`[SkillLearningSentinel] phase ${name} failed: ${message}`);
    }
  }

  // ─── Keys: floor → rung/arbiter → draft ─────────────────────────────

  private async evaluateKeys(summary: TickSummary): Promise<void> {
    const nowMs = this.now();
    const existing = this.loadExistingSkills();
    const proposals = this.loadProposals();
    const proposedKeys = new Set(proposals.map((p) => p.sidecar.key));
    const learnedNames = new Set(existing.filter((s) => s.learned).map((s) => s.name));
    const batch = Math.max(1, Math.floor(this.cfg.llm.batchSize));
    let llmBudgetThisTick = batch;
    const mode = this.mode();
    const promotion = mode === 'live' ? this.arbiterPromotion(proposals) : null;
    if (promotion && promotion.promoted !== this.lastPromoted) {
      this.lastPromoted = promotion.promoted;
      this.appendLog({ kind: 'arbiter-promotion', ...promotion, minDisagreementsSampled: this.cfg.shadow.minDisagreementsSampled });
    }

    for (const k of this.deps.ledger.keys()) {
      summary.keysSeen++;
      const key = k.procedureKey;
      if (proposedKeys.has(key)) continue;
      const requests = this.deps.ledger.requestsForKey(key);
      const outcomes = this.deps.ledger.outcomesForKey(key);
      const verdicts = this.deps.ledger.verdictsForKey(key);

      if (this.isHeld(verdicts, nowMs)) { summary.held++; continue; }

      const floor = evaluateFloor({ requests, outcomes, floor: this.cfg.floor, isLearnedSkill: (n) => learnedNames.has(n) });
      if (!floor.passes) {
        this.onBelowFloor(key, floor);
        continue;
      }
      summary.floorPassed++;
      if (llmBudgetThisTick <= 0) { summary.held++; continue; }   // the batch bound: the rest waits for the next tick

      const operatorVerdicts = proposals.filter((p) => p.sidecar.verdict).map((p) => ({ name: p.sidecar.name, verdict: p.sidecar.verdict!.verdict, reason: p.sidecar.verdict!.reason }));
      const cleanOutlines = this.quickOutlines(outcomes, floor);
      let admissionRefused = false;
      const decision = await decideKey({
        procedureKey: key,
        requests,
        verdicts,
        floor,
        cfg: this.cfg,
        nowMs,
        askArbiter: async (ctx) => {
          llmBudgetThisTick--;
          summary.arbiterCalls++;
          const res = await this.askArbiter(ctx);
          if (res === 'admission') { admissionRefused = true; return null; }
          return res;
        },
        context: {
          paraphrases: this.paraphrasesOf(requests),
          cleanRunOutlines: cleanOutlines,
          libraryDescriptions: existing.map((s) => `${s.name}${s.learned ? ' [learned]' : ''}: ${s.description}`),
          indexBytes: this.tickIndexCost?.totalBytes ?? this.deps.indexBytes?.() ?? null,
          operatorVerdicts,
        },
      });
      if (admissionRefused) { summary.admissionRefusals++; this.counters.admissionRefusals++; break; }
      this.onDecision(key, decision);
      if (decision.action !== 'draft') { summary.held++; continue; }

      // Live mode (§3.4 → §3.5): who acts. The static default rung acts until the arbiter's shadow pair has beaten
      // it on enough operator-sampled disagreements; after that the arbiter's dissent GOVERNS (a default-only
      // draft waits). Before promotion an arbiter-only draft stays a shadow proposal so the sample keeps growing.
      let target: DraftTarget = 'proposal';
      if (mode === 'live') {
        if (decision.disagreement === 'default-only' && promotion?.promoted) {
          this.counters.arbiterGoverned++;
          this.hold(key, `arbiter-governs: ${decision.arbiter}`);
          this.appendLog({ kind: 'arbiter-governs', key, arbiter: decision.arbiter, default: decision.default.verdict, sampled: promotion.sampled });
          this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'arbiter-governs', context: { key, arbiter: decision.arbiter } });
          summary.held++;
          continue;
        }
        target = decision.disagreement === 'arbiter-only' && !promotion?.promoted ? 'proposal' : 'canonical';
      }

      if (llmBudgetThisTick <= 0) { summary.held++; continue; }
      llmBudgetThisTick--;
      const outcome = await this.draft(key, requests, outcomes, floor, decision, existing, proposals, target);
      if (outcome === 'written') { summary.drafted++; proposedKeys.add(key); }
      else if (outcome === 'admission') { summary.admissionRefusals++; this.counters.admissionRefusals++; break; }
      else summary.refused++;
    }
  }

  /**
   * The §3.4 shadow comparison, read from the recorded operator verdicts on labelled-disagreement proposals: on an
   * `arbiter-only` proposal an `agree` credits the arbiter (the default would have waited), a `disagree` the
   * default; on a `default-only` proposal the reverse. Promoted = at least `shadow.minDisagreementsSampled`
   * sampled disagreements AND the arbiter's operator-agreement rate strictly above the default's. A smaller
   * sample is "not measured": the static rung keeps acting.
   */
  arbiterPromotion(proposals: LoadedProposal[] = this.loadProposals()): { sampled: number; arbiterRight: number; defaultRight: number; promoted: boolean } {
    let sampled = 0; let arbiterRight = 0; let defaultRight = 0;
    for (const p of proposals) {
      const d = p.sidecar.disagreement ?? (p.sidecar.arbiterOnly ? 'arbiter-only' : null);
      const v = p.sidecar.verdict?.verdict;
      if (!d || (v !== 'agree' && v !== 'disagree')) continue;
      sampled++;
      const arbiterWasRight = d === 'arbiter-only' ? v === 'agree' : v === 'disagree';
      if (arbiterWasRight) arbiterRight++; else defaultRight++;
    }
    const min = Math.max(1, Math.floor(this.cfg.shadow.minDisagreementsSampled));
    return { sampled, arbiterRight, defaultRight, promoted: sampled >= min && arbiterRight > defaultRight };
  }

  /** A key held by an unexpired default-rung `wait` (a refusal / covered-by hold) or an unexpired arbiter `never`/`wait`. */
  private isHeld(verdicts: VerdictRow[], nowMs: number): boolean {
    for (const v of verdicts) {
      if (v.by !== 'default-rung' || v.verdict !== 'wait' || !v.expiresAt) continue;
      const exp = Date.parse(v.expiresAt);
      if (Number.isFinite(exp) && exp > nowMs) return true;
    }
    return false;
  }

  private onBelowFloor(key: string, floor: FloorResult): void {
    if (floor.failure === 'covered-by-learned' && floor.coveredBy) {
      const events = this.deps.ledger.eventsForKey(key);
      if (!events.some((e) => e.event === 'improve' && e.skill === floor.coveredBy!.skill)) {
        const row: EventRow = {
          kind: 'event', eventId: crypto.randomUUID(), event: 'improve', runId: floor.cleanRunIds[0] ?? '', procedureKey: key,
          skill: floor.coveredBy.skill, reason: `skillUsed on ${floor.coveredBy.occurrences} occurrences`, at: new Date(this.now()).toISOString(), machineId: this.deps.machineId,
        };
        this.deps.ledger.append(row);
        this.counters.improveEvents++;
        this.appendLog({ kind: 'improve', key, skill: floor.coveredBy.skill, occurrences: floor.coveredBy.occurrences });
        this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'covered-by-learned', context: { key, skill: floor.coveredBy.skill } });
      }
      return;
    }
    if (floor.failure === 'covered-by-handwritten' && floor.coveredBy) {
      const dedupe = `${key}|${floor.coveredBy.skill}`;
      if (!this.notedCovered.has(dedupe)) {
        this.notedCovered.add(dedupe);
        this.counters.coveredByHandwritten++;
        this.appendLog({ kind: 'covered-by-handwritten', key, skill: floor.coveredBy.skill, occurrences: floor.coveredBy.occurrences });
        this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'covered-by-handwritten', context: { key, skill: floor.coveredBy.skill } });
      }
    }
  }

  private onDecision(key: string, d: ArbiterDecision): void {
    this.appendLog(d.logRow);
    if (d.arbiter === 'unavailable') { this.counters.arbiterOutages++; }
    if (d.verdictRow) {
      this.deps.ledger.append({ ...d.verdictRow, eventId: crypto.randomUUID(), machineId: this.deps.machineId });
    }
    if (d.action === 'wait' && d.arbiter === 'never') {
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'arbiter-never', context: { key, cached: d.arbiterCached, default: d.default.verdict } });
    }
  }

  private paraphrasesOf(requests: RequestRow[]): string[] {
    const seen = new Set<string>();
    for (const r of requests) { if (r.paraphrase && seen.size < 12) seen.add(scrubSecrets(r.paraphrase)); }
    return [...seen];
  }

  /** Content-free outlines for the arbiter: run id + label + window only (the full slice is read when drafting). */
  private quickOutlines(outcomes: OutcomeRow[], floor: FloorResult): string[] {
    const clean = new Set(floor.cleanRunIds);
    return outcomes.filter((o) => clean.has(o.runId)).map((o) => `run ${o.runId}: ${o.label}, window ${o.windowStart} → ${o.windowEnd ?? 'open'}`);
  }

  // ─── LLM calls (own queue, provenance-recorded) ─────────────────────

  private async callFamily(provider: FamilyProvider, component: typeof COMPONENT_DRAFTER | typeof COMPONENT_REVIEWER, prompt: string): Promise<string | 'admission'> {
    // Cost estimate against the daily money floor: ~1 cent per 4 K prompt chars (capable tier, rounded up).
    const cost = Math.max(1, Math.ceil(prompt.length / 4000));
    try {
      // The attribution component is INLINED as a literal at each callsite (lint-llm-attribution: a variable is not attribution).
      return await this.queue.enqueue('background', (signal) => component === COMPONENT_REVIEWER
        ? provider.evaluate(prompt, { model: 'capable', maxTokens: 4000, temperature: 0, attribution: { component: 'skillLearning.reviewer', deferrable: true }, signal })
        : provider.evaluate(prompt, { model: 'capable', maxTokens: 4000, temperature: 0, attribution: { component: 'skillLearning.drafter', deferrable: true }, signal }), cost);
    } catch (err) {
      if (err instanceof LlmQueueAdmissionError) return 'admission';
      throw err;
    }
  }

  /** Record one judgment; false = unrecorded (the verdict must be discarded). */
  private recordJudgment(input: Omit<DecisionRowInput, 'arbiter'>): boolean {
    if (!this.deps.provenance.isRecordingLive()) return false;
    const id = this.deps.provenance.recordDecision({ ...input, arbiter: true });
    return typeof id === 'string' && id.length > 0;
  }

  private async askArbiter(ctx: ArbiterContext): Promise<{ verdict: 'draft' | 'wait' | 'never'; reason: string } | null | 'admission'> {
    const families = this.deps.families();
    const drafter = families[0];
    if (!drafter) return null;
    const prompt = buildArbiterPrompt(ctx);
    let raw: string | 'admission';
    try { raw = await this.callFamily(drafter, COMPONENT_DRAFTER, prompt); } catch { return null; } // @silent-fallback-ok — an arbiter outage is the logged 'unavailable' arm (default rung alone)
    if (raw === 'admission') return 'admission';
    const parsed = parseArbiterOutput(raw);
    const recorded = this.recordJudgment({
      component: COMPONENT_DRAFTER,
      decisionPoint: 'skill-learning-arbiter',
      context: buildBoundedContext({ key: ctx.procedureKey, occurrences: ctx.floor.occurrences, verified: ctx.floor.verifiedOccurrences, cleanRuns: ctx.floor.cleanRuns, defaultVerdict: ctx.defaultRung.verdict, family: drafter.family, promptChars: prompt.length, reason: parsed?.reason ?? null }),
      optionsPresented: ['draft', 'wait', 'never'],
      decision: parsed?.verdict ?? 'unclassified',
      reason: parsed?.reason ?? 'unparseable',
      floor: `minOccurrences=${this.cfg.floor.minOccurrences} minCorroboratedCleanRuns=${this.cfg.floor.minCorroboratedCleanRuns}`,
      fallbackRung: `default-gate ${this.cfg.defaultGate.minSupport}/${this.cfg.defaultGate.minDistinctDays}/${this.cfg.defaultGate.minDistinctSessions}@${this.cfg.defaultGate.windowDays}d`,
      model: 'capable',
      door: drafter.framework,
    });
    if (!recorded) { this.appendLog({ kind: 'arbiter-unrecorded', key: ctx.procedureKey }); return null; }
    return parsed;
  }

  // ─── Draft → lint → review → write ──────────────────────────────────

  private async draft(
    key: string, requests: RequestRow[], outcomes: OutcomeRow[], floor: FloorResult, decision: ArbiterDecision,
    existing: ExistingSkill[], proposals: LoadedProposal[], target: DraftTarget = 'proposal',
  ): Promise<'written' | 'refused' | 'admission'> {
    const families = this.deps.families();
    const drafter = families[0];
    if (!drafter) { this.refuse(key, 'no-family'); return 'refused'; }

    // Evidence: the clean runs' operator messages + tool-call outlines.
    const byRun = new Map(outcomes.map((o) => [o.runId, o]));
    const reqByRun = new Map<string, RequestRow>();
    for (const r of requests) if (r.runId && r.identity === 'verified' && !reqByRun.has(r.runId)) reqByRun.set(r.runId, r);
    const cleanRuns: CleanRunEvidence[] = [];
    for (const runId of floor.cleanRunIds) {
      const o = byRun.get(runId); const r = reqByRun.get(runId);
      if (!o || !r) continue;
      const slice = await this.sliceFor(o, r);
      if (slice.truncated) {
        this.refuse(key, 'evidence-cut', { runId, cuts: slice.cuts.join(',') });
        return 'refused';
      }
      cleanRuns.push({ runId, source: r.source, operatorMessage: this.deps.operatorMessage(r.source), slice });
    }
    if (cleanRuns.length === 0) { this.refuse(key, 'evidence-cut', { detail: 'no clean run evidence readable' }); return 'refused'; }

    const corrected = floor.correctedRunIds.flatMap((runId) => this.deps.correctionMessages?.(runId, key) ?? []).map(scrubSecrets);
    const built = buildDrafterPrompt({
      procedureKey: key,
      paraphrases: this.paraphrasesOf(requests),
      cleanRuns,
      correctedMessages: corrected,
      preferencesBlock: this.deps.preferencesBlock?.() ?? null,
      existingSkills: existing,
      indexCostLine: renderIndexCostLine(this.tickIndexCost),
    }, this.cfg.evidence.promptBudgetBytes);

    let raw: string | 'admission';
    try { raw = await this.callFamily(drafter, COMPONENT_DRAFTER, built.prompt); } catch (err) {
      this.refuse(key, 'provider-error', { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      return 'refused';
    }
    if (raw === 'admission') return 'admission';
    const action = parseDrafterOutput(raw);
    const recorded = this.recordJudgment({
      component: COMPONENT_DRAFTER,
      decisionPoint: 'skill-learning-draft',
      context: buildBoundedContext({ key, cleanRuns: cleanRuns.length, corrected: corrected.length, promptChars: built.prompt.length, cuts: built.cuts.length, family: drafter.family, arbiterOnly: decision.arbiterOnly }),
      optionsPresented: ['covered-by', 'patch', 'new'],
      decision: action?.action ?? 'unclassified',
      reason: action ? (action.action === 'new' ? action.skill.name : action.target) : 'unparseable',
      floor: 'patch target must carry instar-learned-origin; structural lint; cross-family review',
      fallbackRung: 'no skill',
      model: 'capable',
      door: drafter.framework,
    });
    if (!recorded) { this.refuse(key, 'unrecorded'); return 'refused'; }
    if (!action) { this.refuse(key, 'unparseable'); return 'refused'; }

    const actionRefusal = validateDraftAction(action, existing);
    if (actionRefusal) { this.refuse(key, `action:${actionRefusal}`, { target: action.action === 'new' ? '' : action.target }); return 'refused'; }
    if (action.action === 'covered-by') {
      this.hold(key, `covered-by:${action.target}`);
      this.appendLog({ kind: 'covered-by', key, skill: action.target });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'covered-by', context: { key, skill: action.target } });
      return 'refused';
    }

    const doc = action.skill;
    if (!validSkillName(doc.name)) { this.refuse(key, 'invalid-name', { name: doc.name.slice(0, 80) }); return 'refused'; }
    const patchTarget = action.action === 'patch' ? action.target : undefined;
    const lint = lintDraft(doc, {
      operatorMessages: built.operatorMessages,
      toolTargets: built.toolTargets,
      argsExcerpts: built.argsExcerpts,
      existingSkillNames: [...existing.map((s) => s.name), ...proposals.map((p) => p.sidecar.name)],
      handWrittenDescriptions: existing.filter((s) => !s.learned).map((s) => s.description),
      patchTarget,
      bodyMaxChars: DRAFT_BODY_MAX_CHARS,
    });
    if (!lint.ok) {
      this.refuse(key, `lint:${lint.refusals[0].rule}`, { rules: lint.refusals.map((r) => r.rule).join(','), detail: lint.refusals[0].detail.slice(0, 200) });
      return 'refused';
    }

    const createdAt = new Date(this.now()).toISOString();
    const sources = cleanRuns.map((r) => r.source);
    const evidence = `clean=${floor.counts.cleanRuns} corrected=${floor.counts.correctedRuns} occurrences=${floor.counts.verifiedOccurrences} src=${sources.map((s) => `${s.channel === 'telegram' ? 'tg' : 'slack'}:${s.chatId}:${s.messageId}`).join(',')}`;
    const skillMd = renderProposalSkillMd(doc, { key, createdAt, evidence });

    // Cross-family review v1.
    const reviewer = this.cfg.review.requireDifferentFamily ? pickReviewer(families, drafter.family) : (families[1] ?? families[0]);
    let reviewerFamily: string | undefined;
    let pendingReason: 'one-family' | undefined;
    if (!reviewer) {
      pendingReason = 'one-family';
      this.counters.oneFamilyHolds++;
    } else {
      const reviewPrompt = buildReviewPrompt({
        skillMd, flags: lint.flags, operatorMessages: built.operatorMessages,
        outlines: cleanRuns.map((r, i) => renderOutline(r.slice, String(i + 1))), drafterFamily: drafter.family,
        indexCostLine: renderIndexCostLine(this.tickIndexCost),
      });
      let reviewRaw: string | 'admission';
      try { reviewRaw = await this.callFamily(reviewer, COMPONENT_REVIEWER, reviewPrompt); } catch (err) {
        this.refuse(key, 'provider-error', { stage: 'review', error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        return 'refused';
      }
      if (reviewRaw === 'admission') return 'admission';
      const verdict = parseReviewOutput(reviewRaw, lint.flags);
      const reviewRecorded = this.recordJudgment({
        component: COMPONENT_REVIEWER,
        decisionPoint: 'skill-learning-review',
        context: buildBoundedContext({ key, name: doc.name, flags: lint.flags.length, struck: verdict?.struck.length ?? null, family: reviewer.family, drafterFamily: drafter.family, promptChars: reviewPrompt.length }),
        optionsPresented: ['pass', 'refuse'],
        decision: verdict ? (verdict.pass ? 'pass' : 'refuse') : 'unclassified',
        reason: verdict?.reason ?? 'unparseable',
        floor: 'different family than the drafter; every flagged line explicitly cleared',
        fallbackRung: 'refuse',
        model: 'capable',
        door: reviewer.framework,
      });
      if (!reviewRecorded) { this.refuse(key, 'unrecorded', { stage: 'review' }); return 'refused'; }
      if (!verdict || !verdict.pass) {
        this.counters.reviewsFailed++;
        // A struck policy-relaxation line goes to Attention, as the correction sentinel does.
        for (const id of verdict?.struck ?? []) {
          const f = lint.flags.find((x) => x.id === id);
          if (f?.rule === 'policy-relaxation') void this.raiseAttention({
            id: `skill-learning:policy-relaxation:${doc.name}`, conditionKey: `skill-learning:policy-relaxation:${doc.name}`,
            title: `Skill draft "${doc.name}" tried to relax a policy`, summary: `The reviewer struck: ${f.line.slice(0, 160)}`,
            category: 'skill-learning', priority: 'NORMAL', silent: true,
          });
        }
        this.refuse(key, 'review', { name: doc.name, follows: verdict?.follows ?? null, struck: (verdict?.struck ?? []).join(',') });
        return 'refused';
      }
      this.counters.reviewsPassed++;
      reviewerFamily = reviewer.family;
      // §3.9 cost strike: a SIGNAL in this slice — logged with the measurement, the draft is accepted (default accept;
      // struck drafts join the operator sample so the strike has a positive control).
      if (verdict.costStrike) {
        this.counters.costStrikes++;
        this.appendLog({
          kind: 'index-cost', key, name: doc.name, verdict: 'strike', accepted: true, reason: verdict.costReason ?? null, reviewerFamily: reviewer.family,
          indexBytes: this.tickIndexCost?.totalBytes ?? null, claudeHeadroomChars: this.tickIndexCost?.claudeHeadroomChars ?? null,
          descriptionBytes: Buffer.byteLength(doc.description, 'utf-8'),
        });
        this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'index-cost-strike', context: { key, name: doc.name, accepted: true, indexBytes: this.tickIndexCost?.totalBytes ?? null } });
      }
    }

    if (target === 'canonical') {
      return this.liveCreate({ key, doc, skillMd, createdAt, evidence, sources, runIds: cleanRuns.map((r) => r.runId), reviewerFamily, pendingReason, decision, requests, draftKind: action.action, flags: lint.flags.length });
    }

    const sidecar: ProposalSidecar = {
      name: doc.name, key, arbiterOnly: decision.arbiterOnly, disagreement: decision.disagreement, reviewerFamily, pendingReason, createdAt,
      evidence: { sources, runIds: cleanRuns.map((r) => r.runId) },
      draftKind: action.action, description: doc.description, paraphrases: this.paraphrasesOf(requests),
    };
    this.writeProposal(sidecar, skillMd);
    this.counters.draftsWritten++;
    this.appendLog({ kind: 'would-create', key, name: doc.name, draftKind: action.action, arbiterOnly: decision.arbiterOnly, disagreement: decision.disagreement, reviewerFamily: reviewerFamily ?? null, pendingReason: pendingReason ?? null, evidence, flags: lint.flags.length });
    this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'would-create', context: { key, name: doc.name, draftKind: action.action, arbiterOnly: decision.arbiterOnly, reviewerFamily: reviewerFamily ?? null, pendingReason: pendingReason ?? null } });
    return 'written';
  }

  /**
   * Live write (§3.5): the canonical goes through the commit protocol — `pending` (unrendered) while rung 2 is
   * unproven or only one family reviewed, `active` after. The sentinel never writes a skills directory itself.
   * A refused commit holds the key like any refusal (`draft-refused: commit:<reason>`); nothing is half-written
   * (the protocol journals its own recovery).
   */
  private async liveCreate(input: {
    key: string; doc: ParsedSkillDoc; skillMd: string; createdAt: string; evidence: string; sources: RowSource[]; runIds: string[];
    reviewerFamily?: string; pendingReason?: 'one-family'; decision: ArbiterDecision; requests: RequestRow[]; draftKind: 'new' | 'patch'; flags: number;
  }): Promise<'written' | 'refused'> {
    const { key, doc } = input;
    const protocol = this.deps.commitProtocol;
    if (!protocol) {
      // Misconfiguration, not a reason to lose the draft: report it once per tick and keep the shadow proposal.
      this.counters.liveFallbacks++;
      this.deps.degradation?.report({
        feature: 'SkillLearningSentinel', primary: 'mode: live (commit protocol)', fallback: 'shadow proposal written instead',
        reason: 'no commit protocol was wired', impact: 'Learned skills are not written to the canonical layout until the protocol is wired; proposals accumulate.',
      });
      const sidecar: ProposalSidecar = {
        name: doc.name, key, arbiterOnly: input.decision.arbiterOnly, disagreement: input.decision.disagreement, reviewerFamily: input.reviewerFamily, pendingReason: input.pendingReason, createdAt: input.createdAt,
        evidence: { sources: input.sources, runIds: input.runIds }, draftKind: input.draftKind, description: doc.description, paraphrases: this.paraphrasesOf(input.requests),
      };
      this.writeProposal(sidecar, input.skillMd);
      this.counters.draftsWritten++;
      this.appendLog({ kind: 'would-create', key, name: doc.name, draftKind: input.draftKind, arbiterOnly: input.decision.arbiterOnly, disagreement: input.decision.disagreement, reviewerFamily: input.reviewerFamily ?? null, pendingReason: input.pendingReason ?? null, evidence: input.evidence, flags: input.flags, liveFallback: 'no-commit-protocol' });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: 'live-no-commit-protocol', context: { key, name: doc.name } });
      return 'written';
    }
    const rungProven = this.rungTwoProven();
    const pendingReason: PendingSidecar['pendingReason'] | undefined = input.pendingReason ?? (rungProven ? undefined : 'rung-unproven');
    const state: Extract<LearnedCanonicalState, 'pending' | 'active'> = pendingReason ? 'pending' : 'active';
    const raw = renderProposalSkillMd(doc, { key, createdAt: input.createdAt, evidence: input.evidence, state });
    let res: Awaited<ReturnType<CommitProtocolLike['write']>>;
    try {
      res = await protocol.write('create', doc.name, raw, { expectedPrevHash: null, reason: `skill-learning create (${state}${pendingReason ? `: ${pendingReason}` : ''})` });
    } catch (err) {
      res = { ok: false, reason: 'invalid', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
    if (!res.ok) {
      this.counters.commitRefusals++;
      this.refuse(key, `commit:${res.reason}`, { name: doc.name, detail: (res.detail ?? '').slice(0, 200) });
      return 'refused';
    }
    if (state === 'pending') {
      this.counters.pendingCreates++;
      this.writePendingSidecar({
        name: doc.name, key, description: doc.description, paraphrases: this.paraphrasesOf(input.requests), reviewerFamily: input.reviewerFamily,
        pendingReason: pendingReason!, createdAt: input.createdAt, evidence: { sources: input.sources, runIds: input.runIds },
        disagreement: input.decision.disagreement, arbiterOnly: input.decision.arbiterOnly,
      });
    } else {
      this.counters.liveCreates++;
    }
    this.counters.draftsWritten++;
    this.appendLog({
      kind: 'create', state, key, name: doc.name, draftKind: input.draftKind, arbiterOnly: input.decision.arbiterOnly, disagreement: input.decision.disagreement,
      reviewerFamily: input.reviewerFamily ?? null, pendingReason: pendingReason ?? null, evidence: input.evidence, flags: input.flags,
      txId: res.txId, fileHash: res.fileHash, version: res.version, epoch: res.epoch, fence: res.fence,
    });
    this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: state === 'pending' ? 'pending' : 'create', context: { key, name: doc.name, draftKind: input.draftKind, reviewerFamily: input.reviewerFamily ?? null, pendingReason: pendingReason ?? null, version: res.version, fence: res.fence } });
    return 'written';
  }

  private writePendingSidecar(sidecar: PendingSidecar): void {
    writeFileAtomic(path.join(this.pendingSidecarDir, `${sidecar.name}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  private readPendingSidecar(name: string): PendingSidecar | null {
    const s = readJson<PendingSidecar>(path.join(this.pendingSidecarDir, `${name}.json`));
    return s && typeof s.name === 'string' && typeof s.key === 'string' ? s : null;
  }

  private removePendingSidecar(name: string): void {
    try { SafeFsExecutor.safeRmSync(path.join(this.pendingSidecarDir, `${name}.json`), { force: true, operation: 'skill-learning-sentinel:pending-sidecar' }); } catch (err) {
      this.log(`[SkillLearningSentinel] pending sidecar removal failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The canonical SKILL.md of a learned skill, parsed, with its whole-file hash; null when absent or not learned. */
  private readCanonical(name: string): { raw: string; fileHash: string; doc: ParsedSkillDoc; state: string } | null {
    let raw: string;
    try { raw = fs.readFileSync(path.join(this.canonicalRoot, name, 'SKILL.md'), 'utf-8'); } catch { return null; } // @silent-fallback-ok — absent canonical reads as none
    const meta = skillMeta(raw);
    if (!meta?.learned) return null;
    return { raw, fileHash: sha256(raw), doc: meta.doc, state: meta.doc.metadata[LEARNED_STATE_KEY] ?? 'active' };
  }

  private measureIndexCost(): IndexCostReading | null {
    try { return this.deps.indexCost ? this.deps.indexCost() : measureIndexCost({ projectDir: this.deps.projectDir, now: this.now }); } catch (err) { // @silent-fallback-ok — logged below; an unmeasurable index cost is reported as unknown to the prompts (never a fabricated number), per the spec's unmeasurable rule
      this.log(`[SkillLearningSentinel] index-cost measurement failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async sliceFor(o: OutcomeRow, r: RequestRow): Promise<RunSlice> {
    const file = this.deps.transcriptPath({ sessionName: o.sessionName ?? r.sessionName, topicId: o.topicId, runId: o.runId });
    if (!file) return { steps: [], truncated: true, cuts: ['unreadable'], scannedBytes: 0, windowCovered: false, stepsInWindow: 0 };
    const start = Date.parse(o.windowStart);
    const end = o.windowEnd ? Date.parse(o.windowEnd) : this.now();
    return readRunSlice({
      transcriptPath: file, windowStartMs: Number.isFinite(start) ? start : 0, windowEndMs: Number.isFinite(end) ? end : this.now(),
      transcriptScanBytes: this.cfg.evidence.transcriptScanBytes, runSliceBytesPerRun: this.cfg.evidence.runSliceBytesPerRun,
    });
  }

  /** Refuse a draft: durable hold until the re-ask horizon, log row, evidence row. */
  private refuse(key: string, reason: RefusalReason, context: Record<string, string | number | boolean | null> = {}): void {
    this.counters.draftsRefused++;
    this.hold(key, `draft-refused: ${reason}`);
    this.appendLog({ kind: 'draft-refused', key, reason, ...context });
    this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'held', reason: `draft-refused: ${reason}`, context: { key, ...context } });
  }

  /** Persist a default-rung `wait` with the re-ask horizon so the key is not re-drafted every tick. */
  private hold(key: string, reason: string): void {
    const nowMs = this.now();
    const row: VerdictRow = {
      kind: 'verdict', eventId: crypto.randomUUID(), procedureKey: key, by: 'default-rung', verdict: 'wait', reason,
      expiresAt: new Date(nowMs + Math.max(1, this.cfg.shadow.verdictReaskDays) * 86_400_000).toISOString(),
      at: new Date(nowMs).toISOString(), machineId: this.deps.machineId,
    };
    this.deps.ledger.append(row);
  }

  private writeProposal(sidecar: ProposalSidecar, skillMd: string): void {
    const dir = path.join(this.proposalsDir, sidecar.name);
    writeFileAtomic(path.join(dir, 'SKILL.md'), skillMd);
    writeFileAtomic(path.join(dir, 'proposal.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  // ─── Growth signal (§3.3, attention item 6) ─────────────────────────

  private async checkGrowthSignal(): Promise<void> {
    const nowMs = this.now();
    const limit = Math.max(0, Math.floor(this.cfg.growthSignals.createdPerWeekNotice));
    const recent = this.loadProposals().filter((p) => { const t = Date.parse(p.sidecar.createdAt); return Number.isFinite(t) && nowMs - t <= WEEK_MS; });
    if (recent.length <= limit) return;
    const state = readJson<SentinelState>(this.statePath) ?? {};
    const last = state.growthNoticeAt ? Date.parse(state.growthNoticeAt) : NaN;
    if (Number.isFinite(last) && nowMs - last < WEEK_MS) return;
    const names = recent.map((p) => `${p.sidecar.name}${p.sidecar.arbiterOnly ? ' (arbiter-only)' : ''}`).join(', ');
    await this.raiseAttention({
      id: 'skill-learning:growth', conditionKey: 'skill-learning:growth', silent: true, category: 'skill-learning', priority: 'LOW',
      title: `${recent.length} skill proposals in 7 days (notice at ${limit})`,
      summary: `Proposals this week: ${names}. This is a signal for your review, not a limit — nothing was refused.`,
    });
    this.counters.growthNotices++;
    writeFileAtomic(this.statePath, `${JSON.stringify({ ...state, growthNoticeAt: new Date(nowMs).toISOString() }, null, 2)}\n`);
    this.appendLog({ kind: 'growth-signal', proposals7d: recent.length, limit });
    this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'growth-signal', context: { proposals7d: recent.length, limit } });
  }

  private async raiseAttention(item: SkillLearningAttentionItem): Promise<void> {
    if (!this.deps.createAttentionItem) return;
    try { await this.deps.createAttentionItem(item); } catch (err) {
      this.log(`[SkillLearningSentinel] attention item failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Disk reads ─────────────────────────────────────────────────────

  /** Every existing skill: canonical `.instar/skills`, plus `.claude/skills` and `.agents/skills` renderings. */
  loadExistingSkills(): ExistingSkill[] {
    const out: ExistingSkill[] = [];
    const seen = new Set<string>();
    for (const rel of ['.instar/skills', '.claude/skills', '.agents/skills']) {
      const root = path.join(this.deps.projectDir, rel);
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; } // @silent-fallback-ok — an absent layout is simply no skills there
      for (const e of entries) {
        if (!e.isDirectory() || seen.has(e.name)) continue;
        let text: string;
        try { text = fs.readFileSync(path.join(root, e.name, 'SKILL.md'), 'utf-8'); } catch { continue; } // @silent-fallback-ok — a dir without SKILL.md is not a skill
        const meta = skillMeta(text);
        if (!meta) continue;
        seen.add(e.name);
        out.push({ name: e.name, description: meta.doc.description, learned: meta.learned, location: rel });
      }
    }
    return out;
  }

  loadProposals(): LoadedProposal[] {
    const out: LoadedProposal[] = [];
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.proposalsDir, { withFileTypes: true }); } catch { return out; } // @silent-fallback-ok — no proposals yet
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.proposalsDir, e.name);
      const sidecar = readJson<ProposalSidecar>(path.join(dir, 'proposal.json'));
      if (sidecar && typeof sidecar.name === 'string' && typeof sidecar.key === 'string') out.push({ sidecar, dir });
    }
    return out;
  }

  private appendLog(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.logPath, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), machineId: this.deps.machineId, ...row })}\n`, { mode: 0o600 });
    } catch (err) {
      this.log(`[SkillLearningSentinel] log append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── One-expression construction for server.ts ──────────────────────

  /**
   * Build the whole slice-1 stack (Ledger → SeamFilter → Outcomes → Classifier → this sentinel) from the
   * server's objects, so server.ts needs exactly one expression:
   *   `const s = SkillLearningSentinel.create({...}); server.setSkillLearningSentinel(s); s.start();`
   * `start()` opens the ledger cache (async, off the boot path), re-opens outcome runs, and installs the seam
   * filter the adapters' links resolve per message (server.ts attaches the links; create() never re-attaches).
   * `stop()` uninstalls the filter and closes the cache. Every branch lives here, none in server.ts.
   */
  static create(input: SkillLearningCreateInput): SkillLearningSentinel {
    const now = input.now ?? (() => Date.now());
    const log = input.logger ?? (() => {});
    const cfg = input.config;
    const ledger = new Ledger({ stateDir: input.stateDir, machineId: input.machineId, windowDays: cfg.defaultGate.windowDays, now, logger: log });
    const outcomes = new Outcomes({
      ledger, machineId: input.machineId, stateDir: input.stateDir, projectDir: input.projectDir, windowDays: cfg.defaultGate.windowDays,
      transcriptScanBytes: cfg.evidence.transcriptScanBytes, findSession: input.findSession, sessionClockEnd: input.sessionClockEnd, holdsLease: input.holdsLease,
      versionLookup: input.versionLookup ?? versionLookupFromStore(input.versionStore), now, logger: log,
    });
    // Slice 2 readers. Mode is read LIVE from the agent's config file (the ladder's advance writes it there); an
    // unreadable file keeps the construction value. Rung 2 is read from the ladder's feature view: proven when the
    // feature sits at `fleet`, or is `ready-to-advance` towards it from `dev-agent-live`; anything else (or no
    // ladder) is unproven — pending is the conservative side.
    const readMode = input.readMode ?? ((): SkillLearningMode | null => {
      const raw = readJson<{ monitoring?: { skillLearning?: { mode?: unknown } } }>(path.join(input.stateDir, 'config.json'));
      const m = raw?.monitoring?.skillLearning?.mode;
      return m === 'live' ? 'live' : m === 'shadow' ? 'shadow' : null;
    });
    const rungTwoProven = input.rungTwoProven ?? ((): boolean => {
      const f = input.ladder?.features().find((x) => x.id === SKILL_LEARNING_FEATURE);
      if (!f) return false;
      return f.rung === 'fleet' || (f.rung === 'dev-agent-live' && f.next === 'fleet' && f.state === 'ready-to-advance');
    });
    const admins = (): Array<{ permissions: string[]; channels: Array<{ type: string; identifier: string }> }> => {
      try { return input.userManager?.listUsers() ?? []; } catch { return []; } // @silent-fallback-ok — an unreadable user list means no Slack admin resolves (rows stay not-operator)
    };
    const filter = new SeamFilter({
      ledger, machineId: input.machineId,
      operatorUidForTopic: (topicId) => { try { return input.topicOperatorStore.asVerifiedOperator(topicId)?.uid ?? null; } catch { return null; } }, // @silent-fallback-ok — no binding ⇒ not-operator
      slackAdminUser: (uid) => admins().some((u) => u.permissions.includes('admin') && u.channels.some((c) => c.type === 'slack' && c.identifier === uid)),
      slackTopicId: input.slackTopicId,
      hasOutstandingConfirmation: input.hasOutstandingConfirmation,
      detector: input.detector === undefined ? HumanAsDetectorLog.getInstance() : input.detector ?? undefined,
      topicMemory: input.topicMemory ?? undefined,
      onEvent: (e) => outcomes.observe(e),
      now, logger: log,
    });
    const queue = new LlmQueue({ maxConcurrent: 1, maxDailyCents: Math.max(0, cfg.llm.maxDailyCents), now });
    // Provenance: every judgment is recorded; a write-error delta inside a tick refuses the rest of that tick (§3).
    let writeErrorsAtTickStart: number | null = null;
    const writeErrors = (): number => input.provenanceLog?.status().counters.writeErrors ?? 0;
    const provenance: JudgmentRecorder = {
      recordDecision: (row) => input.provenanceLog ? input.provenanceLog.recordDecision(row) : null,
      isRecordingLive: () => input.provenanceLog !== null && input.provenanceLog !== undefined && (writeErrorsAtTickStart === null || writeErrors() === writeErrorsAtTickStart),
    };
    const classifier = new Classifier({
      ledger, machineId: input.machineId, topicMemory: input.topicMemory, intelligence: input.sharedIntelligence, queue,
      provenance: input.provenanceLog ?? null, degradation: input.degradationReporter ?? null, outcomes, batchSize: cfg.llm.batchSize, retryAfterDays: cfg.shadow.verdictReaskDays, now, logger: log,
    });
    // Families: one provider per reachable framework, through the same tier resolver the cross-model reviewer uses.
    // Order: the drafter override (per-component routing) or the default framework first, then the rest.
    // grok-build (excluded from internal routing by its spec) and pi-cli (untrusted for review) never serve here.
    const build = input.buildProvider ?? ((fw: DrafterFramework) => buildIntelligenceProvider({ framework: fw }));
    const cache = new Map<DrafterFramework, IntelligenceProvider | null>();
    const isDrafterFramework = (f: unknown): f is DrafterFramework => f === 'claude-code' || f === 'codex-cli' || f === 'gemini-cli';
    const families = (): FamilyProvider[] => {
      const enabled = (input.frameworks?.enabled?.length ? input.frameworks.enabled : [input.frameworks?.default ?? 'claude-code']).filter(isDrafterFramework);
      const first = input.frameworks?.overrides?.['skillLearning.drafter'] ?? input.frameworks?.default ?? enabled[0];
      const ordered = [...new Set([first, ...enabled])].filter((f): f is DrafterFramework => isDrafterFramework(f) && enabled.includes(f));
      const out: FamilyProvider[] = [];
      for (const fw of ordered) {
        if (!cache.has(fw)) { try { cache.set(fw, build(fw)); } catch { cache.set(fw, null); } } // @silent-fallback-ok — an unbuildable framework is simply not reachable
        const provider = cache.get(fw);
        if (!provider) continue;
        out.push({
          family: familyOfFramework(fw), framework: fw,
          // The component literal is re-stated here so the funnel callsite carries its own attribution (lint-llm-attribution).
          evaluate: (prompt, opts) => opts.attribution.component === 'skillLearning.reviewer'
            ? provider.evaluate(prompt, { ...opts, attribution: { component: 'skillLearning.reviewer', deferrable: true } })
            : provider.evaluate(prompt, { ...opts, attribution: { component: 'skillLearning.drafter', deferrable: true } }),
        });
      }
      return out;
    };
    const messageText = (source: RowSource): string | null => {
      const row = ledger.requestBySource(source);
      if (!row || !input.topicMemory) return null;
      const topicId = Number(row.topicId);
      if (!Number.isFinite(topicId)) return null;
      const since = new Date(Math.max(0, Date.parse(row.at) - 60_000)).toISOString();
      try {
        const hit = input.topicMemory.getMessagesSince(topicId, since, 200).messages.find((m) => String(m.messageId) === source.messageId && m.fromUser);
        return hit ? hit.text : null;
      } catch { return null; } // @silent-fallback-ok — an unreadable TopicMemory reads as "message unavailable" in the prompt
    };
    const sentinel = new SkillLearningSentinel({
      config: cfg, stateDir: input.stateDir, projectDir: input.projectDir, machineId: input.machineId, ledger,
      ingest: { ingestNew: async () => { writeErrorsAtTickStart = writeErrors(); await ledger.ingestNew(); } },
      classifier,
      outcomes: { close: () => { outcomes.tick(); } },
      counters: () => ({ filtered: filter.filtered(), classifierFailures24h: classifier.counters().classifierFailures24h, pendingBacklog: ledger.pendingCount() }),
      families,
      transcriptPath: (run) => {
        const session = run.sessionName ? input.findSession?.(run.sessionName) : undefined;
        if (!session?.claudeSessionId) return null;
        const file = resolveFrameworkTranscriptPath({ framework: session.framework ?? 'claude-code', sessionId: session.claudeSessionId, projectDir: input.projectDir });
        return file || null;
      },
      operatorMessage: messageText,
      correctionMessages: (runId) => { const closedBy = ledger.latestOutcome(runId)?.closedBy; const text = closedBy ? messageText(closedBy) : null; return text ? [text] : []; },
      preferencesBlock: input.preferencesBlock,
      createAttentionItem: input.createAttentionItem ?? (input.telegram?.createAttentionItem ? (item) => input.telegram!.createAttentionItem!(item) : undefined),
      degradation: input.degradationReporter ?? null,
      provenance,
      evidence: input.featureEvidence ?? null,
      queue,
      bound: {
        start: () => { installSkillLearningSeamFilter(filter); void ledger.start().then(() => outcomes.start()).catch((err) => log(`[SkillLearningSentinel] ledger start failed: ${err instanceof Error ? err.message : String(err)}`)); },
        stop: () => { installSkillLearningSeamFilter(null); ledger.close(); },
      },
      unlinkedMessages: skillLearningUnlinkedMessages,
      holdsLease: input.holdsLease,
      commitProtocol: input.commitProtocol ?? null,
      versionStore: input.versionStore ?? null,
      mode: () => readMode() ?? cfg.mode,
      rungTwoProven,
      indexCost: input.indexCost,
      now, logger: log,
    });
    return sentinel;
  }

  // ─── SkillLearningSentinelLike ──────────────────────────────────────

  status(): SkillLearningStatus {
    const keys = this.deps.ledger.keys();
    const proposals = this.loadProposals();
    const skills = this.learnedSkillSummaries(keys.map((k) => k.procedureKey));
    const ext = this.deps.counters?.() ?? {};
    const versions = this.readVersionsState();
    return {
      machine: this.deps.machineId,
      enabled: this.cfg.enabled,
      mode: this.mode(),
      counts: {
        requests: keys.reduce((n, k) => n + k.requests, 0),
        verified: keys.reduce((n, k) => n + k.verifiedRequests, 0),
        keys: keys.length,
        proposals: proposals.length,
        skills: skills.length,
      },
      channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' },
      pendingBacklog: ext.pendingBacklog ?? this.deps.ledger.pendingCount(),
      classifierFailures24h: ext.classifierFailures24h ?? 0,
      abortedUnreachable24h: ext.abortedUnreachable24h ?? 0,
      filtered: ext.filtered ?? { 'not-user': 0, forwarded: 0, 'not-operator': 0, 'confirmation-reply': 0, 'slack-asserted': 0 },
      skills,
      proposals: proposals.map((p) => this.proposalSummary(p.sidecar)),
      pending: this.pendingSummaries(),
      retired: [],
      lastTickAt: this.lastTickAt,
      llmSpendCentsToday: this.queue.getDailySpendCents(),
      unlinkedMessages: this.deps.unlinkedMessages?.() ?? 0,
      observeOnly: !this.holdsLease(),
      epochSuperseded: versions.epochSuperseded,
      splitBrain: versions.splitBrain,
    };
  }

  /** The sentinel's own counters (observability; not part of the route contract). */
  internalCounters(): Readonly<typeof this.counters> & { lastTick: TickSummary | null } {
    return { ...this.counters, lastTick: this.lastTick };
  }

  skill(name: string): LearnedSkillSummary | ProposalSummary | null {
    if (!validSkillName(name)) return null;
    const learned = this.learnedSkillSummaries(this.deps.ledger.keys().map((k) => k.procedureKey), { includePending: true }).find((s) => s.name === name);
    if (learned) return learned;
    const p = this.loadProposals().find((x) => x.sidecar.name === name);
    return p ? this.proposalSummary(p.sidecar) : null;
  }

  recordOperatorVerdict(name: string, verdict: 'agree' | 'disagree', reason?: string): { ok: true } | { ok: false; error: string } {
    if (!validSkillName(name)) return { ok: false, error: 'invalid-name' };
    if (verdict !== 'agree' && verdict !== 'disagree') return { ok: false, error: 'invalid-verdict' };
    const p = this.loadProposals().find((x) => x.sidecar.name === name);
    if (!p) return { ok: false, error: 'proposal-not-found' };
    const at = new Date(this.now()).toISOString();
    const cleanReason = reason ? scrubSecrets(String(reason)).replace(/\s+/g, ' ').trim().slice(0, 240) : undefined;
    try {
      const next: ProposalSidecar = { ...p.sidecar, verdict: { by: 'operator', verdict, ...(cleanReason ? { reason: cleanReason } : {}), at } };
      writeFileAtomic(path.join(p.dir, 'proposal.json'), `${JSON.stringify(next, null, 2)}\n`);
      this.deps.ledger.append({
        kind: 'verdict', eventId: crypto.randomUUID(), procedureKey: p.sidecar.key, by: 'operator', verdict, reason: cleanReason, at, machineId: this.deps.machineId,
      });
      this.appendLog({ kind: 'operator-verdict', key: p.sidecar.key, name, verdict, reason: cleanReason ?? null });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'outcome', reason: `operator-${verdict}`, outcome: verdict === 'agree' ? 'right' : 'wrong', gradedBy: 'operator', context: { key: p.sidecar.key, name, arbiterOnly: p.sidecar.arbiterOnly } });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `write-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ─── Slice 2: pending → confirm / reject (§3.5 one-tap confirmation) ──

  /** Every canonical in state `pending`, as the console lists it (body + paraphrases on the first screen). */
  pendingSummaries(): PendingSummary[] {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.canonicalRoot, { withFileTypes: true }); } catch { return []; } // @silent-fallback-ok — no canonical layout yet
    const out: PendingSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !validSkillName(e.name)) continue;
      const c = this.readCanonical(e.name);
      if (!c || c.state !== 'pending') continue;
      const side = this.readPendingSidecar(e.name);
      const version = Number.parseInt(c.doc.metadata['instar-learned-version'] ?? '1', 10);
      out.push({
        name: e.name, description: c.doc.description, paraphrases: side?.paraphrases ?? [],
        ...(side?.reviewerFamily ? { reviewerFamily: side.reviewerFamily } : {}),
        pendingReason: side?.pendingReason ?? 'rung-unproven',
        fileHash: c.fileHash, createdAt: c.doc.metadata['instar-learned-created'] ?? side?.createdAt ?? '', version: Number.isFinite(version) ? version : 1,
      });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Serialize taps per name so a double tap observes the first tap's outcome (idempotent on `(name, fileHash)`). */
  private serialized<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.pendingOps.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.pendingOps.set(name, next.catch(() => undefined));
    void next.finally(() => { if (this.pendingOps.get(name) === next) this.pendingOps.delete(name); }).catch(() => undefined);
    return next;
  }

  /**
   * The operator's confirm tap: `pending` → `active` through `write('confirm')` (expectedPrevHash = the pending
   * file's hash), the activation stamp starts the 7-day "new" label. Already active ⇒ ok (idempotent); absent or
   * not learned ⇒ `pending-not-found`; any other state ⇒ `not-pending`.
   */
  confirmPending(name: string, opts: { forwardedFromMachine?: string } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!validSkillName(name)) return Promise.resolve({ ok: false, error: 'invalid-name' });
    return this.serialized(name, async () => {
      const c = this.readCanonical(name);
      if (!c) return { ok: false, error: 'pending-not-found' };
      if (c.state === 'active') { this.removePendingSidecar(name); return { ok: true }; }
      if (c.state !== 'pending') return { ok: false, error: 'not-pending' };
      const protocol = this.deps.commitProtocol;
      if (!protocol) return { ok: false, error: 'no-commit-protocol' };
      const at = new Date(this.now()).toISOString();
      const next = withLearnedMetadata(c.raw, { [LEARNED_STATE_KEY]: 'active', [LEARNED_ACTIVATED_KEY]: at });
      if (!next) return { ok: false, error: 'unparseable-canonical' };
      // §3.5 step 3: the fence is the version-row chain, never the file we just read — a hand edit of a pending
      // canonical is a conflict the protocol locks `operator-owned`, surfaced as such.
      const expectedPrevHash = this.chainHash(name, c.fileHash);
      let res: Awaited<ReturnType<CommitProtocolLike['write']>>;
      try { res = await protocol.write('confirm', name, next, { expectedPrevHash: expectedPrevHash.hash, reason: 'operator confirm tap' }); } catch (err) {
        return { ok: false, error: `commit-failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!res.ok) return this.tapRefused('confirm', name, res, expectedPrevHash, c.fileHash, opts);
      this.counters.confirms++;
      this.removePendingSidecar(name);
      this.appendLog({ kind: 'confirm', name, prevFileHash: expectedPrevHash.hash, chain: expectedPrevHash.source, fileHash: res.fileHash, version: res.version, txId: res.txId, forwardedFromMachine: opts.forwardedFromMachine ?? null });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'confirm', context: { name, version: res.version, forwardedFromMachine: opts.forwardedFromMachine ?? null } });
      return { ok: true };
    });
  }

  /**
   * The operator's reject tap: the body becomes a shadow proposal (state `proposal`, an operator `disagree`
   * verdict recorded so the §3.4 sample sees it), then `write('reject')` retires the pending canonical so nothing
   * stays rendered. A name with no pending canonical but a proposal already holding it ⇒ ok (idempotent).
   */
  rejectPending(name: string, opts: { forwardedFromMachine?: string } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!validSkillName(name)) return Promise.resolve({ ok: false, error: 'invalid-name' });
    return this.serialized(name, async () => {
      const c = this.readCanonical(name);
      if (!c) {
        const already = this.loadProposals().find((p) => p.sidecar.name === name && p.sidecar.verdict?.reason === 'rejected pending skill');
        return already ? { ok: true } : { ok: false, error: 'pending-not-found' };
      }
      if (c.state !== 'pending') return { ok: false, error: 'not-pending' };
      const protocol = this.deps.commitProtocol;
      if (!protocol) return { ok: false, error: 'no-commit-protocol' };
      const at = new Date(this.now()).toISOString();
      const side = this.readPendingSidecar(name);
      const key = c.doc.metadata['instar-learned-key'] ?? side?.key ?? '';
      const proposalMd = withLearnedMetadata(c.raw, { [LEARNED_STATE_KEY]: 'proposal' });
      if (!proposalMd) return { ok: false, error: 'unparseable-canonical' };
      const sidecar: ProposalSidecar = {
        name, key, arbiterOnly: side?.arbiterOnly ?? false, disagreement: side?.disagreement ?? null, reviewerFamily: side?.reviewerFamily,
        pendingReason: side?.pendingReason === 'one-family' ? 'one-family' : undefined, createdAt: c.doc.metadata['instar-learned-created'] ?? side?.createdAt ?? at,
        evidence: side?.evidence ?? { sources: [], runIds: [] }, draftKind: 'new', description: c.doc.description, paraphrases: side?.paraphrases ?? [],
        verdict: { by: 'operator', verdict: 'disagree', reason: 'rejected pending skill', at },
      };
      // The proposal first (nothing is lost if the commit aborts), then the canonical leaves the layout.
      try { this.writeProposal(sidecar, proposalMd); } catch (err) {
        return { ok: false, error: `proposal-write-failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const expectedPrevHash = this.chainHash(name, c.fileHash);
      let res: Awaited<ReturnType<CommitProtocolLike['write']>>;
      try { res = await protocol.write('reject', name, proposalMd, { expectedPrevHash: expectedPrevHash.hash, reason: 'operator reject tap' }); } catch (err) {
        return { ok: false, error: `commit-failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!res.ok) return this.tapRefused('reject', name, res, expectedPrevHash, c.fileHash, opts);
      this.counters.rejects++;
      this.removePendingSidecar(name);
      if (key) {
        this.deps.ledger.append({ kind: 'verdict', eventId: crypto.randomUUID(), procedureKey: key, by: 'operator', verdict: 'disagree', reason: 'rejected pending skill', at, machineId: this.deps.machineId });
      }
      this.appendLog({ kind: 'reject', name, key, prevFileHash: expectedPrevHash.hash, chain: expectedPrevHash.source, txId: res.txId, forwardedFromMachine: opts.forwardedFromMachine ?? null });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'reject', context: { name, key, forwardedFromMachine: opts.forwardedFromMachine ?? null } });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'outcome', reason: 'operator-reject-pending', outcome: 'wrong', gradedBy: 'operator', context: { name, key } });
      return { ok: true };
    });
  }

  /** The hash a write fences against: the version chain's last live row; the on-disk hash only when no store is wired (said so in the log). */
  private chainHash(name: string, onDisk: string): { hash: string; source: 'version-row' | 'on-disk' } {
    const store = this.deps.versionStore;
    if (!store) return { hash: onDisk, source: 'on-disk' };
    let fromChain: string | null = null;
    try { fromChain = store.expectedPrevHash(name); } catch (err) {
      this.log(`[SkillLearningSentinel] version chain unreadable for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // No row at all (a canonical that predates the store): the on-disk hash is the only fence there is.
    return fromChain === null ? { hash: onDisk, source: 'on-disk' } : { hash: fromChain, source: 'version-row' };
  }

  private tapRefused(tap: 'confirm' | 'reject', name: string, res: Extract<Awaited<ReturnType<CommitProtocolLike['write']>>, { ok: false }>, expected: { hash: string; source: string }, onDisk: string, opts: { forwardedFromMachine?: string }): { ok: false; error: string } {
    this.appendLog({ kind: `${tap}-refused`, name, reason: res.reason, detail: (res.detail ?? '').slice(0, 200), expectedPrevHash: expected.hash, chain: expected.source, onDiskFileHash: onDisk, forwardedFromMachine: opts.forwardedFromMachine ?? null });
    if (res.reason === 'user-edit-conflict') {
      this.removePendingSidecar(name);   // the canonical is operator-owned now; it is no longer a pending skill
      return { ok: false, error: 'user-edit-conflict' };
    }
    return { ok: false, error: `commit:${res.reason}${res.detail ? ` (${res.detail.slice(0, 160)})` : ''}` };
  }

  // ─── Slice 2: post-sync epoch reconciliation (deviation (t)) ───────────

  private readVersionsState(): NonNullable<SentinelState['versions']> {
    const state = readJson<SentinelState>(this.statePath) ?? {};
    return state.versions ?? { handled: {}, epochSuperseded: 0, splitBrain: 0, locked: 0 };
  }

  private writeVersionsState(versions: NonNullable<SentinelState['versions']>): void {
    const state = readJson<SentinelState>(this.statePath) ?? {};
    writeFileAtomic(this.statePath, `${JSON.stringify({ ...state, versions }, null, 2)}\n`);
  }

  /**
   * For every learned canonical on disk, classify its whole-file hash against the synced version shards
   * (`VersionStore.reconcileAfterSync`) and perform the body-level consequence ONCE per (name, hash):
   *   - `superseded`  — a lower-epoch body lost to a newer holder: its body becomes a proposal
   *     (`pendingReason: 'superseded'`) and the canonical is locked `operator-owned` so the stale body never
   *     renders (the winner's body is not held here; a later sync or the operator restores it);
   *   - `split-brain` — equal epochs, different bodies: the on-disk body becomes a proposal, every other candidate
   *     is named in the log (its body is not on this machine), the canonical is locked;
   *   - `unknown-hash` — a body no row carries (an LLM merge or an edit): locked `operator-owned`.
   * Locks go through the protocol (`write('lock')`, fenced on the chain; a chain mismatch is the protocol's own
   * operator-owned lock, reported as such). A canonical already `operator-owned` is left alone, so the phase
   * settles: a second tick over the same tree emits nothing.
   */
  async reconcileVersions(): Promise<{ examined: number; superseded: number; splitBrain: number; unknownHash: number; locks: number }> {
    const out = { examined: 0, superseded: 0, splitBrain: 0, unknownHash: 0, locks: 0 };
    const store = this.deps.versionStore;
    if (!store) return out;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.canonicalRoot, { withFileTypes: true }); } catch { return out; } // @silent-fallback-ok — no canonical layout yet ⇒ nothing to reconcile
    const versions = this.readVersionsState();
    let dirty = false;
    for (const e of entries) {
      if (!e.isDirectory() || !validSkillName(e.name)) continue;
      const c = this.readCanonical(e.name);
      if (!c) continue;
      out.examined++;
      if (versions.handled[e.name] === c.fileHash) continue;                 // this exact body was already judged here
      let outcome: SyncReconcileOutcomeLike;
      try { outcome = store.reconcileAfterSync(e.name, c.fileHash); } catch (err) {
        this.log(`[SkillLearningSentinel] reconcileAfterSync failed for ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (outcome.kind === 'no-rows' || outcome.kind === 'in-sync') continue;
      versions.handled[e.name] = c.fileHash;
      dirty = true;
      // Already operator-owned: the consequence was performed (by this phase or by the protocol's own conflict lock);
      // the lock is the durable marker, so the phase settles here — nothing is re-logged or re-written.
      const alreadyLocked = c.state === 'operator-owned' || c.doc.metadata['instar-learned-locked'] === 'true';
      if (alreadyLocked) continue;
      if (outcome.kind === 'superseded') {
        out.superseded++; versions.epochSuperseded++; this.counters.epochSuperseded++;
        const proposal = this.demoteToProposal(e.name, c, 'superseded', `epoch ${outcome.loser.epoch} (${outcome.loser.machineId}) lost to epoch ${outcome.winner.epoch} (${outcome.winner.machineId})`);
        this.appendLog({ kind: 'epoch-superseded', name: e.name, onDiskFileHash: c.fileHash, loser: { epoch: outcome.loser.epoch, machineId: outcome.loser.machineId, version: outcome.loser.version }, winner: { epoch: outcome.winner.epoch, machineId: outcome.winner.machineId, version: outcome.winner.version, fileHash: outcome.winner.fileHash }, tombstoned: outcome.tombstoned, proposal });
        this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'epoch-superseded', context: { name: e.name, loserEpoch: outcome.loser.epoch, winnerEpoch: outcome.winner.epoch } });
        if (await this.lockOperatorOwned(e.name, c, `epoch-superseded: the winner's body (epoch ${outcome.winner.epoch}) is not on this machine; the stale body must not render`)) { out.locks++; versions.locked++; }
      } else if (outcome.kind === 'split-brain') {
        out.splitBrain++; versions.splitBrain++; this.counters.splitBrain++;
        const here = outcome.candidates.find((r) => r.fileHash === c.fileHash) ?? null;
        const elsewhere = outcome.candidates.filter((r) => r.fileHash !== c.fileHash);
        const proposal = this.demoteToProposal(e.name, c, 'split-brain', `epoch ${outcome.epoch} split: ${outcome.candidates.map((r) => `${r.machineId}@${r.fileHash.slice(0, 12)}`).join(' vs ')}`);
        const absent = elsewhere.map((r) => this.recordAbsentCandidate(e.name, r, outcome.epoch));
        this.appendLog({ kind: 'split-brain', name: e.name, epoch: outcome.epoch, onDiskFileHash: c.fileHash, onDiskCandidate: here ? { machineId: here.machineId, version: here.version } : null, candidates: outcome.candidates.map((r) => ({ machineId: r.machineId, version: r.version, fileHash: r.fileHash, at: r.at })), proposal, bodiesNotOnThisMachine: absent });
        this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'split-brain', context: { name: e.name, epoch: outcome.epoch, candidates: outcome.candidates.length } });
        if (await this.lockOperatorOwned(e.name, c, `split-brain at epoch ${outcome.epoch}: ${outcome.candidates.length} bodies; nothing renders until the operator chooses`)) { out.locks++; versions.locked++; }
      } else {
        out.unknownHash++;
        this.appendLog({ kind: 'unknown-hash', name: e.name, onDiskFileHash: c.fileHash, winner: { epoch: outcome.winner.epoch, machineId: outcome.winner.machineId, version: outcome.winner.version, fileHash: outcome.winner.fileHash } });
        this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'unknown-hash', context: { name: e.name, winnerEpoch: outcome.winner.epoch } });
        if (await this.lockOperatorOwned(e.name, c, 'unknown-hash: the on-disk body matches no version row (a merge or an edit)')) { out.locks++; versions.locked++; }
      }
    }
    if (dirty) this.writeVersionsState(versions);
    return out;
  }

  /** The on-disk body as a shadow proposal (`<name>-<reason>-<hash8>`), with the reason on the sidecar. Returns the proposal name, or null when it could not be written. */
  private demoteToProposal(name: string, c: { raw: string; fileHash: string; doc: ParsedSkillDoc }, reason: 'superseded' | 'split-brain', detail: string): string | null {
    const proposalName = `${name}-${reason}-${c.fileHash.slice(0, 8)}`;
    const md = withLearnedMetadata(c.raw, { [LEARNED_STATE_KEY]: 'proposal', 'instar-learned-locked': 'false' })?.replace(/^(---\r?\nname:)[^\n]*/, `$1 ${proposalName}`) ?? null;
    if (!md || !validSkillName(proposalName)) return null;
    const sidecar: ProposalSidecar = {
      name: proposalName, key: c.doc.metadata['instar-learned-key'] ?? '', arbiterOnly: false, disagreement: null, pendingReason: reason,
      createdAt: new Date(this.now()).toISOString(), evidence: { sources: [], runIds: [] }, draftKind: 'new',
      description: `${c.doc.description} [${reason}: ${detail}; body of ${name} at ${c.fileHash.slice(0, 12)}]`.slice(0, 512), paraphrases: [],
    };
    try { this.writeProposal(sidecar, md); return proposalName; } catch (err) { // @silent-fallback-ok — the failure is named in the epoch-superseded/split-brain log row (`proposal: null`) and the canonical is still locked; nothing renders
      this.log(`[SkillLearningSentinel] could not write ${reason} proposal for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** A split-brain candidate whose body is NOT on this machine: a proposal sidecar naming where it is (no body is fabricated). */
  private recordAbsentCandidate(name: string, r: VersionRowLike, epoch: number): { machineId: string; fileHash: string; proposal: string | null } {
    const proposalName = `${name}-split-brain-${r.fileHash.slice(0, 8)}`;
    if (!validSkillName(proposalName)) return { machineId: r.machineId, fileHash: r.fileHash, proposal: null };
    const sidecar: ProposalSidecar = {
      name: proposalName, key: '', arbiterOnly: false, disagreement: null, pendingReason: 'split-brain', createdAt: new Date(this.now()).toISOString(),
      evidence: { sources: [], runIds: [] }, draftKind: 'new', paraphrases: [],
      description: `[split-brain at epoch ${epoch}] body of ${name} written by ${r.machineId} (version ${r.version}, ${r.fileHash.slice(0, 12)}) — not on this machine; it is on ${r.machineId}'s canonical before the sync`,
    };
    try { writeFileAtomic(path.join(this.proposalsDir, proposalName, 'proposal.json'), `${JSON.stringify(sidecar, null, 2)}\n`); return { machineId: r.machineId, fileHash: r.fileHash, proposal: proposalName }; } catch (err) { // @silent-fallback-ok — the candidate is still named in the split-brain log row (`proposal: null`); the lock below is what protects the tree
      this.log(`[SkillLearningSentinel] could not record split-brain candidate for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return { machineId: r.machineId, fileHash: r.fileHash, proposal: null };
    }
  }

  /**
   * Lock a canonical `operator-owned` through the protocol, fenced on the version chain. A chain mismatch is the
   * protocol's own operator-owned lock (`user-edit-conflict`): also a lock. Anything else (fence refused on a
   * standby, invalid) is logged; the (name, hash) is still marked handled here — one attempt per body per machine.
   */
  private async lockOperatorOwned(name: string, c: { raw: string; fileHash: string }, reason: string): Promise<boolean> {
    const protocol = this.deps.commitProtocol;
    if (!protocol) { this.appendLog({ kind: 'lock-refused', name, reason: 'no-commit-protocol', detail: reason }); return false; }
    const locked = withLearnedMetadata(c.raw, { [LEARNED_STATE_KEY]: 'operator-owned', 'instar-learned-locked': 'true' });
    if (!locked) { this.appendLog({ kind: 'lock-refused', name, reason: 'unparseable-canonical', detail: reason }); return false; }
    const expected = this.chainHash(name, c.fileHash);
    let res: Awaited<ReturnType<CommitProtocolLike['write']>>;
    try { res = await protocol.write('lock', name, locked, { expectedPrevHash: expected.hash, reason }); } catch (err) { // @silent-fallback-ok — a thrown write becomes a refused result: logged as `lock-refused` below with the error text, attempted once per (name, hash)
      res = { ok: false, reason: 'invalid', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
    const lockedByProtocol = !res.ok && res.reason === 'user-edit-conflict';
    if (res.ok || lockedByProtocol) {
      this.counters.versionLocks++;
      this.appendLog({ kind: 'lock', name, by: res.ok ? 'sentinel' : 'protocol-conflict', expectedPrevHash: expected.hash, chain: expected.source, onDiskFileHash: c.fileHash, detail: reason, ...(res.ok ? { txId: res.txId, version: res.version, fileHash: res.fileHash } : { protocolDetail: (res.detail ?? '').slice(0, 200) }) });
      this.evidence.record(SKILL_LEARNING_FEATURE, { kind: 'fired', reason: 'lock', context: { name, by: res.ok ? 'sentinel' : 'protocol-conflict' } });
      return true;
    }
    this.appendLog({ kind: 'lock-refused', name, reason: res.reason, detail: `${reason}; ${(res.detail ?? '').slice(0, 160)}`, expectedPrevHash: expected.hash, chain: expected.source });
    return false;
  }

  private proposalSummary(s: ProposalSidecar): ProposalSummary {
    return { name: s.name, key: s.key, arbiterOnly: s.arbiterOnly, disagreement: s.disagreement ?? (s.arbiterOnly ? 'arbiter-only' : null), createdAt: s.createdAt, reviewerFamily: s.reviewerFamily, pendingReason: s.pendingReason, verdict: s.verdict, paraphrases: s.paraphrases, description: s.description };
  }

  /**
   * Learned canonicals under `.instar/skills` with their §3.6 counts from the ledger. `pending` canonicals are
   * listed by `status().pending`, not here (unless `includePending`, for a by-name read). A use whose rendering
   * the operator had edited (`skillUsed.operatorEdited`) is EXCLUDED from every score and counted in
   * `operatorEdited` (§3.9 join hardening).
   */
  private learnedSkillSummaries(keys: string[], opts: { includePending?: boolean } = {}): LearnedSkillSummary[] {
    const root = this.canonicalRoot;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; } // @silent-fallback-ok — no canonical layout yet
    const learned: Array<{ name: string; doc: ParsedSkillDoc }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(root, e.name, 'SKILL.md'), 'utf-8'); } catch { continue; } // @silent-fallback-ok — not a skill dir
      const meta = skillMeta(text);
      if (!meta?.learned) continue;
      if (meta.doc.metadata[LEARNED_STATE_KEY] === 'pending' && !opts.includePending) continue;
      learned.push({ name: e.name, doc: meta.doc });
    }
    if (learned.length === 0) return [];
    const uses = new Map<string, { uses: number; accepted: number; inferred: number; corrected: number; unknown: number; weak: number; corroborated: number; misfires: number; operatorEdited: number; lastUsedAt?: string }>();
    for (const key of keys) {
      for (const o of this.deps.ledger.outcomesForKey(key)) {
        if (!o.skillUsed) continue;
        const u = uses.get(o.skillUsed.skill) ?? { uses: 0, accepted: 0, inferred: 0, corrected: 0, unknown: 0, weak: 0, corroborated: 0, misfires: 0, operatorEdited: 0 };
        if (o.skillUsed.operatorEdited) {
          // The operator's edited rendering ran, not the version: reported, never scored.
          u.operatorEdited++;
          if (!u.lastUsedAt || o.at > u.lastUsedAt) u.lastUsedAt = o.at;
          uses.set(o.skillUsed.skill, u);
          continue;
        }
        u.uses++;
        if (o.skillUsed.corroborated) u.corroborated++;
        if (o.misfire) u.misfires++;
        if (o.label === 'accepted') u.accepted++;
        else if (o.label === 'accepted-inferred') u.inferred++;
        else if (o.label === 'corrected' || o.label === 'redo') u.corrected++;
        else if (o.label === 'weak-positive') u.weak++;
        else u.unknown++;
        if (!u.lastUsedAt || o.at > u.lastUsedAt) u.lastUsedAt = o.at;
        uses.set(o.skillUsed.skill, u);
      }
    }
    const nowMs = this.now();
    return learned.map(({ name, doc }) => {
      const u = uses.get(name) ?? { uses: 0, accepted: 0, inferred: 0, corrected: 0, unknown: 0, weak: 0, corroborated: 0, misfires: 0, operatorEdited: 0 };
      const measured = u.accepted + u.inferred + u.corrected;
      const score = measured > 0 ? (u.accepted + 0.5 * u.inferred + 1) / (u.accepted + 0.5 * u.inferred + u.corrected + 2) : null;
      const state = doc.metadata[LEARNED_STATE_KEY];
      const version = Number.parseInt(doc.metadata['instar-learned-version'] ?? '1', 10);
      // The 7-day "new" label counts from activation (the confirm tap) or, for a skill written active, creation.
      const since = Date.parse(doc.metadata[LEARNED_ACTIVATED_KEY] ?? doc.metadata['instar-learned-created'] ?? '');
      const isNew = (state === undefined || state === 'active') && Number.isFinite(since) && nowMs - since >= 0 && nowMs - since < NEW_LABEL_MS;
      return {
        name,
        state: state === 'retired' ? 'retired' : state === 'proposal' || state === 'pending' ? 'proposal' : doc.metadata['instar-learned-locked'] === 'true' ? 'locked' : 'learned',
        score, uses: u.uses, accepted: u.accepted, acceptedInferred: u.inferred, corrected: u.corrected, unknown: u.unknown, weakPositive: u.weak,
        measurableRate: u.uses > 0 ? u.corroborated / u.uses : null, misfires: u.misfires,
        version: Number.isFinite(version) ? version : 1, lastUsedAt: u.lastUsedAt,
        locked: doc.metadata['instar-learned-locked'] === 'true',
        operatorEdited: u.operatorEdited,
        isNew,
      } satisfies LearnedSkillSummary;
    });
  }
}
