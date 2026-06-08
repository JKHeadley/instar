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
 * Scope: Telegram-bound sessions. Topic resolution checks the in-memory map
 * first and, on a miss, falls back to a fresh disk read of the persisted
 * topic-session registry — so a binding registered after this process loaded
 * the registry (e.g. on a --no-telegram server) is still recoverable. Genuinely
 * non-Telegram-bound sessions (Slack, iMessage, headless) return
 * { ok: false, code: 'not_telegram_bound' } and remain a follow-up.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SessionManager } from './SessionManager.js';
import type { StateManager } from './StateManager.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { TopicResumeMap } from './TopicResumeMap.js';

/**
 * Account-swap conversation continuity. Claude stores conversation transcripts
 * PER CONFIG HOME (`<CLAUDE_CONFIG_DIR>/projects/<projectDir>/<uuid>.jsonl`), so a
 * quota swap that changes CLAUDE_CONFIG_DIR and then runs `claude --resume <uuid>`
 * finds "No conversation found" — the transcript is still in the OLD account's
 * config home. (The resume UUID is account-agnostic, but the transcript STORAGE
 * is config-home-local — the gap a mocked refresh test can't see.) Before the
 * respawn, copy the transcript into the target config home so --resume succeeds.
 *
 * Self-contained: finds the transcript by uuid across the user's `~/.claude*`
 * config homes (default + enrollment-wizard slots) and copies it, preserving the
 * `projects/<projectDir>/` relative path. Idempotent (no-op if already present),
 * best-effort (never throws). Returns true if the transcript is in the target
 * afterward.
 */
function transcriptRelPath(projectsDir: string, uuid: string): string | null {
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const f = path.join(projectsDir, proj, `${uuid}.jsonl`);
      if (fs.existsSync(f)) return path.join(proj, `${uuid}.jsonl`);
    }
  } catch { /* @silent-fallback-ok: missing/unreadable projects dir */ }
  return null;
}

export function ensureResumeTranscriptInConfigHome(uuid: string, targetConfigHome: string): boolean {
  try {
    const home = process.env.HOME || '';
    const target = targetConfigHome.startsWith('~')
      ? path.join(home, targetConfigHome.slice(1))
      : targetConfigHome;
    const targetProjects = path.join(target, 'projects');
    if (transcriptRelPath(targetProjects, uuid)) return true; // already there → no-op
    let homes: string[] = [];
    try {
      homes = fs.readdirSync(home)
        .filter((n) => n === '.claude' || n.startsWith('.claude-'))
        .map((n) => path.join(home, n));
    } catch { /* @silent-fallback-ok: HOME unreadable */ }
    for (const ch of homes) {
      if (path.resolve(ch) === path.resolve(target)) continue;
      const rel = transcriptRelPath(path.join(ch, 'projects'), uuid);
      if (rel) {
        const dst = path.join(targetProjects, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(ch, 'projects', rel), dst);
        return true;
      }
    }
    return false;
  } catch {
    // @silent-fallback-ok: continuity-copy is best-effort; a failure means the
    // swap may start fresh (logged by the caller), not crash the refresh.
    return false;
  }
}

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
  respawner: (
    sessionName: string,
    topicId: number,
    followUpPrompt: string | undefined,
    /** P1.3 account swap (optional, additive): launch the respawn under this
     *  account's config home + record the account id. Omitted = unchanged. */
    accountSwap?: { configHome?: string; accountId?: string },
  ) => Promise<string>;
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
  /**
   * Subscription & Auth Standard P1.3 (quota-aware account swap): when set, the
   * respawned session is launched/resumed under THIS account's config home
   * (CLAUDE_CONFIG_DIR) instead of the parent's, and `accountId` is recorded on
   * the new session record. Both optional + additive — when unset, refresh
   * behaviour is byte-for-byte unchanged (the resume UUID is account-agnostic,
   * so conversation continuity is preserved across the swap). Only meaningful
   * for claude-code sessions.
   */
  configHome?: string;
  accountId?: string;
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

    let topicId = this.deps.telegram.getTopicForSession(sessionName);
    if (topicId === null) {
      // In-memory miss does NOT mean the session is unbound. A binding
      // registered after this process loaded the registry won't be in the
      // in-memory reverse map — most importantly on a `--no-telegram` server,
      // whose map reflects only its boot-time snapshot while the lifeline keeps
      // writing new bindings to disk. That is exactly the gap that left wedged
      // long-lived dev sessions (e.g. the Codey collaboration session, topic
      // 13435) un-recoverable: getTopicForSession returned null, recovery bailed
      // with not_telegram_bound, and the dead session stayed dead. Fall back to
      // a fresh disk-backed reverse lookup before giving up.
      topicId = this.deps.telegram.resolveTopicForSessionFromDisk?.(sessionName) ?? null;
    }
    if (topicId === null) {
      // Genuinely unbound (no topic on disk either): non-Telegram-bound sessions
      // (Slack, iMessage, headless) remain a follow-up — the respawn path is
      // built around topicId → context routing.
      return {
        ok: false,
        code: 'not_telegram_bound',
        message: `Session "${sessionName}" is not bound to a Telegram topic (checked in-memory + disk registry); cannot self-refresh.`,
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
      const accountSwap = (opts.configHome || opts.accountId)
        ? { configHome: opts.configHome, accountId: opts.accountId }
        : undefined;

      // Account-swap continuity: claude stores transcripts per config home, so a
      // swap to a new CLAUDE_CONFIG_DIR must carry the conversation transcript
      // across or `--resume` finds nothing. Skip on `fresh` (we intentionally
      // start a new conversation then). Best-effort: a miss just means the
      // resumed session starts fresh — logged, never fatal.
      if (accountSwap?.configHome && !fresh) {
        const resumeUuid = stateSession.claudeSessionId;
        if (resumeUuid) {
          const ok = ensureResumeTranscriptInConfigHome(resumeUuid, accountSwap.configHome);
          console.log(
            `[SessionRefresh] account-swap continuity: transcript ${ok ? 'ensured in' : 'NOT found for'} ${accountSwap.configHome} (uuid=${resumeUuid}, sessionName=${sessionName})`,
          );
        } else {
          console.log(
            `[SessionRefresh] account-swap continuity: no claudeSessionId on session "${sessionName}" — cannot pre-copy transcript; resumed session may start fresh`,
          );
        }
      }

      const newSessionName = await this.deps.respawner(sessionName, topicId, followUpPrompt, accountSwap);

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
