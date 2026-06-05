/**
 * cutoverReadiness.ts — the cutover-READINESS checker (coordination-mandate spec §7
 * G2.4, scoped by decision 1A): everything UP TO the door, never the door.
 *
 * The Phase-4 cutover flip is Justin's one manual click — NOT an autonomously
 * fireable action (decision 1A/3B). What CAN and SHOULD be autonomous is knowing,
 * from REAL durable state, whether the flip is safe: this module composes the two
 * objective conditions the spec names —
 *
 *   - `integrity-gate-pass`     ← the persisted Phase-4 import IntegrityReport
 *                                 (`runIntegrityGate(...).passed`, written server-side
 *                                 by the import tooling — never asserted by an agent)
 *   - `parity-zero-divergence`  ← `DurableParityMonitor.gate(now).cleared` over the
 *                                 durable zero-divergence window, PLUS a readiness-layer
 *                                 freshness bound (a streak that stopped being fed is
 *                                 visible staleness, not silent readiness)
 *
 * — and exposes them as one read-only status. The T7 discipline (conditions resolve
 * from real state, never an agent's assertion) is structural here: the ONLY write
 * paths are (a) `runParityPass()`, which the agent may TRIGGER but whose result is
 * computed server-side from a live fetch+compare, and (b) `recordIntegrityReport()`,
 * called by the server-side import tooling. There is no "set the condition" input.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DurableParityMonitor } from './monitor/parityMonitorStore.js';
import type { CutoverGateStatus } from './monitor/parityMonitor.js';
import type { IntegrityReport } from './migration/importIntegrity.js';
import type { ParityResult } from './processor/parity.js';

export interface IntegrityStatus {
  /** Has an import integrity report been recorded at all? */
  ran: boolean;
  /** The report's single gate boolean (false when never ran — deny-safe). */
  passed: boolean;
  generatedAt: string | null;
  /** Compact counts for display; null when never ran. */
  summary: {
    fingerprintCollisions: number;
    schemaDivergences: number;
    checksumMismatches: number;
    danglingRefs: number;
  } | null;
}

export interface ParityReadiness extends CutoverGateStatus {
  /** ISO of the most recent recorded pass (clean or divergent), or null. */
  lastPassAt: string | null;
  /** True when the last pass is older than `maxPassStalenessMs` — a cleared-but-stale
   *  window is NOT readiness (the gate has no max-staleness by design; this layer adds it). */
  stale: boolean;
}

export interface CutoverReadinessStatus {
  /** True only when integrity passed AND the parity window is cleared AND fresh.
   *  This is the everything-up-to-the-door signal — it never fires anything. */
  ready: boolean;
  /** Decision 1A, restated machine-readably so no consumer can misread the scope. */
  door: 'manual-operator-click';
  integrity: IntegrityStatus;
  parity: ParityReadiness;
}

export type ParityPassOutcome =
  | { ok: true; pass: { at: string; clustersCompared: number; divergences: number; divergent: boolean }; gate: CutoverGateStatus }
  | { ok: false; reason: string };

export interface CutoverReadinessDeps {
  parityMonitor: DurableParityMonitor;
  /** Where the import tooling's IntegrityReport persists (JSON envelope). */
  integrityReportPath: string;
  /** SERVER-SIDE parity check (live fetch + compare). Null when no parity source is
   *  configured — runParityPass() then refuses, and the parity condition can only
   *  clear via passes recorded by other server-side paths. */
  runParityCheck: (() => Promise<ParityResult>) | null;
  /** Freshness bound for the parity window (default 6h). */
  maxPassStalenessMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_PASS_STALENESS_MS = 6 * 60 * 60 * 1000;

interface PersistedIntegrityEnvelope {
  generatedAt: string;
  report: IntegrityReport;
}

export class CutoverReadiness {
  private readonly d: CutoverReadinessDeps;
  private readonly maxStaleMs: number;

  constructor(deps: CutoverReadinessDeps) {
    this.d = deps;
    this.maxStaleMs = deps.maxPassStalenessMs ?? DEFAULT_MAX_PASS_STALENESS_MS;
  }

  private nowMs(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  /** Persist an import IntegrityReport (server-side import tooling only). */
  recordIntegrityReport(report: IntegrityReport, generatedAt?: string): void {
    const envelope: PersistedIntegrityEnvelope = {
      generatedAt: generatedAt ?? new Date(this.nowMs()).toISOString(),
      report,
    };
    fs.mkdirSync(path.dirname(this.d.integrityReportPath), { recursive: true });
    fs.writeFileSync(this.d.integrityReportPath, JSON.stringify(envelope, null, 2));
  }

  integrityStatus(): IntegrityStatus {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.integrityReportPath, 'utf8')) as PersistedIntegrityEnvelope;
      const r = raw?.report;
      if (!r || typeof r.passed !== 'boolean') {
        return { ran: false, passed: false, generatedAt: null, summary: null };
      }
      return {
        ran: true,
        passed: r.passed,
        generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
        summary: {
          fingerprintCollisions: r.fingerprintCollisions?.length ?? 0,
          schemaDivergences: r.schemaDivergences?.length ?? 0,
          checksumMismatches: r.checksumMismatches?.length ?? 0,
          danglingRefs: r.danglingRefs?.length ?? 0,
        },
      };
    } catch { /* @silent-fallback-ok — no report on disk = the import never ran = NOT ready (deny-safe) */
      return { ran: false, passed: false, generatedAt: null, summary: null };
    }
  }

  parityStatus(): ParityReadiness {
    const nowIso = new Date(this.nowMs()).toISOString();
    const gate = this.d.parityMonitor.gate(nowIso);
    const passes = this.d.parityMonitor.passes;
    const lastPassAt = passes.length > 0 ? passes[passes.length - 1].at : null;
    const stale = lastPassAt === null
      ? true
      : this.nowMs() - Date.parse(lastPassAt) > this.maxStaleMs;
    return { ...gate, lastPassAt, stale };
  }

  /**
   * TRIGGER a server-side parity pass: live fetch + compare via the injected check,
   * record the result (clean OR divergent) into the durable window. The caller
   * contributes nothing to the result — only the request to run it (T7). A FAILED
   * check records nothing: a fetch error is absence of evidence, not evidence of
   * divergence — and it cannot extend the clean window either.
   */
  async runParityPass(): Promise<ParityPassOutcome> {
    if (!this.d.runParityCheck) {
      return { ok: false, reason: 'no parity source configured (feedbackMigration.paritySource) — cannot run a live check' };
    }
    let result: ParityResult;
    try {
      result = await this.d.runParityCheck();
    } catch (err) {
      return { ok: false, reason: `parity check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const at = new Date(this.nowMs()).toISOString();
    this.d.parityMonitor.recordResult(result, at);
    const divergences = result.fingerprintDivergences.length + result.outcomeDivergences.length;
    return {
      ok: true,
      pass: { at, clustersCompared: result.clustersCompared, divergences, divergent: divergences > 0 },
      gate: this.d.parityMonitor.gate(at),
    };
  }

  /** The everything-up-to-the-door readiness signal. Read-only; never fires anything. */
  status(): CutoverReadinessStatus {
    const integrity = this.integrityStatus();
    const parity = this.parityStatus();
    return {
      ready: integrity.passed && parity.cleared && !parity.stale,
      door: 'manual-operator-click',
      integrity,
      parity,
    };
  }
}
