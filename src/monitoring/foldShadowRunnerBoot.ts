/**
 * Wiring for the shadow fold runner (context-budget-layered-summaries §16
 * Phase 2; slice P2-4b): builds the runner's dependencies from the server's
 * live objects, and triggers it on a topic session's turn end (the `Stop` hook
 * event). There is deliberately no timer sweep: a clean stop is a turn end, and
 * a sweep would count idle minutes as stops (skewing the 1-in-3 sample and
 * logging a skip row per idle session per minute).
 *
 * Bounded by construction:
 *  - one shadow fold at a time on this machine (a second turn end while one
 *    runs is ignored, never queued), and one per topic;
 *  - the handoff turn's own `Stop` event is routed to the waiting runner, never
 *    re-triggers a fold (the topic is in flight);
 *  - the switch is read on every trigger (`contextBudget.fold.shadow`,
 *    dev-gated), so turning it off stops new folds at the next turn end.
 *
 * Every dependency is a narrow structural interface so the wiring is testable
 * without the server; server.ts passes the real objects.
 */
import fs from 'node:fs';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import { runShadowFoldOnStop, type LiveTopicSession, type ShadowRunnerDeps } from './foldShadowRunner.js';
import { foldedSpansFromArchive } from './foldWiringHelpers.js';
import { openBackgroundTasks } from './foldCleanStop.js';
import { estimateFoldBenefit, type BenefitEstimate } from './foldBenefit.js';
import type { AnswererDeps } from './foldShadowAnswerer.js';
import type { ShadowFoldRow } from './foldShadowLog.js';

/** The transcript tail the runner reads for the clean stop and the lock window (bounded). */
export const RUNNER_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

export interface RunnerSessionLike { id: string; tmuxSession: string; telegramTopicId?: number; claudeSessionId?: string; framework?: string; model?: string }

export interface ShadowRunnerBootDeps {
  stateDir: string;
  enabled(): boolean;
  /** Running sessions on this machine. */
  sessions(): RunnerSessionLike[];
  /** The session's Claude Code transcript path, or null. */
  transcriptPath(s: RunnerSessionLike): string | null;
  /** The `Stop` hook events: subscribe; the payload carries instar_session_id and last_assistant_message. */
  onStop(cb: (payload: { instar_session_id?: string; session_id?: string; last_assistant_message?: string }) => void): () => void;
  /** Everything the runner needs that is not session- or trigger-specific. */
  base: Omit<ShadowRunnerDeps, 'enabled' | 'session' | 'transcript' | 'estimate' | 'answerer' | 'foldedSpans' | 'stateDir' | 'now'> & {
    sessionOps: {
      exists(tmux: string): boolean;
      workState(tmux: string): Promise<'working' | 'idle' | 'indeterminate'>;
      hasLiveToolShell(tmux: string): boolean;
      hasActiveSubagents(claudeSessionId: string): boolean;
      pendingInjection(tmux: string): boolean;
      inject(tmux: string, text: string): boolean;
    };
    archive: Parameters<typeof foldedSpansFromArchive>[0];
    /** Live context size, its lag, and the trailing turn rate, from the token ledger; null when there is no ledger. */
    ledger: { liveContextTokens(claudeSessionId: string): number | null; lagging(claudeSessionId: string): boolean; turnsLastHour(claudeSessionId: string): number | null } | null;
    /** Estimated packet size in tokens (the standing packet's full size is the floor of a fold packet). */
    packetTokens(topicKey: string): number;
    answerer: AnswererDeps;
  };
  now?(): number;
  onRow?(row: Omit<ShadowFoldRow, 't'>): void;
  /** A step that threw, or a fold record that could not be closed: reported (DegradationReporter in server.ts). */
  onDegraded?(e: { topicKey: string; foldId: string | null; reason: string }): void;
}

export interface ShadowRunnerHandle { stop(): void; status(): { runs: number; inFlight: string | null; lastAt: number | null } }

/** Read the newest `max` bytes of a transcript (whole lines only). */
async function readTail(file: string, max: number): Promise<string | null> {
  try {
    const st = await fs.promises.stat(file);
    const fh = await fs.promises.open(file, 'r');
    try {
      const len = Math.min(st.size, max);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      const text = buf.toString('utf-8');
      return st.size > max ? text.slice(text.indexOf('\n') + 1) : text;
    } finally { await fh.close(); }
  } catch {
    return null; // @silent-fallback-ok — an unreadable transcript is `unknown` to the clean stop (not clean)
  }
}

function lastEntryId(jsonl: string): string | null {
  const lines = jsonl.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const r = JSON.parse(lines[i]) as { uuid?: unknown }; if (typeof r.uuid === 'string') return r.uuid; } catch { /* @silent-fallback-ok — a torn line */ }
  }
  return null;
}

export function startShadowFoldRunner(d: ShadowRunnerBootDeps): ShadowRunnerHandle {
  const now = d.now ?? Date.now;
  let inFlight: string | null = null;
  let runs = 0;
  let lastAt: number | null = null;
  const waiters = new Map<string, (text: string | null) => void>();

  const live = (s: RunnerSessionLike): LiveTopicSession | null => {
    if (typeof s.telegramTopicId !== 'number' || s.telegramTopicId <= 0) return null;
    return { topicKey: String(s.telegramTopicId), tmuxSession: s.tmuxSession, instarSessionId: s.id, claudeSessionId: s.claudeSessionId ?? null, framework: s.framework ?? CLAUDE_CODE_FRAMEWORK, ...(s.model ? { model: s.model } : {}) };
  };

  const deps = (raw: RunnerSessionLike): ShadowRunnerDeps => {
    const b = d.base;
    const estimate = (s: LiveTopicSession): BenefitEstimate => {
      if (!b.ledger || !s.claudeSessionId) return { status: 'unknown', reason: 'no token ledger for this session' };
      if (b.ledger.lagging(s.claudeSessionId)) return { status: 'unknown', reason: 'the live context size is behind the ledger poller' };
      return estimateFoldBenefit({
        liveContextTokens: b.ledger.liveContextTokens(s.claudeSessionId), packetTokens: b.packetTokens(s.topicKey),
        cache: 'accounted', warm: true, // a turn just ended: the prompt cache is warm (§7.2 "written while the cache is warm")
        costs: { handoffOutputTokens: 4_000, sendBacks: 0, fixedTokens: 60_000 },
        trailingTurnsPerHour: b.ledger.turnsLastHour(s.claudeSessionId), openThreads: 0,
      });
    };
    return {
      ...b, stateDir: d.stateDir, enabled: d.enabled, now,
      estimate,
      foldedSpans: (topicKey, finished) => foldedSpansFromArchive(b.archive, topicKey, finished, b.messages(topicKey, 500).map((m) => m.messageId)),
      answerer: b.answerer,
      session: {
        exists: (s) => b.sessionOps.exists(s.tmuxSession),
        paneIdle: async (s) => { const w = await b.sessionOps.workState(s.tmuxSession); return w === 'idle' ? true : w === 'working' ? false : 'unknown'; },
        liveToolShell: (s) => { try { return b.sessionOps.hasLiveToolShell(s.tmuxSession); } catch { return 'unknown'; } }, // @silent-fallback-ok — an unreadable process tree is unknown (not clean)
        liveHelpers: (s) => (s.claudeSessionId ? b.sessionOps.hasActiveSubagents(s.claudeSessionId) : 'unknown'),
        pendingInjection: (s) => b.sessionOps.pendingInjection(s.tmuxSession),
        inject: async (s, text) => b.sessionOps.inject(s.tmuxSession, text),
        awaitTurnEnd: (s, boundMs, onTick) => new Promise<string | null>((resolve) => {
          const tick = setInterval(onTick, 30_000);
          const timer = setTimeout(() => { waiters.delete(s.instarSessionId); clearInterval(tick); resolve(null); }, boundMs);
          waiters.set(s.instarSessionId, (text) => { clearTimeout(timer); clearInterval(tick); waiters.delete(s.instarSessionId); resolve(text); });
        }),
      },
      transcript: {
        read: async () => { const p = d.transcriptPath(raw); return p ? readTail(p, RUNNER_TRANSCRIPT_TAIL_BYTES) : null; },
        lastEntryId,
        openBackgroundTasks: (jsonl) => openBackgroundTasks(jsonl),
      },
      ...(d.onRow ? { log: d.onRow } : {}),
      ...(d.onDegraded ? { onDegraded: d.onDegraded } : {}),
    };
  };

  const trigger = (raw: RunnerSessionLike) => {
    if (inFlight !== null || !d.enabled()) return; // one shadow fold per machine at a time; never queued
    const s = live(raw);
    if (!s || s.framework !== CLAUDE_CODE_FRAMEWORK) return;
    inFlight = s.topicKey;
    runs++;
    lastAt = now();
    void runShadowFoldOnStop(deps(raw), s)
      // The runner closes its own fold on a thrown step; a throw that escapes it (before begin) is reported, never silent.
      .catch((e) => { // @silent-fallback-ok — reported through onDegraded (DegradationReporter in server.ts)
        d.onDegraded?.({ topicKey: s.topicKey, foldId: null, reason: `runner-threw: ${e instanceof Error ? e.name : 'error'}` }); return null; })
      .finally(() => { inFlight = null; });
  };

  const unsubscribe = d.onStop((p) => {
    const iid = p.instar_session_id;
    if (!iid) return;
    // A runner waiting on this session's handoff turn takes the reply; it never re-triggers.
    const w = waiters.get(iid);
    if (w) { w(typeof p.last_assistant_message === 'string' ? p.last_assistant_message : null); return; }
    const raw = d.sessions().find((x) => x.id === iid);
    if (raw) trigger(raw);
  });

  return {
    stop: () => { unsubscribe(); for (const w of waiters.values()) w(null); },
    status: () => ({ runs, inFlight, lastAt }),
  };
}
