/**
 * TaskFlowRegistry — durable, optimistic-concurrency multi-step job records.
 *
 * Imported (trimmed) from OpenClaw's task-flow-registry. See
 * `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` for full design.
 *
 * v1 constraints (deliberate):
 *   - Single writer (the instar server process).
 *   - `managed` sync mode only.
 *   - No `blocked` status (overlapped `waiting`).
 *   - Notification dispatch is wired but stubbed at metric-emission only;
 *     Phase 5 wires through `TelegramAdapter` send.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { TaskFlowStore } from './task-flow-registry.store.sqlite.js';
import { RateLimiter } from './RateLimiter.js';
import { LruCache } from './LruCache.js';
import {
  TaskFlowRecord,
  TaskFlowStatus,
  TaskFlowError,
  TaskFlowPrincipal,
  TaskNotifyPolicy,
  TaskFlowThresholds,
  CreateFlowInput,
  WaitJson,
  RequesterOrigin,
  SupersededRef,
  ApplyResult,
  WaitMatch,
  RateLimitConfig,
  CacheConfig,
  createFlowInputSchema,
  waitJsonSchema,
  isTerminalStatus,
  jsonByteLength,
  MAX_STATE_JSON_BYTES,
  MAX_WAIT_JSON_BYTES,
  MAX_GOAL_CHARS,
  MAX_CURRENT_STEP_CHARS,
  MAX_CACHE_ENTRIES,
  DEFAULT_THRESHOLDS,
  DEFAULT_RATE_LIMITS,
  DEFAULT_CACHE_CONFIG,
  ACTIVE_STATUSES,
  RESERVED_MAINTENANCE_CONTROLLER,
} from './task-flow-types.js';
import type { SharedStateLedger } from '../core/SharedStateLedger.js';

export interface TaskFlowRegistryOptions {
  store: TaskFlowStore;
  ledger?: SharedStateLedger;
  thresholds?: Partial<TaskFlowThresholds>;
  rateLimits?: Partial<RateLimitConfig>;
  cache?: Partial<CacheConfig>;
  now?: () => number;
}

interface NotifyMetrics {
  emitted: number;
  byKind: Record<string, number>;
}

export class TaskFlowRegistry extends EventEmitter {
  private readonly store: TaskFlowStore;
  private readonly ledger?: SharedStateLedger;
  private readonly thresholds: TaskFlowThresholds;
  private readonly rateLimits: RateLimitConfig;
  private readonly cacheConfig: CacheConfig;
  private readonly now: () => number;
  private readonly cache: LruCache<TaskFlowRecord>;
  private readonly createLimiter: RateLimiter;
  private readonly pingLimiter: RateLimiter;
  /** Per-controller in-memory active count cache; populated lazily from DB. */
  private readonly activeCountByController = new Map<string, number>();
  /** Set of controllerIds whose count has been loaded from DB at least once. */
  private readonly activeCountLoaded = new Set<string>();
  readonly notifyMetrics: NotifyMetrics = { emitted: 0, byKind: {} };
  /** Counter for cache evictions (Prometheus-style metric source). */
  cacheEvictionsTotal = 0;
  /** Counter for rate-limit rejections, broken out by kind. */
  rateLimitRejections: Record<string, number> = {
    create_rate: 0,
    max_active: 0,
    ping_rate: 0,
  };

  constructor(opts: TaskFlowRegistryOptions) {
    super();
    this.store = opts.store;
    this.ledger = opts.ledger;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
    this.rateLimits = { ...DEFAULT_RATE_LIMITS, ...(opts.rateLimits ?? {}) };
    this.cacheConfig = { ...DEFAULT_CACHE_CONFIG, ...(opts.cache ?? {}) };
    this.now = opts.now ?? (() => Date.now());
    this.cache = new LruCache<TaskFlowRecord>({
      maxEntries: this.cacheConfig.maxEntries,
      onEvict: (_k, _v) => {
        this.cacheEvictionsTotal++;
        this.emitCacheEvictionMetric();
      },
    });
    this.createLimiter = new RateLimiter({
      windowMs: 1000,
      limit: this.rateLimits.createPerSecPerController,
      now: this.now,
    });
    this.pingLimiter = new RateLimiter({
      windowMs: 60_000,
      limit: this.rateLimits.pingPerMinPerFlow,
      now: this.now,
    });
  }

  getThresholds(): TaskFlowThresholds {
    return { ...this.thresholds };
  }

  getRateLimits(): RateLimitConfig {
    return { ...this.rateLimits };
  }

  getCacheConfig(): CacheConfig {
    return { ...this.cacheConfig };
  }

  /** Test-only: returns the LRU cache size. */
  get cacheSize(): number {
    return this.cache.size;
  }

  // ────────────────── reads ──────────────────

  getFlow(flowId: string, opts: { bypassCache?: boolean } = {}): TaskFlowRecord | null {
    if (!opts.bypassCache) {
      const cached = this.cache.get(flowId);
      if (cached) return cached;
    }
    const rec = this.store.getFlow(flowId);
    if (rec) this.cachePut(rec);
    return rec ?? null;
  }

  /** Returns the redacted view safe to expose to non-owning callers. */
  getRedactedFlow(flowId: string): Partial<TaskFlowRecord> | null {
    const rec = this.getFlow(flowId);
    if (!rec) return null;
    return {
      flowId: rec.flowId,
      ownerKey: rec.ownerKey,
      controllerId: rec.controllerId,
      revision: rec.revision,
      status: rec.status,
      goal: rec.goal,
      currentStep: rec.currentStep,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      endedAt: rec.endedAt,
      // wait_kind only — never the identifying fields inside waitJson
      waitJson: rec.waitJson ? ({ kind: rec.waitJson.kind } as WaitJson) : undefined,
    };
  }

  findWaitingByReply(args: {
    channel: string;
    threadId: string;
    peer: string;
  }): WaitMatch[] {
    return this.store
      .findWaitingReplyByTarget(args)
      .filter((r) => r.waitInstanceId)
      .map((r) => this.toWaitMatch(r));
  }

  findWaitingByCorrelation(args: {
    waitKind: 'external-call' | 'cross-agent-callback';
    correlationId: string;
  }): WaitMatch[] {
    return this.store
      .findWaitingByCorrelation(args)
      .filter((r) => r.waitInstanceId)
      .map((r) => this.toWaitMatch(r));
  }

  findWaitingByDueAt(nowMs: number): WaitMatch[] {
    return this.store
      .findWaitingDue(nowMs)
      .filter((r) => r.waitInstanceId)
      .map((r) => this.toWaitMatch(r));
  }

  /**
   * List all flows for a controllerId, optionally filtered by status.
   * Used by DivergenceChecker — read-only, not on the hot mutation path.
   */
  findByControllerId(
    controllerId: string,
    opts: { status?: TaskFlowStatus } = {}
  ): TaskFlowRecord[] {
    return this.store.findByControllerId(controllerId, opts);
  }

  /**
   * Look up a flow by (controllerId, ownerKey, idempotencyKey). Returns null
   * if no matching record. Useful for migrate-existing backfill and for tests.
   */
  findByIdempotency(
    controllerId: string,
    ownerKey: string,
    idempotencyKey: string
  ): TaskFlowRecord | null {
    return this.store.findIdempotent(controllerId, ownerKey, idempotencyKey);
  }

  // ────────────────── createFlow ──────────────────

  async createFlow(
    input: CreateFlowInput
  ): Promise<{ flow: TaskFlowRecord; created: boolean }> {
    const parsed = createFlowInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TaskFlowError(
        'invalid_argument',
        `${issue.path.join('.')}: ${issue.message}`,
        { field: issue.path.join('.'), reason: issue.message }
      );
    }
    if (parsed.data.controllerId === RESERVED_MAINTENANCE_CONTROLLER) {
      throw new TaskFlowError(
        'unauthorized_controller',
        'TaskFlowMaintenance is a reserved controllerId; createFlow rejected',
        { actual: parsed.data.controllerId }
      );
    }
    if (parsed.data.stateJson !== undefined) {
      this.validateStateJsonSize(parsed.data.stateJson);
    }
    // ── Phase 5 rate limits ────────────────────────────────────────────
    // Idempotent-replay carve-out: a duplicate idempotencyKey replay must
    // NOT count against the per-second rate limit. Check idempotency in a
    // cheap read first; if the flow exists, short-circuit before counting.
    const preExisting = this.store.findIdempotent(
      parsed.data.controllerId,
      parsed.data.ownerKey,
      parsed.data.idempotencyKey
    );
    if (preExisting) return { flow: preExisting, created: false };

    const rateRes = this.createLimiter.tryAcquire(parsed.data.controllerId);
    if (!rateRes.ok) {
      this.rateLimitRejections.create_rate++;
      throw new TaskFlowError(
        'quota_exceeded',
        `createFlow rate limit exceeded for controllerId=${parsed.data.controllerId}`,
        {
          code: 'rate_limit',
          scope: 'create',
          limit: this.rateLimits.createPerSecPerController,
          windowMs: 1000,
          retryAfterMs: rateRes.retryAfterMs ?? 1000,
          controllerId: parsed.data.controllerId,
        }
      );
    }
    const active = this.getActiveCount(parsed.data.controllerId);
    if (active >= this.rateLimits.maxActivePerController) {
      this.rateLimitRejections.max_active++;
      throw new TaskFlowError(
        'quota_exceeded',
        `max active flows exceeded for controllerId=${parsed.data.controllerId}`,
        {
          code: 'max_active',
          scope: 'create',
          limit: this.rateLimits.maxActivePerController,
          currentActive: active,
          controllerId: parsed.data.controllerId,
        }
      );
    }
    return this.store.withWriteTransaction(() => {
      // Re-check idempotency inside the transaction (race-safe).
      const existing = this.store.findIdempotent(
        parsed.data.controllerId,
        parsed.data.ownerKey,
        parsed.data.idempotencyKey
      );
      if (existing) return { flow: existing, created: false };
      const ts = this.now();
      const rec: TaskFlowRecord = {
        flowId: this.genId(),
        ownerKey: parsed.data.ownerKey,
        controllerId: parsed.data.controllerId,
        controllerInstanceId: parsed.data.controllerInstanceId,
        controllerHeartbeatAt: ts,
        revision: 1,
        status: 'queued',
        notifyPolicy: parsed.data.notifyPolicy ?? { kind: 'silent' },
        goal: parsed.data.goal,
        currentStep: parsed.data.currentStep,
        stateJson: parsed.data.stateJson,
        requesterOrigin: parsed.data.requesterOrigin,
        privacyScope: parsed.data.privacyScope,
        createdAt: ts,
        updatedAt: ts,
      };
      this.store.insertFlow(rec, parsed.data.idempotencyKey);
      this.cachePut(rec);
      // bump in-memory active count cache; if not yet loaded, leave it for the
      // next getActiveCount to load lazily.
      if (this.activeCountLoaded.has(parsed.data.controllerId)) {
        this.activeCountByController.set(
          parsed.data.controllerId,
          (this.activeCountByController.get(parsed.data.controllerId) ?? 0) + 1
        );
      }
      this.emitTransitionLedgerNote(rec, null, 'queued', 'createFlow');
      return { flow: rec, created: true };
    });
  }

  /**
   * Returns count of non-terminal flows for a controller. Lazy-loaded from DB
   * on first call, then maintained incrementally via createFlow / applyOcc.
   *
   * The bookkeeping is best-effort — if it drifts (e.g. server restart),
   * the next call resets from DB. The hot path never goes to DB twice.
   */
  private getActiveCount(controllerId: string): number {
    if (!this.activeCountLoaded.has(controllerId)) {
      let total = 0;
      for (const s of ACTIVE_STATUSES) {
        total += this.store.findByControllerId(controllerId, { status: s }).length;
      }
      this.activeCountByController.set(controllerId, total);
      this.activeCountLoaded.add(controllerId);
      return total;
    }
    return this.activeCountByController.get(controllerId) ?? 0;
  }

  /** Hook: invoked after a flow transitions to a terminal status. */
  private onTerminalTransition(rec: TaskFlowRecord): void {
    if (!this.activeCountLoaded.has(rec.controllerId)) return;
    const cur = this.activeCountByController.get(rec.controllerId) ?? 0;
    if (cur > 0) this.activeCountByController.set(rec.controllerId, cur - 1);
  }

  // ────────────────── transitions ──────────────────

  async startStep(args: {
    flowId: string;
    expectedRevision: number;
    principal: TaskFlowPrincipal;
    currentStep: string;
  }): Promise<ApplyResult> {
    if (args.currentStep.length > MAX_CURRENT_STEP_CHARS) {
      throw new TaskFlowError('invalid_argument', 'currentStep exceeds limit', {
        field: 'currentStep',
      });
    }
    return this.applyOcc(args.flowId, args.expectedRevision, (cur) => {
      this.assertControllerScope(cur, args.principal);
      if (cur.status !== 'queued' && cur.status !== 'running') {
        throw new TaskFlowError('invalid_transition', `cannot startStep from ${cur.status}`, {
          from: cur.status,
          op: 'startStep',
        });
      }
      const next: TaskFlowRecord = {
        ...cur,
        status: 'running',
        currentStep: args.currentStep,
        controllerInstanceId: this.controllerInstanceFromPrincipal(args.principal, cur),
        controllerHeartbeatAt: this.now(),
        revision: cur.revision + 1,
        updatedAt: this.now(),
      };
      return next;
    }, 'startStep');
  }

  async setFlowWaiting(args: {
    flowId: string;
    expectedRevision: number;
    principal: TaskFlowPrincipal;
    waitJson: WaitJson;
    currentStep?: string;
    notifyPolicy?: TaskNotifyPolicy;
    statePatch?: unknown;
  }): Promise<ApplyResult> {
    const parsed = waitJsonSchema.safeParse(args.waitJson);
    if (!parsed.success) {
      throw new TaskFlowError('invalid_argument', 'waitJson failed validation', {
        field: 'waitJson',
        reason: parsed.error.issues[0]?.message,
      });
    }
    if (jsonByteLength(parsed.data) > MAX_WAIT_JSON_BYTES) {
      throw new TaskFlowError('invalid_argument', 'waitJson exceeds size limit', {
        field: 'waitJson',
      });
    }
    return this.applyOcc(args.flowId, args.expectedRevision, (cur) => {
      this.assertControllerScope(cur, args.principal);
      if (cur.status !== 'running') {
        throw new TaskFlowError(
          'invalid_transition',
          `cannot setFlowWaiting from ${cur.status}`,
          { from: cur.status, op: 'setFlowWaiting' }
        );
      }
      // Reply uniqueness: at most one active reply wait per (controllerId, channel, threadId, peer).
      if (parsed.data.kind === 'reply') {
        const collisions = this.store.findWaitingReplyByTarget({
          channel: parsed.data.channel,
          threadId: parsed.data.threadId,
          peer: parsed.data.peer,
          controllerId: cur.controllerId,
        });
        if (collisions.length > 0) {
          throw new TaskFlowError(
            'wait_collision',
            'duplicate reply wait for (controllerId, channel, threadId, peer)',
            { existingFlowId: collisions[0].flowId }
          );
        }
      }
      const ts = this.now();
      let nextState = cur.stateJson;
      if (args.statePatch !== undefined) {
        nextState = args.statePatch;
        this.validateStateJsonSize(nextState);
      }
      const next: TaskFlowRecord = {
        ...cur,
        status: 'waiting',
        waitJson: parsed.data,
        waitInstanceId: this.genId(),
        waitStartedAt: ts,
        currentStep: args.currentStep ?? cur.currentStep,
        notifyPolicy: args.notifyPolicy ?? cur.notifyPolicy,
        stateJson: nextState,
        controllerInstanceId: this.controllerInstanceFromPrincipal(args.principal, cur),
        controllerHeartbeatAt: ts,
        revision: cur.revision + 1,
        updatedAt: ts,
      };
      return next;
    }, 'setFlowWaiting');
  }

  async resumeFlow(args: {
    flowId: string;
    expectedRevision: number;
    principal: TaskFlowPrincipal;
    waitInstanceId: string;
    currentStep?: string;
    statePatch?: unknown;
  }): Promise<ApplyResult> {
    return this.applyOcc(args.flowId, args.expectedRevision, (cur) => {
      // controller principal must match controllerId; system-waker permitted.
      if (args.principal.scope === 'controller') {
        this.assertControllerScope(cur, args.principal);
      } else if (args.principal.scope !== 'system-waker' && args.principal.scope !== 'admin') {
        throw new TaskFlowError(
          'unauthorized_controller',
          'resumeFlow requires controller / system-waker / admin scope',
          {}
        );
      }
      if (cur.status !== 'waiting') {
        // If the wait already fired, return already_consumed; if the supplied id was never
        // valid, invalid_argument.
        if (cur.waitInstanceId == null && !isTerminalStatus(cur.status)) {
          throw new TaskFlowError('already_consumed', 'wait already fired', {
            waitInstanceId: args.waitInstanceId,
          });
        }
        throw new TaskFlowError(
          'invalid_transition',
          `cannot resumeFlow from ${cur.status}`,
          { from: cur.status, op: 'resumeFlow' }
        );
      }
      if (cur.waitInstanceId !== args.waitInstanceId) {
        throw new TaskFlowError('invalid_argument', 'waitInstanceId mismatch', {
          field: 'waitInstanceId',
        });
      }
      const ts = this.now();
      let nextState = cur.stateJson;
      if (args.statePatch !== undefined) {
        nextState = args.statePatch;
        this.validateStateJsonSize(nextState);
      }
      const next: TaskFlowRecord = {
        ...cur,
        status: 'running',
        waitJson: undefined,
        waitInstanceId: undefined,
        waitStartedAt: undefined,
        currentStep: args.currentStep ?? cur.currentStep,
        stateJson: nextState,
        controllerInstanceId:
          args.principal.scope === 'controller'
            ? args.principal.controllerInstanceId
            : cur.controllerInstanceId,
        controllerHeartbeatAt: ts,
        revision: cur.revision + 1,
        updatedAt: ts,
      };
      return next;
    }, 'resumeFlow');
  }

  async finishFlow(args: {
    flowId: string;
    expectedRevision: number;
    principal: TaskFlowPrincipal;
    result?: unknown;
  }): Promise<ApplyResult> {
    return this.applyOcc(args.flowId, args.expectedRevision, (cur) => {
      this.assertControllerScope(cur, args.principal);
      if (cur.status !== 'running') {
        throw new TaskFlowError('invalid_transition', `cannot finishFlow from ${cur.status}`, {
          from: cur.status,
          op: 'finishFlow',
        });
      }
      const ts = this.now();
      let nextState: any = cur.stateJson ?? {};
      if (args.result !== undefined) {
        if (typeof nextState !== 'object' || nextState === null) nextState = {};
        nextState = { ...(nextState as object), _result: args.result };
        this.validateStateJsonSize(nextState);
      }
      const next: TaskFlowRecord = {
        ...cur,
        status: 'succeeded',
        stateJson: nextState,
        revision: cur.revision + 1,
        updatedAt: ts,
        endedAt: ts,
      };
      return next;
    }, 'finishFlow');
  }

  async failFlow(args: {
    flowId: string;
    expectedRevision: number;
    principal: TaskFlowPrincipal;
    failureReason: string;
  }): Promise<ApplyResult> {
    return this.applyOcc(args.flowId, args.expectedRevision, (cur) => {
      this.assertControllerScope(cur, args.principal);
      if (cur.status !== 'running' && cur.status !== 'waiting') {
        throw new TaskFlowError('invalid_transition', `cannot failFlow from ${cur.status}`, {
          from: cur.status,
          op: 'failFlow',
        });
      }
      const ts = this.now();
      let nextState: any = cur.stateJson ?? {};
      if (typeof nextState !== 'object' || nextState === null) nextState = {};
      nextState = { ...(nextState as object), _failureReason: args.failureReason };
      this.validateStateJsonSize(nextState);
      const next: TaskFlowRecord = {
        ...cur,
        status: 'failed',
        stateJson: nextState,
        // clear wait state since transitioning from waiting → failed
        waitJson: undefined,
        waitInstanceId: undefined,
        waitStartedAt: undefined,
        revision: cur.revision + 1,
        updatedAt: ts,
        endedAt: ts,
      };
      return next;
    }, 'failFlow');
  }

  async requestFlowCancel(args: {
    flowId: string;
    expectedRevision: number;
    requesterOrigin: RequesterOrigin;
  }): Promise<ApplyResult> {
    return this.applyOcc(args.flowId, args.expectedRevision, (cur) => {
      if (isTerminalStatus(cur.status)) {
        throw new TaskFlowError('already_terminal', 'cannot cancel a terminal flow', {});
      }
      const ts = this.now();
      const next: TaskFlowRecord = {
        ...cur,
        cancelRequestedAt: ts,
        cancelRequestedBy: args.requesterOrigin,
        revision: cur.revision + 1,
        updatedAt: ts,
      };
      return next;
    }, 'requestFlowCancel', (next, prev) => {
      if (next.status === 'waiting') {
        this.emit('taskflow:cancel-requested', {
          flowId: next.flowId,
          controllerId: next.controllerId,
        });
      }
      // Audit ledger note for cancel-request
      this.emitLedgerNote('taskflow-cancel-requested', {
        flowId: next.flowId,
        revision: next.revision,
        cancelRequestedBy: args.requesterOrigin,
      });
    });
  }

  async cancelFlow(args: {
    flowId: string;
    expectedRevision: number;
    principal: TaskFlowPrincipal;
  }): Promise<ApplyResult> {
    return this.applyOcc(args.flowId, args.expectedRevision, (cur) => {
      this.assertControllerScope(cur, args.principal);
      if (isTerminalStatus(cur.status)) {
        throw new TaskFlowError('already_terminal', 'flow is already terminal', {});
      }
      if (cur.cancelRequestedAt == null) {
        throw new TaskFlowError(
          'invalid_transition',
          'cancelFlow requires a prior requestFlowCancel',
          { from: cur.status, op: 'cancelFlow' }
        );
      }
      const ts = this.now();
      const next: TaskFlowRecord = {
        ...cur,
        status: 'cancelled',
        waitJson: undefined,
        waitInstanceId: undefined,
        waitStartedAt: undefined,
        revision: cur.revision + 1,
        updatedAt: ts,
        endedAt: ts,
      };
      return next;
    }, 'cancelFlow');
  }

  async markLost(args: {
    flowId: string;
    expectedRevision: number;
    ledgerEntryId: string;
    reason: 'lost' | 'stranded';
  }): Promise<ApplyResult> {
    return this.applyOcc(args.flowId, args.expectedRevision, (cur) => {
      if (cur.status !== 'running' && cur.status !== 'waiting') {
        throw new TaskFlowError('invalid_transition', `cannot markLost from ${cur.status}`, {
          from: cur.status,
          op: 'markLost',
        });
      }
      const ts = this.now();
      const next: TaskFlowRecord = {
        ...cur,
        status: 'lost',
        waitJson: undefined,
        waitInstanceId: undefined,
        waitStartedAt: undefined,
        supersededBy: { kind: 'ledger-note', ledgerEntryId: args.ledgerEntryId, reason: args.reason },
        revision: cur.revision + 1,
        updatedAt: ts,
        endedAt: ts,
      };
      return next;
    }, 'markLost');
  }

  async pingFlow(args: {
    flowId: string;
    principal: TaskFlowPrincipal;
  }): Promise<TaskFlowRecord> {
    if (args.principal.scope !== 'controller') {
      throw new TaskFlowError('unauthorized_controller', 'pingFlow requires controller scope', {});
    }
    const cur = this.store.getFlow(args.flowId);
    if (!cur) throw new TaskFlowError('not_found', 'flow not found', { flowId: args.flowId });
    if (cur.controllerId !== args.principal.controllerId) {
      throw new TaskFlowError('unauthorized_controller', 'controllerId mismatch', {
        expected: cur.controllerId,
        actual: args.principal.controllerId,
      });
    }
    if (cur.status !== 'running') {
      throw new TaskFlowError('invalid_transition', `cannot pingFlow when status=${cur.status}`, {
        from: cur.status,
        op: 'pingFlow',
      });
    }
    // ── Phase 5 ping rate limit ──────────────────────────────────────
    // Spec § Threat Model line 685 — heartbeat-flood mitigation. Authority
    // check first (above): bogus pings don't even count against the limit.
    const rateRes = this.pingLimiter.tryAcquire(args.flowId);
    if (!rateRes.ok) {
      this.rateLimitRejections.ping_rate++;
      throw new TaskFlowError(
        'quota_exceeded',
        `pingFlow rate limit exceeded for flowId=${args.flowId}`,
        {
          code: 'rate_limited',
          scope: 'ping',
          limit: this.rateLimits.pingPerMinPerFlow,
          windowMs: 60_000,
          retryAfterMs: rateRes.retryAfterMs ?? 60_000,
          flowId: args.flowId,
        }
      );
    }
    const ts = this.now();
    const updated = this.store.pingFlowRow({
      flowId: args.flowId,
      controllerInstanceId: args.principal.controllerInstanceId,
      controllerHeartbeatAt: ts,
      updatedAt: ts,
    });
    if (updated === 0) {
      // Race: the row's status changed between read and write. Return current.
      const fresh = this.store.getFlow(args.flowId);
      if (fresh) this.cachePut(fresh);
      throw new TaskFlowError('invalid_transition', 'pingFlow lost a race', {
        from: fresh?.status ?? 'unknown',
        op: 'pingFlow',
      });
    }
    const next: TaskFlowRecord = {
      ...cur,
      controllerInstanceId: args.principal.controllerInstanceId,
      controllerHeartbeatAt: ts,
      updatedAt: ts,
    };
    this.cachePut(next);
    return next;
  }

  // ────────────────── internal: OCC apply ──────────────────

  private async applyOcc(
    flowId: string,
    expectedRevision: number,
    mutate: (cur: TaskFlowRecord) => TaskFlowRecord,
    op: string,
    afterCommit?: (next: TaskFlowRecord, prev: TaskFlowRecord) => void
  ): Promise<ApplyResult> {
    const result = await this.store.withWriteTransaction(() => {
      const cur = this.store.getFlow(flowId);
      if (!cur) throw new TaskFlowError('not_found', 'flow not found', { flowId });
      if (isTerminalStatus(cur.status)) {
        throw new TaskFlowError('already_terminal', 'flow already terminal', {
          current: cur,
        });
      }
      if (cur.revision !== expectedRevision) {
        throw new TaskFlowError(
          'revision_conflict',
          `expected revision ${expectedRevision}, current ${cur.revision}`,
          { current: cur }
        );
      }
      const next = mutate(cur);
      const changes = this.store.patchFlowOcc(next, expectedRevision);
      if (changes !== 1) {
        // Highly unlikely inside BEGIN IMMEDIATE — re-read for the discriminator.
        const meta = this.store.getFlowMeta(flowId);
        if (!meta) throw new TaskFlowError('not_found', 'flow not found', { flowId });
        throw new TaskFlowError(
          'revision_conflict',
          'patch returned 0 rows mid-transaction',
          { current: this.store.getFlow(flowId) }
        );
      }
      return { prev: cur, next };
    });
    this.cachePut(result.next);
    // Active-count bookkeeping: decrement on terminal entry.
    if (!isTerminalStatus(result.prev.status) && isTerminalStatus(result.next.status)) {
      this.onTerminalTransition(result.next);
      // Heartbeat bucket is also pointless for terminal flows — let it GC.
      this.pingLimiter.forget(result.next.flowId);
    }
    this.emitTransitionLedgerNote(result.next, result.prev.status, result.next.status, op);
    if (afterCommit) {
      try {
        afterCommit(result.next, result.prev);
      } catch (err) {
        // afterCommit failures are best-effort — never roll back state.
        // Fall through.
      }
    }
    this.maybeNotify(result.next, result.prev.status);
    return { applied: true, flow: result.next };
  }

  private cachePut(rec: TaskFlowRecord): void {
    this.cache.set(rec.flowId, rec);
  }

  private emitCacheEvictionMetric(): void {
    // Lightweight metric surface — instar emits `[metric] name=value labels`
    // tagged lines that the dashboard scrapes. Keep emission identical
    // shape to DivergenceChecker.emitMetric for consistency.
    try {
      console.log(
        `[metric] taskflow_cache_evictions_total=${this.cacheEvictionsTotal} ${JSON.stringify({ scope: 'TaskFlowRegistry' })}`
      );
    } catch {
      /* swallow */
    }
  }

  private assertControllerScope(rec: TaskFlowRecord, principal: TaskFlowPrincipal): void {
    if (principal.scope === 'admin') return;
    if (principal.scope !== 'controller') {
      throw new TaskFlowError('unauthorized_controller', 'controller scope required', {});
    }
    if (rec.controllerId !== principal.controllerId) {
      throw new TaskFlowError('unauthorized_controller', 'controllerId mismatch', {
        expected: rec.controllerId,
        actual: principal.controllerId,
      });
    }
  }

  private controllerInstanceFromPrincipal(
    principal: TaskFlowPrincipal,
    cur: TaskFlowRecord
  ): string {
    if (principal.scope === 'controller') return principal.controllerInstanceId;
    return cur.controllerInstanceId;
  }

  private validateStateJsonSize(value: unknown): void {
    const bytes = jsonByteLength(value);
    if (bytes > MAX_STATE_JSON_BYTES) {
      throw new TaskFlowError('invalid_argument', 'stateJson exceeds size limit', {
        field: 'stateJson',
        bytes,
      });
    }
  }

  private toWaitMatch(rec: TaskFlowRecord): WaitMatch {
    return {
      flowId: rec.flowId,
      revision: rec.revision,
      waitInstanceId: rec.waitInstanceId!,
      controllerId: rec.controllerId,
      waitJson: rec.waitJson!,
    };
  }

  private genId(): string {
    return crypto.randomUUID();
  }

  // ────────────────── audit + notify ──────────────────

  /**
   * Emit a redacted state-transition audit note. Per spec § Threat Model
   * lines 681-682, the audit shape carries only structural metadata:
   *   { flowId, revision, currentStep, from_status, to_status, waitJson.kind, controllerId, op }
   *
   * It MUST NOT include `stateJson` (controller-private; spec line 705) and
   * MUST NOT include any field of `waitJson` other than `kind` (spec line 681).
   *
   * Audit emission is fire-and-forget; failures never affect state-machine
   * correctness (tier-2 audit per spec § Storage and Concurrency).
   */
  private emitTransitionLedgerNote(
    rec: TaskFlowRecord,
    fromStatus: TaskFlowStatus | null,
    toStatus: TaskFlowStatus,
    op: string
  ): void {
    if (!this.crossesAuditBoundary(fromStatus, toStatus, op)) return;
    if (!this.ledger) return;

    // Redacted shape per spec lines 681-682.
    const auditPayload = {
      flowId: rec.flowId,
      revision: rec.revision,
      currentStep: rec.currentStep ?? null,
      from_status: fromStatus,
      to_status: toStatus,
      waitKind: rec.waitJson?.kind ?? null,
      controllerId: rec.controllerId,
      op,
    };
    // Summary embeds only the redacted fields; subject is the static kind tag.
    // This keeps the SharedStateLedger schema (subject required, max 200 chars,
    // summary max 400) happy without leaking stateJson.
    const summary =
      `flow=${rec.flowId} rev=${rec.revision} ` +
      `${fromStatus ?? 'null'}->${toStatus} ` +
      `step=${rec.currentStep ?? 'none'} ` +
      `wait=${rec.waitJson?.kind ?? 'none'} ` +
      `op=${op}`;
    void Promise.resolve()
      .then(() =>
        this.ledger!.append({
          kind: 'note',
          provenance: 'subsystem-asserted',
          emittedBy: {
            subsystem: 'taskflow-transition',
            instance: 'TaskFlowRegistry',
          },
          counterparty: { type: 'self', name: rec.controllerId.slice(0, 64).replace(/[^a-zA-Z0-9\-_.:]/g, '_'), trustTier: 'trusted' },
          subject: 'taskflow-transition',
          summary: summary.length > 400 ? summary.slice(0, 400) : summary,
          dedupKey: `taskflow-transition:${rec.flowId}:${rec.revision}:${op}`,
        } as any)
      )
      .catch(() => {
        /* swallow — audit best-effort */
      });
    // Expose the redacted payload via an event for tests / dashboards.
    this.emit('taskflow:audit-emitted', auditPayload);
  }

  private crossesAuditBoundary(
    fromStatus: TaskFlowStatus | null,
    toStatus: TaskFlowStatus,
    op: string
  ): boolean {
    if (op === 'createFlow') return true;
    if (op === 'startStep') return true;
    if (op === 'setFlowWaiting') return true;
    if (op === 'resumeFlow') return true;
    if (isTerminalStatus(toStatus)) return true;
    return false;
  }

  /**
   * Emit a generic redacted ledger note (used by cancel-requested path).
   * Same redaction discipline as emitTransitionLedgerNote.
   */
  private emitLedgerNote(kind: string, payload: Record<string, unknown>): void {
    if (!this.ledger) return;
    void Promise.resolve()
      .then(() =>
        this.ledger!.append({
          kind: 'note',
          provenance: 'subsystem-asserted',
          emittedBy: {
            subsystem: 'taskflow-transition',
            instance: 'TaskFlowRegistry',
          },
          counterparty: { type: 'self', name: 'TaskFlowRegistry', trustTier: 'trusted' },
          subject: kind.slice(0, 200),
          summary: `flow=${payload.flowId} rev=${payload.revision ?? 'na'} kind=${kind}`,
          dedupKey: `${kind}:${payload.flowId}:${payload.revision ?? 'na'}`,
        } as any)
      )
      .catch(() => {
        /* swallow */
      });
  }

  private maybeNotify(rec: TaskFlowRecord, fromStatus: TaskFlowStatus): void {
    const policy = rec.notifyPolicy;
    if (policy.kind === 'silent') return;
    const enteredWaiting = fromStatus !== 'waiting' && rec.status === 'waiting';
    const enteredTerminal = !isTerminalStatus(fromStatus) && isTerminalStatus(rec.status);
    let fire = false;
    if (policy.kind === 'on-wait' && enteredWaiting) fire = true;
    if (policy.kind === 'on-terminal' && enteredTerminal) fire = true;
    if (policy.kind === 'on-wait-and-terminal' && (enteredWaiting || enteredTerminal)) fire = true;
    if (!fire) return;
    // Phase 1 ships the wiring with metric-only emission. Phase 5 wires through
    // TelegramAdapter.send.
    this.notifyMetrics.emitted++;
    const k = enteredTerminal ? `terminal:${rec.status}` : 'wait';
    this.notifyMetrics.byKind[k] = (this.notifyMetrics.byKind[k] ?? 0) + 1;
    this.emit('taskflow:notify', {
      flowId: rec.flowId,
      goal: rec.goal,
      currentStep: rec.currentStep,
      status: rec.status,
      waitKind: rec.waitJson?.kind,
      revision: rec.revision,
      topicId: 'topicId' in policy ? policy.topicId : undefined,
    });
  }
}
