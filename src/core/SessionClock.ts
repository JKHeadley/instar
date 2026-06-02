/**
 * SessionClock — pure, deterministic computation of a time-boxed session's
 * elapsed / remaining clock. Tier0 (no LLM, no I/O): given the canonical record
 * fields and a `now`, it returns the numbers the rest of the time-awareness
 * system injects and serves.
 *
 * Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md (Component 0 label
 * derivation, Component 1 compute). Built for the 2026-06-02 time-blindness fix:
 * an agent must never compute or guess elapsed/remaining — this module is the
 * single source of that math (the bash hooks only render what this produces).
 */

export type SessionKind = 'autonomous' | 'loop' | 'commitment';

export type SessionClockStatus =
  | 'active' // started, bounded, not yet expired
  | 'expired' // started, bounded, now past the end
  | 'not-started' // startedAt is in the future (clock skew / foreign timestamp)
  | 'unbounded' // started, no durationSeconds -> no remaining
  | 'unparseable'; // startedAt could not be parsed -> caller fails open to absolute-only

export interface SessionClockInput {
  /** Short human label for the session. DERIVE it via deriveLabel(goal). */
  label: string;
  kind: SessionKind;
  /** ISO-8601 timestamp (e.g. "2026-06-02T05:42:40Z"). */
  startedAt: string;
  /** Seconds the box is meant to run, or null/undefined for an unbounded run. */
  durationSeconds: number | null;
}

export interface SessionClock {
  label: string;
  kind: SessionKind;
  startedAt: string;
  durationSeconds: number | null;
  /** Derived ISO end (startedAt + durationSeconds), or null when unbounded/unparseable. */
  endsAt: string | null;
  elapsedSeconds: number;
  /** null when unbounded or unparseable. */
  remainingSeconds: number | null;
  elapsedHuman: string;
  remainingHuman: string | null;
  /** 0-100, or null when unbounded/unparseable. */
  percentElapsed: number | null;
  status: SessionClockStatus;
}

/** Max chars for an injected/served label (matches the stop-hook goal_snippet cap). */
export const LABEL_MAX = 80;

// Control characters (C0 range + DEL) that must never reach an injected prompt.
// Built via RegExp(string) with escaped unicode so the SOURCE carries no literal
// control bytes.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');

/**
 * Derive a safe, bounded label from a free-text `goal`. The ONLY task-descriptor
 * text that may ever enter a prompt or the /session/clock response. Strips all
 * control characters and newlines (so a multi-line fake-directive cannot survive)
 * and angle brackets (so a <promise>-style tag cannot be reconstructed), collapses
 * whitespace, and caps length.
 */
export function deriveLabel(goal: string | null | undefined): string {
  if (!goal) return '';
  const stripped = String(goal)
    .replace(CONTROL_CHARS, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > LABEL_MAX ? stripped.slice(0, LABEL_MAX).trimEnd() : stripped;
}

/** Format a non-negative duration in seconds as "Xh Ym" / "Ym" / "Xs". */
export function humanizeDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * Compute the clock for a session record against `nowMs` (epoch ms).
 * Pure + total: every malformed input maps to a defined, clamped result —
 * never a negative, NaN, or throwing path.
 */
export function computeSessionClock(input: SessionClockInput, nowMs: number): SessionClock {
  const { kind, durationSeconds } = input;
  const label = input.label ?? '';
  const startMs = Date.parse(input.startedAt);

  // Unparseable startedAt -> fail open. Caller renders absolute-time-only.
  if (!Number.isFinite(startMs)) {
    return {
      label,
      kind,
      startedAt: input.startedAt,
      durationSeconds: durationSeconds ?? null,
      endsAt: null,
      elapsedSeconds: 0,
      remainingSeconds: null,
      elapsedHuman: '0s',
      remainingHuman: null,
      percentElapsed: null,
      status: 'unparseable',
    };
  }

  const hasDuration =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0;
  const endMs = hasDuration ? startMs + (durationSeconds as number) * 1000 : null;
  const endsAt = endMs !== null ? new Date(endMs).toISOString() : null;

  const rawElapsed = Math.floor((nowMs - startMs) / 1000);

  // Future startedAt (clock skew / a state file synced from another machine):
  // clamp to not-started rather than emit a negative elapsed.
  if (rawElapsed < 0) {
    return {
      label,
      kind,
      startedAt: input.startedAt,
      durationSeconds: hasDuration ? (durationSeconds as number) : null,
      endsAt,
      elapsedSeconds: 0,
      remainingSeconds: hasDuration ? (durationSeconds as number) : null,
      elapsedHuman: '0s',
      remainingHuman: hasDuration ? humanizeDuration(durationSeconds as number) : null,
      percentElapsed: hasDuration ? 0 : null,
      status: 'not-started',
    };
  }

  const elapsedSeconds = rawElapsed;
  const elapsedHuman = humanizeDuration(elapsedSeconds);

  if (!hasDuration) {
    return {
      label,
      kind,
      startedAt: input.startedAt,
      durationSeconds: null,
      endsAt: null,
      elapsedSeconds,
      remainingSeconds: null,
      elapsedHuman,
      remainingHuman: null,
      percentElapsed: null,
      status: 'unbounded',
    };
  }

  const dur = durationSeconds as number;
  const remainingRaw = dur - elapsedSeconds;
  const remainingSeconds = Math.max(0, remainingRaw);
  const percentElapsed = Math.min(100, Math.max(0, Math.round((elapsedSeconds / dur) * 100)));
  const status: SessionClockStatus = remainingRaw <= 0 ? 'expired' : 'active';

  return {
    label,
    kind,
    startedAt: input.startedAt,
    durationSeconds: dur,
    endsAt,
    elapsedSeconds,
    remainingSeconds,
    elapsedHuman,
    remainingHuman: humanizeDuration(remainingSeconds),
    percentElapsed,
    status,
  };
}
