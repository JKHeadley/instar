/**
 * DivergenceChecker — TaskFlow Phase 3a state-coherence monitor.
 *
 * Runs every 15 minutes during the Phase 3a dual-write window. Compares
 * EvolutionManager's authoritative JSON state (proposals) against the
 * TaskFlow registry's flow records on the (ownerKey, status, currentStep,
 * waitJson.kind) tuple. Emits a `taskflow_divergence_count` metric on every
 * run and a SharedStateLedger note kind `taskflow-divergence` per mismatch.
 *
 * Signal-vs-authority compliance: this is a SIGNAL emitter, never a gate.
 *   - It does not block any user-facing action.
 *   - It does not block any agent-internal action.
 *   - On divergence > 0, it asks EvolutionManager to halt shadow-writes via
 *     `setShadowWritesHalted(true)`. EvolutionManager continues JSON writes
 *     uninterrupted; only the secondary TaskFlow shadow-write is paused
 *     until divergence clears. This is a self-applied brake, not an
 *     authority decision over user-facing flow.
 *
 * Phase 3b cutover requires `divergenceCount == 0` for ≥7 consecutive days
 * AND ledger contains zero `taskflow-divergence` notes in that window. The
 * cutover gate is enforced in the Phase 3b PR, not here.
 *
 * Spec: docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Phase 3a.
 */

import type { TaskFlowRegistry } from './TaskFlowRegistry.js';
import type { EvolutionManager } from '../core/EvolutionManager.js';
import type { SharedStateLedger } from '../core/SharedStateLedger.js';
import type { TaskFlowRecord, TaskFlowStatus } from './task-flow-types.js';
import type { EvolutionProposal, EvolutionStatus } from '../core/types.js';

/** Default cron interval — 15 minutes per spec § Phase 3a. */
export const DIVERGENCE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

const CONTROLLER_ID = 'EvolutionManager';

export interface DivergenceMismatch {
  kind:
    | 'json-only'         // proposal exists in JSON but not TaskFlow
    | 'taskflow-only'     // flow exists in TaskFlow but not JSON
    | 'status-mismatch'   // both exist, statuses don't line up
    | 'step-mismatch'     // both exist, currentStep doesn't match expectation
    | 'wait-kind-mismatch'; // both exist, waitJson.kind differs from expectation
  ownerKey: string;
  proposalId?: string;
  flowId?: string;
  proposalStatus?: EvolutionStatus;
  flowStatus?: TaskFlowStatus;
  expectedStep?: string;
  actualStep?: string;
  expectedWaitKind?: string | null;
  actualWaitKind?: string | null;
}

export interface DivergenceReport {
  scannedJsonProposals: number;
  scannedTaskFlowRecords: number;
  divergenceCount: number;
  mismatches: DivergenceMismatch[];
  checkedAt: string;
}

export interface DivergenceCheckerOptions {
  registry: TaskFlowRegistry;
  evolutionManager: EvolutionManager;
  ledger?: SharedStateLedger;
  intervalMs?: number;
  now?: () => number;
}

/**
 * Status mapping — what TaskFlow status corresponds to a given proposal status?
 * Single source of truth shared with EvolutionManager's dual-write logic.
 *
 * `null` means "ignore this proposal during divergence checks" — used for
 * pre-Phase-3a JSON-only records that have not yet been backfilled.
 */
function expectedFlowStatusFor(p: EvolutionStatus): TaskFlowStatus | null {
  switch (p) {
    case 'proposed':
      return 'queued';
    case 'approved':
    case 'in_progress':
      return 'running';
    case 'implemented':
      return 'succeeded';
    case 'rejected':
      return 'failed';
    case 'deferred':
      return 'cancelled';
    default:
      return null;
  }
}

function expectedStepFor(p: EvolutionStatus): string | null {
  switch (p) {
    case 'approved':
      return 'approved';
    case 'in_progress':
      return 'in_progress';
    default:
      return null;
  }
}

export class DivergenceChecker {
  private timer: NodeJS.Timeout | null = null;
  private readonly registry: TaskFlowRegistry;
  private readonly evolutionManager: EvolutionManager;
  private readonly ledger?: SharedStateLedger;
  private readonly intervalMs: number;
  private readonly now: () => number;

  /** Most recent divergence count; readable by /health probes. */
  divergenceCount = 0;
  /** Wall-clock of the most recent runOnce(). null until first run. */
  lastCheckAt: string | null = null;
  /** The most recent report, kept for /health and test assertions. */
  lastReport: DivergenceReport | null = null;

  constructor(opts: DivergenceCheckerOptions) {
    this.registry = opts.registry;
    this.evolutionManager = opts.evolutionManager;
    this.ledger = opts.ledger;
    this.intervalMs = opts.intervalMs ?? DIVERGENCE_CHECK_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {
        /* swallow — divergence checking is best-effort */
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
   * Single-pass divergence scan. Idempotent; safe to call as often as desired.
   *
   * Returns the report. Side effects:
   *   1. Updates `divergenceCount` / `lastCheckAt` / `lastReport`.
   *   2. Emits a SharedStateLedger note per mismatch (kind: 'note',
   *      subject: 'taskflow-divergence').
   *   3. Calls `evolutionManager.setShadowWritesHalted(...)`:
   *        divergenceCount > 0 → halted=true
   *        divergenceCount == 0 → halted=false (resume shadow-writes)
   */
  async runOnce(): Promise<DivergenceReport> {
    const checkedAt = new Date(this.now()).toISOString();

    // Read JSON-side proposals via the public API.
    const proposals = this.evolutionManager.listProposals();
    const flowRecs = this.registry.findByControllerId(CONTROLLER_ID);

    const mismatches: DivergenceMismatch[] = [];
    const flowByOwnerKey = new Map<string, TaskFlowRecord>();
    for (const f of flowRecs) flowByOwnerKey.set(f.ownerKey, f);

    const jsonByOwnerKey = new Map<string, EvolutionProposal>();
    for (const p of proposals) {
      jsonByOwnerKey.set(`evolution:cluster:${p.id}`, p);
    }

    // Forward scan: JSON → TaskFlow.
    for (const p of proposals) {
      const ownerKey = `evolution:cluster:${p.id}`;
      const flow = flowByOwnerKey.get(ownerKey);
      if (!flow) {
        mismatches.push({
          kind: 'json-only',
          ownerKey,
          proposalId: p.id,
          proposalStatus: p.status,
        });
        continue;
      }
      const expectedStatus = expectedFlowStatusFor(p.status);
      if (expectedStatus !== null && flow.status !== expectedStatus) {
        mismatches.push({
          kind: 'status-mismatch',
          ownerKey,
          proposalId: p.id,
          flowId: flow.flowId,
          proposalStatus: p.status,
          flowStatus: flow.status,
        });
      }
      const expectedStep = expectedStepFor(p.status);
      if (expectedStep !== null && flow.currentStep !== expectedStep) {
        mismatches.push({
          kind: 'step-mismatch',
          ownerKey,
          proposalId: p.id,
          flowId: flow.flowId,
          expectedStep,
          actualStep: flow.currentStep,
        });
      }
      // Wait-kind: Phase 3a does not yet use TaskFlow waits for proposals,
      // so any waitJson on the flow is itself a divergence signal.
      if (flow.waitJson) {
        mismatches.push({
          kind: 'wait-kind-mismatch',
          ownerKey,
          proposalId: p.id,
          flowId: flow.flowId,
          expectedWaitKind: null,
          actualWaitKind: flow.waitJson.kind,
        });
      }
    }

    // Reverse scan: TaskFlow → JSON.
    for (const f of flowRecs) {
      if (!jsonByOwnerKey.has(f.ownerKey)) {
        mismatches.push({
          kind: 'taskflow-only',
          ownerKey: f.ownerKey,
          flowId: f.flowId,
          flowStatus: f.status,
        });
      }
    }

    const report: DivergenceReport = {
      scannedJsonProposals: proposals.length,
      scannedTaskFlowRecords: flowRecs.length,
      divergenceCount: mismatches.length,
      mismatches,
      checkedAt,
    };

    this.divergenceCount = report.divergenceCount;
    this.lastCheckAt = checkedAt;
    this.lastReport = report;

    // Emit metric counter — surfaced via /health and ledger-stats.
    this.emitMetric('taskflow_divergence_count', report.divergenceCount, {
      controllerId: CONTROLLER_ID,
      checkedAt,
    });

    // Emit one ledger note per mismatch (capped at 50 per pass to bound spam).
    const noteLimit = 50;
    for (const m of report.mismatches.slice(0, noteLimit)) {
      this.emitLedgerNote(m, checkedAt);
    }

    // Signal-consumed brake — flip EvolutionManager's shadow-write switch.
    // Tag the halt with our identity so a manual halt by an operator survives
    // until that operator clears it. Auto-resume only clears halts we set.
    if (report.divergenceCount > 0) {
      this.evolutionManager.setShadowWritesHalted(
        true,
        `taskflow-divergence: ${report.divergenceCount} mismatch(es) at ${checkedAt}`,
        'divergence-checker'
      );
    } else {
      const cur = this.evolutionManager.isShadowWritesHalted();
      if (cur.halted && cur.source === 'divergence-checker') {
        this.evolutionManager.setShadowWritesHalted(false);
      }
    }

    return report;
  }

  // ── private helpers ──────────────────────────────────────────────

  private emitMetric(name: string, value: number, labels: Record<string, string>): void {
    // Lightweight surface — instar's metrics are emitted via console.log
    // tagged lines that the dashboard scrapes; structured JSON keeps the
    // line greppable. If a metric backend is wired later, this is the seam.
    try {
      console.log(`[metric] ${name}=${value} ${JSON.stringify(labels)}`);
    } catch {
      /* swallow */
    }
  }

  private emitLedgerNote(m: DivergenceMismatch, checkedAt: string): void {
    if (!this.ledger) return;
    void Promise.resolve()
      .then(() =>
        this.ledger!.append({
          kind: 'note',
          provenance: 'subsystem-asserted',
          emittedBy: {
            subsystem: 'taskflow-divergence',
            instance: 'DivergenceChecker',
          },
          counterparty: { type: 'self', name: 'EvolutionManager', trustTier: 'trusted' },
          subject: 'taskflow-divergence',
          summary:
            `${m.kind}: ownerKey=${m.ownerKey} ` +
            (m.proposalId ? `proposalId=${m.proposalId} ` : '') +
            (m.flowId ? `flowId=${m.flowId} ` : '') +
            (m.proposalStatus ? `proposalStatus=${m.proposalStatus} ` : '') +
            (m.flowStatus ? `flowStatus=${m.flowStatus} ` : '') +
            (m.expectedStep !== undefined ? `expectedStep=${m.expectedStep ?? 'none'} actualStep=${m.actualStep ?? 'none'} ` : '') +
            (m.expectedWaitKind !== undefined ? `expectedWaitKind=${m.expectedWaitKind ?? 'none'} actualWaitKind=${m.actualWaitKind ?? 'none'}` : ''),
          dedupKey: `taskflow-divergence:${m.kind}:${m.ownerKey}:${checkedAt}`,
        } as any)
      )
      .catch(() => {
        /* swallow — best-effort */
      });
  }
}
