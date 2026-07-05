/**
 * stopGate.ts — UnjustifiedStopGate server infrastructure (PR0a).
 *
 * Provides the read-side API surface that the stop-hook router consumes.
 * Runtime mode persists to disk so shadow-mode rollout survives server
 * restarts; per-session hot-path state remains process-local and is
 * repopulated by hook events.
 *
 * Spec: docs/specs/context-death-pitfall-prevention.md
 *
 * PR0a deliverables:
 * - Hot-path batched state assembly: {mode, killSwitch, autonomousActive,
 *   compactionInFlight, sessionStartTs}
 * - Kill-switch local fast-path (set/clear/get)
 * - Compaction probe (P0.6): /tmp/claude-session-<id>/compacting OR
 *   compaction-recovery.sh mtime within 60s
 * - Version contract constants for /health
 *
 * Threat model: drift-correction, NOT security boundary. See spec §
 * "Threat model".
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Version contract (P0.7) ─────────────────────────────────────────────
//
// `GATE_ROUTE_VERSION` is the protocol version this server speaks on
// the /internal/stop-gate/* routes. Hook-lib reads it from /health and
// emits a one-time DegradationReport if its required minimum is greater
// than what the server exposes.
//
// `GATE_ROUTE_MINIMUM_VERSION` is the lowest hook-lib version this
// server will accept without degraded-mode warnings. Bump in lockstep
// with breaking changes to the hot-path schema.
export const GATE_ROUTE_VERSION = 1;
export const GATE_ROUTE_MINIMUM_VERSION = 1;

// ── Mode + kill-switch state ─────────────────────────────────────────────
//
// Mode is the operating mode of the gate. Default 'off' so PR0a ships
// completely inert — the spec's PR4 lands the CLI that flips to shadow.
//
// killSwitch overrides mode regardless of value. Drift-rollback semantic:
// any operator can flip it instantly via the local fast-path endpoint.
export type GateMode = 'off' | 'shadow' | 'enforce';

interface GateState {
  mode: GateMode;
  killSwitch: boolean;
  modeFilePath: string | null;
  // sessionStartTs is keyed by sessionId; populated by SessionStart hook
  // events received via /hooks/events. PR3 migrates to a sessions(sessions
  // table) row.
  sessionStartTs: Map<string, number>;
}

const state: GateState = {
  mode: 'off',
  killSwitch: false,
  modeFilePath: null,
  sessionStartTs: new Map(),
};

function readPersistedMode(filePath: string): GateMode | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mode?: unknown };
    const mode = parsed.mode;
    if (mode === 'off' || mode === 'shadow' || mode === 'enforce') return mode;
  } catch {
    // Missing/unreadable state is not fatal; caller supplies default.
  }
  return null;
}

function persistMode(): void {
  if (!state.modeFilePath) return;
  try {
    fs.mkdirSync(path.dirname(state.modeFilePath), { recursive: true });
    fs.writeFileSync(
      state.modeFilePath,
      JSON.stringify({ mode: state.mode, updatedAt: new Date().toISOString() }, null, 2) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Fail open. The route still returns the in-memory mode; persistence
    // failure is reported by the caller's normal health/degradation path.
  }
}

export function configureStopGateState(opts: {
  modeFilePath?: string;
  defaultMode?: GateMode;
} = {}): GateMode {
  if (opts.modeFilePath) {
    state.modeFilePath = opts.modeFilePath;
    state.mode = readPersistedMode(opts.modeFilePath) ?? (opts.defaultMode ?? state.mode);
    persistMode();
    return state.mode;
  }
  if (opts.defaultMode) state.mode = opts.defaultMode;
  return state.mode;
}

export function getMode(): GateMode {
  return state.mode;
}

export function setMode(mode: GateMode): void {
  state.mode = mode;
  persistMode();
}

export function getKillSwitch(): boolean {
  return state.killSwitch;
}

/**
 * Set kill-switch state in-memory. Returns the prior value so the caller
 * can detect no-op flips for telemetry.
 *
 * PR0a does NOT propagate to the machine registry — that fanout lands in
 * PR4 alongside the CLI. The server can be killed via the local fast-path
 * endpoint immediately; remote machines catch up later.
 */
export function setKillSwitch(value: boolean): boolean {
  const prior = state.killSwitch;
  state.killSwitch = value;
  return prior;
}

/**
 * Record the SessionStart timestamp for a session id. Idempotent:
 * subsequent calls for the same id are no-ops (first SessionStart wins —
 * we track the original session boundary, not later resumes).
 *
 * Called by the /hooks/events handler when a SessionStart event arrives.
 */
export function recordSessionStart(sessionId: string, timestampMs: number): void {
  if (!sessionId) return;
  if (state.sessionStartTs.has(sessionId)) return;
  state.sessionStartTs.set(sessionId, timestampMs);
}

export function getSessionStartTs(sessionId: string): number | null {
  if (!sessionId) return null;
  return state.sessionStartTs.get(sessionId) ?? null;
}

/**
 * Test-only reset. Production code must not call this.
 */
export function _resetForTests(): void {
  state.mode = 'off';
  state.killSwitch = false;
  state.modeFilePath = null;
  state.sessionStartTs.clear();
}

// ── Compaction probe (P0.6) ─────────────────────────────────────────────
//
// Best-effort signal that compaction is currently in flight. Two sources:
//
//   1. If Claude Code exposes `/tmp/claude-session-<id>/compacting`, the
//      file's existence is authoritative.
//   2. Heuristic fallback: `compaction-recovery.sh` mtime within last 60s.
//      Beyond 60s the signal is stale and ignored.
//
// Returning false on any error (fail-open) — drift-correction model, the
// gate's hot-path treats compactionInFlight as a routing hint, not a
// safety-critical assertion.
const COMPACTION_HEURISTIC_WINDOW_MS = 60_000;

export interface CompactionProbeOptions {
  /** Session id used to look up the per-session marker file. */
  sessionId?: string;
  /** Path to compaction-recovery.sh (for mtime heuristic). Defaults to
   *  the agent-local hook path. Tests inject a tmp path. */
  recoveryScriptPath?: string;
  /** Override "now" for tests. */
  now?: number;
}

export function compactionInFlight(opts: CompactionProbeOptions = {}): boolean {
  const now = opts.now ?? Date.now();

  // Source 1: authoritative marker file (if present).
  if (opts.sessionId) {
    const marker = `/tmp/claude-session-${opts.sessionId}/compacting`;
    try {
      if (fs.existsSync(marker)) return true;
    } catch {
      // fail-open
    }
  }

  // Source 2: recovery script mtime heuristic.
  const recoveryPath = opts.recoveryScriptPath
    ?? path.resolve(process.cwd(), '.instar/hooks/instar/compaction-recovery.sh');
  try {
    const st = fs.statSync(recoveryPath);
    const ageMs = now - st.mtimeMs;
    if (ageMs >= 0 && ageMs <= COMPACTION_HEURISTIC_WINDOW_MS) return true;
  } catch {
    // fail-open: missing recovery script is reported separately by
    // health probes, not by this gate.
  }

  return false;
}

// ── Hot-path batched state ──────────────────────────────────────────────
//
// Single read returning all five fields the stop-hook router needs in one
// HTTP round-trip. Hook caches the response in /tmp/instar-<agent>-stop-
// gate-hot-path.json with mtime-TTL 60s — server doesn't need to be
// involved in caching.

export interface HotPathState {
  mode: GateMode;
  killSwitch: boolean;
  autonomousActive: boolean;
  compactionInFlight: boolean;
  sessionStartTs: number | null;
  routeVersion: number;
  /**
   * green-pr-automerge-enforcement Layer 2: present only when the ending
   * session's branch matches a fresh, armed green-PR snapshot candidate. The
   * hook acts on it MODE-INDEPENDENTLY (one-shot block). NO variant carries a
   * runnable merge command (round-6) — the watcher being armed is exactly the
   * state where manual merging is recreated manual work.
   */
  greenPrBlock?: GreenPrBlock | null;
  /**
   * Turn-End Self-Deferral Guard (Phase A) — whether the dev-gated
   * `monitoring.selfDeferralGuard` guard is on for this agent. Set by the
   * hot-path ROUTE (which holds the config), NOT by getHotPathState. The
   * stop-gate hook reads this to decide whether to do the (otherwise wasted)
   * transcript tail-read for user-turn context; when false it skips it entirely.
   */
  selfDeferralGuardOn?: boolean;
}

export interface GreenPrBlock {
  pr: number;
  message: string;
  variant: 'mergeable' | 'protected-paths' | 'disarmed';
}

/** A minimal projection of the watcher's last-tick snapshot for Layer 2. */
export interface GreenPrSnapshotForBlock {
  at: number;
  entries: Array<{ pr: number; headRefName: string; kind: 'mergeable' | 'protected-paths' }>;
}

/**
 * Compute the Layer-2 greenPrBlock for an ending session. Pure + testable.
 * Blocks ONLY when: the snapshot is fresh (≤ 2× tickIntervalMs), the session's
 * branch matches a candidate, and not suppressed by killSwitch/compaction. When
 * the watcher is DISARMED, the matching entry yields the do-not-merge variant
 * (never the merge coaching). No variant contains a runnable command.
 */
export function computeGreenPrBlock(args: {
  snapshot: GreenPrSnapshotForBlock | null;
  sessionBranch: string | null;
  armed: boolean;
  killSwitch: boolean;
  compactionInFlight: boolean;
  tickIntervalMs: number;
  now: number;
}): GreenPrBlock | null {
  const { snapshot, sessionBranch, armed, killSwitch, compactionInFlight, tickIntervalMs, now } = args;
  if (!snapshot || !sessionBranch) return null;
  if (killSwitch || compactionInFlight) return null;
  if (now - snapshot.at > 2 * tickIntervalMs) return null; // staleness gate
  const match = snapshot.entries.find((e) => e.headRefName === sessionBranch);
  if (!match) return null;
  if (!armed) {
    return {
      pr: match.pr,
      variant: 'disarmed',
      message: `PR #${match.pr} (your branch) is green, but the auto-merge watcher is disabled by operator rollback — do NOT merge it manually; confirm with the operator.`,
    };
  }
  if (match.kind === 'protected-paths') {
    return {
      pr: match.pr,
      variant: 'protected-paths',
      message: `PR #${match.pr} (your branch) is green but touches protected paths — it needs the operator's review and merge; it is already on the attention queue. Do NOT merge it manually.`,
    };
  }
  return {
    pr: match.pr,
    variant: 'mergeable',
    message: `PR #${match.pr} (your branch) is green and unmerged. Either hold it (POST /green-pr-automerge/hold {"pr": ${match.pr}, "reason": "…"}) or end the session — the watcher lands it within ~10 minutes. Do NOT merge it manually.`,
  };
}

/**
 * Resolve a session's current git branch from its cwd, handling the linked-
 * worktree case where `.git` is a FILE (`gitdir: <path>`) not a directory
 * (instar-dev builds live in worktrees). Two tiny reads, no git spawn,
 * fail-open (null → never blocks). Pure over the injected fs reader.
 */
export function resolveBranchFromCwd(cwd: string, readFile: (p: string) => string, exists: (p: string) => boolean): string | null {
  try {
    const dotGit = path.join(cwd, '.git');
    if (!exists(dotGit)) return null;
    let gitDir = dotGit;
    // A worktree's .git is a file: "gitdir: /abs/path/to/worktrees/x/.git".
    let headPath: string;
    try {
      const content = readFile(dotGit);
      const m = content.match(/^gitdir:\s*(.+)\s*$/m);
      if (m) {
        gitDir = path.isAbsolute(m[1].trim()) ? m[1].trim() : path.resolve(cwd, m[1].trim());
        headPath = path.join(gitDir, 'HEAD');
      } else {
        headPath = path.join(dotGit, 'HEAD');
      }
    } catch { /* @silent-fallback-ok: green-pr-automerge Layer-2 belt — .git is a directory; fall through to .git/HEAD. Fail-open. */
      headPath = path.join(dotGit, 'HEAD');
    }
    const head = readFile(headPath);
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)\s*$/m);
    return ref ? ref[1].trim() : null;
  } catch { /* @silent-fallback-ok: green-pr-automerge Layer-2 belt — branch resolution is fail-open; null means no block, never a wrong block. */
    return null;
  }
}

export interface HotPathInputs {
  sessionId?: string;
  /** Whether the current agent is in autonomous mode. PR0a reads it from
   *  the autonomous-state.local.md file convention; PR3 may use a
   *  finer-grained source. Pass an explicit boolean to override (tests). */
  autonomousActiveOverride?: boolean;
  autonomousStateFile?: string;
  recoveryScriptPath?: string;
  now?: number;
  /**
   * GAP-B (autonomous-run-registration-guarantee D2): the topic this
   * session serves, resolved SERVER-SIDE by inverting
   * `.instar/topic-session-registry.json`'s `topicToSession` map on the
   * session's tmux name (the same inversion the bash stop hook uses). When
   * present, readAutonomousActive checks the CANONICAL per-topic
   * registration `.instar/autonomous/<topicId>.local.md` FIRST.
   *
   * Unresolved (a registry-lookup miss) → undefined. The read then falls
   * back to BOTH legacy single-file paths — NEVER a silent
   * autonomousActive:false (no-silent-fallbacks ratchet).
   */
  topicId?: string | number;
  /**
   * Agent home root the relative autonomous-state paths resolve against.
   * Defaults to process.cwd() (the agent home the server runs in). Tests
   * inject a tmp dir. The per-topic file lives at
   * `<stateRoot>/.instar/autonomous/<topicId>.local.md`; the two legacy
   * single-files at `<stateRoot>/.instar/autonomous-state.local.md` and
   * `<stateRoot>/.claude/autonomous-state.local.md`.
   */
  stateRoot?: string;
}

/**
 * GAP-B D1 — fixed read precedence for autonomousActive. An autonomous run
 * registered per-topic at `.instar/autonomous/<topicId>.local.md` (the
 * canonical path the reaper/revival machinery reads) was previously
 * INVISIBLE to the stop gate, which only ever checked the oldest legacy
 * path. The precedence, applied with the SAME existence check the original
 * function used (consistently across all three):
 *
 *   1. `.instar/autonomous/<topicId>.local.md`  (per-topic — canonical;
 *      only when a topicId is resolved)
 *   2. `.instar/autonomous-state.local.md`       (legacy single-file)
 *   3. `.claude/autonomous-state.local.md`       (oldest legacy)
 *
 * autonomousActive:true if ANY exists. The legacy paths are ALWAYS checked
 * as fallbacks — even on an unresolved topic — so a registry-lookup miss
 * can never silently return false (no-silent-fallbacks ratchet, D2).
 *
 * `autonomousStateFile` (the historical test/override seam) still wins:
 * when supplied it is the sole path read, preserving back-compat for
 * existing callers/tests that point at one explicit file.
 *
 * E2E-PAIRING: EXEMPT — a read-path correction to an existing internal
 * gate route (/internal/stop-gate/*); it adds no new route or feature
 * surface that could 503 in prod, so the "feature is alive" E2E does not
 * apply. The full HTTP hot-path (UUID to tmux to topic to per-topic file)
 * is covered by tests/integration/stop-gate-autonomous-topic-resolution.test.ts;
 * the incident-level boot E2E belongs to the registration-guard increment.
 */
function readAutonomousActive(opts: HotPathInputs): boolean {
  if (typeof opts.autonomousActiveOverride === 'boolean') {
    return opts.autonomousActiveOverride;
  }

  const existsSafe = (file: string): boolean => {
    try {
      return fs.existsSync(file);
    } catch { /* @silent-fallback-ok: GAP-B — a per-PATH stat error is not a registry miss; the precedence chain continues to the next path, never short-circuiting the whole read. */
      return false;
    }
  };

  // Back-compat: an explicit single-file override is the sole path read.
  if (opts.autonomousStateFile) {
    return existsSafe(opts.autonomousStateFile);
  }

  const root = opts.stateRoot ?? process.cwd();

  // 1. Per-topic canonical path — ONLY when a topic was resolved. A topicId
  //    of undefined/'' means the registry inversion missed (or no session);
  //    we fall through to the legacy paths below (the explicit, recorded
  //    no-silent-fallback handling for the unresolved-topic case).
  const topicIdStr =
    opts.topicId === undefined || opts.topicId === null ? '' : String(opts.topicId).trim();
  if (topicIdStr) {
    const perTopic = path.resolve(root, '.instar/autonomous', `${topicIdStr}.local.md`);
    if (existsSafe(perTopic)) return true;
  }

  // 2 + 3. Legacy single-file fallbacks (ALWAYS checked — including on an
  //        unresolved topic). Precedence: .instar then .claude.
  const legacyInstar = path.resolve(root, '.instar/autonomous-state.local.md');
  if (existsSafe(legacyInstar)) return true;

  const legacyClaude = path.resolve(root, '.claude/autonomous-state.local.md');
  if (existsSafe(legacyClaude)) return true;

  return false;
}

/**
 * GAP-B D2 — resolve the topic a session serves SERVER-SIDE, mirroring the
 * bash stop hook's inversion of `topic-session-registry.json`'s
 * `topicToSession` (topic→tmux) map keyed on the session's tmux name.
 *
 * The stop-gate hot-path receives the Claude session UUID, not the tmux
 * name, so the caller resolves UUID→tmux first (via the session manager's
 * claudeSessionId record) and passes the tmux name here. Pure + fail-open:
 * any read/parse error → null (the read then uses the legacy fallbacks; a
 * null is the explicit unresolved-topic case, never a silent false).
 *
 * @param registryPath absolute path to topic-session-registry.json
 * @param tmuxSession  the session's tmux name (the registry value to invert on)
 */
export function resolveTopicForTmux(
  registryPath: string,
  tmuxSession: string | null | undefined,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): string | null {
  if (!tmuxSession) return null;
  try {
    const reg = JSON.parse(readFile(registryPath)) as {
      topicToSession?: Record<string, string>;
    };
    const t2s = reg.topicToSession ?? {};
    for (const [topicId, sess] of Object.entries(t2s)) {
      if (sess === tmuxSession) return topicId;
    }
    return null;
  } catch { /* @silent-fallback-ok: GAP-B — a missing/corrupt registry yields null (unresolved topic), which the read handles EXPLICITLY by checking both legacy paths; it is never coerced to autonomousActive:false. */
    return null;
  }
}

export function getHotPathState(opts: HotPathInputs = {}): HotPathState {
  return {
    mode: state.mode,
    killSwitch: state.killSwitch,
    autonomousActive: readAutonomousActive(opts),
    compactionInFlight: compactionInFlight({
      sessionId: opts.sessionId,
      recoveryScriptPath: opts.recoveryScriptPath,
      now: opts.now,
    }),
    sessionStartTs: opts.sessionId ? getSessionStartTs(opts.sessionId) : null,
    routeVersion: GATE_ROUTE_VERSION,
  };
}
