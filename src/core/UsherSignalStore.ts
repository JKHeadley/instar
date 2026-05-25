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
}

export interface UsherMetrics {
  fired: number;
  acted: number;
  last_fired_at: string | null;
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

  /** Mark a signal as acted-on (precision numerator). Best-effort. */
  markActed(topicId: number, signalId: string): boolean {
    try {
      const file = this.load(topicId);
      const sig = file.signals.find(x => x.id === signalId);
      if (!sig || sig.acted) return false;
      sig.acted = true;
      file.metrics.acted += 1;
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
