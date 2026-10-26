/**
 * CodexArmSessionSweeper — closes the tmux sessions `codexHookArm` leaks.
 *
 * `makeTmuxTrustDriver` (src/core/codexHookArm.ts) creates a DETACHED tmux session
 * named `instar-codex-arm-<base36 ms>` to drive Codex's interactive hook-trust prompt.
 * The session is owned by the tmux SERVER, not by the node process that created it,
 * and its teardown lives solely in that driver's `finally`. A caller killed between
 * `new-session` and that `finally` orphans the session permanently — and the caller
 * that dies this way is `PostUpdateMigrator`, which arms on EVERY update, during which
 * the server restarts. So the race is a scheduled event, not an accident.
 *
 * Measured on the operator's laptop: 25 orphans retired 2026-10-24, 16 more (oldest 43 h)
 * on 2026-10-25 — ~8/day on one machine, each holding an interactive `codex` at a prompt.
 *
 * THE load-bearing design decision: this sweeper reads the MACHINE (`tmux ls`), never
 * instar's own session registry. An arm session is never registered with SessionManager,
 * which is exactly why the leak was invisible: `GET /sessions` reported 11 while the
 * machine held 112. A sweeper built on the registry would have reaped zero of the 41.
 *
 * It is the BACKSTOP, not the fix. The fix is the arm session bounding its own lifetime
 * (codexHookArm's ARM_SESSION_TTL_MS self-destruct). This exists because that fix can
 * still fail — a shell that never starts, a socket that moved, a machine already carrying
 * orphans from an older release — and because the thing that cleans up must not be the
 * thing that might have died.
 *
 * Spec: docs/specs/codex-arm-session-leak-and-sweeper.md
 */

/* @self-action-controller: codex-arm-session-sweep */
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { withSyncOp } from '../core/InFlightSyncOpMarker.js';
import { mergeDefaults, resolveTimerMs } from '../core/mergeDefaults.js';

/** The ONLY name shape this sweeper will ever act on. Anchored at position 0. */
export const ARM_SESSION_PREFIX = 'instar-codex-arm-';

/**
 * The suffix shape `makeTmuxTrustDriver` mints: `Date.now().toString(36)`.
 * Lowercase base36, nothing else.
 */
const ARM_SUFFIX = /^[0-9a-z]+$/;

/**
 * How far the creation time ENCODED IN THE NAME may sit from the creation time tmux
 * INDEPENDENTLY recorded. The driver mints the name and calls `new-session` in
 * consecutive statements, so the real gap is milliseconds; 5 minutes is slack for a
 * clock adjustment, not for a coincidence.
 */
export const NAME_TIME_TOLERANCE_MS = 300_000;

/**
 * Floor for `maxAgeMs`. The modeled worst-case legitimate arm lifetime is ~150 s (see
 * ARM_SESSION_TTL_MS in codexHookArm.ts for the arithmetic — earlier drafts said 53 s, then
 * 124 s, and the reviews caught both). 300 s is ~2x that, so a live arm is not killed within
 * the modeled bound even if an operator sets `maxAgeMs` to something careless. The cost of
 * the margin is nil: a leaked session is measured in hours, and the self-destruct ends it at
 * 600 s anyway. The budget is not a wall-clock guarantee; the attached keep is the backstop.
 */
export const MIN_MAX_AGE_MS = 300_000;

/**
 * Subprocess timeouts. Both calls are synchronous on the server's event loop (funnelled
 * through withSyncOp so the stall is attributed, never mistaken for sleep), so the worst
 * case per pass is bounded by LIST + (one kill that overran the pass budget) ≈ 8 s, not
 * minutes. A tmux that cannot answer `ls` in 5 s is a tmux this pass should not act on.
 */
export const LIST_TIMEOUT_MS = 5_000;
export const KILL_TIMEOUT_MS = 3_000;

export interface CodexArmSessionSweeperConfig {
  enabled: boolean;
  /** Record would-kill verdicts without killing. */
  dryRun: boolean;
  /** Minimum age before an arm session is considered orphaned. Clamped to MIN_MAX_AGE_MS. */
  maxAgeMs: number;
  sweepIntervalMs: number;
  /** One-time pass this long after start(), so the first sweep is not a whole interval away. */
  initialPassDelayMs: number;
  /** Bounded blast radius per pass (Bounded Blast Radius standard). */
  maxKillsPerPass: number;
  /**
   * P19 brake (No Unbounded Loops): after this many CONSECUTIVE passes whose session
   * list could not be read, the sweeper stops attempting until a restart. A permanently
   * broken tmux must not be re-probed forever. A single readable pass resets it.
   */
  maxConsecutiveListFailures: number;
  /**
   * P19 brake: after this many failed kills of the SAME session name, that session is
   * never attempted again (it is reported as kept, with the reason). A permanently
   * unkillable session cannot become an infinite retry.
   */
  maxKillFailuresPerSession: number;
  /**
   * Breaker RECOVERY (cross-model review): an open breaker is not permanent. Every this
   * many passes it lets ONE probe through; a readable list closes it. Otherwise a tmux
   * server that was merely absent at boot — the normal order on this host — would leave
   * every later session unswept until a restart.
   */
  breakerProbeEveryPasses: number;
  /**
   * Wall-clock budget for one pass's KILL attempts, so the synchronous kill path cannot
   * block the server's event loop for long on the timeout path (50 kills × a 10 s timeout
   * was ~510 s — the very stall this change exists to relieve). Once exceeded, remaining
   * candidates are kept (`keptReasons['pass-time-budget']`) until the next pass.
   */
  maxPassMs: number;
}

export const DEFAULT_CODEX_ARM_SESSION_SWEEPER_CONFIG: CodexArmSessionSweeperConfig = {
  enabled: true,
  // dryRun by default: the SOURCE fix (the self-destruct in codexHookArm) stops new
  // orphans, so the sweeper's kill authority only matters for a backlog that already
  // exists — and the dry-run report says, empirically, whether that backlog is real on
  // this machine before anything is killed. The graduated path costs nothing here.
  dryRun: true,
  maxAgeMs: 900_000,
  sweepIntervalMs: 10 * 60 * 1000,
  initialPassDelayMs: 90_000,
  maxKillsPerPass: 50,
  maxConsecutiveListFailures: 5,
  maxKillFailuresPerSession: 3,
  breakerProbeEveryPasses: 6,
  maxPassMs: 3_000,
};

export interface TmuxSessionRow {
  name: string;
  /** Unix seconds, as tmux's `#{session_created}` reports it. */
  createdEpochSec: number;
  /** Unix seconds of the last activity in the session (`#{session_activity}`); absent on older tmux. */
  activityEpochSec?: number;
  /** `#{session_attached}` > 0 — a client is looking at it. */
  attached?: boolean;
}

export interface SweepKill {
  session: string;
  ageMs: number;
  dryRun: boolean;
  at: string;
}

export interface SweepResult {
  /** Sessions actually killed. Never incremented in dry-run. */
  killed: number;
  /** Sessions that WOULD have been killed. Incremented only in dry-run. */
  wouldKill: number;
  kept: number;
  errors: number;
  /** True when the pass ended without acting because the session list could not be read. */
  failedClosed: boolean;
  /** True when a P19 brake stopped this pass before it looked at anything. */
  breakerOpen: boolean;
  /** Kills that failed because the session was ALREADY gone (a sibling got it) — not errors. */
  alreadyGone: number;
  kills: SweepKill[];
  /** Per-name reasons a candidate was kept — the audit answer to "why is this still here?". */
  keptReasons: Record<string, number>;
}

export interface CodexArmSessionSweeperDeps {
  /** Lists every tmux session on this machine. MUST throw rather than return a partial list. */
  listSessions: () => TmuxSessionRow[];
  killSession: (name: string) => void;
  /** Three-state probe used only after a failed kill: present / absent / unknown. */
  hasSession?: (name: string) => SessionProbe;
  /**
   * Live read of `monitoring.codexArmSessionSweeper.dryRun` at each pass, so the operator's
   * one arming action (`dryRun: false`) takes effect WITHOUT a restart. `undefined` = keep
   * the boot value. (Integration review: a boot-snapshot flag with no pending signal.)
   */
  liveDryRun?: () => boolean | undefined;
  /**
   * Names the sweeper must never touch, read live from config (`sessions.protectedSessions`
   * + `sessions.standingSessions`). Invariant 5: unreachable through the prefix+corroboration
   * matcher today, asserted as code so a future widening cannot silently cross the line.
   */
  protectedNames?: () => string[];
  /** Injected for determinism in tests. */
  now?: () => number;
  /** One line per kill decision; never throws into the pass. */
  audit?: (entry: SweepKill) => void;
  log?: (msg: string) => void;
}

/** Default lister: `tmux ls -F '#{session_name} #{session_created}'`. */
export function makeTmuxSessionLister(tmuxPath: string): () => TmuxSessionRow[] {
  return () => {
    // Funnelled through withSyncOp so the CROSS-PROCESS in-flight marker (the lifeline's
    // ServerSupervisor reads the mirror file during the block) attributes this wait to a
    // sync op rather than an unresponsive server. The in-process SleepWakeDetector can only
    // tick after the pass returns, so the marker does not protect it — which is why the pass
    // is also bounded by maxPassMs + short timeouts (~8 s worst case), not by the marker.
    //
    // NOTE on error handling: this deliberately does NOT classify the failure. The
    // obvious shortcut is to match tmux's "no server running" message and return []
    // (there are provably no sessions), but that means a genuine failure whose text
    // happens to match is silently read as "nothing to sweep" — a swallowed error in
    // the one component whose job is to notice accumulation. Any throw propagates and
    // the caller fails closed with zero kills. The cost of being strict here is nil:
    // when there is no tmux server there is nothing to sweep anyway.
    const out = withSyncOp(() => execFileSync(tmuxPath, ['ls', '-F', '#{session_name} #{session_created} #{session_activity} #{session_attached}'], {
      encoding: 'utf-8',
      timeout: LIST_TIMEOUT_MS,
    }));
    return parseTmuxSessionRows(out);
  };
}

/**
 * Pure parse of `tmux ls -F '#{session_name} #{session_created} #{session_activity} #{session_attached}'`
 * (the two-field `name created` form from older callers is also accepted).
 *
 * Fields are taken from the RIGHT, not the left: a tmux session name may legitimately
 * contain spaces, and splitting from the left would mis-read `my build 1761…` as the
 * session `my` — which would then fail the arm-prefix test and be silently ignored. A row
 * whose created field is not a finite number is dropped rather than guessed at, because a
 * row we cannot date is a row we must not age out.
 */
export function parseTmuxSessionRows(out: string): TmuxSessionRow[] {
  const rows: TmuxSessionRow[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(' ');
    if (parts.length < 2) continue;
    // Trailing numeric fields are ours; everything before them is the name.
    const tail: number[] = [];
    while (parts.length > 1 && tail.length < 3 && /^\d+$/.test(parts[parts.length - 1])) {
      tail.unshift(Number(parts.pop()));
    }
    if (tail.length === 0) continue;
    const name = parts.join(' ');
    if (!name) continue;
    const [created, activity, attached] = tail.length === 3 ? tail : tail.length === 2 ? [tail[0], tail[1], undefined] : [tail[0], undefined, undefined];
    if (!Number.isFinite(created)) continue;
    rows.push({
      name,
      createdEpochSec: created,
      ...(activity !== undefined ? { activityEpochSec: activity } : {}),
      ...(attached !== undefined ? { attached: attached > 0 } : {}),
    });
  }
  return rows;
}

export function makeTmuxSessionKiller(tmuxPath: string): (name: string) => void {
  return (name: string) => {
    // `=name` — EXACT target. Without `=`, tmux resolves `-t` by prefix/fnmatch and could
    // kill a longer-named sibling (confirmed on tmux 3.7c). Exact refuses with no exact match.
    withSyncOp(() => execFileSync(tmuxPath, ['kill-session', '-t', `=${name}`], { encoding: 'utf-8', timeout: KILL_TIMEOUT_MS }));
  };
}

export type SessionProbe = 'present' | 'absent' | 'unknown';

/**
 * `tmux has-session -t =name` → present / absent / UNKNOWN. Used only on a kill's failure
 * path to tell "already gone" (a sibling sweeper or the self-destruct got there first —
 * expected on a shared host) from a genuine failure.
 *
 * Three states, not two (cross-model review): `absent` ONLY when tmux itself ran and exited
 * non-zero with no signal and no spawn error. A timeout, a missing binary or a dead socket is
 * `unknown`, and unknown is counted as an ERROR by the sweeper — never as a successful
 * cleanup. (An earlier draft returned false for every throw, so an unreadable probe would
 * have cleared the retry count and suppressed the error.)
 */
export function makeTmuxSessionProbe(tmuxPath: string): (name: string) => SessionProbe {
  return (name: string) => {
    try {
      withSyncOp(() => execFileSync(tmuxPath, ['has-session', '-t', `=${name}`], { encoding: 'utf-8', timeout: KILL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }));
      return 'present';
    } catch (err) {
      const e = err as { status?: number | null; signal?: string | null; code?: string };
      const ranAndExited = typeof e.status === 'number' && !e.signal && !e.code;
      return ranAndExited ? 'absent' : 'unknown';
    }
  };
}

/** Invariant 1: the prefix match is anchored and includes the trailing hyphen. */
export function isArmSessionName(name: string): boolean {
  return name.startsWith(ARM_SESSION_PREFIX);
}

export type ArmCorroboration =
  | 'corroborated'
  | 'not-an-arm-name'
  | 'name-shape-mismatch'
  | 'timestamp-mismatch';

/**
 * Verify the STATE, not its symbol.
 *
 * The prefix alone is a symbol: anyone can type it. What makes this session provably
 * one of `makeTmuxTrustDriver`'s is that the name CARRIES ITS OWN BIRTH TIME —
 * `instar-codex-arm-${Date.now().toString(36)}` — and tmux SEPARATELY records when the
 * session was created. Two independent records of the same instant agreeing is
 * corroboration; a prefix is not.
 *
 * A hand-made `instar-codex-arm-scratch` fails the shape check. A hand-made
 * `instar-codex-arm-zzzzzzz` passes the shape check and fails the time check, because
 * encoding your own creation millisecond into your own name is precisely the thing only
 * the driver does. Anything that does not corroborate is KEPT.
 */
export function armSessionCorroboration(name: string, createdEpochSec: number): ArmCorroboration {
  if (!isArmSessionName(name)) return 'not-an-arm-name';
  const suffix = name.slice(ARM_SESSION_PREFIX.length);
  if (!ARM_SUFFIX.test(suffix)) return 'name-shape-mismatch';
  const mintedMs = parseInt(suffix, 36);
  if (!Number.isFinite(mintedMs)) return 'name-shape-mismatch';
  const createdMs = createdEpochSec * 1000;
  if (Math.abs(mintedMs - createdMs) > NAME_TIME_TOLERANCE_MS) return 'timestamp-mismatch';
  return 'corroborated';
}

export class CodexArmSessionSweeper extends EventEmitter {
  private readonly cfg: CodexArmSessionSweeperConfig;
  private readonly deps: CodexArmSessionSweeperDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeping = false;

  private passes = 0;
  private killedTotal = 0;
  private wouldKillTotal = 0;
  private alreadyGoneTotal = 0;
  /** Every name EVER seen as would-kill — dedupes the dry-run audit (one line per name per lifetime). */
  private readonly wouldKillNames = new Set<string>();
  /** Names seen as would-kill in the LATEST readable pass — the honest CURRENT backlog. */
  private wouldKillCurrent = new Set<string>();
  private keptTotal = 0;
  private lastKillsAt: string | null = null;
  private errorsTotal = 0;
  private lastPassAt: string | null = null;
  private lastKills: SweepKill[] = [];
  private consecutiveListFailures = 0;
  private breakerOpen = false;
  private passesSinceBreakerOpened = 0;
  private breakerProbes = 0;
  private readonly killFailures = new Map<string, number>();
  private keptReasonTotals: Record<string, number> = {};

  constructor(cfg: Partial<CodexArmSessionSweeperConfig>, deps: CodexArmSessionSweeperDeps) {
    super();
    // mergeDefaults, not a spread: a config key present-but-undefined must not
    // erase the shipped default (lint-no-undefined-erasing-default-merge).
    this.cfg = mergeDefaults(DEFAULT_CODEX_ARM_SESSION_SWEEPER_CONFIG, cfg);
    // Invariant 2: the age floor is enforced here, not trusted from config.
    this.cfg.maxAgeMs = Math.max(MIN_MAX_AGE_MS, Number(this.cfg.maxAgeMs) || 0);
    // A repeating timer whose period comes from JSON: `null`, a string, or NaN would
    // make setInterval spin at 1 ms doing a synchronous `tmux ls` (the 2026-09-21
    // ContextWedgeSentinel incident). resolveTimerMs is the repo's answer to that.
    const d = DEFAULT_CODEX_ARM_SESSION_SWEEPER_CONFIG;
    this.cfg.sweepIntervalMs = resolveTimerMs(this.cfg.sweepIntervalMs, d.sweepIntervalMs, 60_000);
    this.cfg.initialPassDelayMs = resolveTimerMs(this.cfg.initialPassDelayMs, d.initialPassDelayMs, 0);
    this.cfg.maxKillsPerPass = Math.max(1, Number(this.cfg.maxKillsPerPass) || d.maxKillsPerPass);
    this.cfg.maxPassMs = resolveTimerMs(this.cfg.maxPassMs, d.maxPassMs, 500);
    this.cfg.breakerProbeEveryPasses = Math.max(1, Number(this.cfg.breakerProbeEveryPasses) || d.breakerProbeEveryPasses);

    this.deps = deps;
  }

  start(): void {
    if (!this.cfg.enabled || this.timer) return;
    // A throw escaping a setInterval callback is an uncaughtException that takes the
    // server down; a sweep must never be able to do that.
    const guarded = (): void => {
      try { this.sweep(); } catch (err) {
        // @silent-fallback-ok — NOT a swallow: the throw is counted in `errorsTotal` (served on
        // GET /codex-arm-sweeper, so a repeatedly-throwing sweep is visible) and logged with its
        // message. Rethrowing is the thing that must not happen: an escaping setInterval throw is
        // an uncaughtException that takes the whole server down, which is a far worse outcome than
        // a missed sweep of a watch-only reporter.
        this.errorsTotal += 1;
        this.deps.log?.(`[codex-arm-sweeper] pass threw: ${(err as Error)?.message ?? err}`);
      }
    };
    this.timer = setInterval(guarded, this.cfg.sweepIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    if (this.cfg.initialPassDelayMs > 0) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = null;
        guarded();
      }, this.cfg.initialPassDelayMs);
      if (typeof this.initialTimer.unref === 'function') this.initialTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
  }

  /** One pass. Safe to call directly (the route and the tests both do). */
  sweep(): SweepResult {
    const blank = (): SweepResult => ({
      killed: 0, wouldKill: 0, kept: 0, errors: 0, failedClosed: false, breakerOpen: false, alreadyGone: 0, kills: [], keptReasons: {},
    });
    if (!this.cfg.enabled || this.sweeping) return blank();
    if (this.breakerOpen) {
      // Half-open: let one probe through every breakerProbeEveryPasses passes.
      this.passesSinceBreakerOpened += 1;
      if (this.passesSinceBreakerOpened % Math.max(1, this.cfg.breakerProbeEveryPasses) !== 0) {
        const r = blank();
        r.breakerOpen = true;
        return r;
      }
      this.breakerProbes += 1;
      this.deps.log?.(`[codex-arm-sweeper] breaker probe #${this.breakerProbes} — trying the session list again`);
    }
    this.sweeping = true;
    try {
      const live = this.deps.liveDryRun?.();
      if (typeof live === 'boolean') this.cfg.dryRun = live;
    } catch { /* @silent-fallback-ok: an unreadable config keeps the current posture */ }
    const rawNow = (this.deps.now ?? Date.now)();
    // A non-finite clock would make `new Date(now).toISOString()` throw mid-pass.
    const now = Number.isFinite(rawNow) ? rawNow : Date.now();
    const result = blank();
    let attempted = 0; // Invariant 6 bounds ATTEMPTS, not successes — a pass of failing kills is still bounded.
    let protectedNames: Set<string>;
    try {
      protectedNames = new Set(this.deps.protectedNames?.() ?? []);
    } catch (err) {
      // Invariant 5 must not fail OPEN: if we cannot read which names are protected we do
      // not know what we may kill, so this pass kills nothing (cross-model review).
      result.errors += 1;
      result.failedClosed = true;
      this.errorsTotal += 1;
      // Charged to the same brake as a list failure, so a persistently unreadable config
      // opens the breaker instead of failing closed every pass forever.
      this.consecutiveListFailures += 1;
      if (this.consecutiveListFailures >= this.cfg.maxConsecutiveListFailures) { this.breakerOpen = true; this.passesSinceBreakerOpened = 0; result.breakerOpen = true; }
      this.sweeping = false;
      this.passes += 1;
      this.lastPassAt = new Date(now).toISOString();
      this.deps.log?.(`[codex-arm-sweeper] protected-name lookup failed, no kills this pass: ${(err as Error)?.message ?? err}`);
      return result;
    }
    const passStartedAt = Date.now();
    const passWouldKill = new Set<string>();
    const keep = (reason: string): void => {
      result.kept += 1;
      this.keptTotal += 1;
      result.keptReasons[reason] = (result.keptReasons[reason] ?? 0) + 1;
      this.keptReasonTotals[reason] = (this.keptReasonTotals[reason] ?? 0) + 1;
    };
    try {
      let rows: TmuxSessionRow[];
      try {
        rows = this.deps.listSessions();
        this.consecutiveListFailures = 0;
        if (this.breakerOpen) {
          this.breakerOpen = false;
          this.passesSinceBreakerOpened = 0;
          this.deps.log?.('[codex-arm-sweeper] breaker CLOSED — session list readable again');
        }
      } catch (err) {
        // Invariant 4: an unreadable list ends the pass with ZERO kills.
        result.errors += 1;
        result.failedClosed = true;
        this.errorsTotal += 1;
        this.consecutiveListFailures += 1;
        if (this.consecutiveListFailures >= this.cfg.maxConsecutiveListFailures) {
          // P19: stop re-probing a permanently broken tmux. Visible on getStatus().
          this.breakerOpen = true;
          this.passesSinceBreakerOpened = 0;
          result.breakerOpen = true;
          this.deps.log?.(`[codex-arm-sweeper] breaker OPEN after ${this.consecutiveListFailures} unreadable passes — one probe every ${this.cfg.breakerProbeEveryPasses} passes until the list reads again`);
        }
        this.deps.log?.(`[codex-arm-sweeper] session list unreadable, no kills this pass: ${(err as Error)?.message ?? err}`);
        return result;
      }

      for (const row of rows) {
        const verdict = armSessionCorroboration(row.name, row.createdEpochSec);
        if (verdict === 'not-an-arm-name') continue; // Invariant 1 — not even a candidate
        if (verdict !== 'corroborated') { keep(verdict); continue; } // the symbol is not the state
        const ageMs = now - row.createdEpochSec * 1000;
        // Invariant 3: a future-dated session (clock skew) is kept, never treated as ancient.
        if (!(ageMs > this.cfg.maxAgeMs)) { keep('within-age-threshold'); continue; }
        // Invariant 9: a session someone is LOOKING at is never an orphan, whatever its age.
        // (An earlier draft also kept sessions with recent `#{session_activity}`; measured on
        // tmux 3.7c, that field moves only on an ATTACHED client's input — never on the
        // detached, send-keys-driven arm it was meant to protect — so it was withdrawn
        // rather than left as dead reassurance. The 300 s floor is the live-arm protection.)
        if (row.attached) { keep('attached'); continue; }
        // P19: a session we have repeatedly failed to kill is not retried forever.
        if ((this.killFailures.get(row.name) ?? 0) >= this.cfg.maxKillFailuresPerSession) {
          keep('kill-failures-exhausted');
          continue;
        }
        // Invariant 5: a protected or standing name is never touched, even though the
        // matcher above cannot reach one today — asserted so a future widening cannot.
        if (protectedNames.has(row.name)) { keep('protected-or-standing'); continue; }
        // Invariant 6: bounded per pass — counted on LIVE kill attempts (incl. failures).
        // Dry-run observation is exempt: it costs a Set insert, no subprocess, and capping
        // it would let the first 50 of a standing backlog hide every later candidate from
        // the report forever (cross-model review).
        if (!this.cfg.dryRun) {
          if (attempted >= this.cfg.maxKillsPerPass) { keep('per-pass-cap'); continue; }
          // Wall-clock budget: the kill path is synchronous on the event loop, so a pass may
          // not keep issuing kills once it has already spent its budget (timeouts included).
          if (Date.now() - passStartedAt > this.cfg.maxPassMs) { keep('pass-time-budget'); continue; }
          attempted += 1;
        }

        const entry: SweepKill = {
          session: row.name,
          ageMs,
          dryRun: this.cfg.dryRun,
          at: new Date(now).toISOString(),
        };
        if (this.cfg.dryRun) {
          // Dry-run books `wouldKill`, never `killed` — a flag flipped mid-life must not
          // leave a status that says 41 sessions died when none did.
          result.wouldKill += 1;
          this.wouldKillTotal += 1;
          const firstSighting = !this.wouldKillNames.has(row.name);
          this.wouldKillNames.add(row.name);
          passWouldKill.add(row.name);
          result.kills.push(entry);
          // Audit a dry-run name ONCE per process lifetime: a standing backlog of 41 would
          // otherwise write ~5.9k identical lines a day.
          if (firstSighting) { try { this.deps.audit?.(entry); } catch { /* @silent-fallback-ok: audit must never fail a sweep */ } }
          continue;
        }
        try {
          this.deps.killSession(row.name);
          this.killFailures.delete(row.name);
          result.killed += 1;
          this.killedTotal += 1;
          result.kills.push(entry);
          try { this.deps.audit?.(entry); } catch { /* @silent-fallback-ok: audit must never fail a sweep */ }
          this.emit('killed', entry);
        } catch (err) {
          // On a shared host two sweepers (or the self-destruct) can race for one orphan;
          // the loser's exact-target kill fails. That is not an error — probe by exit code.
          let probe: SessionProbe = 'unknown';
          try { probe = this.deps.hasSession ? this.deps.hasSession(row.name) : 'unknown'; } catch { probe = 'unknown'; }
          if (probe === 'absent') {
            result.alreadyGone += 1;
            this.alreadyGoneTotal += 1;
            this.killFailures.delete(row.name);
            continue;
          }
          result.errors += 1;
          this.errorsTotal += 1;
          this.killFailures.set(row.name, (this.killFailures.get(row.name) ?? 0) + 1);
          this.deps.log?.(`[codex-arm-sweeper] kill failed for ${row.name}: ${(err as Error)?.message ?? err}`);
        }
      }
      // killFailures must not grow without bound: forget names no longer present.
      const present = new Set(rows.map((r) => r.name));
      for (const name of [...this.killFailures.keys()]) if (!present.has(name)) this.killFailures.delete(name);
      this.wouldKillCurrent = passWouldKill; // a sibling clearing a backlog is reflected next pass
      return result;
    } finally {
      this.sweeping = false;
      this.passes += 1;
      this.lastPassAt = new Date(now).toISOString();
      if (result.kills.length) {
        this.lastKills = result.kills.slice(-20);
        this.lastKillsAt = new Date(now).toISOString();
      }
    }
  }

  getStatus(): {
    enabled: boolean;
    dryRun: boolean;
    maxAgeMs: number;
    sweepIntervalMs: number;
    maxKillsPerPass: number;
    passes: number;
    killed: number;
    /** Pass-cumulative would-kill count (the same orphan is re-counted every pass). */
    wouldKill: number;
    /** DISTINCT session names seen as would-kill in the LATEST readable pass — read THIS for the backlog. */
    wouldKillDistinct: number;
    /** Kills that found the session already gone (a sibling got it) — expected on a shared host. */
    alreadyGone: number;
    kept: number;
    errors: number;
    lastPassAt: string | null;
    /** Epoch ms of the last pass — the guard registry's staleness input. */
    lastTickAt: number;
    lastKills: SweepKill[];
    lastKillsAt: string | null;
    breakerOpen: boolean;
    consecutiveListFailures: number;
    breakerProbes: number;
    keptReasons: Record<string, number>;
  } {
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      maxAgeMs: this.cfg.maxAgeMs,
      sweepIntervalMs: this.cfg.sweepIntervalMs,
      maxKillsPerPass: this.cfg.maxKillsPerPass,
      passes: this.passes,
      killed: this.killedTotal,
      wouldKill: this.wouldKillTotal,
      wouldKillDistinct: this.wouldKillCurrent.size,
      alreadyGone: this.alreadyGoneTotal,
      kept: this.keptTotal,
      errors: this.errorsTotal,
      lastPassAt: this.lastPassAt,
      lastTickAt: this.lastPassAt ? Date.parse(this.lastPassAt) : 0,
      lastKills: this.lastKills,
      lastKillsAt: this.lastKillsAt,
      breakerOpen: this.breakerOpen,
      consecutiveListFailures: this.consecutiveListFailures,
      breakerProbes: this.breakerProbes,
      keptReasons: { ...this.keptReasonTotals },
    };
  }
}
