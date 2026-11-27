/**
 * Transcript-growth ticks (context-budget-layered-summaries §6.4): keep H1
 * current for a tool-heavy session that sends no messages.
 *
 * Event-loop discipline: a pass `await`s an async stat per session first and
 * checks growth and the interval; the mid-turn probe (tmux forks) runs only
 * for a session that is otherwise due, the tail is read asynchronously only
 * then, and the pass yields between sessions. A session that is not due costs
 * one async stat.
 *
 * A tick runs only when the transcript grew, the session is not mid-turn, the
 * per-session minimum interval has passed (growing with recent updates from
 * ANY trigger, user turns included), and the layer budget admits it. A tick
 * that is shed or fails does not consume the growth: the next due pass
 * retries it. Every outcome is counted for the status/card.
 */
import fs from 'node:fs';
import { tickDue, buildTickDigest, readTranscriptTailAsync, estimateTokens, type TickState, type TopicLayerBudget, type TickDigest } from './layerCadence.js';

export interface TickSession {
  topicId: number;
  /** Stable per-session key (the engine session id). */
  sessionKey: string;
  transcriptPath: string;
  tmuxSession: string;
}

export type TickIngestOutcome = 'updated' | 'no-update' | 'shed' | 'failed';

export interface LayerTickerDeps {
  sessions: () => TickSession[];
  midTurn: (tmuxSession: string) => boolean | Promise<boolean>;
  budget: TopicLayerBudget;
  /** Feed one digest to the extractor; reports what happened. */
  ingest: (s: TickSession, digest: TickDigest) => Promise<TickIngestOutcome>;
  /** The agent's live secret values, for the digest's live-value pass. */
  liveSecrets?: () => readonly string[];
  now?: () => number;
  baseMs?: number;
  /**
   * The topic's recorded fold lock windows (§10 suppression carrier): the
   * transcript entries a fold's internal turns occupy (the handoff request and
   * its reply). The ticker skips them, so an internal turn never becomes the
   * conversation's current-work awareness.
   */
  lockWindows?: (topicId: number) => ReadonlyArray<{ fromEntry?: string; toEntry?: string; closedAt?: number }>;
}

/**
 * Drop the lines inside any lock window: every line AFTER the window's
 * `fromEntry` (the last entry before the internal turn was injected) up to
 * and including its `toEntry`. A window without a `toEntry` ends at the first
 * line timestamped after its `closedAt` (a fold that ended early); one with
 * neither (a fold still open) drops everything after its start. When the tail
 * no longer holds a window's start but still holds its end, the window is
 * open from the tail's first line. Lines without a uuid follow their window.
 */
export function dropLockWindows(lines: readonly string[], windows: ReadonlyArray<{ fromEntry?: string; toEntry?: string; closedAt?: number }>): string[] {
  const ws = windows.filter((w) => (typeof w.fromEntry === 'string' && w.fromEntry.length > 0) || typeof w.toEntry === 'string');
  if (ws.length === 0) return [...lines];
  // The entry's own top-level uuid and timestamp (never values nested inside its content).
  const parse = (line: string): { uuid: string | null; ts: number | null } => {
    try {
      const r = JSON.parse(line) as { uuid?: unknown; timestamp?: unknown };
      const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
      return { uuid: typeof r.uuid === 'string' ? r.uuid : null, ts: Number.isFinite(ts) ? ts : null };
    } catch { return { uuid: null, ts: null }; } // @silent-fallback-ok — a torn line has no uuid; it follows its neighbours in or out of a window
  };
  const parsed = lines.map(parse);
  const present = new Set(parsed.map((p) => p.uuid).filter((u): u is string => !!u));
  type Open = { toEntry?: string; closedAt?: number };
  // A window whose start scrolled out of the tail but whose end is still in it: open from the top.
  let open: Open | null = (() => {
    const w = ws.find((x) => x.toEntry && present.has(x.toEntry) && !(x.fromEntry && present.has(x.fromEntry)));
    return w ? { toEntry: w.toEntry } : null;
  })();
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { uuid, ts } = parsed[i];
    if (open) {
      if (open.toEntry !== undefined) { if (uuid === open.toEntry) open = null; continue; }
      if (open.closedAt !== undefined && ts !== null && ts > open.closedAt) { open = null; } else continue;
    }
    out.push(lines[i]);
    const w = uuid ? ws.find((x) => x.fromEntry === uuid) : undefined;
    if (w) open = { ...(w.toEntry ? { toEntry: w.toEntry } : {}), ...(w.toEntry === undefined && typeof w.closedAt === 'number' ? { closedAt: w.closedAt } : {}) };
  }
  return out;
}

export interface LayerTickerStatus {
  passes: number;
  ticks: number;
  updated: number;
  skipped: { midTurn: number; notGrown: number; interval: number; noDigest: number; budget: number; unreadable: number; shed: number };
  failed: number;
  lastPassAt: number | null;
}

const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

export class LayerTicker {
  private readonly state = new Map<string, TickState>();
  private running = false;
  private readonly st: LayerTickerStatus = { passes: 0, ticks: 0, updated: 0, skipped: { midTurn: 0, notGrown: 0, interval: 0, noDigest: 0, budget: 0, unreadable: 0, shed: 0 }, failed: 0, lastPassAt: null };

  constructor(private readonly d: LayerTickerDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /**
   * Record a layer update from any trigger for a topic (a captured user turn,
   * §6.4 "growing with the number of recent updates"), so every live session
   * of that topic lengthens its interval.
   */
  noteTopicUpdate(topicId: number): void {
    const now = this.now();
    for (const [key, s] of this.state) {
      if (this.topicOf.get(key) === topicId) s.recentUpdates = [...s.recentUpdates.filter((t) => now - t < 3_600_000), now];
    }
  }
  private readonly topicOf = new Map<string, number>();

  /** One pass. Re-entrancy safe: a pass still running makes the next a no-op. */
  async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.st.passes++;
      this.st.lastPassAt = this.now();
      let sessions: TickSession[];
      try { sessions = this.d.sessions(); } catch { return; /* @silent-fallback-ok — no session list this pass: keep every tick state; the next pass retries */ }
      const live = new Set(sessions.map((s) => s.sessionKey));
      for (const k of [...this.state.keys()]) if (!live.has(k)) { this.state.delete(k); this.topicOf.delete(k); }
      for (const s of sessions) {
        this.topicOf.set(s.sessionKey, s.topicId);
        await this.one(s);
        await yieldTurn();
      }
    } finally {
      this.running = false;
    }
  }

  private async one(s: TickSession): Promise<void> {
    const now = this.now();
    let size: number;
    try { size = (await fs.promises.stat(s.transcriptPath)).size; } catch { this.st.skipped.unreadable++; return; }
    let st = this.state.get(s.sessionKey);
    if (!st) {
      // First sight: baseline the size so the first tick needs real growth.
      this.state.set(s.sessionKey, { lastTickAt: now, lastSize: size, recentUpdates: [] });
      this.st.skipped.notGrown++;
      return;
    }
    // Cheap checks first; the mid-turn probe only for an otherwise-due session.
    const pre = tickDue(st, { now, size, midTurn: false, baseMs: this.d.baseMs });
    if (!pre.due) {
      if (pre.reason === 'not-grown') this.st.skipped.notGrown++;
      else this.st.skipped.interval++;
      return;
    }
    let midTurn = true;
    try { midTurn = await this.d.midTurn(s.tmuxSession); } catch { midTurn = true; /* @silent-fallback-ok — unknown activity is treated as mid-turn: skip */ }
    if (midTurn) { this.st.skipped.midTurn++; return; }
    const tail = await readTranscriptTailAsync(s.transcriptPath);
    if (!tail) { this.st.skipped.unreadable++; return; }
    let secrets: readonly string[] = [];
    try { secrets = this.d.liveSecrets?.() ?? []; } catch { secrets = []; /* @silent-fallback-ok — the shape scrub still runs */ }
    let windows: ReadonlyArray<{ fromEntry?: string; toEntry?: string; closedAt?: number }> = [];
    try { windows = this.d.lockWindows?.(s.topicId) ?? []; } catch { windows = []; /* @silent-fallback-ok — an unreadable window log means no recorded window; the fold hold kept the turn off the channel anyway */ }
    const digest = buildTickDigest(windows.length ? dropLockWindows(tail.lines, windows) : tail.lines, { liveSecrets: secrets });
    if (!digest) { this.st.skipped.noDigest++; st.lastSize = tail.size; st.lastTickAt = now; return; }
    // Deferred, not dropped: the size is not advanced, so the next due pass retries.
    const reserve = estimateTokens(digest.text) + 2_500;
    if (!this.d.budget.admit(String(s.topicId), reserve).ok) { this.st.skipped.budget++; return; }
    st = this.state.get(s.sessionKey) ?? st;
    let outcome: TickIngestOutcome;
    try { outcome = await this.d.ingest(s, digest); } catch { outcome = 'failed'; /* @silent-fallback-ok — counted on the status */ }
    if (outcome === 'shed' || outcome === 'failed') {
      // The growth is not consumed, the reservation is returned, and the retry
      // waits out the interval (no per-minute probe/read/scrub storm).
      if (outcome === 'shed') this.st.skipped.shed++; else this.st.failed++;
      this.d.budget.refund(String(s.topicId), reserve);
      st.lastTickAt = now;
      return;
    }
    this.st.ticks++;
    st.lastSize = tail.size;
    st.lastTickAt = now;
    if (outcome === 'updated') {
      this.st.updated++;
      st.recentUpdates = [...st.recentUpdates.filter((t) => now - t < 3_600_000), now];
    }
  }

  status(): LayerTickerStatus {
    return { ...this.st, skipped: { ...this.st.skipped } };
  }
}
