/**
 * TaskFlowMaintenanceSweeper — hourly scan that marks stranded flows `lost`.
 *
 * Acts as a reserved controller (`TaskFlowMaintenance`); the registry
 * whitelists this id for terminal-from-running and terminal-from-waiting
 * transitions via `markLost`. Every transition emits a SharedStateLedger note
 * for human-visible audit context.
 *
 * Threshold rules per spec § Sweeper threshold policy.
 */

import crypto from 'node:crypto';
import { TaskFlowRegistry } from './TaskFlowRegistry.js';
import { TaskFlowStore } from './task-flow-registry.store.sqlite.js';
import {
  SWEEPER_INTERVAL_MS,
  SweeperEvalCounts,
  TaskFlowError,
  TaskFlowThresholds,
} from './task-flow-types.js';
import type { SharedStateLedger } from '../core/SharedStateLedger.js';

export interface SweeperOptions {
  registry: TaskFlowRegistry;
  store: TaskFlowStore;
  ledger?: SharedStateLedger;
  intervalMs?: number;
  now?: () => number;
}

export class TaskFlowMaintenanceSweeper {
  private timer: NodeJS.Timeout | null = null;
  private readonly registry: TaskFlowRegistry;
  private readonly store: TaskFlowStore;
  private readonly ledger?: SharedStateLedger;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(opts: SweeperOptions) {
    this.registry = opts.registry;
    this.store = opts.store;
    this.ledger = opts.ledger;
    this.intervalMs = opts.intervalMs ?? SWEEPER_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch(() => {
        /* swallow — best-effort hourly sweep */
      });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Scan candidate flows and mark eligible rows as `lost`. Returns counts.
   * Idempotent — safe to call as often as desired.
   */
  async sweep(): Promise<SweeperEvalCounts> {
    const t = this.registry.getThresholds();
    const candidates = this.store.findSweeperCandidates();
    let marked = 0;
    for (const flow of candidates) {
      if (!this.isLostEligible(flow, t)) continue;
      // Best-effort ledger note BEFORE markLost so we have the explanation
      // even if markLost loses an OCC race.
      const ledgerEntryId = await this.appendSweeperLedgerNote(flow, t);
      try {
        await this.registry.markLost({
          flowId: flow.flowId,
          expectedRevision: flow.revision,
          ledgerEntryId,
          reason: 'lost',
        });
        marked++;
      } catch (err) {
        if (err instanceof TaskFlowError && err.code === 'revision_conflict') continue;
        if (err instanceof TaskFlowError && err.code === 'already_terminal') continue;
        // Anything else: swallow but keep going. The ledger note remains as a
        // hint for human follow-up.
      }
    }
    return { scanned: candidates.length, marked };
  }

  private isLostEligible(
    flow: { status: string; controllerHeartbeatAt: number; waitJson?: any; waitStartedAt?: number },
    t: TaskFlowThresholds
  ): boolean {
    const now = this.now();
    if (flow.status === 'running') {
      return now - flow.controllerHeartbeatAt > t.RUNNING_LOST_MS;
    }
    if (flow.status !== 'waiting') return false;
    const startedAt = flow.waitStartedAt ?? 0;
    const kind = flow.waitJson?.kind;
    switch (kind) {
      case 'reply':
        return now - startedAt > t.REPLY_LOST_MS;
      case 'human-review':
        return now - startedAt > t.HUMAN_REVIEW_LOST_MS;
      case 'external-call': {
        const deadline = flow.waitJson?.deadline as number | undefined;
        if (typeof deadline === 'number') return now > deadline + t.EXTERNAL_GRACE_MS;
        return now - startedAt > t.EXTERNAL_LOST_MS;
      }
      case 'cross-agent-callback':
        return now - startedAt > t.XAGENT_LOST_MS;
      case 'scheduled-tick':
      default:
        return false;
    }
  }

  private async appendSweeperLedgerNote(
    flow: { flowId: string; revision: number; controllerId: string; status: string },
    _t: TaskFlowThresholds
  ): Promise<string> {
    const id = crypto.randomUUID();
    if (!this.ledger) return id;
    try {
      const entry = await this.ledger.append({
        kind: 'note:taskflow-lost',
        provenance: 'TaskFlowMaintenanceSweeper',
        emittedBy: 'TaskFlowMaintenanceSweeper',
        counterparty: 'self',
        subject: 'taskflow-lost',
        dedupKey: `taskflow-lost:${flow.flowId}:${flow.revision}`,
        payload: {
          flowId: flow.flowId,
          revision: flow.revision,
          controllerId: flow.controllerId,
          fromStatus: flow.status,
        },
      } as any);
      return entry?.id ?? id;
    } catch {
      return id;
    }
  }
}
