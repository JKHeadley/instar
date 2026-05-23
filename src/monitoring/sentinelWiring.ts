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
} from './ActiveWorkSilenceSentinel.js';
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
      const hash = cheapHash(output);
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
}

export function buildActiveWorkSilenceDeps(opts: {
  tracker: OutputActivityTracker;
  sessions: SentinelSessionSurface;
  escalate: EscalateFn;
}): ActiveWorkSilenceSentinelDeps {
  return {
    listSessions: () => opts.tracker.snapshot(),
    nudgeFn: async (sessionName) => {
      if (!opts.sessions.isSessionAlive(sessionName)) return false;
      return opts.sessions.sendKey(sessionName, 'Enter');
    },
    notifyFn: async (sessionName, text) => {
      await opts.escalate(sessionName, text);
    },
  };
}

/** FNV-1a — enough to detect that captured output changed. Not security-sensitive. */
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
