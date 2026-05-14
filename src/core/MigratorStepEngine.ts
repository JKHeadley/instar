/**
 * MigratorStepEngine — atomic-step primitive for post-update migrations.
 *
 * Implements F-7 of `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`
 * (§R1 Upgrade invariants + §A35 + §A50 + §A57 Tier-2). Provides:
 *
 *   1. `MigratorStepEngine` — registers named, idempotent, run-once-per-
 *      version atomic steps that fire at release boundaries. Each step is
 *      self-contained; one step failing does NOT roll back prior steps or
 *      prevent subsequent steps from running. Persisted state lives at
 *      `<stateDir>/migrator-steps-completed.json` keyed by
 *      `<version>:<step-name>`.
 *
 *   2. `AnnouncementManager` — `announceOnce` primitive for "show this
 *      message to the user exactly once and then never again". Used for
 *      surfacing migration completions, structural changes, or any other
 *      one-shot user-facing notice. Persisted state lives at
 *      `<stateDir>/announcements-shown.json` keyed by announcementId.
 *
 * Design notes:
 *
 *   - Atomic: each step records outcome (completed | skipped | failed)
 *     atomically (temp-file → fsync → rename). A crash mid-step leaves
 *     the ledger consistent — either the step is recorded or it isn't,
 *     never partial.
 *
 *   - Version-gated: a step `version: "1.2.3"` runs only when the engine
 *     is invoked with `toVersion >= "1.2.3"` (semver compare). Steps for
 *     versions strictly newer than `toVersion` are skipped without being
 *     recorded — they will run on the next update boundary that catches
 *     up to them.
 *
 *   - Once-per-version-step pair: a successful step is recorded with key
 *     `<version>:<step-name>`. Re-runs of `runPendingSteps()` short-circuit
 *     on that key. A FAILED step IS also recorded (with outcome `failed`)
 *     so the same broken step doesn't re-run unbounded on every update —
 *     operators see the failure in the report and decide whether to retry.
 *
 *   - No rollback. Each step must be self-contained and atomic on its
 *     own. The spec deliberately rejects step ordering / dependency /
 *     rollback semantics — those couplings are what made v1's migrator
 *     unmaintainable.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Public types ─────────────────────────────────────────────────────

export interface MigratorContext {
  /** State directory (typically `<projectDir>/.instar`). */
  stateDir: string;
  /** Previous version on disk (may be empty on first install). */
  fromVersion: string;
  /** Version we're upgrading to. */
  toVersion: string;
  /** Per-run logger — step writes diagnostics here. */
  logger: (msg: string) => void;
}

export interface MigratorStepRunResult {
  outcome: 'completed' | 'skipped' | 'failed';
  details?: string;
}

export interface MigratorStep {
  /** Globally unique step name. */
  name: string;
  /**
   * Semver version this step runs on/after. The step runs when invoked
   * with `toVersion >= step.version`. Use the version in which the step
   * was introduced.
   */
  version: string;
  /** Idempotent worker. Must NOT throw — return `{ outcome: 'failed' }` on error. */
  run: (ctx: MigratorContext) => Promise<MigratorStepRunResult>;
}

export interface RunPendingStepsResult {
  steps: Array<{ name: string; outcome: string; details?: string }>;
}

// ── Internal types ───────────────────────────────────────────────────

interface StepLedgerEntry {
  outcome: 'completed' | 'skipped' | 'failed';
  details?: string;
  /** ISO timestamp at which the step was recorded. */
  recordedAt: string;
}

type StepLedger = Record<string, StepLedgerEntry>;

// ── Semver comparison (minimal, sufficient for this engine) ─────────

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(v: string): [number, number, number, string] | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m[4] ?? ''];
}

/**
 * Compare two semver strings. Returns -1 / 0 / 1. Pre-release strings are
 * compared lexically when major.minor.patch match (good-enough for our
 * "run on version >= X" usage). Unparseable inputs sort as -Infinity so
 * a malformed `fromVersion` never blocks step execution.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if ((pa[i] as number) > (pb[i] as number)) return 1;
  }
  // major.minor.patch equal — compare pre-release. Absent pre-release
  // outranks any pre-release (e.g. 1.0.0 > 1.0.0-rc1).
  const preA = pa[3] as string;
  const preB = pb[3] as string;
  if (preA === '' && preB === '') return 0;
  if (preA === '') return 1;
  if (preB === '') return -1;
  if (preA < preB) return -1;
  if (preA > preB) return 1;
  return 0;
}

// ── MigratorStepEngine ───────────────────────────────────────────────

export class MigratorStepEngine {
  private readonly stateDir: string;
  private readonly steps: MigratorStep[] = [];
  /** Path to the step-completion ledger. */
  private readonly ledgerPath: string;

  constructor(stateDir: string) {
    this.stateDir = path.resolve(stateDir);
    this.ledgerPath = path.join(this.stateDir, 'migrator-steps-completed.json');
  }

  /**
   * Register an atomic step. Steps run in registration order on each
   * invocation of `runPendingSteps()`, subject to the version gate and
   * the per-version-per-step idempotency guard.
   *
   * Duplicate `name` values are rejected at registration time — names
   * are global identifiers in the ledger.
   */
  registerStep(step: MigratorStep): void {
    if (!step.name || typeof step.name !== 'string') {
      throw new Error('MigratorStepEngine.registerStep: step.name is required');
    }
    if (!step.version || typeof step.version !== 'string') {
      throw new Error(`MigratorStepEngine.registerStep: step.version is required (step=${step.name})`);
    }
    if (typeof step.run !== 'function') {
      throw new Error(`MigratorStepEngine.registerStep: step.run must be a function (step=${step.name})`);
    }
    for (const existing of this.steps) {
      if (existing.name === step.name) {
        throw new Error(`MigratorStepEngine.registerStep: duplicate step name "${step.name}"`);
      }
    }
    this.steps.push(step);
  }

  /**
   * Run every pending step. A step is "pending" when:
   *   - its `version <= toVersion` (semver compare), AND
   *   - no ledger entry exists for `<version>:<name>`.
   *
   * Steps for versions strictly newer than `toVersion` are reported as
   * `skipped` (with details: `future-version`) but NOT recorded — they
   * will run on a later update boundary that crosses their threshold.
   *
   * Steps whose ledger entry already exists are reported as `skipped`
   * (with details: `already-recorded:<previous-outcome>`).
   *
   * Each step is executed under a try/catch; thrown errors are converted
   * to `outcome: 'failed'` and recorded. The engine never propagates
   * step failures to the caller — one broken step cannot block subsequent
   * steps.
   */
  async runPendingSteps(fromVersion: string, toVersion: string): Promise<RunPendingStepsResult> {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
    const ledger = this.readLedger();
    const report: RunPendingStepsResult = { steps: [] };

    for (const step of this.steps) {
      const key = `${step.version}:${step.name}`;

      // Already recorded — skip.
      if (ledger[key]) {
        report.steps.push({
          name: step.name,
          outcome: 'skipped',
          details: `already-recorded:${ledger[key].outcome}`,
        });
        continue;
      }

      // Future-version — skip without recording.
      if (compareSemver(step.version, toVersion) > 0) {
        report.steps.push({
          name: step.name,
          outcome: 'skipped',
          details: `future-version:${step.version} > ${toVersion}`,
        });
        continue;
      }

      // Execute.
      const ctx: MigratorContext = {
        stateDir: this.stateDir,
        fromVersion,
        toVersion,
        logger: (_msg: string) => {
          /* default no-op; callers wire a real logger via wrapping */
        },
      };

      let result: MigratorStepRunResult;
      try {
        result = await step.run(ctx);
        if (!result || typeof result.outcome !== 'string') {
          result = { outcome: 'failed', details: 'step returned malformed result' };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { outcome: 'failed', details: `threw: ${msg}` };
      }

      // Record outcome (including failures — see class docstring).
      ledger[key] = {
        outcome: result.outcome,
        details: result.details,
        recordedAt: new Date().toISOString(),
      };
      this.writeLedger(ledger);

      report.steps.push({
        name: step.name,
        outcome: result.outcome,
        details: result.details,
      });
    }

    return report;
  }

  /**
   * Look up whether `<version>:<name>` is recorded. Returns the ledger
   * entry or `undefined`. Intended for callers that want to render a
   * migration report.
   */
  getRecorded(version: string, name: string): StepLedgerEntry | undefined {
    const ledger = this.readLedger();
    return ledger[`${version}:${name}`];
  }

  // ── Ledger I/O ─────────────────────────────────────────────────────

  private readLedger(): StepLedger {
    try {
      if (!fs.existsSync(this.ledgerPath)) return {};
      const raw = fs.readFileSync(this.ledgerPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as StepLedger;
      }
      return {};
    } catch {
      // Corrupt ledger — treat as empty rather than blocking. The crash
      // recovery path is: subsequent run records its results into a
      // fresh ledger. Lost history of past runs is acceptable; blocked
      // upgrades are not.
      return {};
    }
  }

  private writeLedger(ledger: StepLedger): void {
    const tmpPath = `${this.ledgerPath}.tmp-${process.pid}-${Date.now()}`;
    const serialized = JSON.stringify(ledger, null, 2) + '\n';
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.ledgerPath);
  }
}

// ── AnnouncementManager ──────────────────────────────────────────────

export type AnnouncementChannel = 'telegram' | 'dashboard' | 'log';

export interface AnnouncementSink {
  (announcementId: string, message: string, channel: AnnouncementChannel): void | Promise<void>;
}

interface AnnouncementLedgerEntry {
  channel: AnnouncementChannel;
  shownAt: string;
}

type AnnouncementLedger = Record<string, AnnouncementLedgerEntry>;

/**
 * AnnouncementManager — "show this message to the user once, then never
 * again" primitive. Used for one-shot migration completions, structural-
 * change notices, etc.
 *
 * The default sink writes to stderr with an `[announcement]` prefix.
 * Callers can pass a custom sink (e.g. routed to Telegram or the
 * dashboard's attention queue) via the constructor.
 *
 * Persisted state at `<stateDir>/announcements-shown.json`. The ledger
 * survives across instances and across agent restarts.
 */
export class AnnouncementManager {
  private readonly stateDir: string;
  private readonly ledgerPath: string;
  private readonly sink: AnnouncementSink;

  constructor(stateDir: string, sink?: AnnouncementSink) {
    this.stateDir = path.resolve(stateDir);
    this.ledgerPath = path.join(this.stateDir, 'announcements-shown.json');
    this.sink = sink ?? defaultSink;
  }

  /**
   * Emit the announcement exactly once per `announcementId`.
   *
   * Returns `true` if the announcement was emitted this call; `false`
   * if a prior call (in this process or a previous run) already
   * emitted it.
   *
   * Caller-side idempotency: the ledger is consulted BEFORE the sink
   * is invoked. Repeated calls with the same id are O(1) reads.
   */
  async announceOnce(
    announcementId: string,
    message: string,
    channel: AnnouncementChannel,
  ): Promise<boolean> {
    if (!announcementId || typeof announcementId !== 'string') {
      throw new Error('AnnouncementManager.announceOnce: announcementId is required');
    }
    if (typeof message !== 'string') {
      throw new Error('AnnouncementManager.announceOnce: message must be a string');
    }
    if (channel !== 'telegram' && channel !== 'dashboard' && channel !== 'log') {
      throw new Error(`AnnouncementManager.announceOnce: invalid channel "${channel}"`);
    }

    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }

    const ledger = this.readLedger();
    if (ledger[announcementId]) {
      return false;
    }

    // Record BEFORE emitting so a sink that throws cannot leave us
    // emitting twice on the next call. Worst case: announcement was
    // recorded but the sink failed — operator sees a missed notice
    // once, never a duplicate.
    ledger[announcementId] = {
      channel,
      shownAt: new Date().toISOString(),
    };
    this.writeLedger(ledger);

    try {
      await this.sink(announcementId, message, channel);
    } catch {
      // Swallow — see comment above. The ledger entry stands.
    }
    return true;
  }

  /** Has this announcement been shown? Read-only check. */
  hasBeenShown(announcementId: string): boolean {
    const ledger = this.readLedger();
    return Boolean(ledger[announcementId]);
  }

  private readLedger(): AnnouncementLedger {
    try {
      if (!fs.existsSync(this.ledgerPath)) return {};
      const raw = fs.readFileSync(this.ledgerPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as AnnouncementLedger;
      }
      return {};
    } catch {
      return {};
    }
  }

  private writeLedger(ledger: AnnouncementLedger): void {
    const tmpPath = `${this.ledgerPath}.tmp-${process.pid}-${Date.now()}`;
    const serialized = JSON.stringify(ledger, null, 2) + '\n';
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.ledgerPath);
  }
}

function defaultSink(
  announcementId: string,
  message: string,
  channel: AnnouncementChannel,
): void {
  // Default sink writes to stderr so it never interferes with stdout
  // RPC responses or CLI output capture.
  const line = `[announcement:${channel}] ${announcementId}: ${message}`;
  process.stderr.write(line + '\n');
}
