/**
 * FrameworkParitySentinel — consumer of the Layer-3 parity rules registry.
 *
 * Spec: specs/instar-foundations/framework-parity-sentinel.md
 *
 * Walks the registry on its scan cadence (and on triggers), calls each rule's
 * verify() per instance, surfaces drift via events + degradation reports, and
 * (per rule's remediationPolicy) optionally calls remediate() to re-render
 * canonical into the framework-native shape.
 *
 * v0.1 scope:
 *   - Registry walker (consume listParityRules → iterate → collect verify).
 *   - State file persistence (.instar/state/framework-parity-sentinel.json).
 *   - Interval trigger (single setInterval; no chokidar watcher yet).
 *   - EventEmitter wiring (5 events: gap-found, remediated, remediation-refused,
 *     orphan-found, scan-complete).
 *   - Degradation reporter on persistent unresolved gaps.
 *
 * v0.2 deferred: chokidar source-change watcher, per-instance remediate HTTP
 * route, trust-level integration for mirror-trust gating, backfill migration.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  listParityRules,
  getParityRule,
} from '../providers/parity/registry.js';
import type {
  ParityRule,
  ParityMismatch,
  FunctionalPrimitive,
} from '../providers/parity/types.js';
import type { IntelligenceFramework } from '../core/intelligenceProviderFactory.js';
import { DegradationReporter } from './DegradationReporter.js';
import type { AdaptiveTrust } from '../core/AdaptiveTrust.js';

// ── Types ─────────────────────────────────────────────────────────

export interface FrameworkParitySentinelConfig {
  /** Project root (passed to each rule's verify/remediate). */
  projectRoot: string;
  /** State directory (typically `.instar`). */
  stateDir: string;
  /** Which frameworks are currently enabled for this agent. */
  enabledFrameworks: ReadonlyArray<IntelligenceFramework>;
  /** Scan interval in ms. Default: 1_800_000 (30 min). */
  scanIntervalMs?: number;
  /** Initial scan delay in ms. Default: 60_000 (1 min after start). */
  initialScanDelayMs?: number;
  /** If true, mirror-trust rules call remediate(); if false, all rules are flag-only. */
  remediationEnabled?: boolean;
  /**
   * Optional AdaptiveTrust handle. When provided, mirror-trust rules consult
   * the trust level for service='parity-sentinel', operation='modify':
   *   - autonomous|log  → remediate
   *   - approve-*|block → flag-only
   * When omitted, mirror-trust rules fall through to remediationEnabled
   * (preserves the v0.1 binary gate). PostUpdateMigrator seeds the
   * parity-sentinel service entry at level=log on update so existing agents
   * keep remediating once the wiring is enabled.
   */
  adaptiveTrust?: AdaptiveTrust;
}

interface PerInstanceCursor {
  lastScanAt: string;
  lastResult: 'ok' | 'drift' | 'conflict' | 'error';
  lastDetail?: string;
  /** Number of consecutive scans with unresolved drift — used for degradation reporting. */
  unresolvedCount: number;
}

interface SentinelState {
  /** Per (primitive × instance) cursor */
  cursors: Record<string, PerInstanceCursor>;
  /** When the last full scan finished */
  lastScanAt: string | null;
}

export interface ParityScanReport {
  scannedAt: string;
  rulesWalked: number;
  instancesChecked: number;
  gapsFound: number;
  remediated: number;
  remediationRefused: number;
  orphansFound: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function cursorKey(primitive: FunctionalPrimitive, instance: string): string {
  return `${primitive}::${instance}`;
}

// ── Implementation ────────────────────────────────────────────────

export class FrameworkParitySentinel extends EventEmitter {
  private config: FrameworkParitySentinelConfig;
  private state: SentinelState;
  private statePath: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;
  private isScanning = false;

  constructor(config: FrameworkParitySentinelConfig) {
    super();
    this.config = config;
    this.statePath = path.join(config.stateDir, 'state', 'framework-parity-sentinel.json');
    this.state = this.loadState();
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start(): void {
    if (this.interval) return;

    const intervalMs = this.config.scanIntervalMs ?? 1_800_000;
    const initialDelay = this.config.initialScanDelayMs ?? 60_000;

    this.initialTimeout = setTimeout(() => {
      void this.scan();
    }, initialDelay);
    this.initialTimeout.unref?.();

    this.interval = setInterval(() => {
      void this.scan();
    }, intervalMs);
    this.interval.unref?.();

    console.log(
      `[FrameworkParitySentinel] started — interval ${Math.round(intervalMs / 60_000)}m, ` +
        `first scan in ${Math.round(initialDelay / 1000)}s`,
    );
  }

  stop(): void {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Run a full scan immediately. Returns a structured report. Safe to call
   * concurrently — overlapping calls are short-circuited.
   */
  async scan(): Promise<ParityScanReport> {
    if (this.isScanning) {
      return {
        scannedAt: new Date().toISOString(),
        rulesWalked: 0,
        instancesChecked: 0,
        gapsFound: 0,
        remediated: 0,
        remediationRefused: 0,
        orphansFound: 0,
      };
    }
    this.isScanning = true;
    const scannedAt = new Date().toISOString();
    const report: ParityScanReport = {
      scannedAt,
      rulesWalked: 0,
      instancesChecked: 0,
      gapsFound: 0,
      remediated: 0,
      remediationRefused: 0,
      orphansFound: 0,
    };

    try {
      const rules = listParityRules();
      for (const rule of rules) {
        report.rulesWalked += 1;
        await this.scanRule(rule, report);
      }

      this.state.lastScanAt = scannedAt;
      this.saveState();
      this.emit('parity:scan-complete', report);
      return report;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'FrameworkParitySentinel.scan',
        primary: 'Walk parity rules registry + verify',
        fallback: 'Scan aborted; cursors not advanced',
        reason: `Scan error: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Cross-framework drift may go undetected until next successful scan',
      });
      console.error('[FrameworkParitySentinel] scan error:', err);
      return report;
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Returns the current scan state — used by the HTTP /api/framework-parity/status route.
   */
  getStatus(): { lastScanAt: string | null; cursors: Record<string, PerInstanceCursor> } {
    return {
      lastScanAt: this.state.lastScanAt,
      cursors: { ...this.state.cursors },
    };
  }

  // ── Scan implementation ────────────────────────────────────────

  private async scanRule(rule: ParityRule, report: ParityScanReport): Promise<void> {
    let instances: string[];
    try {
      instances = await rule.listInstances(this.config.projectRoot);
    } catch (err) {
      this.recordRuleError(rule, err);
      return;
    }

    for (const instance of instances) {
      report.instancesChecked += 1;
      const key = cursorKey(rule.primitive, instance);
      let result: 'ok' | 'drift' | 'conflict' | 'error' = 'ok';
      let detail: string | undefined;

      try {
        const verifyResult = await rule.verify(this.config.projectRoot, instance);
        if (!verifyResult.ok) {
          report.gapsFound += verifyResult.mismatches.length;
          const hasConflict = verifyResult.mismatches.some(
            (m) => m.reasonCode === 'user-edit-conflict',
          );
          // Per Migration Parity §4, rules with alwaysOverwrite=true (e.g.
          // hookParityRule for built-in hooks) treat user-edit-conflict as a
          // signal-only — remediation proceeds, and we emit
          // parity:user-edit-overwritten so operators can recover via git.
          const conflictBlocksRemediation = hasConflict && !rule.alwaysOverwrite;
          result = conflictBlocksRemediation ? 'conflict' : 'drift';
          detail = verifyResult.mismatches.map((m) => `${m.framework}: ${m.detail}`).join('; ');

          for (const m of verifyResult.mismatches) {
            this.emit('parity:gap-found', m);
            if (m.reasonCode === 'user-edit-conflict' && rule.alwaysOverwrite) {
              this.emit('parity:user-edit-overwritten', m);
            }
          }

          if (result === 'drift' && this.shouldRemediate(rule)) {
            for (const m of verifyResult.mismatches) {
              if (m.framework === 'canonical') continue; // can't remediate canonical drift
              await this.attemptRemediate(rule, instance, m.framework, report);
            }
          } else if (result === 'conflict') {
            for (const m of verifyResult.mismatches) {
              this.emit('parity:remediation-refused', m);
              report.remediationRefused += 1;
            }
          }
        }
      } catch (err) {
        result = 'error';
        detail = err instanceof Error ? err.message : String(err);
      }

      const prior = this.state.cursors[key];
      const unresolvedCount =
        result === 'ok'
          ? 0
          : (prior?.unresolvedCount ?? 0) + 1;
      this.state.cursors[key] = {
        lastScanAt: report.scannedAt,
        lastResult: result,
        lastDetail: detail,
        unresolvedCount,
      };

      if (unresolvedCount >= 3 && result !== 'ok') {
        DegradationReporter.getInstance().report({
          feature: `parity:${rule.primitive}:${instance}`,
          primary: 'Cross-framework parity for this instance',
          fallback: 'Drift persists across multiple scans',
          reason: detail ?? 'unknown',
          impact: `Drift unresolved for ${unresolvedCount} consecutive scans`,
        });
      }
    }

    // Orphan detection (per rule)
    try {
      const orphans = await rule.listOrphans(this.config.projectRoot);
      for (const o of orphans) {
        report.orphansFound += 1;
        this.emit('parity:orphan-found', o);
      }
    } catch (err) {
      this.recordRuleError(rule, err);
    }
  }

  private async attemptRemediate(
    rule: ParityRule,
    instance: string,
    framework: IntelligenceFramework | 'canonical',
    report: ParityScanReport,
  ): Promise<void> {
    if (framework === 'canonical') return;
    if (!this.config.enabledFrameworks.includes(framework)) return;
    try {
      await rule.remediate(this.config.projectRoot, instance, framework);
      report.remediated += 1;
      this.emit('parity:remediated', {
        primitive: rule.primitive,
        instance,
        framework,
      });
    } catch (err) {
      report.remediationRefused += 1;
      this.emit('parity:remediation-refused', {
        primitive: rule.primitive,
        instanceName: instance,
        framework,
        reasonCode: 'user-edit-conflict' as const,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private shouldRemediate(rule: ParityRule): boolean {
    if (rule.remediationPolicy === 'flag-only') return false;
    if (this.config.remediationEnabled === false) return false;
    // Mirror-trust: when AdaptiveTrust is wired, consult the trust level for
    // the parity-sentinel service on 'modify' operations. The PostUpdateMigrator
    // seeds this entry at level=log so existing agents keep remediating.
    // Operators can downgrade to approve-* or block to flag-only without
    // touching the sentinel config.
    if (this.config.adaptiveTrust && rule.remediationPolicy === 'mirror-trust') {
      const entry = this.config.adaptiveTrust.getTrustLevel('parity-sentinel', 'modify');
      const autonomy = this.config.adaptiveTrust.trustToAutonomy(entry.level);
      // 'proceed' (autonomous) and 'log' allow remediation; 'approve' and 'block' do not.
      return autonomy === 'proceed' || autonomy === 'log';
    }
    return true;
  }

  private recordRuleError(rule: ParityRule, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[FrameworkParitySentinel] rule ${rule.primitive} error: ${detail}`);
    DegradationReporter.getInstance().report({
      feature: `parity:${rule.primitive}`,
      primary: 'Walk this primitive\'s parity rule',
      fallback: 'Skip this rule for this scan; other rules unaffected',
      reason: detail,
      impact: `Drift detection for ${rule.primitive} primitive paused until next successful scan`,
    });
  }

  // ── Persistence ────────────────────────────────────────────────

  private loadState(): SentinelState {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      }
    } catch {
      /* start fresh */
    }
    return { cursors: {}, lastScanAt: null };
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.statePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmpPath, this.statePath);
    } catch {
      // @silent-fallback-ok — state loss just re-scans on next pass
    }
  }
}

// ── Test seam ─────────────────────────────────────────────────────

/**
 * Lookup a single rule by primitive. Re-exported here so the sentinel's
 * tests and the HTTP routes have a single import surface.
 * @internal
 */
export const _getParityRuleForTest = getParityRule;
