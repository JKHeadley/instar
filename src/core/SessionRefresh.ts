/**
 * SessionRefresh — orchestrates an agent-initiated session respawn.
 *
 * When an agent installs a new MCP server or skill mid-session, Claude Code
 * only attaches the new tools at session start. The agent triggers this class
 * to kill its current tmux session and respawn it with `claude --resume <uuid>`,
 * which loads the freshly installed tools while preserving full conversation
 * state.
 *
 * The respawn lifecycle is owned end-to-end here:
 *   detect    — sanity-check session, topic binding, resume UUID exist
 *   attempt   — apply rate guard, persist resume UUID, kill tmux, respawn
 *   verify    — new session is registered for the topic
 *   finalize  — return structured result
 *
 * Rate guard is a structural rate-counter (allowed-detector category per
 * docs/signal-vs-authority.md "safety guards on irreversible actions"
 * carve-out) — prevents infinite-respawn loops. Not a judgment call.
 *
 * v1 scope: Telegram-bound sessions only. Non-Telegram-bound respawn is a
 * v2 follow-up — returns { ok: false, code: 'not_telegram_bound' } for now.
 */

import type { SessionManager } from './SessionManager.js';
import type { StateManager } from './StateManager.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { TopicResumeMap } from './TopicResumeMap.js';

export interface SessionRefreshDeps {
  sessionManager: SessionManager;
  state: StateManager;
  telegram: TelegramAdapter | null;
  topicResumeMap: TopicResumeMap | null;
  /**
   * Respawn callback. Wired by server bootstrap to call
   * respawnSessionForTopic with the right closure (sessionManager,
   * telegram, topicMemory, etc). Kept as a callback to keep this class
   * decoupled from the server-internal respawn helper.
   *
   * IMPORTANT: respawnSessionForTopic does NOT kill the old tmux session
   * — it only spawns a new one and re-registers the topic mapping.
   * SessionRefresh.refreshSession is responsible for killing the old
   * session via sessionManager.killSession BEFORE calling the respawner,
   * which also triggers the beforeSessionKill listener that persists
   * the resume UUID.
   *
   * Resolves to the new tmux session name on success.
   */
  respawner: (sessionName: string, topicId: number, followUpPrompt: string | undefined) => Promise<string>;
  /** Rate-guard config. Defaults: 5 refreshes per 10-minute rolling window. */
  rateLimit?: { maxPerWindow: number; windowMs: number };
  /** Injectable clock for tests. Defaults to Date.now. */
  clock?: () => number;
}

export type RefreshResult =
  | { ok: true; newSessionName: string; topicId: number }
  | { ok: false; code: RefreshFailureCode; message: string };

export type RefreshFailureCode =
  | 'rate_limited'
  | 'session_not_found'
  | 'not_telegram_bound'
  | 'no_telegram_adapter'
  | 'refresh_in_progress';

export interface RefreshOptions {
  sessionName: string;
  followUpPrompt?: string;
  reason?: string;
  /**
   * Fresh respawn: do NOT `--resume` the old session. After the kill (which
   * fires beforeSessionKill → TopicResumeMap saves the Claude UUID), clear that
   * resume entry so the respawner spawns a brand-new session with no
   * conversation carried over. Used by ContextWedgeSentinel: the old
   * transcript's latest assistant turn is corrupted (thinking-block 400), so
   * resuming it would immediately re-wedge. Default false (continuity-preserving
   * resume, the original self-refresh behavior).
   */
  fresh?: boolean;
}

const DEFAULT_MAX_PER_WINDOW = 5;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

export class SessionRefresh {
  private readonly deps: SessionRefreshDeps;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly recentRefreshes: Map<string, number[]> = new Map();
  /** In-flight refresh guard — prevents the race where a second call
   *  fires before the first's kill+spawn completes, which would spawn
   *  two parallel sessions for the same topic. */
  private readonly inFlight: Set<string> = new Set();

  constructor(deps: SessionRefreshDeps) {
    this.deps = deps;
    this.maxPerWindow = deps.rateLimit?.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
    this.windowMs = deps.rateLimit?.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = deps.clock ?? Date.now;
  }

  /**
   * Refresh a session: kill its tmux session (which fires beforeSessionKill
   * so the existing listener persists the Claude UUID via TopicResumeMap),
   * then respawn via the injected respawner which spawns a fresh tmux that
   * runs `claude --resume <uuid>` — picking up newly installed MCPs/skills
   * while preserving the full conversation.
   *
   * Returns a structured result; never throws on the expected failure modes
   * (rate-limit, session-not-found, non-Telegram-bound). Throws only on
   * unexpected internal errors from the respawner callback.
   */
  async refreshSession(opts: RefreshOptions): Promise<RefreshResult> {
    const { sessionName, followUpPrompt, reason, fresh } = opts;

    // ── detect ─────────────────────────────────────────────────────────
    if (!this.deps.telegram) {
      return {
        ok: false,
        code: 'no_telegram_adapter',
        message: 'No Telegram adapter wired — self-refresh requires a Telegram-bound session in v1.',
      };
    }

    const topicId = this.deps.telegram.getTopicForSession(sessionName);
    if (topicId === null) {
      // TODO(v2): handle non-Telegram-bound sessions (Slack, iMessage,
      // headless). Today only Telegram-bound is supported because the
      // respawn path is built around topicId → context routing.
      return {
        ok: false,
        code: 'not_telegram_bound',
        message: `Session "${sessionName}" is not bound to a Telegram topic; cannot self-refresh in v1.`,
      };
    }

    // Look up the state session by tmux name — needed for killSession,
    // which takes the state session id, not the tmux session name.
    const stateSession = this.deps.state.listSessions({ status: 'running' })
      .find(s => s.tmuxSession === sessionName);
    if (!stateSession) {
      return {
        ok: false,
        code: 'session_not_found',
        message: `No running session found for tmux name "${sessionName}".`,
      };
    }

    // ── in-flight guard ────────────────────────────────────────────────
    if (this.inFlight.has(sessionName)) {
      return {
        ok: false,
        code: 'refresh_in_progress',
        message: `A refresh is already in progress for "${sessionName}".`,
      };
    }

    // ── rate guard ─────────────────────────────────────────────────────
    if (!this.checkRateLimit(sessionName)) {
      this.logRateLimit(sessionName, reason);
      return {
        ok: false,
        code: 'rate_limited',
        message: `Refresh rate limit exceeded (${this.maxPerWindow} per ${Math.round(this.windowMs / 60000)} minutes) for session "${sessionName}".`,
      };
    }

    // ── attempt ────────────────────────────────────────────────────────
    // Record the attempt against the rate guard window BEFORE the work —
    // we count attempts, not successes, so a flapping respawner can't
    // bypass the cap. Also mark in-flight so a parallel call refuses.
    this.recordRefresh(sessionName);
    this.inFlight.add(sessionName);

    try {
      // Kill via sessionManager so the beforeSessionKill listener fires
      // and persists the resume UUID using session.claudeSessionId. This
      // replaces the previous SessionRefresh-side findUuidForSession+save
      // dance, which would silently no-op (findUuidForSession requires
      // claudeSessionId as second arg; without it, the mtime fallback was
      // removed deliberately and the call returns null).
      this.deps.sessionManager.killSession(stateSession.id);

      // Fresh respawn: drop the resume UUID that beforeSessionKill just saved,
      // so the respawner finds no entry and spawns a brand-new conversation
      // instead of `--resume`-ing the corrupted transcript. MUST run after the
      // kill (beforeSessionKill writes the entry) and before the respawner
      // reads it.
      if (fresh) {
        this.deps.topicResumeMap?.remove(topicId);
        console.log(`[SessionRefresh] fresh respawn — cleared resume UUID for topic ${topicId} (sessionName=${sessionName})`);
      }

      // The respawner spawns a fresh tmux session that runs `claude
      // --resume <uuid>` (resolved by spawnSessionForTopic via the saved
      // TopicResumeMap entry) and re-registers the topic mapping. With
      // `fresh`, the entry was just cleared, so it spawns without --resume.
      const newSessionName = await this.deps.respawner(sessionName, topicId, followUpPrompt);

      // ── verify + finalize ────────────────────────────────────────────
      console.log(`[SessionRefresh] Refreshed "${sessionName}" → "${newSessionName}" (topic ${topicId})${reason ? ` reason="${reason}"` : ''}`);
      return { ok: true, newSessionName, topicId };
    } finally {
      this.inFlight.delete(sessionName);
    }
  }

  /**
   * Returns true if a fresh refresh is allowed under the rolling window cap.
   * Pure read of the recent-refresh ledger; does not mutate.
   */
  private checkRateLimit(sessionName: string): boolean {
    const now = this.clock();
    const recent = this.recentRefreshes.get(sessionName) ?? [];
    const fresh = recent.filter(ts => now - ts < this.windowMs);
    if (fresh.length !== recent.length) {
      // Prune stale entries opportunistically.
      this.recentRefreshes.set(sessionName, fresh);
    }
    return fresh.length < this.maxPerWindow;
  }

  /** Append a timestamp to the rolling window for this session. */
  private recordRefresh(sessionName: string): void {
    const now = this.clock();
    const recent = this.recentRefreshes.get(sessionName) ?? [];
    recent.push(now);
    this.recentRefreshes.set(sessionName, recent);
  }

  /**
   * Structured log when the rate guard blocks a request. Logged at warn
   * level so over-blocks are detectable in operations (per
   * docs/signal-vs-authority.md "Authorities must log their decisions").
   */
  private logRateLimit(sessionName: string, reason: string | undefined): void {
    console.warn(
      `[SessionRefresh] rate_limited sessionName=${sessionName} window=${this.windowMs}ms cap=${this.maxPerWindow}${reason ? ` reason=${reason}` : ''}`,
    );
  }
}
