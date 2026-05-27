/**
 * SessionLivenessOracle — the single, tri-state answer to "is this tmux session
 * alive?" for every autonomous session killer.
 *
 * Spec: docs/specs/unified-session-lifecycle-robustness.md §P1.
 *
 * The 2026-05-27 incident: the boot purge probed `tmux has-session` with a 1s
 * timeout inside a bare try/catch, so a *timeout* (tmux busy at boot) threw the
 * same error as "session gone" — and live sessions were mass-purged. The oracle
 * is the structural fix:
 *
 *   - `dead` is returned ONLY on a definitive negative: the tmux server is
 *     reachable (a `list-sessions` succeeded) AND the session's exact canonical
 *     id is absent from that list. Never inferred from a prefix match, an
 *     unrecognized error string, or an exit code.
 *   - Anything else — timeout, server-unreachable, ENOENT/EPIPE, unknown failure
 *     — is `indeterminate`. The hard rule (enforced by every caller) is: NEVER
 *     transition a session to killed on `indeterminate`. Indeterminate means
 *     "ask again next tick," never "reap now."
 *
 * Performance contract (§P1): liveness for the whole set is resolved from ONE
 * `tmux list-sessions` (no per-session fork), cached for a short TTL so multiple
 * killers in one tick never re-probe. The list call is async (never
 * execFileSync), retried once with backoff, and bounded by a total wall-clock
 * cap so a slow tmux can never block boot — unresolved sessions are left
 * `indeterminate` and finished by the first monitoring tick.
 */

export type Liveness = 'alive' | 'dead' | 'indeterminate';

export interface LivenessResult {
  liveness: Liveness;
  /** Diagnostic reason — for the reap-log / debugging, never user-facing prose. */
  reason: string;
}

export interface SessionLivenessOracleConfig {
  /** Per-attempt timeout for the `list-sessions` probe (ms). Must be > a floor. */
  probeTimeoutMs: number;
  /** Retries (in addition to the first attempt) on a transient/unreachable result. */
  probeRetries: number;
  /** Backoff between retries (ms). */
  probeBackoffMs: number;
  /** Total wall-clock cap across all attempts (ms). On cap → indeterminate. */
  bootCapMs: number;
  /** How long a successful list snapshot is trusted before a refresh (ms). */
  cacheTtlMs: number;
}

export const DEFAULT_LIVENESS_CONFIG: SessionLivenessOracleConfig = {
  probeTimeoutMs: 5000,
  probeRetries: 1,
  probeBackoffMs: 250,
  bootCapMs: 8000,
  cacheTtlMs: 3000,
};

/** Floors enforced at startup validation (a 0ms timeout would re-create the death spiral). */
export const LIVENESS_FLOORS = {
  minProbeTimeoutMs: 1000,
  minBootCapMs: 2000,
} as const;

type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface SessionLivenessOracleDeps {
  tmuxPath: string;
  /** promisified execFile — injected for testability. */
  exec: ExecFn;
  now?: () => number;
  /** Optional sink for diagnostics. */
  log?: (msg: string) => void;
}

/** Outcome of a single `list-sessions` snapshot attempt. */
interface ListSnapshot {
  /** true only if tmux answered authoritatively (success OR a clean "no server"). */
  authoritative: boolean;
  /** Exact session names present (empty set when authoritative + no sessions). */
  names: Set<string>;
  reason: string;
}

/**
 * Validate a liveness config against the floors. Returns an array of human-readable
 * problems (empty = valid). Called at startup so a nonsensical knob is rejected
 * loudly rather than silently re-creating the boot-purge bug.
 */
export function validateLivenessConfig(cfg: Partial<SessionLivenessOracleConfig>): string[] {
  const problems: string[] = [];
  if (cfg.probeTimeoutMs != null && cfg.probeTimeoutMs < LIVENESS_FLOORS.minProbeTimeoutMs) {
    problems.push(
      `liveness.probeTimeoutMs (${cfg.probeTimeoutMs}) is below the floor ${LIVENESS_FLOORS.minProbeTimeoutMs}ms — ` +
        `a too-short probe re-creates the 2026-05-27 false-purge (slow tmux read as dead).`,
    );
  }
  if (cfg.probeRetries != null && cfg.probeRetries < 0) {
    problems.push(`liveness.probeRetries (${cfg.probeRetries}) must be >= 0.`);
  }
  if (cfg.bootCapMs != null && cfg.bootCapMs < LIVENESS_FLOORS.minBootCapMs) {
    problems.push(`liveness.bootCapMs (${cfg.bootCapMs}) is below the floor ${LIVENESS_FLOORS.minBootCapMs}ms.`);
  }
  if (cfg.cacheTtlMs != null && cfg.cacheTtlMs < 0) {
    problems.push(`liveness.cacheTtlMs (${cfg.cacheTtlMs}) must be >= 0.`);
  }
  return problems;
}

export class SessionLivenessOracle {
  private readonly cfg: SessionLivenessOracleConfig;
  private readonly deps: SessionLivenessOracleDeps;
  private readonly now: () => number;
  private snapshot: ListSnapshot | null = null;
  private snapshotAt = 0;
  /** Coalesce concurrent refreshes so N killers in one tick share one tmux call. */
  private inflight: Promise<ListSnapshot> | null = null;

  constructor(deps: SessionLivenessOracleDeps, cfg?: Partial<SessionLivenessOracleConfig>) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_LIVENESS_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Liveness for a single session. Uses the cached list snapshot when fresh,
   * otherwise refreshes (one shared tmux call). Never throws.
   */
  async probe(tmuxSession: string): Promise<LivenessResult> {
    const snap = await this.ensureSnapshot();
    return this.classify(tmuxSession, snap);
  }

  /**
   * Liveness for many sessions resolved from ONE snapshot. This is the boot-purge
   * path: one `tmux list-sessions` for the whole tracked set, no per-session fork.
   */
  async probeAll(tmuxSessions: string[]): Promise<Map<string, LivenessResult>> {
    const snap = await this.ensureSnapshot();
    const out = new Map<string, LivenessResult>();
    for (const name of tmuxSessions) out.set(name, this.classify(name, snap));
    return out;
  }

  /** Force the next probe to re-read tmux (used by tests / after a known change). */
  invalidate(): void {
    this.snapshot = null;
    this.snapshotAt = 0;
  }

  private classify(tmuxSession: string, snap: ListSnapshot): LivenessResult {
    if (!snap.authoritative) {
      // Could not get ground truth — slow/unreachable tmux. NEVER dead.
      return { liveness: 'indeterminate', reason: snap.reason };
    }
    // Authoritative snapshot: exact-id membership is ground truth.
    if (snap.names.has(tmuxSession)) {
      return { liveness: 'alive', reason: 'present-in-list' };
    }
    return { liveness: 'dead', reason: 'absent-from-reachable-server' };
  }

  private async ensureSnapshot(): Promise<ListSnapshot> {
    const fresh = this.snapshot && this.now() - this.snapshotAt < this.cfg.cacheTtlMs;
    if (fresh) return this.snapshot!;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh()
      .then((snap) => {
        // Only cache an authoritative snapshot; a transient failure must not be
        // sticky (else one bad tick freezes liveness for the whole TTL).
        if (snap.authoritative) {
          this.snapshot = snap;
          this.snapshotAt = this.now();
        }
        return snap;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /**
   * One `tmux list-sessions`, retried up to probeRetries on a transient/unreachable
   * result, bounded by bootCapMs total. Returns an authoritative snapshot only when
   * tmux answered definitively (success, or a clean "no server running").
   */
  private async refresh(): Promise<ListSnapshot> {
    const deadline = this.now() + this.cfg.bootCapMs;
    let lastReason = 'no-attempt';
    for (let attempt = 0; attempt <= this.cfg.probeRetries; attempt++) {
      if (attempt > 0) {
        if (this.now() >= deadline) {
          return { authoritative: false, names: new Set(), reason: `boot-cap-exceeded(${lastReason})` };
        }
        await delay(this.cfg.probeBackoffMs);
      }
      const remaining = Math.max(0, deadline - this.now());
      const timeout = Math.min(this.cfg.probeTimeoutMs, remaining || this.cfg.probeTimeoutMs);
      const res = await this.listOnce(timeout);
      if (res.authoritative) return res;
      lastReason = res.reason;
    }
    return { authoritative: false, names: new Set(), reason: lastReason };
  }

  private async listOnce(timeout: number): Promise<ListSnapshot> {
    try {
      const { stdout } = await this.deps.exec(
        this.deps.tmuxPath,
        ['list-sessions', '-F', '#{session_name}'],
        { timeout },
      );
      const names = new Set(
        stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      return { authoritative: true, names, reason: 'list-ok' };
    } catch (err: unknown) {
      // tmux exits non-zero with "no server running on ..." when there is no
      // server at all. That is an AUTHORITATIVE "no sessions exist" — but we
      // treat it conservatively: only classify it authoritative-empty when the
      // message is the recognized no-server string. Any other error (timeout,
      // ENOENT, EPIPE, unknown) is non-authoritative → indeterminate.
      const msg = errText(err);
      if (/no server running/i.test(msg)) {
        return { authoritative: true, names: new Set(), reason: 'no-server-running' };
      }
      if (isTimeout(err)) return { authoritative: false, names: new Set(), reason: 'probe-timeout' };
      return { authoritative: false, names: new Set(), reason: `probe-error:${truncate(msg, 80)}` };
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string };
    return (e.stderr || e.message || String(err)).toString();
  }
  return String(err);
}

function isTimeout(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { killed?: boolean; signal?: string; code?: string };
    // execFile timeout kills the child with SIGTERM and sets killed=true.
    return e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
  }
  return false;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
