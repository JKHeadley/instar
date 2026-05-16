/**
 * AuditProjection — Read view over the audit-projection file.
 *
 * Foundation F-4 component (SELF-HEALING-REMEDIATOR-V2-SPEC §A14 / §A29).
 *
 * Exposes a `Map<runbookId, recentEntries>` used by the churn detector and
 * the SystemReviewer's clustering pipeline. The projection is hot-path:
 * reads come from an in-memory cache, refreshed when the underlying file
 * changes.
 *
 * Change detection follows the A47 amendment: parent-directory watch with a
 * mtime-diff fallback. We do NOT depend on per-file `fs.watch` semantics for
 * correctness — every cache read re-stats the file and reloads if `mtimeMs`
 * diverged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { deserializeAuditEntry, type AuditEntry } from './AuditWriter.js';

export interface AuditProjectionOptions {
  machineId: string;
}

export class AuditProjection {
  private readonly projectionPath: string;
  private byRunbook: Map<string, AuditEntry[]> = new Map();
  private unmatchedEntries: AuditEntry[] = [];
  private lastMtimeMs = 0;
  private lastSize = 0;
  private watcher?: fs.FSWatcher;

  constructor(stateDir: string, options: AuditProjectionOptions) {
    const dir = path.join(stateDir, 'remediation');
    this.projectionPath = path.join(dir, `audit-projection-${options.machineId}.jsonl`);
    this.tryStartWatcher(dir);
    this.reloadIfChanged();
  }

  /**
   * Snapshot of (runbookId → recent entries) seen so far. Refreshed on every
   * call by re-statting the projection file; cheap when mtime is unchanged.
   */
  recentByRunbook(): Map<string, AuditEntry[]> {
    this.reloadIfChanged();
    // Return a shallow copy so callers can't mutate our internal state.
    const out = new Map<string, AuditEntry[]>();
    for (const [k, v] of this.byRunbook) out.set(k, [...v]);
    return out;
  }

  /**
   * Snapshot of `no-matching-runbook` audit entries since projection start.
   * Consumed by NovelFailureReviewer (Tier-3 S-1) for bottom-up cluster
   * discovery. Order preserved — append order in the projection file.
   */
  unmatched(): AuditEntry[] {
    this.reloadIfChanged();
    return [...this.unmatchedEntries];
  }

  /** Stop watching the projection directory. Idempotent. */
  close(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = undefined;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  private tryStartWatcher(dir: string): void {
    try {
      if (!fs.existsSync(dir)) return;
      this.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) {
          this.reloadIfChanged();
          return;
        }
        if (path.basename(this.projectionPath) === filename) {
          this.reloadIfChanged();
        }
      });
    } catch {
      // inotify exhausted or platform-unsupported — read-path stat is the
      // source of truth, watcher is supplementary (A46/A47).
    }
  }

  private reloadIfChanged(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.projectionPath);
    } catch {
      // File doesn't exist yet — empty projection.
      this.byRunbook.clear();
      this.lastMtimeMs = 0;
      this.lastSize = 0;
      return;
    }
    if (st.mtimeMs === this.lastMtimeMs && st.size === this.lastSize) return;
    this.lastMtimeMs = st.mtimeMs;
    this.lastSize = st.size;

    let raw: string;
    try {
      raw = fs.readFileSync(this.projectionPath, 'utf8');
    } catch {
      return;
    }
    const next = new Map<string, AuditEntry[]>();
    const nextUnmatched: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry: AuditEntry;
      try {
        entry = deserializeAuditEntry(line);
      } catch {
        continue;
      }
      if (entry.outcome === 'no-matching-runbook') {
        nextUnmatched.push(entry);
        continue;
      }
      if (!entry.runbookId) continue;
      const arr = next.get(entry.runbookId) ?? [];
      arr.push(entry);
      next.set(entry.runbookId, arr);
    }
    this.byRunbook = next;
    this.unmatchedEntries = nextUnmatched;
  }
}
