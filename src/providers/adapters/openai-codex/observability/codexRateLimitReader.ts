/**
 * Reads the codex CLI's `/status`-equivalent rate-limit usage from the
 * on-disk rollout JSONL stream — WITHOUT the interactive TUI.
 *
 * Codex has no public usage endpoint (the UsageMeterProvider falls back to
 * local token accounting and reports isAuthoritative()=false). But the codex
 * CLI DOES persist the authoritative account rate-limit windows it gets back
 * from OpenAI: every turn it appends a `token_count` event to the session
 * rollout whose `payload.rate_limits` carries the same primary (5h) /
 * secondary (weekly) windows the TUI's `/status` shows:
 *
 *   { "type": "event_msg",
 *     "payload": {
 *       "type": "token_count",
 *       "rate_limits": {
 *         "limit_id": "codex",
 *         "primary":   { "used_percent": 13, "window_minutes": 300,   "resets_at": 1780171524 },
 *         "secondary": { "used_percent": 93, "window_minutes": 10080, "resets_at": 1780174809 },
 *         "plan_type": "prolite",
 *         "rate_limit_reached_type": null } } }
 *
 * This reader finds the newest rollout(s), reads only the tail (rate-limit
 * events are appended per-turn, so the freshest is near the end), and returns
 * the most recent snapshot. It is read-only and never mutates any session
 * state — the same discipline as the rest of the codex observability layer.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (cost-routing / model-swap input)
 *   Frequency:   per-poll / on-demand (route hit)
 *   Stability:   semi-stable (codex rollout layout changes occasionally —
 *                shared with sessionPaths, covered by codexSessionLayoutCanary)
 *   Fallback:    return null when no rollout / no token_count event is found
 *   Verdict:     deterministic tail-scan; canary covers the layout
 */

import { promises as fs } from 'node:fs';
import { listAllRollouts } from './sessionPaths.js';

/** A single rate-limit window (5h primary or weekly secondary). */
export interface CodexRateWindow {
  /** Percent of the window's budget consumed (0-100). */
  usedPercent: number;
  /** Convenience: 100 - usedPercent, clamped to [0, 100]. */
  remainingPercent: number;
  /** Window length in minutes (300 = 5h, 10080 = weekly). */
  windowMinutes: number;
  /** Absolute reset time, unix epoch seconds (as codex reports it). */
  resetsAt: number;
  /** Derived ISO-8601 of `resetsAt`, or null if `resetsAt` is missing/invalid. */
  resetsAtIso: string | null;
  /** Seconds until reset relative to the provided clock, or null when no clock. */
  resetsInSeconds: number | null;
}

/** A point-in-time snapshot of codex account rate-limit usage. */
export interface CodexUsageSnapshot {
  source: 'codex-rollout';
  /** The rollout file the snapshot was read from. */
  rolloutPath: string;
  /** Thread UUID parsed from the rollout filename, or null. */
  threadId: string | null;
  /** Timestamp of the token_count event the snapshot came from (ISO), or null. */
  capturedAt: string | null;
  /** Model in effect at capture (best-effort from the latest turn_context), or null. */
  model: string | null;
  /** Plan tier codex reports (e.g. "plus", "prolite"), or null. */
  planType: string | null;
  /**
   * Which window (if any) is currently exhausted. codex sets this to e.g.
   * "primary" / "secondary" when a limit is hit; null when usage is fine.
   * This is the authoritative "we are rate-limited" signal.
   */
  rateLimitReachedType: string | null;
  /** The 5h rolling window (window_minutes 300), or null if absent. */
  primary: CodexRateWindow | null;
  /** The weekly rolling window (window_minutes 10080), or null if absent. */
  secondary: CodexRateWindow | null;
  /**
   * True when the account's rollouts carried rate-limit records but NONE of
   * them reported a usage window — i.e. the only records were entitlement /
   * credits families (currently `premium`). Both `primary` and `secondary` are
   * null in that case, exactly as they would be if nothing were found at all,
   * so this flag is the ONLY way a consumer can tell "this account reports no
   * usage window" apart from "we found no reading". Consumers must treat it as
   * a SIGNAL (render it honestly, skip a pointless re-poll) — never as an
   * authority to route, shed or swap on.
   */
  windowsUnavailable?: boolean;
}

export interface ReadCodexUsageOptions {
  /** Override $CODEX_HOME (defaults to ~/.codex). */
  codexHome?: string;
  /** Clock for deriving `resetsInSeconds` (defaults to Date.now()). */
  nowMs?: number;
  /** How many newest rollouts to scan for a token_count event (default 8). */
  maxRolloutsScanned?: number;
  /** Tail size to read from each rollout (default 512 KiB). */
  tailBytes?: number;
}

const DEFAULT_TAIL_BYTES = 512 * 1024;
const DEFAULT_MAX_ROLLOUTS = 8;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Read the freshest codex rate-limit snapshot from disk. Returns null when
 * there is no codex rollout with a rate-limit-bearing token_count event
 * (e.g. a pure-Claude agent, or a session that has not completed a turn yet).
 *
 * When rollouts DO carry rate-limit records but none of them reports a usage
 * window (an entitlement/credits-only account), the returned snapshot has both
 * windows null and `windowsUnavailable: true` — a distinct, honest state from
 * the null "nothing found" return.
 */
export async function readLatestCodexUsage(
  opts: ReadCodexUsageOptions = {},
): Promise<CodexUsageSnapshot | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const maxRollouts = opts.maxRolloutsScanned ?? DEFAULT_MAX_ROLLOUTS;

  const rollouts = await listAllRollouts(opts.codexHome, maxRollouts);
  // A windowed reading always wins. A window-less (entitlement-only) reading is
  // held back as a fallback: an account whose NEWEST rollout ends on the
  // session-close `premium` record still has its real quota a few rollouts
  // further down, and returning the entitlement record first would hide it.
  let windowless: CodexUsageSnapshot | null = null;
  for (const { path: rolloutPath } of rollouts) {
    let tail: string;
    try {
      tail = await readTail(rolloutPath, tailBytes);
    } catch {
      continue;
    }
    const snapshot = parseUsageFromTail(tail, rolloutPath, nowMs);
    if (!snapshot) continue;
    if (!snapshot.windowsUnavailable) return snapshot;
    windowless ??= snapshot;
  }
  return windowless;
}

/**
 * Parse the freshest rate-limit snapshot out of a rollout tail. Exported for
 * unit tests so they can exercise the parser without touching disk.
 */
export function parseUsageFromTail(
  tail: string,
  rolloutPath: string,
  nowMs: number,
): CodexUsageSnapshot | null {
  const lines = tail.split('\n');
  // The newest CODEX-family record that actually carries a usage window.
  let rateLimits: Record<string, unknown> | null = null;
  let capturedAt: string | null = null;
  // The newest record of ANY family that carries no window — the fallback that
  // lets a caller tell "this account reports no window" from "nothing found".
  let windowlessLimits: Record<string, unknown> | null = null;
  let windowlessCapturedAt: string | null = null;
  let model: string | null = null;

  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    // Cheap pre-filter before the JSON.parse cost.
    const hasRate = line.includes('"rate_limits"');
    const hasModel = line.includes('"turn_context"') && line.includes('"model"');
    if (!hasRate && !hasModel) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (payload.type === 'token_count' && payload.rate_limits) {
      const candidate = payload.rate_limits as Record<string, unknown>;
      const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
      // Codex appends a SECOND token_count record for a different limit family
      // (currently `premium`) when a session closes. Those entitlement records
      // carry no windows, and taking the newest record blindly let that one
      // final line erase a whole session's worth of real quota — which is why
      // an account's card went blank the moment its session ended. Keep
      // backwards compatibility with older rollouts that omitted limit_id.
      const limitId = candidate.limit_id;
      const isCodexFamily = limitId === undefined || limitId === 'codex';
      const hasWindow = isRateWindowObject(candidate.primary) || isRateWindowObject(candidate.secondary);
      if (isCodexFamily && hasWindow) {
        rateLimits = candidate;
        capturedAt = ts ?? capturedAt;
      } else if (!hasWindow) {
        windowlessLimits = candidate;
        windowlessCapturedAt = ts ?? windowlessCapturedAt;
      }
    } else if (payload.type === undefined && obj.type === 'turn_context') {
      // turn_context nests its fields directly under payload.
      const m = payload.model;
      if (typeof m === 'string' && m) model = m;
    }
  }

  const chosen = rateLimits ?? windowlessLimits;
  if (!chosen) return null;
  const windowsUnavailable = rateLimits === null;

  const snapshot: CodexUsageSnapshot = {
    source: 'codex-rollout',
    rolloutPath,
    threadId: parseThreadId(rolloutPath),
    capturedAt: windowsUnavailable ? windowlessCapturedAt : capturedAt,
    model,
    planType: typeof chosen.plan_type === 'string' ? chosen.plan_type : null,
    rateLimitReachedType:
      typeof chosen.rate_limit_reached_type === 'string'
        ? chosen.rate_limit_reached_type
        : null,
    primary: parseWindow(chosen.primary, nowMs),
    secondary: parseWindow(chosen.secondary, nowMs),
  };
  if (windowsUnavailable) snapshot.windowsUnavailable = true;
  return snapshot;
}

function isRateWindowObject(value: unknown): boolean {
  return !!value && typeof value === 'object';
}

function parseWindow(raw: unknown, nowMs: number): CodexRateWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const usedPercent = typeof w.used_percent === 'number' ? w.used_percent : null;
  const windowMinutes = typeof w.window_minutes === 'number' ? w.window_minutes : null;
  const resetsAt = typeof w.resets_at === 'number' ? w.resets_at : null;
  if (usedPercent === null || windowMinutes === null || resetsAt === null) return null;
  const validReset = Number.isFinite(resetsAt) && resetsAt > 0;
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowMinutes,
    resetsAt,
    resetsAtIso: validReset ? new Date(resetsAt * 1000).toISOString() : null,
    resetsInSeconds: validReset ? Math.round((resetsAt * 1000 - nowMs) / 1000) : null,
  };
}

function clampPercent(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function parseThreadId(rolloutPath: string): string | null {
  const m = UUID_RE.exec(rolloutPath);
  return m ? m[1] : null;
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // The first line is likely partial — drop up to the first newline.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    await handle.close();
  }
}
