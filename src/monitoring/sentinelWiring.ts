/**
 * sentinelWiring — constructs the runtime dependencies for the two
 * "silently-stopped" sentinels (SocketDisconnectSentinel and
 * ActiveWorkSilenceSentinel) from a SessionManager surface + config.
 *
 * Why this module exists: PR #334 merged both sentinels as standalone,
 * unit-tested detectors but never instantiated them in the server. The
 * release notes claimed "wired into server startup" — it wasn't true. This
 * module is the missing wire-up, extracted from server.ts so the dependency
 * construction is itself unit-testable (Testing Integrity Standard: every
 * dependency-injected component needs wiring-integrity tests proving the deps
 * are real functions that delegate to the underlying primitives, not nulls or
 * silent no-ops).
 *
 * Signal-vs-authority: everything here is a detector or a bounded recovery
 * primitive. `looksActivelyWorking` is a structural detector. All user-facing
 * escalation routes through the existing MessagingToneGate via the `/attention`
 * endpoint (category: degradation) — no new blocking authority is introduced.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

import type { SocketDisconnectSentinelDeps } from './SocketDisconnectSentinel.js';
import type {
  ActiveWorkSilenceSentinelDeps,
  SessionRegistryEntry,
  SilenceFunnelEvent,
} from './ActiveWorkSilenceSentinel.js';
import type {
  ContextWedgeSentinelDeps,
  WedgeRecoveryOutcome,
} from './ContextWedgeSentinel.js';
import { getActivitySignal } from './frameworkActivitySignals.js';
import type { IntelligenceFramework } from '../core/intelligenceProviderFactory.js';

/** Minimal SessionManager surface the wiring depends on. */
export interface SentinelSessionSurface {
  captureOutput(tmuxSession: string, lines?: number): string | null;
  isSessionAlive(tmuxSession: string): boolean;
  sendKey(tmuxSession: string, key: string): boolean;
  listRunningSessions(): Array<{ tmuxSession: string; framework?: IntelligenceFramework }>;
}

/**
 * Posts a user-facing escalation through the tone-gated `/attention` route.
 * Returns true on 201 (delivered), false otherwise — including a 422 tone-gate
 * block (which is the gate doing its job, not an error to retry).
 */
export type AttentionPoster = (item: {
  id: string;
  title: string;
  summary: string;
  category?: string;
  priority?: string;
  /** Route into the calm "🩺 Agent Health" lane (see TelegramAdapter). */
  lane?: 'agent-health';
  /** Stable per-entity key for Agent-Health-lane suppression dedup. */
  healthKey?: string;
}) => Promise<boolean>;

export function makeAttentionPoster(opts: {
  port: number;
  authToken: string;
  fetchImpl?: typeof fetch;
}): AttentionPoster {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (item) => {
    try {
      const resp = await doFetch(`http://localhost:${opts.port}/attention`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.authToken}`,
        },
        body: JSON.stringify({ category: 'degradation', priority: 'HIGH', ...item }),
      });
      return resp.status === 201;
    } catch {
      // Network/route failure — treat as not-delivered. The sentinel's notify
      // wrapper swallows this; the bigger failure (silent stop) is still closed
      // because recovery attempts are independent of the notice landing.
      return false;
    }
  };
}

const SOCKET_CAPTURE_LINES = 40;
const SILENCE_CAPTURE_LINES = 40;
const WEDGE_CAPTURE_LINES = 30;

/**
 * Callback shape for routing a recovery-failed escalation through the
 * SentinelNotifier (or any equivalent sink). Decouples the wiring from the
 * specific delivery policy — server.ts wires a SentinelNotifier, tests wire a
 * capture function. The wiring no longer knows or cares whether the message
 * ends up in the logs, on Telegram, or in a fixture array.
 */
export type EscalateFn = (sessionName: string, text: string) => void | Promise<void>;

export function buildSocketDisconnectDeps(opts: {
  sessions: SentinelSessionSurface;
  escalate: EscalateFn;
}): SocketDisconnectSentinelDeps {
  return {
    getRecentOutput: (sessionName) =>
      opts.sessions.captureOutput(sessionName, SOCKET_CAPTURE_LINES) ?? '',
    resumeFn: async (sessionName) => {
      if (!opts.sessions.isSessionAlive(sessionName)) return false;
      // A socket drop leaves Claude Code waiting at a retry state; a bare Enter
      // re-engages without interrupting in-flight work (unlike Ctrl+C, which
      // would cancel a tool call that may still be running).
      return opts.sessions.sendKey(sessionName, 'Enter');
    },
    notifyFn: async (sessionName, text) => {
      await opts.escalate(sessionName, text);
    },
    listSessionNames: () =>
      opts.sessions.listRunningSessions().map((s) => s.tmuxSession),
  };
}

/**
 * Builds the ContextWedgeSentinel deps. The `recoverFn` encodes the
 * detect-only / dry-run / live recovery policy from autoRecovery config and
 * delegates the actual fresh respawn to the injected `freshRespawn` callback
 * (server bootstrap wires it to SessionRefresh.refreshSession({ fresh: true }),
 * which clears the topic's resume UUID so the new session never --resume-s the
 * corrupted transcript). Keeping policy here — not in the sentinel — means the
 * sentinel stays a pure detector + lifecycle and the rollout-staged flag is
 * observed in exactly one place.
 */
export function buildContextWedgeDeps(opts: {
  sessions: SentinelSessionSurface;
  escalate: EscalateFn;
  /** autoRecovery config (the Graduated-Feature-Rollout staged flag). */
  autoRecovery: { enabled: boolean; dryRun?: boolean };
  /** Performs the destructive fresh respawn. Returns true if the session was
   *  actually killed + respawned. Wired to SessionRefresh fresh-mode. */
  freshRespawn: (sessionName: string) => Promise<boolean>;
}): ContextWedgeSentinelDeps {
  return {
    getRecentOutput: (sessionName) =>
      opts.sessions.captureOutput(sessionName, WEDGE_CAPTURE_LINES) ?? '',
    recoverFn: async (sessionName): Promise<WedgeRecoveryOutcome> => {
      // dark: detection + audit only, no destructive action.
      if (!opts.autoRecovery.enabled) return 'detect-only';
      // dry-run: log the would-respawn decision, kill nothing.
      if (opts.autoRecovery.dryRun) return 'dry-run';
      // live: actually kill + fresh-respawn.
      try {
        const ok = await opts.freshRespawn(sessionName);
        return ok ? 'respawned' : 'failed';
      } catch {
        return 'failed';
      }
    },
    notifyFn: async (sessionName, text) => {
      await opts.escalate(sessionName, text);
    },
    listSessionNames: () =>
      opts.sessions.listRunningSessions().map((s) => s.tmuxSession),
  };
}

/**
 * Detector: does this captured frame show the framework actively working
 * (spinner, tool call, "esc to interrupt", "(running)") rather than sitting
 * idle at its prompt? Used to filter the silence sentinel's candidate set so a
 * session that is simply waiting for the user is never flagged as "stopped".
 */
export function looksActivelyWorking(
  output: string,
  framework?: IntelligenceFramework,
): boolean {
  if (!output) return false;
  const sig = getActivitySignal(framework);
  return (
    sig.toolCallOrSpinner.test(output) ||
    sig.escapeToInterrupt.test(output) ||
    sig.runningIndicator.test(output)
  );
}

/**
 * Stricter sibling of looksActivelyWorking (HONEST-PROGRESS-MESSAGING A1): is the
 * framework GENERATING RIGHT NOW? Uses only the live-generation markers
 * (`liveActivity` — the animated spinner / "Working (Ns" / "esc to interrupt"),
 * deliberately EXCLUDING `toolCallOrSpinner`'s scrollback-persistent tool names
 * which linger in an idle pane. This is the correct signal for the silence
 * sentinel's live-frame re-check: a frozen scrollback full of past `Read(`/`Bash(`
 * is NOT "generating now", but a still-rendered spinner / "esc to interrupt" IS.
 */
export function looksGeneratingNow(
  output: string,
  framework?: IntelligenceFramework,
): boolean {
  if (!output) return false;
  const sig = getActivitySignal(framework);
  return (
    sig.liveActivity.test(output) ||
    sig.escapeToInterrupt.test(output) ||
    sig.runningIndicator.test(output)
  );
}

/**
 * Tracks per-session output-change time so the silence sentinel can tell
 * "frozen mid-task" from "still producing output". Only sessions whose most
 * recent frame shows active-work signatures are surfaced as candidates; an
 * idle-at-prompt session is marked `paused` so the sentinel skips it — it is
 * not "actively working then stopped".
 *
 * Observed-change requirement (incident 2026-05-22): the tracker reports
 * `lastOutputAt: 0` for any session it has NOT yet watched produce a real
 * output change. A first sighting only records the baseline hash — it is never
 * treated as an output event. This is the critical discriminator between
 * "frozen mid-task" and "frozen since before I started watching": on a server
 * restart the tracker re-sees every leftover tmux session fresh, and a long-
 * dead session whose frozen last frame happens to contain "esc to interrupt"
 * would otherwise be misread as "was producing output at restart, then
 * stopped" — and flagged en masse 15 minutes later. By requiring an OBSERVED
 * active→silent transition (hash changes once, THEN stops), a session that was
 * already frozen before boot can never trip the silence threshold, because its
 * `lastOutputAt` stays 0 and the sentinel's `lastOutputAt <= 0` guard skips it.
 */
export class OutputActivityTracker {
  private readonly last = new Map<string, { hash: string; lastChangeAt: number }>();

  constructor(
    private readonly sessions: SentinelSessionSurface,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): SessionRegistryEntry[] {
    const t = this.now();
    const running = this.sessions.listRunningSessions();
    const seen = new Set<string>();
    const out: SessionRegistryEntry[] = [];
    for (const s of running) {
      seen.add(s.tmuxSession);
      const output = this.sessions.captureOutput(s.tmuxSession, SILENCE_CAPTURE_LINES) ?? '';
      // Hash a SPINNER-IMMUNE view of the frame. The host's "working" spinner
      // (e.g. Claude's `✻ Sautéed for 26m 16s · (esc to interrupt)`) ticks its
      // elapsed-time counter every second, so a raw hash changes on every poll
      // even when the turn has produced no real output for many minutes — which
      // made `lastChangeAt` perpetually fresh and blinded ActiveWorkSilenceSentinel
      // to a stalled-but-spinning turn (the 26-min API-stall incident). Stripping
      // the volatile status region means only REAL scrollback changes refresh the
      // activity timestamp. Safe: the silence nudge is a non-destructive `Enter`
      // (sendKey 'Enter'), so a false-positive on a genuinely-long turn is harmless;
      // the only destructive recovery (Ctrl-C) lives in SocketDisconnectSentinel,
      // gated on a positive error-string marker. (Cross-model reviewed, task #63.)
      const hash = cheapHash(stripVolatileStatus(output, s.framework));
      const prev = this.last.get(s.tmuxSession);
      let lastChangeAt: number;
      if (!prev) {
        // First sighting: record the baseline hash but DO NOT count it as an
        // output event. We have no evidence this session was ever producing
        // output — it may have been frozen since before we started watching.
        // lastChangeAt 0 → the silence sentinel skips it (lastOutputAt <= 0).
        lastChangeAt = 0;
        this.last.set(s.tmuxSession, { hash, lastChangeAt });
      } else if (prev.hash !== hash) {
        // Observed a real output change → this session is genuinely producing
        // output. Stamp the change time; from here it is silence-eligible.
        lastChangeAt = t;
        this.last.set(s.tmuxSession, { hash, lastChangeAt });
      } else {
        // Unchanged since the last tick → hold the prior lastChangeAt (which is
        // still 0 if we have never yet observed a change for this session).
        lastChangeAt = prev.lastChangeAt;
      }
      const active = looksActivelyWorking(output, s.framework);
      out.push({ sessionName: s.tmuxSession, lastOutputAt: lastChangeAt, paused: !active });
    }
    // Drop tracking for sessions that have ended so the map can't grow without bound.
    for (const key of Array.from(this.last.keys())) {
      if (!seen.has(key)) this.last.delete(key);
    }
    return out;
  }

  /**
   * Cached read of the LAST-computed output-change time for a session, WITHOUT
   * capturing (no tmux frame is read). Returns the `lastChangeAt` recorded by
   * the most recent `snapshot()` call, or null when the session has not been
   * observed yet OR its first sighting only recorded the baseline (lastChangeAt
   * is still 0 — i.e. no real output change has been observed).
   *
   * This is the AutonomousProgressHeartbeat's predicate #8 read (spec
   * §Shared-snapshot dependency): the heartbeat shares THIS tracker (the one
   * ActiveWorkSilenceSentinel ticks on its own 60s loop) and reads the value it
   * already computed — it NEVER captures its own frame. Returns null fails-closed
   * for the heartbeat (no emit).
   */
  lastOutputAtFor(sessionName: string): number | null {
    const rec = this.last.get(sessionName);
    if (!rec || rec.lastChangeAt <= 0) return null;
    return rec.lastChangeAt;
  }
}

export function buildActiveWorkSilenceDeps(opts: {
  tracker: OutputActivityTracker;
  sessions: SentinelSessionSurface;
  escalate: EscalateFn;
  /** Auto-recovery respawn primitive (DARK; only wired when autoRecover is on).
   *  Returns whether the respawn succeeded. */
  recoverFn?: (sessionName: string) => Promise<boolean>;
  /** Resolve a session to its Telegram topic, so silence/recovery notices land
   *  in the STALLED session's OWN topic (operator ask, 2026-06-09). */
  getTopicForSession?: (sessionName: string) => number | null | undefined;
  /** Deliver a notice to a specific topic. Returns success; never throws. */
  deliverToTopic?: (topicId: number, text: string) => Promise<boolean>;
  /** HONEST-PROGRESS-MESSAGING A1/A2 — capture the session's CURRENT live frame
   *  for corroboration before escalating. */
  captureFrame?: (sessionName: string) => string | null;
  /** A2(c) — does the session have a live sub-agent (SubagentTracker)? */
  hasActiveSubagents?: (sessionName: string) => boolean;
  /** Resolve the framework so the live-frame "generating now" check is accurate. */
  frameworkForSession?: (sessionName: string) => IntelligenceFramework | undefined;
  /** Observability funnel hook (E). */
  recordEvent?: (event: SilenceFunnelEvent, sessionName: string, detail?: string) => void;
}): ActiveWorkSilenceSentinelDeps {
  return {
    listSessions: () => opts.tracker.snapshot(),
    nudgeFn: async (sessionName) => {
      if (!opts.sessions.isSessionAlive(sessionName)) return false;
      return opts.sessions.sendKey(sessionName, 'Enter');
    },
    notifyFn: async (sessionName, text) => {
      // Route to the stalled session's OWN topic when we can resolve it
      // (operator ask: "messages should only go to the topic that's stalled").
      // Fall back to the consolidated tone-gated escalate path otherwise.
      const topicId = opts.getTopicForSession?.(sessionName);
      if (topicId != null && opts.deliverToTopic) {
        const ok = await opts.deliverToTopic(topicId, text).catch(() => false);
        if (ok) return;
      }
      await opts.escalate(sessionName, text);
    },
    recoverFn: opts.recoverFn,
    captureFrame: opts.captureFrame,
    // A1 uses the STRICT "generating now" check (live spinner / esc-to-interrupt
    // / running), never the broad scrollback-matching looksActivelyWorking — a
    // frozen pane full of past tool names is NOT generating now.
    looksActivelyWorking: opts.captureFrame
      ? (frame, sessionName) => looksGeneratingNow(frame, opts.frameworkForSession?.(sessionName))
      : undefined,
    hasActiveSubagents: opts.hasActiveSubagents,
    recordEvent: opts.recordEvent,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// RateLimitSentinel recovery deps — reachability under ALL session conditions.
//
// The original resume/notify closures in server.ts silently no-opped whenever
// getTopicForSession returned null — which is exactly the case for a developer's
// interactive Claude Code window (not bound to any Telegram topic). Detection +
// backoff ran, then every output dropped on the floor, so the throttle never
// recovered and nothing reached the user. Extracted here so the reachability
// logic is unit-testable (it was previously inline + untestable, which is why
// the bug shipped past green tests). Spec: Sentinel Reachability + Worktree
// Isolation.
// ───────────────────────────────────────────────────────────────────────────

export type RecoveryReachKind = 'recovery-reached' | 'recovery-unreachable';

/** The neutral "continue" nudge — NOT a compaction-resume payload (which would
 *  falsely tell the agent its memory was reset). */
export const RATE_LIMIT_RESUME_NUDGE =
  'The temporary server throttle should have cleared — please continue where you left off.';

export interface RateLimitRecoverySurface {
  isSessionAlive(sessionName: string): boolean;
  /**
   * Trusted internal nudge that bypasses the topic-prefix requirement.
   *
   * This is the ONLY channel the resume nudge is allowed to use. The resume
   * nudge is infrastructure poking the session to continue — it is NOT a user
   * message, so it must never carry a `[telegram:N]` prefix. A telegram-prefixed
   * nudge is byte-indistinguishable from a real message from the user, which
   * makes the agent answer it ("no throttle on my end") and relay that denial
   * back to the topic, contradicting the sentinel's own throttle notices.
   * (Incoherence incident 2026-06-05.)
   */
  injectInternalNudge(sessionName: string, text: string): boolean;
  getTopicForSession(sessionName: string): number | null | undefined;
  /** The always-available system topic; null during initial setup. */
  getLifelineTopicId(): number | null | undefined;
  /** Deliver a user-facing notice to a topic. Returns success; never throws. */
  deliverNotice(topicId: number, text: string): Promise<boolean>;
  /** Audit sink — invoked on EVERY recovery attempt. Never throws. */
  recordRecovery(
    kind: RecoveryReachKind,
    sessionName: string,
    detail: string,
    fallbackTried: string[],
  ): void;
}

/**
 * Build the resume/notify functions for RateLimitSentinel. Both paths ALWAYS
 * record an audit event and never silently return:
 *  - resumeFn: ALWAYS internal inject (no `[telegram:N]` user-message prefix),
 *    topic-bound or not — the resume nudge is infrastructure, never a user turn.
 *  - notifyFn: session topic → lifeline topic → recovery-unreachable audit.
 */
export function buildRateLimitRecoveryDeps(s: RateLimitRecoverySurface): {
  resumeFn: (sessionName: string) => Promise<boolean>;
  notifyFn: (sessionName: string, text: string) => Promise<void>;
} {
  return {
    resumeFn: async (sessionName) => {
      if (!s.isSessionAlive(sessionName)) return false;
      // The resume nudge ALWAYS goes through the internal recovery channel —
      // topic-bound or not. It un-sticks the session identically to the
      // user-message path (both converge on the same low-level inject) but
      // carries no `[telegram:N]` prefix, so the agent can never mistake it for
      // a message from the user and relay a contradictory "no throttle" reply.
      // The topic (when present) is recorded for the audit trail only.
      // (Incoherence incident 2026-06-05 — see throttle-notice-coherence spec.)
      const topicId = s.getTopicForSession(sessionName);
      const ok = s.injectInternalNudge(sessionName, RATE_LIMIT_RESUME_NUDGE);
      s.recordRecovery(
        ok ? 'recovery-reached' : 'recovery-unreachable',
        sessionName,
        ok
          ? `resume nudge injected via internal recovery channel${topicId != null ? ` (topic ${topicId})` : ''}`
          : 'internal injection returned false',
        ['internal-injection'],
      );
      return ok;
    },
    notifyFn: async (sessionName, text) => {
      const topicId = s.getTopicForSession(sessionName);
      if (topicId != null) {
        const ok = await s.deliverNotice(topicId, text).catch(() => false);
        s.recordRecovery(
          ok ? 'recovery-reached' : 'recovery-unreachable',
          sessionName,
          ok ? 'notice delivered to session topic' : 'topic delivery failed',
          ['topic'],
        );
        return;
      }
      // No topic for this session — fall back to the lifeline (system) topic.
      const lifelineId = s.getLifelineTopicId();
      if (lifelineId != null) {
        const ok = await s.deliverNotice(lifelineId, text).catch(() => false);
        s.recordRecovery(
          ok ? 'recovery-reached' : 'recovery-unreachable',
          sessionName,
          ok
            ? 'notice delivered to lifeline topic (session not topic-bound)'
            : 'lifeline delivery failed',
          ['topic', 'lifeline'],
        );
        return;
      }
      // Neither a session topic nor a lifeline topic is available. Never silent.
      s.recordRecovery(
        'recovery-unreachable',
        sessionName,
        `no topic and no lifeline; notice not delivered: ${text.slice(0, 120)}`,
        ['topic', 'lifeline', 'audit'],
      );
    },
  };
}

/** FNV-1a — enough to detect that captured output changed. Not security-sensitive. */
/**
 * Spinner-immune view of a captured pane for the change-detector hash. Removes
 * the host's animated working-status region — the rotating Braille glyph, the
 * ticking elapsed-time counter, the token/context counters, and the
 * `esc to interrupt` footer line — so only REAL scrollback content affects the
 * hash. Without this, the spinner's per-second clock made every poll look like
 * fresh output and blinded the silence sentinel to a stalled-but-spinning turn.
 * Conservative + anchored: real assistant/tool text is never stripped; unknown
 * frameworks still get the shared footer/glyph/timer stripping. (task #63)
 */
export function stripVolatileStatus(
  output: string,
  framework: Parameters<typeof getActivitySignal>[0],
): string {
  if (!output) return output;
  const sig = getActivitySignal(framework);
  // Strip volatile TOKENS from each line (not the whole line): real hosts put
  // genuine progress on the same line as the spinner/affordance — e.g.
  // `Bash(npm test) step 2 (esc to interrupt)` — so dropping the line would erase
  // the real active→silent signal. We remove only the parts that change without
  // real progress: the rotating glyph, the `esc to interrupt` affordance phrase,
  // the elapsed-time and token/context counters.
  const escPhrase = new RegExp(sig.escapeToInterrupt.source, 'gi');
  return output
    .split('\n')
    .map((line) =>
      line
        .replace(/[⠀-⣿]/g, '') // Braille spinner glyphs
        .replace(escPhrase, '') // the "esc to interrupt" affordance phrase
        .replace(/\b\d+m\s*\d+s\b/g, '') // elapsed "26m 16s"
        .replace(/\(\s*\d+\s*s\b/g, '(') // "(12s …" working-status seconds
        .replace(/[↑↓]\s*[\d.,]+\s*k?\s*tokens?/gi, '') // token counter
        .replace(/\b\d+%\s*context\b/gi, ''), // "N% context"
    )
    .join('\n');
}

function cheapHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function friendly(sessionName: string): string {
  return sessionName
    .replace(/^ai\.instar\./, '')
    .replace(/-server$/, '')
    .replace(/-lifeline$/, '');
}
