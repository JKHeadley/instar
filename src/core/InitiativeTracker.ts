/**
 * InitiativeTracker — persists and queries multi-phase, long-running work.
 *
 * Fills the gap between one-off AttentionItems (single actionable) and
 * scheduled Jobs (recurring cron task). An Initiative represents a
 * bounded-but-multi-week effort with phases, each advancing in order.
 *
 * Storage:
 *   - When TaskFlow is wired (`setTaskFlowRegistry`), TaskFlow is the
 *     **single source of truth** (per OPENCLAW-IMPORT-TASKFLOW-SPEC.md
 *     § Phase 4, lines 645–648). Each initiative is one TaskFlow record:
 *     `controllerId="InitiativeTracker"`, `ownerKey="initiative:<id>"`,
 *     `idempotencyKey="initiative:<id>"`. The full Initiative shape is
 *     persisted in `stateJson`. The active phase id maps to `currentStep`;
 *     `needsUser` / blockers map to `setFlowWaiting({kind:"human-review"})`.
 *   - When TaskFlow is NOT wired, behavior falls back to legacy
 *     `.instar/initiatives.json`. This keeps the disabled-feature path
 *     working for installs where `taskFlow.enabled` is false.
 *
 * Migration:
 *   - On startup, the server calls `migrateExistingToTaskFlow()` once when
 *     TaskFlow is enabled. It backfills any initiatives present in the
 *     legacy JSON file into TaskFlow. Idempotent via `findIdempotent` on
 *     `(controllerId, ownerKey, idempotencyKey)` — running twice produces
 *     no duplicates.
 *
 * API shape:
 *   - All public mutators are `async` to allow TaskFlow's promise-based
 *     write API to complete before returning. Reads are `sync` (TaskFlow's
 *     read API uses `better-sqlite3` synchronously through the in-memory
 *     cache).
 *
 * Consumers: HTTP routes (`/initiatives/*`), dashboard "Initiatives" tab,
 * daily digest job (alerts when initiatives go stale / need user input /
 * are ready to advance).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TaskFlowRegistry } from '../tasks/TaskFlowRegistry.js';
import type { DriftVerdict } from './types.js';
import type {
  TaskFlowPrincipal,
  TaskFlowRecord,
  WaitJson,
} from '../tasks/task-flow-types.js';
import { TaskFlowError } from '../tasks/task-flow-types.js';

export type InitiativePhaseStatus = 'pending' | 'in-progress' | 'done' | 'blocked';

export interface InitiativePhase {
  /** Stable identifier within this initiative (e.g. 'phase-a'). */
  id: string;
  /** Human-readable name (e.g. 'Phase A: Scaffolding'). */
  name: string;
  /** Short summary of what this phase delivers. */
  summary?: string;
  status: InitiativePhaseStatus;
  /** ISO timestamp when status first became 'in-progress'. */
  startedAt?: string;
  /** ISO timestamp when status first became 'done'. */
  completedAt?: string;
}

export type InitiativeStatus =
  | 'active'
  | 'completed'
  | 'archived'
  | 'abandoned'
  | 'paused'
  | 'halted'
  | 'awaiting-user';

export type InitiativeKind = 'task' | 'project';

/** Post-ship rollout stages for a ships-staged feature. The stage is DERIVED
 *  from observing the feature's config flag (never written by the driver) —
 *  GRADUATED-FEATURE-ROLLOUT-SPEC §4.2-4.3. */
export type RolloutStage = 'dark' | 'dry-run' | 'live' | 'default-on';

export type MaturationMetricSource = 'blocker-summary' | 'blocker-trend' | 'feature-summary';
export type MaturationMetricDirection = 'at-least' | 'at-most';

export interface MaturationMetricContract {
  id: string;
  source: MaturationMetricSource;
  sourceRef: string;
  direction: MaturationMetricDirection;
  threshold: number;
  minSamples: number;
}

export interface MaturationEvaluationContract {
  cadenceHours: number;
  evidenceMaxAgeHours: number;
  metrics: MaturationMetricContract[];
}

export type MaturationLadderRung = 'test-agent-live' | 'dev-agent-live' | 'fleet';
export type RolloutAccountingDisposition = 'active' | 'composed' | 'excluded';

/** Complete rollout-accounting row. Active rows derive rung from the observed
 * flag; composed/excluded rows are intentionally rung-null and never gain a
 * control seam of their own. */
export interface RolloutAccountingInfo {
  disposition: RolloutAccountingDisposition;
  sourcePrNumber: number;
  rung: MaturationLadderRung | null;
  ownerFeatureId?: string;
  exclusionReason?: string;
  evidenceSource?: { type: 'log-filter' | 'endpoint'; ref: string; filter?: string };
  graduationCriterion?: string;
  maturationEvaluation?: MaturationEvaluationContract;
  maturationContractError?: 'invalid-json' | 'oversized' | 'invalid-shape' | 'unknown-source-ref';
}

/** Typed rollout metadata for a ships-staged feature task. Operational criteria
 *  live here (typed), NOT in free-form phase summaries. */
export interface RolloutInfo {
  /** Dotted config key whose observed value derives the stage, e.g.
   *  'monitoring.sessionReaper'. The driver NEVER writes this. */
  flagPath: string;
  /** Stage derived from the last observed flag value. */
  stage: RolloutStage;
  /** Where the twice-weekly driver gathers promotion evidence. */
  evidenceSource?: { type: 'log-filter' | 'endpoint'; ref: string; filter?: string };
  /** Human-readable promotion gate (e.g. "≥2wk + ≥3 genuinely-idle would-reaps"). */
  promotionCriteria?: string;
  /** D7: bounded numeric contract evaluated on the shared blocker-lifecycle
   * metrics substrate. Evaluation is advisory and never advances this track. */
  maturationEvaluation?: MaturationEvaluationContract;
  /** Near-silent edge dedupe: last time a needs-user line was surfaced for this track. */
  lastDigestNotifiedAt?: string;
}

export type PipelineStage =
  | 'outline'
  | 'spec-drafted'
  | 'spec-converged'
  | 'approved'
  | 'building'
  | 'merged'
  | 'regressed'
  | 'skipped';

export type RoundStatus =
  | 'pending'
  | 'ready'
  | 'in-progress'
  | 'partially-complete'
  | 'complete'
  | 'complete-with-skips'
  | 'failed'
  | 'regressed';

export interface InitiativeRound {
  name: string;
  /** Child initiative IDs in this round. */
  itemIds: string[];
  status: RoundStatus;
  /** ISO; populated when prior round completes and this one becomes ready. */
  autoAdvanceAt?: string;
  completedAt?: string;
  haltedAt?: string;
  haltReason?: string;
  /** Counter; round-runner caps this at 3. */
  resumeAttempts?: number;
  /** Cached drift verdict from the most recent attempt. See DriftVerdict in types.ts. */
  lastDriftVerdict?: DriftVerdict;
  /** ISO timestamp the lastDriftVerdict was computed; round-runner uses this for the 24h freshness window. */
  lastDriftVerdictAt?: string;
  /** Hashes of referenced files at verdict time; round-runner re-runs drift if any changed. */
  lastDriftReferencedFileHashes?: Record<string, string>;
}

export interface InitiativeConflictPatch {
  patchId: string;
  recordId: string;
  path: string;
  oursValue: unknown;
  theirsValue: unknown;
  baseValue?: unknown;
  losingMachineId: string;
  capturedAt: string;
}

export interface InitiativeLink {
  type: 'spec' | 'pr' | 'commit' | 'topic' | 'doc' | 'other';
  label: string;
  url?: string;
  ref?: string;
}

export interface Initiative {
  /** URL-safe slug (stable identifier). */
  id: string;
  title: string;
  description: string;
  status: InitiativeStatus;
  phases: InitiativePhase[];
  /** Index into phases[] of the phase currently active (or last worked on). */
  currentPhaseIndex: number;
  /** ISO timestamp of the last phase/status update. */
  lastTouchedAt: string;
  /** Optional ISO timestamp; digest job flags if past and status === 'active'. */
  nextCheckAt?: string;
  /** True when waiting on the user (decision, approval, ratification). */
  needsUser: boolean;
  /** Short rationale when needsUser === true. */
  needsUserReason?: string;
  /** Free-text list of current blockers (not necessarily user-blocked). */
  blockers: string[];
  /** External references: spec docs, PRs, commits, Telegram topics, etc. */
  links: InitiativeLink[];
  createdAt: string;
  updatedAt: string;

  // ── Project-scope additions (Phase 1.1) ──────────────────────────
  // All fields below are OPTIONAL. Pre-project-scope records leave them
  // undefined; backfill writes `kind: 'task' + schemaVersion: 1` to legacy
  // records on first load.

  /** Distinguishes leaf work items ('task') from rollups ('project').
   *  Immutable after creation. Defaults to 'task' when omitted. */
  kind?: InitiativeKind;
  /** Bumped on backfill / migration. */
  schemaVersion?: number;
  /** Optimistic concurrency counter. Increments on every successful write.
   *  Starts at 1 on create. */
  version?: number;
  /** Back-pointer to a project that lists this child in `rounds[].itemIds`. */
  parentProjectId?: string;

  // Child-only fields (only meaningful when `kind === 'task'`):
  pipelineStage?: PipelineStage;
  /** Relative to repo root; required for stages ≥ 'spec-drafted'. */
  specPath?: string;
  /** Required for stages = 'building' or 'merged'. */
  prNumber?: number;
  /** GitHub-reported merge commit; recorded at building → merged. */
  mergeCommitOid?: string;
  /** ISO; last revalidation against origin/main. */
  ciCheckedAt?: string;
  skippedAt?: string;
  skippedBy?: string;
  skippedReason?: string;
  /** Recorded on skipped → outline reverse transition. */
  unskippedAt?: string;
  /** Default true at runtime; false marks infrastructure-of-tracker specs. */
  driftCheck?: boolean;
  /** Post-ship rollout track (ships-staged features). Present only when the
   *  feature matures behind a flag. Stage is derived from observing flagPath. */
  rollout?: RolloutInfo;
  rolloutAccounting?: RolloutAccountingInfo;
  /** Immutable exact-key link from the feedback-drain outbox. One work key may
   *  identify at most one Initiative task; semantic matching never substitutes. */
  feedbackWorkKey?: string;

  // Project-only fields (only meaningful when `kind === 'project'`):
  rounds?: InitiativeRound[];
  /** Paths jailed to project-root allowlist. */
  sourceDocs?: string[];
  /** Default true at runtime. */
  autoAdvance?: boolean;
  /** For round-complete and halt notifications. */
  telegramTopicId?: string;
  /** Current round owner (Phase 1.5). */
  ownerMachineId?: string;
  /** Absolute path to the target source repo; required for projects. */
  targetRepoPath?: string;
  /** Increments on each auto-advance without ack; pauses project at ≥ 2. */
  unacknowledgedAdvanceCount?: number;
  /** Populated when user acks the first-launch digest. */
  firstLaunchAckAt?: string;
  /** Highest round index acked. */
  lastAckedRoundIndex?: number;
  /** Populated by git-sync conflict handler (Phase 1.12). */
  awaitingReconciliation?: InitiativeConflictPatch[];
  /** For cache invalidation on drift-prompt edits. */
  driftPromptTemplateVersion?: number;
}

export interface InitiativeCreateInput {
  id: string;
  title: string;
  description: string;
  phases: Array<{ id: string; name: string; summary?: string; status?: InitiativePhaseStatus }>;
  links?: InitiativeLink[];
  nextCheckAt?: string;
  needsUser?: boolean;
  needsUserReason?: string;
  blockers?: string[];

  // ── Project-scope additions ─────────────────────────────────────
  /** Defaults to 'task' if omitted. Immutable after creation. */
  kind?: InitiativeKind;
  parentProjectId?: string;
  pipelineStage?: PipelineStage;
  specPath?: string;
  prNumber?: number;
  mergeCommitOid?: string;
  ciCheckedAt?: string;
  driftCheck?: boolean;
  rollout?: RolloutInfo;
  rolloutAccounting?: RolloutAccountingInfo;
  /** Immutable exact-key link from the feedback-drain outbox. */
  feedbackWorkKey?: string;
  rounds?: InitiativeRound[];
  sourceDocs?: string[];
  autoAdvance?: boolean;
  telegramTopicId?: string;
  ownerMachineId?: string;
  targetRepoPath?: string;
  driftPromptTemplateVersion?: number;
}

export interface InitiativeUpdateInput {
  title?: string;
  description?: string;
  status?: InitiativeStatus;
  nextCheckAt?: string | null;
  needsUser?: boolean;
  needsUserReason?: string | null;
  blockers?: string[];
  links?: InitiativeLink[];

  // ── Project-scope additions ─────────────────────────────────────
  /** Optimistic concurrency guard. When provided, must equal the current
   *  `version` or update() throws `OccVersionMismatchError`. Backward
   *  compatible: callers that omit ifMatch get unconditional writes. */
  ifMatch?: number;
  /** Presence triggers immutability check: any value that differs from
   *  the current `kind` throws `KindImmutableError`. */
  kind?: InitiativeKind;
  /** Set to a project id to attach; set to null to clear. Bidirectional
   *  validation against the named project's `rounds[].itemIds` runs on set. */
  parentProjectId?: string | null;
  pipelineStage?: PipelineStage;
  specPath?: string | null;
  prNumber?: number | null;
  mergeCommitOid?: string | null;
  ciCheckedAt?: string | null;
  skippedAt?: string | null;
  skippedBy?: string | null;
  skippedReason?: string | null;
  unskippedAt?: string | null;
  driftCheck?: boolean;
  rollout?: RolloutInfo | null;
  rolloutAccounting?: RolloutAccountingInfo | null;
  rounds?: InitiativeRound[];
  sourceDocs?: string[];
  autoAdvance?: boolean;
  telegramTopicId?: string | null;
  ownerMachineId?: string | null;
  targetRepoPath?: string;
  unacknowledgedAdvanceCount?: number;
  firstLaunchAckAt?: string | null;
  lastAckedRoundIndex?: number;
  awaitingReconciliation?: InitiativeConflictPatch[];
  driftPromptTemplateVersion?: number;
}

/**
 * Thrown by `update()` when the caller supplied `ifMatch` and it didn't
 * equal the current `version`. The HTTP layer (Phase 1.3) translates this
 * to a 409 response with body `{ currentVersion }`.
 */
export class OccVersionMismatchError extends Error {
  readonly currentVersion: number;
  constructor(message: string, currentVersion: number) {
    super(message);
    this.name = 'OccVersionMismatchError';
    this.currentVersion = currentVersion;
  }
}

/**
 * Thrown by `update()` when the caller attempted to change `kind`. The
 * `kind` field is set at creation time and never changes thereafter.
 */
export class KindImmutableError extends Error {
  constructor(message = '`kind` is immutable after initiative creation') {
    super(message);
    this.name = 'KindImmutableError';
  }
}

/**
 * Thrown by `update()` when setting `parentProjectId` and the named parent
 * either doesn't exist, isn't a `kind: 'project'` initiative, or doesn't
 * list this child in any of its `rounds[].itemIds`. Bidirectional check
 * keeps the parent/child relationship internally consistent.
 */
export class InvalidParentProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParentProjectError';
  }
}

export interface DigestItem {
  initiativeId: string;
  title: string;
  reason: 'stale' | 'needs-user' | 'next-check-due' | 'ready-to-advance';
  detail: string;
}

export interface Digest {
  generatedAt: string;
  items: DigestItem[];
}

/**
 * Staleness threshold for the digest scan (7 days without an update on an
 * active initiative triggers a 'stale' flag).
 */
export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * TaskFlow controller identity for InitiativeTracker (Phase 4 migration).
 * Every initiative's flow is owned by this controllerId; the registry uses
 * it for OCC scope checks. Single instance per server process.
 */
export const INITIATIVE_TASKFLOW_CONTROLLER_ID = 'InitiativeTracker';

/**
 * JSON.stringify replacer that omits any property whose value is exactly
 * `undefined`. Native JSON.stringify already drops undefined object values,
 * but using an explicit replacer makes intent visible AND ensures we never
 * accidentally serialize a `null` for an optional field — the runtime
 * guards in `update()` already reject `null`, so this is belt-and-braces.
 *
 * Round-trip stability: a record loaded and saved without mutation
 * produces byte-identical output (asserted by the unit tests).
 */
function omitUndefinedReplacer(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}

/**
 * Reject `null` for any of the project-scope optional fields when supplied
 * via `InitiativeCreateInput`. (Update inputs are field-by-field; null
 * means "clear" for nullable fields and "reject" for the rest, enforced
 * inline in `update()`.)
 */
function rejectNullCreateInput(input: InitiativeCreateInput): void {
  const forbiddenNullKeys: Array<keyof InitiativeCreateInput> = [
    'kind',
    'parentProjectId',
    'pipelineStage',
    'specPath',
    'prNumber',
    'mergeCommitOid',
    'ciCheckedAt',
    'driftCheck',
    'feedbackWorkKey',
    'rounds',
    'sourceDocs',
    'autoAdvance',
    'telegramTopicId',
    'ownerMachineId',
    'targetRepoPath',
    'driftPromptTemplateVersion',
  ];
  for (const k of forbiddenNullKeys) {
    if ((input as unknown as Record<string, unknown>)[k as string] === null) {
      throw new Error(`Initiative create input field "${k}" must not be null`);
    }
  }
}

function ownerKeyForInitiative(initiativeId: string): string {
  return `initiative:${initiativeId}`;
}

function idempotencyKeyForInitiative(initiativeId: string): string {
  return `initiative:${initiativeId}`;
}

export class InitiativeTracker {
  private readonly filePath: string;
  /** In-process cache. Authoritative when TaskFlow is not wired; otherwise
   * a read-side projection of TaskFlow's stateJson. */
  private readonly initiatives = new Map<string, Initiative>();

  // ── TaskFlow Phase 4 wiring ────────────────────────────────────
  private taskFlowRegistry: TaskFlowRegistry | null = null;
  private taskFlowControllerInstanceId: string | null = null;

  // ── Digest cache invalidator hook (Phase 1.1) ──────────────────
  // PR 3 wires the real invalidator (clears the project-scope digest cache
  // so the next read recomputes). Until then this is a no-op. The hook
  // fires after every successful mutating call.
  private digestCacheInvalidator: () => void = () => {};

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'initiatives.json');
    this.loadFromDisk();
  }

  /**
   * Register a callback invoked once after every successful mutating call
   * (`create`, `update`, `setPhaseStatus`, `remove`). The default is a
   * no-op so legacy callers see no change. PR 3 wires the real cache
   * invalidator.
   */
  setDigestCacheInvalidator(fn: () => void): void {
    this.digestCacheInvalidator = typeof fn === 'function' ? fn : () => {};
  }

  /**
   * Wire a TaskFlow registry to make TaskFlow the source of truth.
   * Idempotent — safe to call multiple times. After wiring, all reads come
   * from TaskFlow and all writes go through TaskFlow APIs. The legacy JSON
   * file is no longer written.
   *
   * Callers are expected to call `migrateExistingToTaskFlow()` after this
   * to backfill any initiatives that were loaded from the legacy file.
   */
  setTaskFlowRegistry(
    registry: TaskFlowRegistry,
    controllerInstanceId: string
  ): void {
    this.taskFlowRegistry = registry;
    this.taskFlowControllerInstanceId = controllerInstanceId;
    // Layer existing TaskFlow records over legacy-loaded data without
    // clearing the cache: any legacy initiatives still need to be backfilled
    // via `migrateExistingToTaskFlow()`. TaskFlow records win on collision.
    this.layerCacheFromTaskFlow();
  }

  /** True when TaskFlow is wired and authoritative. */
  isTaskFlowEnabled(): boolean {
    return this.taskFlowRegistry !== null && this.taskFlowControllerInstanceId !== null;
  }

  private taskFlowPrincipal(): TaskFlowPrincipal | null {
    if (!this.taskFlowRegistry || !this.taskFlowControllerInstanceId) return null;
    return {
      scope: 'controller',
      controllerId: INITIATIVE_TASKFLOW_CONTROLLER_ID,
      controllerInstanceId: this.taskFlowControllerInstanceId,
    };
  }

  // ── Legacy JSON storage (used until TaskFlow is wired) ─────────

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(raw?.initiatives)) {
        let backfilled = 0;
        for (const item of raw.initiatives) {
          if (item && typeof item.id === 'string') {
            // Phase 1.1 idempotent backfill: legacy records (missing `kind`)
            // get `kind: 'task'` + `schemaVersion: 1`. Records that already
            // carry `kind` are untouched. Second load is a no-op because
            // nothing changes after the first pass.
            if (item.kind === undefined) {
              item.kind = 'task';
              if (item.schemaVersion === undefined) item.schemaVersion = 1;
              backfilled++;
            }
            this.initiatives.set(item.id, item as Initiative);
          }
        }
        // Rewrite the file exactly once if any record was backfilled. The
        // rewrite uses the same omit-undefined replacer as `saveToDisk()`
        // so the file is stable on a subsequent load.
        if (backfilled > 0) {
          this.saveToDisk();
        }
      }
    } catch (err) {
      console.error(`[initiatives] Failed to load: ${err instanceof Error ? err.message : err}`);
    }
  }

  private saveToDisk(): void {
    if (this.isTaskFlowEnabled()) return; // TaskFlow's SQLite is the durable store.
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = { initiatives: Array.from(this.initiatives.values()) };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, omitUndefinedReplacer, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // ── TaskFlow ↔ Initiative serialization ─────────────────────────

  private initiativeFromFlow(flow: TaskFlowRecord): Initiative | null {
    const state = flow.stateJson as { initiative?: Initiative } | undefined;
    if (!state || typeof state !== 'object' || !state.initiative) return null;
    return state.initiative;
  }

  private refreshCacheFromTaskFlow(): void {
    if (!this.taskFlowRegistry) return;
    const flows = this.taskFlowRegistry.findByControllerId(
      INITIATIVE_TASKFLOW_CONTROLLER_ID
    );
    this.initiatives.clear();
    for (const f of flows) {
      const init = this.initiativeFromFlow(f);
      // Tombstone-removed initiatives are filtered out so callers can't
      // see them via list() / get() after remove().
      if (init && !this.isTombstoned(f)) {
        this.initiatives.set(init.id, init);
      }
    }
  }

  /**
   * Layer TaskFlow data on top of the existing cache without clearing it.
   * Used during `setTaskFlowRegistry` so legacy-loaded initiatives are
   * preserved as backfill candidates while any pre-existing TaskFlow
   * records take precedence.
   */
  private layerCacheFromTaskFlow(): void {
    if (!this.taskFlowRegistry) return;
    const flows = this.taskFlowRegistry.findByControllerId(
      INITIATIVE_TASKFLOW_CONTROLLER_ID
    );
    for (const f of flows) {
      const init = this.initiativeFromFlow(f);
      if (init && !this.isTombstoned(f)) {
        this.initiatives.set(init.id, init);
      } else if (this.isTombstoned(f) && init) {
        // Tombstoned flows shadow legacy entries.
        this.initiatives.delete(init.id);
      }
    }
  }

  /**
   * A flow is "tombstoned" when remove() marked it as removed before
   * cancelling. The marker lives in stateJson._removed and is the
   * single signal that a flow's owning Initiative should be hidden from
   * list() / get(). We can't delete TaskFlow records from this layer, so
   * the marker is the durable equivalent of deletion.
   */
  private isTombstoned(flow: TaskFlowRecord): boolean {
    const state = flow.stateJson as { _removed?: boolean } | undefined;
    return state?._removed === true;
  }

  private waitJsonForInitiative(init: Initiative): WaitJson | null {
    const blocked = init.needsUser || init.blockers.length > 0;
    if (!blocked) return null;
    const reason = init.needsUser
      ? init.needsUserReason ?? 'Initiative needs user decision'
      : init.blockers.join('; ');
    const question = (reason || 'Initiative blocked').slice(0, 2000);
    return { kind: 'human-review', question };
  }

  /** Determine the desired TaskFlow status for an Initiative. */
  private desiredFlowStatus(init: Initiative):
    | { kind: 'running'; step: string }
    | { kind: 'waiting'; step: string; waitJson: WaitJson }
    | { kind: 'succeeded'; step: string }
    | { kind: 'failed'; step: string }
    | { kind: 'cancelled'; step: string } {
    const phase = init.phases[init.currentPhaseIndex];
    const step = phase ? phase.id : 'unknown';
    if (init.status === 'completed') return { kind: 'succeeded', step };
    if (init.status === 'abandoned') return { kind: 'failed', step };
    if (init.status === 'archived') return { kind: 'cancelled', step };
    const wait = this.waitJsonForInitiative(init);
    if (wait) return { kind: 'waiting', step, waitJson: wait };
    return { kind: 'running', step };
  }

  /**
   * Persist an Initiative through TaskFlow. Walks the flow state machine
   * to the desired target (running / waiting / succeeded / failed /
   * cancelled), updating `stateJson` along the way so reads see the latest
   * shape. Returns the Initiative as projected from TaskFlow after
   * transitions settle.
   */
  private async persistThroughTaskFlow(init: Initiative): Promise<Initiative> {
    const registry = this.taskFlowRegistry;
    const principal = this.taskFlowPrincipal();
    if (!registry || !principal || principal.scope !== 'controller') return init;

    const ownerKey = ownerKeyForInitiative(init.id);
    const idemKey = idempotencyKeyForInitiative(init.id);
    const desired = this.desiredFlowStatus(init);
    const stateJson = { initiative: init };

    let existing = registry.findByIdempotency(
      INITIATIVE_TASKFLOW_CONTROLLER_ID,
      ownerKey,
      idemKey
    );
    if (!existing) {
      const r = await registry.createFlow({
        controllerId: INITIATIVE_TASKFLOW_CONTROLLER_ID,
        controllerInstanceId: principal.controllerInstanceId,
        ownerKey,
        idempotencyKey: idemKey,
        goal: init.title.slice(0, 1024),
        currentStep: desired.step,
        stateJson,
      });
      existing = r.flow;
    }
    let cur = registry.getFlow(existing.flowId, { bypassCache: true }) ?? existing;

    try {
      // Already terminal? Accept and stop — terminal flows are immutable
      // per TaskFlow contract. The Initiative's local terminal state stays
      // in sync via the cache, but we never re-mutate the flow.
      if (
        cur.status === 'succeeded' ||
        cur.status === 'failed' ||
        cur.status === 'cancelled' ||
        cur.status === 'lost'
      ) {
        return this.initiativeFromFlow(cur) ?? init;
      }

      // queued → running (always; a fresh create lands in queued).
      if (cur.status === 'queued') {
        const r = await registry.startStep({
          flowId: cur.flowId,
          expectedRevision: cur.revision,
          principal,
          currentStep: desired.step,
        });
        cur = r.flow;
      }

      // waiting → running (resume), in case desired wait is different or
      // we're moving to running/terminal. resumeFlow accepts statePatch so
      // we update stateJson here too.
      if (cur.status === 'waiting') {
        if (cur.waitInstanceId) {
          const r = await registry.resumeFlow({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            principal,
            waitInstanceId: cur.waitInstanceId,
            currentStep: desired.step,
            statePatch: stateJson,
          });
          cur = r.flow;
        }
      }

      // Now cur.status === 'running'. Drive to the desired terminal state.
      if (cur.status === 'running') {
        if (desired.kind === 'running') {
          // Re-startStep when currentStep changed; this updates the step.
          if (cur.currentStep !== desired.step) {
            const r = await registry.startStep({
              flowId: cur.flowId,
              expectedRevision: cur.revision,
              principal,
              currentStep: desired.step,
            });
            cur = r.flow;
          }
          // Always patch stateJson to reflect the latest Initiative shape.
          cur = await this.patchStateJson(cur, stateJson);
        } else if (desired.kind === 'waiting') {
          const r = await registry.setFlowWaiting({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            principal,
            waitJson: desired.waitJson,
            currentStep: desired.step,
            statePatch: stateJson,
          });
          cur = r.flow;
        } else if (desired.kind === 'succeeded') {
          cur = await this.patchStateJson(cur, stateJson);
          const r = await registry.finishFlow({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            principal,
          });
          cur = r.flow;
        } else if (desired.kind === 'failed') {
          cur = await this.patchStateJson(cur, stateJson);
          const r = await registry.failFlow({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            principal,
            failureReason: 'abandoned',
          });
          cur = r.flow;
        } else if (desired.kind === 'cancelled') {
          cur = await this.patchStateJson(cur, stateJson);
          const cr = await registry.requestFlowCancel({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            requesterOrigin: { kind: 'system', id: 'InitiativeTracker' },
          });
          const r = await registry.cancelFlow({
            flowId: cur.flowId,
            expectedRevision: cr.flow.revision,
            principal,
          });
          cur = r.flow;
        }
      }
    } catch (err) {
      this.logTaskFlowError('persist', init.id, err);
    }

    const fresh = registry.getFlow(cur.flowId, { bypassCache: true }) ?? cur;
    const persisted = this.initiativeFromFlow(fresh) ?? init;
    this.initiatives.set(persisted.id, persisted);
    return persisted;
  }

  /**
   * Patch a running flow's stateJson without changing its observable
   * status. Uses a brief setFlowWaiting → resumeFlow round-trip (the only
   * atomic state-bearing transitions for `running` flows that accept
   * `statePatch`). The wait kind `'human-review'` with a sentinel question
   * is used; the wait is consumed in the same call, so no external
   * observer sees `waiting`.
   */
  private async patchStateJson(
    flow: TaskFlowRecord,
    stateJson: { initiative: Initiative }
  ): Promise<TaskFlowRecord> {
    const registry = this.taskFlowRegistry;
    const principal = this.taskFlowPrincipal();
    if (!registry || !principal || principal.scope !== 'controller') return flow;
    if (flow.status !== 'running') return flow;
    try {
      const w = await registry.setFlowWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        principal,
        waitJson: { kind: 'human-review', question: '__statePatch__' },
        statePatch: stateJson,
      });
      const r = await registry.resumeFlow({
        flowId: w.flow.flowId,
        expectedRevision: w.flow.revision,
        principal,
        waitInstanceId: w.flow.waitInstanceId!,
        statePatch: stateJson,
      });
      return r.flow;
    } catch (err) {
      this.logTaskFlowError('patchStateJson', flow.flowId, err);
      return flow;
    }
  }

  private findFlowIdForInitiative(id: string): string | null {
    const registry = this.taskFlowRegistry;
    if (!registry) return null;
    const f = registry.findByIdempotency(
      INITIATIVE_TASKFLOW_CONTROLLER_ID,
      ownerKeyForInitiative(id),
      idempotencyKeyForInitiative(id)
    );
    return f?.flowId ?? null;
  }

  private logTaskFlowError(op: string, key: string, err: unknown): void {
    if (err instanceof TaskFlowError) {
      console.warn(
        `[InitiativeTracker] taskflow ${op} for ${key} skipped: ${err.code} (${err.message})`
      );
    } else {
      console.warn(
        `[InitiativeTracker] taskflow ${op} for ${key} unexpected error:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Backfill all initiatives currently in the in-memory cache (loaded from
   * legacy JSON in the constructor) into TaskFlow. Idempotent via
   * `findIdempotent`. Safe to call multiple times.
   */
  async migrateExistingToTaskFlow(): Promise<{
    created: number;
    alreadyExisted: number;
    advanced: number;
    skipped: number;
  }> {
    const registry = this.taskFlowRegistry;
    const principal = this.taskFlowPrincipal();
    if (!registry || !principal || principal.scope !== 'controller') {
      return { created: 0, alreadyExisted: 0, advanced: 0, skipped: 0 };
    }
    let created = 0;
    let alreadyExisted = 0;
    let advanced = 0;
    let skipped = 0;
    const candidates = Array.from(this.initiatives.values());
    for (const init of candidates) {
      try {
        const ownerKey = ownerKeyForInitiative(init.id);
        const idemKey = idempotencyKeyForInitiative(init.id);
        const existing = registry.findByIdempotency(
          INITIATIVE_TASKFLOW_CONTROLLER_ID,
          ownerKey,
          idemKey
        );
        if (existing) {
          alreadyExisted++;
        } else {
          await registry.createFlow({
            controllerId: INITIATIVE_TASKFLOW_CONTROLLER_ID,
            controllerInstanceId: principal.controllerInstanceId,
            ownerKey,
            idempotencyKey: idemKey,
            goal: init.title.slice(0, 1024),
            currentStep: init.phases[init.currentPhaseIndex]?.id ?? 'start',
            stateJson: { initiative: init },
          });
          created++;
        }
        const persisted = await this.persistThroughTaskFlow(init);
        if (persisted) advanced++;
      } catch (err) {
        skipped++;
        this.logTaskFlowError('migrate', init.id, err);
      }
    }
    this.refreshCacheFromTaskFlow();
    return { created, alreadyExisted, advanced, skipped };
  }

  // ── Public API ─────────────────────────────────────────────────

  list(filter?: { status?: InitiativeStatus; kind?: InitiativeKind }): Initiative[] {
    if (this.isTaskFlowEnabled()) this.refreshCacheFromTaskFlow();
    const all = Array.from(this.initiatives.values());
    let filtered = filter?.status ? all.filter((i) => i.status === filter.status) : all;
    if (filter?.kind) {
      // Records without explicit `kind` are treated as 'task' (default).
      // Backfill writes `kind: 'task'` on load; this guard covers in-memory
      // records that haven't been persisted yet.
      const wanted = filter.kind;
      filtered = filtered.filter((i) => (i.kind ?? 'task') === wanted);
    }
    return filtered.sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt));
  }

  /**
   * Reverse-lookup by exact merge-commit OID (Ingestion-sources spec §3.1).
   * Scans via `list()` (which refreshes the TaskFlow cache) — NOT the raw
   * `this.initiatives` Map — so it stays correct under TaskFlow. Exact-OID
   * match only; never a branch/substring match. No index needed at current
   * initiative scale.
   */
  findByMergeCommit(mergeCommitOid: string): Initiative | undefined {
    if (!mergeCommitOid) return undefined;
    return this.list().find((i) => i.mergeCommitOid === mergeCommitOid);
  }

  /** Reverse-lookup by exact PR number (Ingestion-sources spec §3.1). Same TaskFlow-safe scan. */
  findByPrNumber(prNumber: number): Initiative | undefined {
    if (!Number.isFinite(prNumber)) return undefined;
    return this.list().find((i) => i.prNumber === prNumber);
  }

  /** Exact feedback-outbox lookup. Uses list() so TaskFlow remains authoritative. */
  findByFeedbackWorkKey(feedbackWorkKey: string): Initiative | undefined {
    if (!feedbackWorkKey) return undefined;
    return this.list({ kind: 'task' }).find((i) => i.feedbackWorkKey === feedbackWorkKey);
  }

  get(id: string): Initiative | undefined {
    if (this.isTaskFlowEnabled()) {
      const fid = this.findFlowIdForInitiative(id);
      if (!fid) return undefined;
      const f = this.taskFlowRegistry!.getFlow(fid, { bypassCache: true });
      if (!f) return undefined;
      if (this.isTombstoned(f)) {
        this.initiatives.delete(id);
        return undefined;
      }
      const init = this.initiativeFromFlow(f);
      if (init) this.initiatives.set(id, init);
      return init ?? undefined;
    }
    return this.initiatives.get(id);
  }

  async create(input: InitiativeCreateInput): Promise<Initiative> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.id)) {
      throw new Error('Initiative id must be lowercase kebab-case, 1–63 chars');
    }
    if (!input.phases.length) {
      throw new Error('Initiative must have at least one phase');
    }
    rejectNullCreateInput(input);
    if (input.feedbackWorkKey !== undefined) {
      if (!/^feedback-work:[a-zA-Z0-9._:-]{1,180}$/.test(input.feedbackWorkKey)) {
        throw new Error('feedbackWorkKey must be a bounded feedback-work key');
      }
      if (this.findByFeedbackWorkKey(input.feedbackWorkKey)) {
        throw new Error(`Initiative feedbackWorkKey "${input.feedbackWorkKey}" already exists`);
      }
    }
    if (this.isTaskFlowEnabled()) {
      if (this.findFlowIdForInitiative(input.id)) {
        throw new Error(`Initiative "${input.id}" already exists`);
      }
    } else if (this.initiatives.has(input.id)) {
      throw new Error(`Initiative "${input.id}" already exists`);
    }
    const now = new Date().toISOString();
    const phases: InitiativePhase[] = input.phases.map((p) => ({
      id: p.id,
      name: p.name,
      summary: p.summary,
      status: p.status ?? 'pending',
    }));
    const firstOpen = phases.findIndex((p) => p.status !== 'done');
    const currentPhaseIndex = firstOpen === -1 ? phases.length - 1 : firstOpen;
    const allDone = phases.every((p) => p.status === 'done');
    const initiative: Initiative = {
      id: input.id,
      title: input.title,
      description: input.description,
      status: allDone ? 'completed' : 'active',
      phases,
      currentPhaseIndex,
      lastTouchedAt: now,
      nextCheckAt: input.nextCheckAt,
      needsUser: input.needsUser ?? false,
      needsUserReason: input.needsUserReason,
      blockers: input.blockers ?? [],
      links: input.links ?? [],
      createdAt: now,
      updatedAt: now,

      // Project-scope: default kind to 'task' and start version at 1. Both
      // are persisted from create-time so subsequent backfill is a no-op.
      kind: input.kind ?? 'task',
      schemaVersion: 1,
      version: 1,
    };
    // Optional project-layer fields are passed through if present. Stored
    // as-is; runtime validation (parentProjectId existence, etc.) happens
    // on subsequent updates that mutate the relationship.
    if (input.parentProjectId !== undefined) initiative.parentProjectId = input.parentProjectId;
    if (input.pipelineStage !== undefined) initiative.pipelineStage = input.pipelineStage;
    if (input.specPath !== undefined) initiative.specPath = input.specPath;
    if (input.prNumber !== undefined) initiative.prNumber = input.prNumber;
    if (input.mergeCommitOid !== undefined) initiative.mergeCommitOid = input.mergeCommitOid;
    if (input.ciCheckedAt !== undefined) initiative.ciCheckedAt = input.ciCheckedAt;
    if (input.driftCheck !== undefined) initiative.driftCheck = input.driftCheck;
    if (input.rollout !== undefined) initiative.rollout = input.rollout;
    if (input.rolloutAccounting !== undefined) initiative.rolloutAccounting = input.rolloutAccounting;
    if (input.feedbackWorkKey !== undefined) initiative.feedbackWorkKey = input.feedbackWorkKey;
    if (input.rounds !== undefined) initiative.rounds = input.rounds;
    if (input.sourceDocs !== undefined) initiative.sourceDocs = input.sourceDocs;
    if (input.autoAdvance !== undefined) initiative.autoAdvance = input.autoAdvance;
    if (input.telegramTopicId !== undefined) initiative.telegramTopicId = input.telegramTopicId;
    if (input.ownerMachineId !== undefined) initiative.ownerMachineId = input.ownerMachineId;
    if (input.targetRepoPath !== undefined) initiative.targetRepoPath = input.targetRepoPath;
    if (input.driftPromptTemplateVersion !== undefined) {
      initiative.driftPromptTemplateVersion = input.driftPromptTemplateVersion;
    }

    this.initiatives.set(initiative.id, initiative);
    let result: Initiative;
    if (this.isTaskFlowEnabled()) {
      result = await this.persistThroughTaskFlow(initiative);
    } else {
      this.saveToDisk();
      result = initiative;
    }
    this.digestCacheInvalidator();
    return result;
  }

  async update(id: string, input: InitiativeUpdateInput): Promise<Initiative> {
    const existing = this.get(id);
    if (!existing) throw new Error(`Initiative "${id}" not found`);

    // ── kind immutability check (Phase 1.1) ────────────────────────
    // The `kind` field is set at creation and never mutates. We treat the
    // current kind as 'task' when undefined (legacy records pre-backfill).
    if (input.kind !== undefined) {
      const currentKind = existing.kind ?? 'task';
      if (input.kind !== currentKind) {
        throw new KindImmutableError(
          `Cannot change kind from "${currentKind}" to "${input.kind}"`
        );
      }
    }

    // ── OCC version check (Phase 1.1) ──────────────────────────────
    // Only enforce when caller supplied ifMatch — preserves backward
    // compatibility for legacy callers that never knew about versioning.
    const currentVersion = existing.version ?? 1;
    if (input.ifMatch !== undefined && input.ifMatch !== currentVersion) {
      throw new OccVersionMismatchError(
        `Initiative "${id}" version mismatch: expected ${input.ifMatch}, current ${currentVersion}`,
        currentVersion
      );
    }

    const now = new Date().toISOString();
    const next: Initiative = { ...existing, updatedAt: now, lastTouchedAt: now };
    if (input.title !== undefined) next.title = input.title;
    if (input.description !== undefined) next.description = input.description;
    if (input.status !== undefined) next.status = input.status;
    if (input.nextCheckAt !== undefined) {
      next.nextCheckAt = input.nextCheckAt === null ? undefined : input.nextCheckAt;
    }
    if (input.needsUser !== undefined) next.needsUser = input.needsUser;
    if (input.needsUserReason !== undefined) {
      next.needsUserReason = input.needsUserReason === null ? undefined : input.needsUserReason;
    }
    if (input.blockers !== undefined) next.blockers = input.blockers;
    if (input.links !== undefined) next.links = input.links;

    // ── Project-scope field updates ────────────────────────────────
    // Bidirectional parentProjectId validation: when setting (not clearing),
    // the named parent must exist as kind:'project' AND list this child in
    // rounds[].itemIds. Clearing (null) skips validation.
    if (input.parentProjectId !== undefined) {
      if (input.parentProjectId === null) {
        next.parentProjectId = undefined;
      } else {
        this.assertValidParentProject(input.parentProjectId, id);
        next.parentProjectId = input.parentProjectId;
      }
    }
    if (input.pipelineStage !== undefined) next.pipelineStage = input.pipelineStage;
    if (input.specPath !== undefined) {
      next.specPath = input.specPath === null ? undefined : input.specPath;
    }
    if (input.prNumber !== undefined) {
      next.prNumber = input.prNumber === null ? undefined : input.prNumber;
    }
    if (input.mergeCommitOid !== undefined) {
      next.mergeCommitOid = input.mergeCommitOid === null ? undefined : input.mergeCommitOid;
    }
    if (input.ciCheckedAt !== undefined) {
      next.ciCheckedAt = input.ciCheckedAt === null ? undefined : input.ciCheckedAt;
    }
    if (input.skippedAt !== undefined) {
      next.skippedAt = input.skippedAt === null ? undefined : input.skippedAt;
    }
    if (input.skippedBy !== undefined) {
      next.skippedBy = input.skippedBy === null ? undefined : input.skippedBy;
    }
    if (input.skippedReason !== undefined) {
      next.skippedReason = input.skippedReason === null ? undefined : input.skippedReason;
    }
    if (input.unskippedAt !== undefined) {
      next.unskippedAt = input.unskippedAt === null ? undefined : input.unskippedAt;
    }
    if (input.driftCheck !== undefined) next.driftCheck = input.driftCheck;
    if (input.rollout !== undefined) {
      next.rollout = input.rollout === null ? undefined : input.rollout;
    }
    if (input.rolloutAccounting !== undefined) {
      next.rolloutAccounting = input.rolloutAccounting === null ? undefined : input.rolloutAccounting;
    }
    if (input.rounds !== undefined) next.rounds = input.rounds;
    if (input.sourceDocs !== undefined) next.sourceDocs = input.sourceDocs;
    if (input.autoAdvance !== undefined) next.autoAdvance = input.autoAdvance;
    if (input.telegramTopicId !== undefined) {
      next.telegramTopicId = input.telegramTopicId === null ? undefined : input.telegramTopicId;
    }
    if (input.ownerMachineId !== undefined) {
      next.ownerMachineId = input.ownerMachineId === null ? undefined : input.ownerMachineId;
    }
    if (input.targetRepoPath !== undefined) next.targetRepoPath = input.targetRepoPath;
    if (input.unacknowledgedAdvanceCount !== undefined) {
      next.unacknowledgedAdvanceCount = input.unacknowledgedAdvanceCount;
    }
    if (input.firstLaunchAckAt !== undefined) {
      next.firstLaunchAckAt =
        input.firstLaunchAckAt === null ? undefined : input.firstLaunchAckAt;
    }
    if (input.lastAckedRoundIndex !== undefined) {
      next.lastAckedRoundIndex = input.lastAckedRoundIndex;
    }
    if (input.awaitingReconciliation !== undefined) {
      next.awaitingReconciliation = input.awaitingReconciliation;
    }
    if (input.driftPromptTemplateVersion !== undefined) {
      next.driftPromptTemplateVersion = input.driftPromptTemplateVersion;
    }

    // Bump version on every successful write.
    next.version = currentVersion + 1;

    this.initiatives.set(id, next);
    let result: Initiative;
    if (this.isTaskFlowEnabled()) {
      result = await this.persistThroughTaskFlow(next);
    } else {
      this.saveToDisk();
      result = next;
    }
    this.digestCacheInvalidator();
    return result;
  }

  /**
   * Verify that `parentId` names an existing `kind: 'project'` initiative
   * AND that one of its rounds lists `childId` in itemIds. Throws
   * `InvalidParentProjectError` on any failure. Used by `update()` when
   * a child's `parentProjectId` is set to a non-null value.
   */
  private assertValidParentProject(parentId: string, childId: string): void {
    const parent = this.get(parentId);
    if (!parent) {
      throw new InvalidParentProjectError(
        `Parent project "${parentId}" not found`
      );
    }
    if ((parent.kind ?? 'task') !== 'project') {
      throw new InvalidParentProjectError(
        `Initiative "${parentId}" is not a project (kind="${parent.kind ?? 'task'}")`
      );
    }
    const rounds = parent.rounds ?? [];
    const listed = rounds.some((r) => Array.isArray(r.itemIds) && r.itemIds.includes(childId));
    if (!listed) {
      throw new InvalidParentProjectError(
        `Project "${parentId}" does not list child "${childId}" in any round`
      );
    }
  }

  async setPhaseStatus(
    id: string,
    phaseId: string,
    status: InitiativePhaseStatus
  ): Promise<Initiative> {
    const existing = this.get(id);
    if (!existing) throw new Error(`Initiative "${id}" not found`);
    const phases = existing.phases.map((p) => ({ ...p }));
    const phase = phases.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Phase "${phaseId}" not found in "${id}"`);
    const now = new Date().toISOString();
    phase.status = status;
    if (status === 'in-progress' && !phase.startedAt) phase.startedAt = now;
    if (status === 'done' && !phase.completedAt) phase.completedAt = now;
    const firstOpen = phases.findIndex((p) => p.status !== 'done');
    const allDone = phases.every((p) => p.status === 'done');
    const next: Initiative = {
      ...existing,
      phases,
      currentPhaseIndex: firstOpen === -1 ? phases.length - 1 : firstOpen,
      status: allDone ? 'completed' : existing.status === 'completed' ? 'active' : existing.status,
      updatedAt: now,
      lastTouchedAt: now,
      version: (existing.version ?? 1) + 1,
    };
    this.initiatives.set(id, next);
    let result: Initiative;
    if (this.isTaskFlowEnabled()) {
      result = await this.persistThroughTaskFlow(next);
    } else {
      this.saveToDisk();
      result = next;
    }
    this.digestCacheInvalidator();
    return result;
  }

  async remove(id: string): Promise<boolean> {
    if (this.isTaskFlowEnabled()) {
      const fid = this.findFlowIdForInitiative(id);
      if (!fid) {
        const removed = this.initiatives.delete(id);
        if (removed) this.digestCacheInvalidator();
        return removed;
      }
      const registry = this.taskFlowRegistry!;
      const principal = this.taskFlowPrincipal();
      let flow = registry.getFlow(fid, { bypassCache: true });
      if (flow && principal && principal.scope === 'controller') {
        try {
          if (flow.status === 'queued') {
            const r = await registry.startStep({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              principal,
              currentStep: flow.currentStep ?? 'remove',
            });
            flow = r.flow;
          }
          if (flow.status === 'waiting' && flow.waitInstanceId) {
            const r = await registry.resumeFlow({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              principal,
              waitInstanceId: flow.waitInstanceId,
            });
            flow = r.flow;
          }
          // Stamp the tombstone marker into stateJson so subsequent reads
          // hide the initiative. Done before cancel because terminal flows
          // are immutable.
          const init = this.initiativeFromFlow(flow);
          if (flow.status === 'running' && init) {
            const tomb = await this.patchStateJson(
              flow,
              { initiative: init, _removed: true } as { initiative: Initiative }
            );
            flow = tomb;
          }
          if (
            flow.status !== 'succeeded' &&
            flow.status !== 'failed' &&
            flow.status !== 'cancelled' &&
            flow.status !== 'lost'
          ) {
            const cr = await registry.requestFlowCancel({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              requesterOrigin: { kind: 'system', id: 'InitiativeTracker' },
            });
            await registry.cancelFlow({
              flowId: flow.flowId,
              expectedRevision: cr.flow.revision,
              principal,
            });
          }
        } catch (err) {
          this.logTaskFlowError('remove', id, err);
        }
      }
      this.initiatives.delete(id);
      this.digestCacheInvalidator();
      return true;
    }
    const removed = this.initiatives.delete(id);
    if (removed) {
      this.saveToDisk();
      this.digestCacheInvalidator();
    }
    return removed;
  }

  /**
   * One-time backfill helper for TaskFlow-enabled installs: scans all
   * records, identifies those missing `kind`, and updates them through
   * TaskFlow. Idempotent — running twice produces no change after the
   * first pass. The legacy-JSON path runs an equivalent backfill inside
   * `loadFromDisk()` on first load.
   *
   * Returns counts so callers can log/observe what happened.
   */
  async backfillKindAndSchema(): Promise<{ backfilled: number; scanned: number }> {
    if (!this.isTaskFlowEnabled()) {
      // Legacy path is backfilled during load. A no-op here is correct
      // because the in-memory cache already reflects the backfill.
      let backfilled = 0;
      for (const init of this.initiatives.values()) {
        if (init.kind === undefined) {
          init.kind = 'task';
          if (init.schemaVersion === undefined) init.schemaVersion = 1;
          backfilled++;
        }
      }
      if (backfilled > 0) this.saveToDisk();
      return { backfilled, scanned: this.initiatives.size };
    }
    this.refreshCacheFromTaskFlow();
    let backfilled = 0;
    const records = Array.from(this.initiatives.values());
    for (const init of records) {
      if (init.kind !== undefined) continue;
      const patched: Initiative = {
        ...init,
        kind: 'task',
        schemaVersion: init.schemaVersion ?? 1,
      };
      this.initiatives.set(init.id, patched);
      await this.persistThroughTaskFlow(patched);
      backfilled++;
    }
    return { backfilled, scanned: records.length };
  }

  /**
   * Scan active initiatives for anything actionable. Empty items[] means
   * "quiet day, don't spam the user."
   */
  digest(now: Date = new Date()): Digest {
    if (this.isTaskFlowEnabled()) this.refreshCacheFromTaskFlow();
    const items: DigestItem[] = [];
    const nowMs = now.getTime();
    for (const initiative of this.initiatives.values()) {
      if (initiative.status !== 'active') continue;

      if (initiative.needsUser) {
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'needs-user',
          detail: initiative.needsUserReason ?? 'Needs your decision.',
        });
        continue;
      }

      if (initiative.nextCheckAt) {
        const checkMs = Date.parse(initiative.nextCheckAt);
        if (Number.isFinite(checkMs) && checkMs <= nowMs) {
          items.push({
            initiativeId: initiative.id,
            title: initiative.title,
            reason: 'next-check-due',
            detail: `Check-in scheduled for ${initiative.nextCheckAt}.`,
          });
          continue;
        }
      }

      const current = initiative.phases[initiative.currentPhaseIndex];
      const previous = initiative.currentPhaseIndex > 0
        ? initiative.phases[initiative.currentPhaseIndex - 1]
        : undefined;
      if (previous?.status === 'done' && current?.status === 'pending') {
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'ready-to-advance',
          detail: `Phase "${previous.name}" done → "${current.name}" can start.`,
        });
        continue;
      }

      const lastMs = Date.parse(initiative.lastTouchedAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs > STALE_THRESHOLD_MS) {
        const days = Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000));
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'stale',
          detail: `No movement in ${days} days.`,
        });
      }
    }
    return { generatedAt: now.toISOString(), items };
  }
}
