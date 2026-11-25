/**
 * SEC-135 (docs/specs/sec135-approval-link-guess-bound.md, Observability): per-machine counters for the
 * recommended-services confirm page. Kept in memory and flushed to
 * `state/recommended-service-tokens/confirm-stats.json` at most once a minute, so a flood cannot drive
 * disk writes. Each counter names a PATH, never a person (a `local` answer is any local process; a
 * `marker` answer is a browser that once unlocked the dashboard).
 *
 * Machine-local and proxied-on-read: each machine reports its own in `GET /recommended-services`; the
 * graduation review reads every machine's and sums them.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CONFIRM_STATS_FLUSH_MS = 60_000;
/** Timed events kept for the graduation review (exempt-path answers while the aggregate was full). */
const MAX_EVENTS = 200;

export type ConfirmStatsPath = 'marker' | 'local' | 'public';

export interface ConfirmStatsSnapshot {
  since: string;
  publicPathRefused: number;
  answersByPath: Record<ConfirmStatsPath, number>;
  exemptPathOpens: number;
  exemptPathAnswersWhileAggregateFull: { marker: number; local: number };
  /** Each exempt-path answer completed while the public aggregate was full, with its time. */
  events: Array<{ at: string; path: 'marker' | 'local' }>;
}

export type ConfirmStatsReport = ConfirmStatsSnapshot | { state: 'unknown'; reason: string };

export function confirmStatsFile(stateDir: string): string {
  return path.join(stateDir, 'state', 'recommended-service-tokens', 'confirm-stats.json');
}

function fresh(now: number): ConfirmStatsSnapshot {
  return { since: new Date(now).toISOString(), publicPathRefused: 0, answersByPath: { marker: 0, local: 0, public: 0 }, exemptPathOpens: 0, exemptPathAnswersWhileAggregateFull: { marker: 0, local: 0 }, events: [] };
}

function isSnapshot(v: unknown): v is ConfirmStatsSnapshot {
  const s = v as ConfirmStatsSnapshot;
  const n = (x: unknown): boolean => Number.isInteger(x) && (x as number) >= 0;
  return !!s && typeof s === 'object' && typeof s.since === 'string' && n(s.publicPathRefused) && n(s.exemptPathOpens)
    && !!s.answersByPath && n(s.answersByPath.marker) && n(s.answersByPath.local) && n(s.answersByPath.public)
    && !!s.exemptPathAnswersWhileAggregateFull && n(s.exemptPathAnswersWhileAggregateFull.marker) && n(s.exemptPathAnswersWhileAggregateFull.local)
    && Array.isArray(s.events);
}

export class ConfirmStats {
  private readonly file: string;
  private stats: ConfirmStatsSnapshot;
  private lastFlushAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** The file existed at load but could not be read; it is set aside at the first flush. */
  private unreadableAtLoad: string | null = null;
  private lastWriteError: string | null = null;

  constructor(private readonly opts: { stateDir: string; now?: () => number; onWriteError?: (reason: string) => void }) {
    this.file = confirmStatsFile(opts.stateDir);
    this.stats = this.load();
  }

  recordPublicRefused(): void { this.stats.publicPathRefused++; this.touch(); }

  recordOwnerOpen(): void { this.stats.exemptPathOpens++; this.touch(); }

  recordAnswer(p: ConfirmStatsPath, aggregateFull: boolean): void {
    this.stats.answersByPath[p]++;
    if (aggregateFull && p !== 'public') {
      this.stats.exemptPathAnswersWhileAggregateFull[p]++;
      this.stats.events.push({ at: new Date(this.now()).toISOString(), path: p });
      if (this.stats.events.length > MAX_EVENTS) this.stats.events.splice(0, this.stats.events.length - MAX_EVENTS);
    }
    this.touch();
  }

  /**
   * What GET /recommended-services reports. Before the first flush, the in-memory counters. An
   * unreadable file (or a failed last write) reports `unknown` with the reason, never zeros.
   */
  report(): ConfirmStatsReport {
    if (this.lastWriteError) return { state: 'unknown', reason: `The counters could not be saved: ${this.lastWriteError}` };
    let text: string | null = null;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return { state: 'unknown', reason: `The counters file could not be read: ${(err as Error).message}` };
    }
    if (text !== null) {
      try { if (!isSnapshot(JSON.parse(text))) return { state: 'unknown', reason: 'The counters file is not in the expected shape.' }; }
      catch (err) { return { state: 'unknown', reason: `The counters file is damaged: ${(err as Error).message}` }; }
    } else if (this.unreadableAtLoad) {
      return { state: 'unknown', reason: this.unreadableAtLoad };
    }
    return structuredClone(this.stats);
  }

  /** Writes now if anything changed (tests and shutdown). */
  flushNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.lastFlushAt = this.now();
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (this.unreadableAtLoad && fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file.replace(/\.json$/, '')}.unreadable-${this.now()}.json`);
      this.unreadableAtLoad = null;
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.stats), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.lastWriteError = null;
    } catch (err) {
      const first = this.lastWriteError === null;
      this.lastWriteError = err instanceof Error ? err.message : String(err);
      if (first) this.opts.onWriteError?.(this.lastWriteError);
    }
  }

  private touch(): void {
    this.dirty = true;
    const wait = this.lastFlushAt + CONFIRM_STATS_FLUSH_MS - this.now();
    if (wait <= 0) { this.flushNow(); return; }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flushNow(); }, wait);
      this.timer.unref?.();
    }
  }

  private load(): ConfirmStatsSnapshot {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return fresh(this.now()); // @silent-fallback-ok — no file yet: nothing counted yet
      this.unreadableAtLoad = `The counters file could not be read: ${(err as Error).message}`;
      return fresh(this.now());
    }
    try {
      const raw = JSON.parse(text);
      if (isSnapshot(raw)) return raw;
      this.unreadableAtLoad = 'The counters file is not in the expected shape.';
    } catch (err) {
      this.unreadableAtLoad = `The counters file is damaged: ${(err as Error).message}`;
    }
    return fresh(this.now());
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }
}
