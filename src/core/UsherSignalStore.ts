/**
 * UsherSignalStore — durable, read-only-from-the-outside store of the Usher's
 * re-surface signals + its precision metrics (rung 4 of continuous-working-awareness).
 *
 * Signal-only: the Usher writes suggestions here; consumers PULL them
 * (GET /usher/signals). It never injects. The metrics (fired / acted) — paired
 * with the HumanAsDetectorLog miss-map — are the precision read that gates rung 5.
 *
 * File-backed per topic at {stateDir}/usher/<topicId>.json. Atomic writes
 * (temp+rename); best-effort (metering/signalling must never throw into the
 * message path). Spec: docs/specs/cwa-usher.md §3–4.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface UsherSignal {
  id: string;
  /** The faded context ref the turn re-activated. */
  contextRef: string;
  /** The ref's proposition text (for the pull surface). */
  contextText: string;
  /** Why this turn re-activates it (one line, LLM-produced). */
  reason: string;
  /** The user-turn at which it fired. */
  turn: number;
  at: string;
  /** True once the re-surfaced context was actually used (precision numerator). */
  acted: boolean;
  /**
   * Which path confirmed the signal was useful (set when `acted` flips true):
   *   'use'  — the agent's next reply actually used the re-surfaced context.
   *   'miss' — the user later had to correct the agent on that same context, so
   *            the nudge was a genuine catch the agent ignored.
   * Optional for backward-compat with signals/callers that pre-date the split.
   */
  actedVia?: 'use' | 'miss';
  /** ISO timestamp when the signal was marked acted. */
  actedAt?: string;
}

export interface UsherMetrics {
  fired: number;
  acted: number;
  last_fired_at: string | null;
  /** Precision numerator, split by which path confirmed usefulness (observability). */
  acted_by_use?: number;
  acted_by_miss?: number;
}

interface UsherTopicFile {
  topicId: number;
  signals: UsherSignal[];
  metrics: UsherMetrics;
  schemaVersion: 1;
}

const MAX_SIGNALS_PER_TOPIC = 50;

function emptyFile(topicId: number): UsherTopicFile {
  return { topicId, signals: [], metrics: { fired: 0, acted: 0, last_fired_at: null }, schemaVersion: 1 };
}

export class UsherSignalStore {
  private dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'usher');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (err) {
      console.error(`[UsherSignalStore] mkdir failed: ${err}`);
    }
  }

  private filePath(topicId: number): string {
    return path.join(this.dir, `${topicId}.json`);
  }

  load(topicId: number): UsherTopicFile {
    try {
      const fp = this.filePath(topicId);
      if (fs.existsSync(fp)) {
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as UsherTopicFile;
        if (!Array.isArray(parsed.signals)) parsed.signals = [];
        if (!parsed.metrics) parsed.metrics = emptyFile(topicId).metrics;
        return parsed;
      }
    } catch (err) {
      console.error(`[UsherSignalStore] corrupt file for ${topicId}, fresh: ${err}`);
    }
    return emptyFile(topicId);
  }

  private save(file: UsherTopicFile): void {
    try {
      const fp = this.filePath(file.topicId);
      const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
      fs.renameSync(tmp, fp);
    } catch (err) {
      console.error(`[UsherSignalStore] save failed: ${err}`);
    }
  }

  /** Record a fired signal (best-effort; never throws). Returns the signal id, or null. */
  recordSignal(topicId: number, s: { contextRef: string; contextText: string; reason: string; turn: number; at?: string }): string | null {
    try {
      const file = this.load(topicId);
      const signal: UsherSignal = {
        id: `usig-${randomUUID()}`,
        contextRef: s.contextRef,
        contextText: s.contextText,
        reason: s.reason,
        turn: s.turn,
        at: s.at ?? new Date().toISOString(),
        acted: false,
      };
      file.signals.push(signal);
      if (file.signals.length > MAX_SIGNALS_PER_TOPIC) {
        file.signals = file.signals.slice(-MAX_SIGNALS_PER_TOPIC);
      }
      file.metrics.fired += 1;
      file.metrics.last_fired_at = signal.at;
      this.save(file);
      return signal.id;
    } catch (err) {
      console.error(`[UsherSignalStore] recordSignal failed: ${err}`);
      return null;
    }
  }

  /**
   * Mark a signal as acted-on (precision numerator). Best-effort, idempotent
   * (a second call on the same signal is a no-op returning false).
   *
   * `opts.via` records WHICH correlation path confirmed usefulness ('use' =
   * the agent used it in a reply; 'miss' = the user had to correct on it) and
   * is reflected in the split metrics. `opts.at` lets callers stamp a
   * deterministic timestamp (tests); defaults to now.
   */
  markActed(topicId: number, signalId: string, opts?: { via?: 'use' | 'miss'; at?: string }): boolean {
    try {
      const file = this.load(topicId);
      const sig = file.signals.find(x => x.id === signalId);
      if (!sig || sig.acted) return false;
      sig.acted = true;
      if (opts?.via) sig.actedVia = opts.via;
      sig.actedAt = opts?.at ?? new Date().toISOString();
      file.metrics.acted += 1;
      if (opts?.via === 'use') file.metrics.acted_by_use = (file.metrics.acted_by_use ?? 0) + 1;
      else if (opts?.via === 'miss') file.metrics.acted_by_miss = (file.metrics.acted_by_miss ?? 0) + 1;
      this.save(file);
      return true;
    } catch {
      return false;
    }
  }

  getSignals(topicId: number, limit = 20): UsherSignal[] {
    const file = this.load(topicId);
    return file.signals.slice(-limit).reverse();
  }

  getMetrics(topicId: number): UsherMetrics {
    return this.load(topicId).metrics;
  }
}
