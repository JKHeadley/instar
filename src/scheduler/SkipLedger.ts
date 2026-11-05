/**
 * SkipLedger — Tracks skipped job runs and workload signals.
 *
 * Foundation for adaptive job scheduling (auto-tuning).
 * Records WHY jobs were skipped and HOW MUCH work each run found.
 * This data feeds the future auto-tune engine.
 *
 * Storage: JSONL files in {stateDir}/ledger/
 * Retention: 30 days, rotated on startup
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SkipEvent, SkipReason, WorkloadSignal } from '../core/types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

const RETENTION_DAYS = 30;

export class SkipLedger {
  private ledgerDir: string;
  private skipFile: string;
  private workloadFile: string;
  /** Optional live observation; the ledger remains the durable record. */
  onSkip?: (event: SkipEvent) => void;

  constructor(stateDir: string) {
    this.ledgerDir = path.join(stateDir, 'ledger');
    this.skipFile = path.join(this.ledgerDir, 'skipped-runs.jsonl');
    this.workloadFile = path.join(this.ledgerDir, 'workload-signals.jsonl');

    this.ensureDirectory();
    this.rotateOldEntries();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.ledgerDir)) {
      fs.mkdirSync(this.ledgerDir, { recursive: true });
      console.log(`[SkipLedger] Created ledger directory: ${this.ledgerDir}`);
    }
  }

  /**
   * Record a skipped job run.
   */
  recordSkip(slug: string, reason: SkipReason, scheduledAt?: string): void {
    const event: SkipEvent = {
      slug,
      timestamp: new Date().toISOString(),
      reason,
      scheduledAt,
    };
    this.appendLine(this.skipFile, event);
    try { this.onSkip?.(event); } catch (error) {
      console.error('[SkipLedger] Skip observer failed:', error);
    }
  }

  /**
   * Record a workload signal from a completed job run.
   */
  recordWorkload(signal: WorkloadSignal): void {
    this.appendLine(this.workloadFile, signal);
  }

  /**
   * Get skip events, optionally filtered by slug and/or time window.
   */
  getSkips(opts?: { slug?: string; sinceHours?: number; reason?: SkipReason }): SkipEvent[] {
    const events = this.readLines<SkipEvent>(this.skipFile);
    const cutoff = opts?.sinceHours
      ? new Date(Date.now() - opts.sinceHours * 60 * 60 * 1000).toISOString()
      : undefined;

    return events.filter(e => {
      if (opts?.slug && e.slug !== opts.slug) return false;
      if (opts?.reason && e.reason !== opts.reason) return false;
      if (cutoff && e.timestamp < cutoff) return false;
      return true;
    });
  }

  /**
   * Get workload signals, optionally filtered by slug and/or time window.
   */
  getWorkloads(opts?: { slug?: string; sinceHours?: number; limit?: number }): WorkloadSignal[] {
    const signals = this.readLines<WorkloadSignal>(this.workloadFile);
    const cutoff = opts?.sinceHours
      ? new Date(Date.now() - opts.sinceHours * 60 * 60 * 1000).toISOString()
      : undefined;

    let filtered = signals.filter(s => {
      if (opts?.slug && s.slug !== opts.slug) return false;
      if (cutoff && s.timestamp < cutoff) return false;
      return true;
    });

    // Most recent first
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (opts?.limit) {
      filtered = filtered.slice(0, opts.limit);
    }

    return filtered;
  }

  /**
   * Get aggregated skip counts per job (for dashboard).
   */
  getSkipSummary(sinceHours: number = 24): Record<string, { total: number; byReason: Record<string, number> }> {
    const events = this.getSkips({ sinceHours });
    const summary: Record<string, { total: number; byReason: Record<string, number> }> = {};

    for (const event of events) {
      if (!summary[event.slug]) {
        summary[event.slug] = { total: 0, byReason: {} };
      }
      summary[event.slug].total++;
      summary[event.slug].byReason[event.reason] = (summary[event.slug].byReason[event.reason] || 0) + 1;
    }

    return summary;
  }

  /**
   * Get workload trend for a specific job (for auto-tune engine).
   */
  getWorkloadTrend(slug: string, windowSize: number = 10): {
    avgSaturation: number;
    skipFastRate: number;
    avgDuration: number;
    runCount: number;
  } {
    const signals = this.getWorkloads({ slug, limit: windowSize });

    if (signals.length === 0) {
      return { avgSaturation: 0, skipFastRate: 0, avgDuration: 0, runCount: 0 };
    }

    const totalSaturation = signals.reduce((sum, s) => sum + s.saturation, 0);
    const skipFastCount = signals.filter(s => s.skipFast).length;
    const totalDuration = signals.reduce((sum, s) => sum + s.duration, 0);

    return {
      avgSaturation: totalSaturation / signals.length,
      skipFastRate: skipFastCount / signals.length,
      avgDuration: totalDuration / signals.length,
      runCount: signals.length,
    };
  }

  /**
   * Rotate entries older than RETENTION_DAYS.
   */
  private rotateOldEntries(): void {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    for (const file of [this.skipFile, this.workloadFile]) {
      if (!fs.existsSync(file)) continue;

      const lines = this.readLines<{ timestamp: string }>(file);
      const fresh = lines.filter(l => l.timestamp >= cutoff);
      const removed = lines.length - fresh.length;

      if (removed > 0) {
        const content = fresh.map(l => JSON.stringify(l)).join('\n') + (fresh.length > 0 ? '\n' : '');
        fs.writeFileSync(file, content);
        console.log(`[SkipLedger] Rotated ${removed} entries from ${path.basename(file)} (${fresh.length} remaining)`);
      }
    }
  }

  private appendLine(file: string, data: unknown): void {
    try {
      fs.appendFileSync(file, JSON.stringify(data) + '\n');
    } catch (error) {
      console.error(`[SkipLedger] Failed to write to ${file}:`, error);
    }
  }

  private readLines<T>(file: string): T[] {
    if (!fs.existsSync(file)) return [];

    try {
      const content = fs.readFileSync(file, 'utf-8').trim();
      if (!content) return [];

      return content.split('\n').map(line => {
        try {
          return JSON.parse(line) as T;
        } catch {
          // @silent-fallback-ok — JSONL line parse, skip corrupted
          return null;
        }
      }).filter(Boolean) as T[];
    } catch (error) {
      console.error(`[SkipLedger] Failed to read ${file}:`, error);
      DegradationReporter.getInstance().report({
        feature: 'SkipLedger.readLines',
        primary: 'Read skip/workload ledger',
        fallback: 'Return empty — no historical data',
        reason: `Failed to read ledger: ${error instanceof Error ? error.message : String(error)}`,
        impact: 'Auto-tune engine lacks historical context',
      });
      return [];
    }
  }
}
