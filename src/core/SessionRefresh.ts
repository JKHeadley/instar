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
 * Scope: Telegram-bound AND Slack-bound sessions (TOPIC-PROFILE-SPEC §10.5 —
 * Slack parity is an explicit prerequisite, not a v2 follow-up). Binding
 * resolution checks Telegram first (in-memory map, then a fresh disk read of
 * the persisted topic-session registry — so a binding registered after this
 * process loaded the registry, e.g. on a --no-telegram server, is still
 * recoverable), then the Slack channel/thread registry via the optional
 * `slack` dep. Slack respawns go through the optional `slackRespawner`
 * callback; when a session is Slack-bound but no slackRespawner is wired the
 * refusal is the structured `slack_respawner_unwired` (so callers can degrade
 * to CONTINUATION-on-next-message, disclosed honestly, per §10.5). Genuinely
 * unbound sessions (iMessage, headless) return
 * { ok: false, code: 'not_telegram_bound' } (code kept for back-compat).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureInteractiveReady } from './ensureInteractiveReady.js';
import {
  slackConversationKey,
  slackRoutingKeySyntheticId,
  type SlackRefreshBinding,
  type SlackRespawner,
} from './slackRefreshBinding.js';
import type { SessionManager } from './SessionManager.js';
import type { StateManager } from './StateManager.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { TopicResumeMap } from './TopicResumeMap.js';
import {
  buildMitigationPayload,
  type MitigationInbound,
  type SubagentSnapshot,
  type SwapWorkGateCallerClass,
  type WorkProbeResult,
} from './SwapWorkGate.js';

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
  /**
   * Slack binding resolution (§10.5, optional + additive). SlackAdapter
   * satisfies this structurally; null/omitted = Telegram-only behavior,
   * byte-for-byte as before. Consulted only after BOTH Telegram lookups miss
   * (Telegram-bound resolution takes precedence, matching today's order).
   */
  slack?: SlackRefreshBinding | null;
  /**
   * Slack respawner callback (§10.5, optional + additive). Wired by server
   * bootstrap to mirror the Slack message-handler spawn path (resume read +
   * spawnInteractiveSession + registerChannelSession) — see SlackRespawner
   * docs. Same kill contract as `respawner`: SessionRefresh kills first.
   */
  slackRespawner?: SlackRespawner | null;
  /** Rate-guard config. Defaults: 5 refreshes per 10-minute rolling window. */
  rateLimit?: { maxPerWindow: number; windowMs: number };
  /**
   * swap-continuity-antithrash §4.2 — the in-flight work gate, bound at THIS
   * primitive (the one funnel every session-killing account/model/refresh
   * mutation flows through). Constructor-injected on purpose: §7.1 marks
   * `swapContinuity.enabled` restart-required; the numeric knobs + dryRun are
   * read live via `getKnobs`. Absent/null ⇒ byte-for-byte today's behavior.
   */
  workGateCtx?: SwapContinuityGateContext | null;
  /** Injectable clock for tests. Defaults to Date.now. */
  clock?: () => number;
}

/** The work-gate context SessionRefresh consumes (§4.2/§4.3/§4.5). */
export interface SwapContinuityGateContext {
  /** SwapWorkGate.probe — the stateless busy predicate. */
  probe: (tmuxSession: string) => Promise<WorkProbeResult>;
  /** Live knobs (dryRun + grace bounds read per evaluation, §7.1). */
  getKnobs: () => { enabled: boolean; dryRun: boolean; reactiveGraceMs: number; recheckMs: number };
  /** Swap-ledger hooks (optional — present when the anti-thrash engine is wired). */
  recordProceeded?: (args: {
    session: string;
    kind: 'reactive' | 'interactive';
    callerClass: string;
    nowMs: number;
    from: string;
    to?: string;
    reason: 'busy-turn' | 'busy-subagents' | 'busy-indeterminate';
    inFlight: { turn: boolean; subagents: number };
    subagentLeg: 'ok' | 'absent' | 'indeterminate';
    killedSubagents?: number;
    killedSubagentList?: Array<{ agentType: string; ageMinutes: number; transcriptPath?: string }>;
    inbound: 'reinjected' | 'none' | 'unknown';
    force?: boolean;
  }) => void;
  recordInteractiveRefusal?: (args: {
    session: string;
    nowMs: number;
    inFlight: { turn: boolean; subagents: number };
    subagentLeg: 'ok' | 'absent' | 'indeterminate';
  }) => void;
  /** §4.3(2) — the last unanswered inbound for a topic (Q4: in-memory map in
   *  v1; 'unknown' = map unavailable / post-restart). */
  resolveUnansweredInbound?: (topicId: number) => MitigationInbound | 'none' | 'unknown';
  /** Injectable sleep for tests (grace-loop pacing). */
  wait?: (ms: number) => Promise<void>;
}

export type RefreshResult =
  | {
      ok: true;
      newSessionName: string;
      /** §4.3 — this refresh proceeded OVER busy work with the mitigation
       *  payload attached (reactive-after-grace or force). Lets the swap
       *  orchestration avoid double-recording (the proceeded row is written). */
      proceededOverBusy?: boolean;
      /** Telegram topic id, or (Slack) the stable NEGATIVE synthetic id —
       *  same hash the rest of the system uses to bridge Slack channels into
       *  numeric topic space. Kept required for back-compat consumers. */
      topicId: number;
      /** §10.5 platform tag. Absent = Telegram (pre-Slack result shape is
       *  preserved byte-for-byte for existing consumers/tests). */
      platform?: 'slack';
      /** §10.5 conversation key (`slack:<channel>[:<thread>]`). Slack only. */
      conversationKey?: string;
    }
  | {
      ok: false;
      code: RefreshFailureCode;
      message: string;
      /** §4.5 session-busy refusal payload (counts and ages only — no titles,
       *  no transcript paths, no message content on the wire). */
      turnInFlight?: boolean;
      subagents?: Array<{ agentType: string; ageMinutes: number }>;
      /** 'absent' = no readable claudeSessionId (R5-M1) — `subagents` is then
       *  OMITTED: unreadable is never rendered as an empty list. */
      subagentLeg?: 'absent' | 'indeterminate';
    };

export type RefreshFailureCode =
  | 'rate_limited'
  | 'session_not_found'
  | 'not_telegram_bound'
  | 'no_telegram_adapter'
  | 'slack_respawner_unwired'
  | 'refresh_in_progress'
  // swap-continuity-antithrash §4.5 — one spelling everywhere: the wire code
  // and the ledger reason are BOTH the hyphenated `session-busy`.
  | 'session-busy';

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
  /**
   * swap-continuity-antithrash §4.2 — the work-gate caller class. Set ONLY by
   * server-internal call sites (invariant I11 — no route ever populates it
   * from request input; a wire-derived 'recovery' would be a gate bypass by
   * construction). Absent/unlisted callers default to 'interactive-refresh'
   * (the safest class: nothing is killed, the caller is told why).
   */
  callerClass?: SwapWorkGateCallerClass;
  /**
   * §4.5 — interactive override of the work gate ONLY (never the rate guard).
   * Bearer-level authority, recorded as such in the ledger. A `force` over
   * busy work proceeds WITH the §4.3 mitigation payload attached.
   */
  force?: boolean;
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
    if (!this.deps.telegram && !this.deps.slack) {
      return {
        ok: false,
        code: 'no_telegram_adapter',
        message: 'No Telegram adapter wired (and no Slack binding either) — self-refresh requires a platform-bound session.',
      };
    }

    let topicId: number | null = null;
    if (this.deps.telegram) {
      topicId = this.deps.telegram.getTopicForSession(sessionName);
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
    }

    // §10.5 Slack arm: consulted only after BOTH Telegram lookups miss, so a
    // Telegram-bound session resolves exactly as before. The routing key is
    // `<channelId>` or `<channelId>:<thread_ts>` — the same key the kill-time
    // beforeSessionKill listener saves the channel-resume entry under.
    let slackRoutingKey: string | null = null;
    if (topicId === null && this.deps.slack) {
      slackRoutingKey = this.deps.slack.getChannelForSession(sessionName);
      if (slackRoutingKey === null) {
        // Disk-backed fallback parity with the Telegram arm (optional method —
        // adapters without it just skip the fallback).
        slackRoutingKey = this.deps.slack.resolveChannelForSessionFromDisk?.(sessionName) ?? null;
      }
    }

    if (topicId === null && slackRoutingKey === null) {
      // Genuinely unbound (no binding on either platform): iMessage/headless
      // sessions remain a follow-up — the respawn path is built around
      // conversation-key → context routing. Code kept as 'not_telegram_bound'
      // for back-compat with existing consumers/log greps.
      return {
        ok: false,
        code: 'not_telegram_bound',
        message: `Session "${sessionName}" is not bound to a Telegram topic${this.deps.slack ? ' or Slack conversation' : ''} (checked in-memory + disk registry); cannot self-refresh.`,
      };
    }

    if (topicId === null && slackRoutingKey !== null && !this.deps.slackRespawner) {
      // Slack-bound, but the Slack respawner isn't wired on this server.
      // Structured refusal (NOT a throw) so the caller can degrade honestly —
      // §10.5: "a respawn-requiring change on a Slack topic degrades to
      // CONTINUATION-on-next-message, disclosed honestly."
      return {
        ok: false,
        code: 'slack_respawner_unwired',
        message: `Session "${sessionName}" is Slack-bound (${slackConversationKey(slackRoutingKey)}) but no Slack respawner is wired — the session will resume via CONTINUATION on the next message instead of an immediate respawn.`,
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
    // Mark in-flight BEFORE the work gate: the reactive grace loop can hold
    // this call open for up to reactiveGraceMs, and a parallel refresh racing
    // through that window must refuse rather than double-kill.
    this.inFlight.add(sessionName);

    let followUpWithMitigations = followUpPrompt;
    let proceededOverBusy = false;
    try {
      // ── work gate (swap-continuity-antithrash §4.2) — BEFORE the rate
      // guard: a deferred or refused attempt consumes ZERO rate budget,
      // otherwise a busy session's own deferrals would exhaust the budget
      // and starve the eventual legitimate swap. ──
      const gate = await this.consultWorkGate(opts, stateSession, topicId);
      if (gate.refusal) return gate.refusal;
      if (gate.mitigationBlock !== undefined) {
        proceededOverBusy = true;
        if (gate.mitigationBlock.length > 0) {
          followUpWithMitigations = [followUpPrompt, gate.mitigationBlock]
            .filter((s): s is string => !!s && s.length > 0)
            .join('\n\n');
        }
      }

      // ── rate guard ───────────────────────────────────────────────────
      if (!this.checkRateLimit(sessionName)) {
        this.logRateLimit(sessionName, reason);
        return {
          ok: false,
          code: 'rate_limited',
          message: `Refresh rate limit exceeded (${this.maxPerWindow} per ${Math.round(this.windowMs / 60000)} minutes) for session "${sessionName}".`,
        };
      }

      // ── attempt ──────────────────────────────────────────────────────
      // Record the attempt against the rate guard window BEFORE the work —
      // we count attempts, not successes, so a flapping respawner can't
      // bypass the cap. (`force` overrides ONLY the work gate, never the
      // rate guard — a forced refresh still consumes rate budget, §4.5.)
      this.recordRefresh(sessionName);
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
      // reads it. Platform-routed: Telegram entries live in TopicResumeMap;
      // Slack entries live in the adapter's channel-resume map keyed on the
      // routing key (the same key beforeSessionKill saved under).
      if (fresh) {
        if (topicId !== null) {
          this.deps.topicResumeMap?.remove(topicId);
          console.log(`[SessionRefresh] fresh respawn — cleared resume UUID for topic ${topicId} (sessionName=${sessionName})`);
        } else if (slackRoutingKey !== null) {
          this.deps.slack?.removeChannelResume(slackRoutingKey);
          console.log(`[SessionRefresh] fresh respawn — cleared Slack channel resume for ${slackConversationKey(slackRoutingKey)} (sessionName=${sessionName})`);
        }
      }

      // The respawner spawns a fresh tmux session that runs `claude
      // --resume <uuid>` (resolved by spawnSessionForTopic via the saved
      // TopicResumeMap entry) and re-registers the topic mapping. With
      // `fresh`, the entry was just cleared, so it spawns without --resume.
      const accountSwap = (opts.configHome || opts.accountId)
        ? { configHome: opts.configHome, accountId: opts.accountId }
        : undefined;

      // Onboarding-safe swap (2026-06-09 incident): the target config home was
      // enrolled headlessly, so it has OAuth tokens but NOT the interactive
      // first-launch flags — relaunching an interactive session into it would
      // wedge on the onboarding screens. Seed the flags BEFORE the respawn.
      // Applies to `fresh` too (the new session is interactive either way).
      // Idempotent + fail-safe: a failure here is logged and the respawn
      // proceeds (worst case is the pre-fix behavior, not a dead refresh).
      if (accountSwap?.configHome) {
        const ready = ensureInteractiveReady(accountSwap.configHome);
        console.log(
          `[SessionRefresh] account-swap onboarding-readiness: ${accountSwap.configHome} ` +
          `${ready.patched ? `patched (${ready.reason})` : ready.reason} (sessionName=${sessionName})`,
        );
      }

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

      // §10.5 Slack respawn path. The slackRespawner mirrors the Slack
      // message-handler spawn: read+consume getChannelResume(routingKey) and
      // spawnInteractiveSession with the resume UUID + channel/thread opts,
      // then re-register the routing-key → session binding. Guarded non-null
      // by the slack_respawner_unwired refusal in detect.
      if (topicId === null && slackRoutingKey !== null) {
        const newSessionName = await this.deps.slackRespawner!(sessionName, slackRoutingKey, followUpWithMitigations, accountSwap);
        const conversationKey = slackConversationKey(slackRoutingKey);
        // ── verify + finalize (Slack) ──────────────────────────────────
        console.log(`[SessionRefresh] Refreshed "${sessionName}" → "${newSessionName}" (${conversationKey})${reason ? ` reason="${reason}"` : ''}`);
        return {
          ok: true,
          newSessionName,
          topicId: slackRoutingKeySyntheticId(slackRoutingKey),
          platform: 'slack',
          conversationKey,
          ...(proceededOverBusy ? { proceededOverBusy: true } : {}),
        };
      }

      const newSessionName = await this.deps.respawner(sessionName, topicId!, followUpWithMitigations, accountSwap);

      // ── verify + finalize ────────────────────────────────────────────
      console.log(`[SessionRefresh] Refreshed "${sessionName}" → "${newSessionName}" (topic ${topicId})${reason ? ` reason="${reason}"` : ''}`);
      return { ok: true, newSessionName, topicId: topicId!, ...(proceededOverBusy ? { proceededOverBusy: true } : {}) };
    } finally {
      this.inFlight.delete(sessionName);
    }
  }

  /**
   * The §4.2 work-gate consult. Returns:
   *  - `{}`                          — proceed normally (gate absent/dark/idle/dry-run/recovery)
   *  - `{ refusal }`                 — structured refusal (nothing killed)
   *  - `{ mitigationBlock }`         — proceed OVER busy work with the §4.3
   *                                    mitigation payload (reactive-after-grace or force)
   */
  private async consultWorkGate(
    opts: RefreshOptions,
    stateSession: { subscriptionAccountId?: string },
    topicId: number | null,
  ): Promise<{ refusal?: RefreshResult & { ok: false }; mitigationBlock?: string }> {
    const ctx = this.deps.workGateCtx;
    if (!ctx) return {};
    let knobs: { enabled: boolean; dryRun: boolean; reactiveGraceMs: number; recheckMs: number };
    try {
      knobs = ctx.getKnobs();
    } catch {
      return {}; // a broken knob getter must never block a refresh
    }
    if (!knobs.enabled) return {};
    const callerClass: SwapWorkGateCallerClass = opts.callerClass ?? 'interactive-refresh';
    // Recovery is EXEMPT by explicit class (§4.2): the session is wedged, its
    // "work" is not progressing; gating recovery on a broken pane's
    // indicators would deadlock recovery.
    if (callerClass === 'recovery') return {};

    let probe: WorkProbeResult;
    try {
      probe = await ctx.probe(opts.sessionName);
    } catch {
      // Probe machinery itself failed — I7: uncertainty resolves busy.
      probe = {
        busy: true,
        turnLeg: 'indeterminate',
        subagentLeg: 'indeterminate',
        turnInFlight: false,
        subagents: null,
        reason: 'busy-indeterminate',
      };
    }
    if (!probe.busy) return {};
    const busyReason = probe.reason ?? 'busy-indeterminate';

    if (knobs.dryRun) {
      // Rung-2 soak: log the would-decision, change nothing.
      const would =
        callerClass === 'proactive-swap' ? 'WOULD-DEFER' : callerClass === 'reactive-swap' || opts.force ? 'WOULD-MITIGATE' : 'WOULD-REFUSE';
      console.log(
        `[SwapWorkGate] ${would} session=${opts.sessionName} caller=${callerClass} reason=${busyReason} (dryRun — no behavior change)`,
      );
      return {};
    }

    if (callerClass === 'proactive-swap') {
      // The monitor owns the deferral lifecycle; the funnel's job is that
      // nothing is killed. The structured refusal reads as "defer" upstream.
      return {
        refusal: {
          ok: false,
          code: 'session-busy',
          message: `Session "${opts.sessionName}" has in-flight work (${busyReason}) — proactive swap deferred, retried next tick.`,
        },
      };
    }

    if (callerClass === 'interactive-refresh' && !opts.force) {
      // §4.5 pre-202 structured refusal — the caller decides: wait, or
      // re-issue with force:true. Counts and ages only on the wire.
      try {
        ctx.recordInteractiveRefusal?.({
          session: opts.sessionName,
          nowMs: this.clock(),
          inFlight: { turn: probe.turnInFlight, subagents: probe.subagents?.length ?? 0 },
          subagentLeg: probe.subagentLeg,
        });
      } catch {
        /* ledger hooks are additive — never block the refusal itself */
      }
      const refusal: RefreshResult & { ok: false } = {
        ok: false,
        code: 'session-busy',
        message: `Session "${opts.sessionName}" has in-flight work (${busyReason}). Wait for it to land, or re-issue with force:true (the kill then carries the mitigation payload).`,
        turnInFlight: probe.turnInFlight,
      };
      if (probe.subagentLeg === 'ok') {
        // agentType + ageMinutes only — never titles/paths/content (§4.5).
        refusal.subagents = (probe.subagents ?? []).map((s) => ({ agentType: s.agentType, ageMinutes: s.ageMinutes }));
      } else {
        // Unreadable is never rendered as an empty list (R5-M1).
        refusal.subagentLeg = probe.subagentLeg;
      }
      return { refusal };
    }

    if (callerClass === 'reactive-swap') {
      // §4.2: bounded grace — re-check every recheckMs, execute at the FIRST
      // not-busy observation, never sitting out the full grace; at the
      // deadline the swap proceeds WITH mitigations (any new turn on a walled
      // account is failing anyway). Never refused: deferring long has no
      // upside; the grace only absorbs a mid-write tool call.
      const wait = ctx.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const deadline = this.clock() + Math.max(0, knobs.reactiveGraceMs);
      const recheck = Math.max(250, knobs.recheckMs);
      while (this.clock() < deadline) {
        await wait(Math.min(recheck, Math.max(1, deadline - this.clock())));
        try {
          const p = await ctx.probe(opts.sessionName);
          probe = p;
          if (!p.busy) return {}; // work landed — a clean swap, no mitigations
        } catch {
          /* stays busy-for-grace (I7) — the deadline still bounds the wait */
        }
      }
      return { mitigationBlock: this.buildMitigation(opts, stateSession, topicId, probe, false) };
    }

    // interactive-refresh + force: proceed with the mitigation toll (§4.5).
    return { mitigationBlock: this.buildMitigation(opts, stateSession, topicId, probe, true) };
  }

  /**
   * §4.5 pre-202 interactive busy precheck — lets `/sessions/refresh` answer
   * the truth SYNCHRONOUSLY (HTTP 409 `session-busy`) instead of
   * accepting-then-failing. Returns null when the gate is absent/dark/dry-run
   * or the session is idle (the route then 202s and schedules the refresh; the
   * in-funnel gate remains the authority for the raced window). A busy verdict
   * records the §6.1 interactive refusal row.
   */
  async precheckInteractiveBusy(sessionName: string): Promise<{
    turnInFlight: boolean;
    subagents?: Array<{ agentType: string; ageMinutes: number }>;
    subagentLeg?: 'absent' | 'indeterminate';
    message: string;
  } | null> {
    const ctx = this.deps.workGateCtx;
    if (!ctx) return null;
    let knobs: { enabled: boolean; dryRun: boolean };
    try {
      knobs = ctx.getKnobs();
    } catch {
      return null; // a broken knob getter must never block a refresh
    }
    if (!knobs.enabled || knobs.dryRun) return null;
    let probe: WorkProbeResult;
    try {
      probe = await ctx.probe(sessionName);
    } catch {
      probe = {
        busy: true,
        turnLeg: 'indeterminate',
        subagentLeg: 'indeterminate',
        turnInFlight: false,
        subagents: null,
        reason: 'busy-indeterminate',
      };
    }
    if (!probe.busy) return null;
    try {
      ctx.recordInteractiveRefusal?.({
        session: sessionName,
        nowMs: this.clock(),
        inFlight: { turn: probe.turnInFlight, subagents: probe.subagents?.length ?? 0 },
        subagentLeg: probe.subagentLeg,
      });
    } catch {
      /* ledger hooks are additive — never block the refusal itself */
    }
    const busyReason = probe.reason ?? 'busy-indeterminate';
    const out: {
      turnInFlight: boolean;
      subagents?: Array<{ agentType: string; ageMinutes: number }>;
      subagentLeg?: 'absent' | 'indeterminate';
      message: string;
    } = {
      turnInFlight: probe.turnInFlight,
      message: `Session "${sessionName}" has in-flight work (${busyReason}). Wait for it to land, or re-issue with force:true (the kill then carries the mitigation payload).`,
    };
    if (probe.subagentLeg === 'ok') {
      // Counts and ages only — never titles/paths/content (§4.5).
      out.subagents = (probe.subagents ?? []).map((s) => ({ agentType: s.agentType, ageMinutes: s.ageMinutes }));
    } else {
      // Unreadable is never rendered as an empty list (R5-M1).
      out.subagentLeg = probe.subagentLeg;
    }
    return out;
  }

  /** Build + record the §4.3 mitigation payload. Additive to the respawn and
   *  never gates it — a failure here logs and proceeds (the kill is already
   *  justified when we reach here; the mitigation must not become a new wedge). */
  private buildMitigation(
    opts: RefreshOptions,
    stateSession: { subscriptionAccountId?: string },
    topicId: number | null,
    probe: WorkProbeResult,
    forced: boolean,
  ): string {
    try {
      const ctx = this.deps.workGateCtx!;
      // Unreadable ≠ zero (R5-M1): a null enumeration renders the honesty
      // line, never an implicit empty list.
      const killed: SubagentSnapshot[] | null = probe.subagentLeg === 'ok' ? (probe.subagents ?? []) : null;
      let inbound: MitigationInbound | 'none' | 'unknown' = 'unknown';
      if (topicId !== null && ctx.resolveUnansweredInbound) {
        try {
          inbound = ctx.resolveUnansweredInbound(topicId);
        } catch {
          inbound = 'unknown';
        }
      }
      const busyReason = probe.reason ?? 'busy-indeterminate';
      const inboundState = inbound === 'none' ? 'none' : inbound === 'unknown' ? 'unknown' : 'reinjected';
      try {
        ctx.recordProceeded?.({
          session: opts.sessionName,
          kind: forced ? 'interactive' : 'reactive',
          callerClass: forced ? 'interactive-refresh' : 'reactive-swap',
          nowMs: this.clock(),
          from: stateSession.subscriptionAccountId ?? '',
          ...(opts.accountId ? { to: opts.accountId } : {}),
          reason: busyReason,
          inFlight: { turn: probe.turnInFlight, subagents: probe.subagents?.length ?? 0 },
          subagentLeg: probe.subagentLeg,
          ...(killed !== null ? { killedSubagents: killed.length, killedSubagentList: killed } : {}),
          inbound: inboundState,
          ...(forced ? { force: true } : {}),
        });
      } catch {
        /* ledger hooks never gate the respawn */
      }
      console.log(
        `[SwapWorkGate] PROCEEDED-WITH-MITIGATIONS session=${opts.sessionName} caller=${forced ? 'interactive-refresh' : 'reactive-swap'} ` +
          `killedSubagents=${killed !== null ? killed.length : 'unreadable'} inbound=${inboundState}`,
      );
      return buildMitigationPayload({ killedSubagents: killed, inbound });
    } catch {
      console.warn(
        `[SwapWorkGate] mitigation payload failed for session=${opts.sessionName} — proceeding without it (mitigations never gate the respawn)`,
      );
      return '';
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
