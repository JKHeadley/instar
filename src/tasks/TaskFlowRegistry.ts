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
  RESERVED_MAINTENANCE_CONTROLLER,
} from './task-flow-types.js';
import type { SharedStateLedger } from '../core/SharedStateLedger.js';

export interface TaskFlowRegistryOptions {
  store: TaskFlowStore;
  ledger?: SharedStateLedger;
  thresholds?: Partial<TaskFlowThresholds>;
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
  private readonly now: () => number;
  private readonly cache = new Map<string, TaskFlowRecord>();
  readonly notifyMetrics: NotifyMetrics = { emitted: 0, byKind: {} };

  constructor(opts: TaskFlowRegistryOptions) {
    super();
    this.store = opts.store;
    this.ledger = opts.ledger;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
    this.now = opts.now ?? (() => Date.now());
  }

  getThresholds(): TaskFlowThresholds {
    return { ...this.thresholds };
  }

  // ────────────────── reads ──────────────────

  getFlow(flowId: string, opts: { bypassCache?: boolean } = {}): TaskFlowRecord | null {
    if (!opts.bypassCache) {
      const cached = this.cache.get(flowId);
      if (cached) return cached;
    }
    const rec = this.store.getFlow(flowId);
    if (rec) this.cachePut(rec);
    return rec;
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
    return this.store.withWriteTransaction(() => {
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
      this.emitTransitionLedgerNote(rec, null, 'queued', 'createFlow');
      return { flow: rec, created: true };
    });
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
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      // Evict the oldest insertion-order key. (Map preserves insertion order.)
      // Prefer terminal flows for eviction by scanning the head a bit.
      let evicted = false;
      let i = 0;
      for (const [k, v] of this.cache) {
        if (i++ > 32) break;
        if (v.endedAt != null) {
          this.cache.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        const firstKey = this.cache.keys().next().value as string | undefined;
        if (firstKey) this.cache.delete(firstKey);
      }
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

  private emitTransitionLedgerNote(
    rec: TaskFlowRecord,
    fromStatus: TaskFlowStatus | null,
    toStatus: TaskFlowStatus,
    op: string
  ): void {
    if (!this.crossesAuditBoundary(fromStatus, toStatus, op)) return;
    this.emitLedgerNote('taskflow-transition', {
      flowId: rec.flowId,
      revision: rec.revision,
      from_status: fromStatus,
      to_status: toStatus,
      currentStep: rec.currentStep,
      waitKind: rec.waitJson?.kind ?? null,
      controllerId: rec.controllerId,
      op,
    });
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

  private emitLedgerNote(kind: string, payload: Record<string, unknown>): void {
    if (!this.ledger) return;
    // Best-effort: ledger.append is async but we don't await — tier-2 audit, never
    // blocks state correctness (per spec § Storage and Concurrency).
    void Promise.resolve()
      .then(() =>
        this.ledger!.append({
          kind: `note:${kind}`,
          provenance: 'TaskFlowRegistry',
          emittedBy: 'TaskFlowRegistry',
          counterparty: 'self',
          subject: kind,
          dedupKey: `${kind}:${payload.flowId}:${payload.revision ?? 'na'}`,
          payload,
        } as any)
      )
      .catch(() => {
        /* swallow — audit best-effort */
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
