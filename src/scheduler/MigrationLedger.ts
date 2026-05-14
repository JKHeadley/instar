/**
 * MigrationLedger — append-only telemetry writer for migration runs.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Seamless Migration Guarantee invariant 8:
 *
 *   Every migrator run emits exactly one `migration.completed` or
 *   `migration.aborted` event to `.instar/ledger/job-runs.jsonl` with
 *   start/end timestamps, per-entry outcomes (`migrated | forked |
 *   renamed | skipped | failed | deferred-in-flight`), backup file path,
 *   lock-file `instarVersion`, and trigger (`post-update | cli |
 *   dashboard`). Telemetry write is the LAST action of a successful
 *   migration. Presence of a `migration.completed` row with matching
 *   `instarVersion` is the canonical signal that migration finished for
 *   this update.
 *
 * The event coexists in `job-runs.jsonl` alongside regular JobRun rows;
 * readers discriminate via the `kind` field (absent on JobRun, present
 * with `migration.*` value on migration events).
 */

import fs from 'node:fs';
import path from 'node:path';

export type MigrationEventKind = 'migration.completed' | 'migration.aborted';

export type MigrationTrigger = 'post-update' | 'cli' | 'dashboard';

export type MigrationPerEntryAction =
  | 'migrated'
  | 'forked'
  | 'renamed'
  | 'skipped'
  | 'failed'
  | 'deferred-in-flight';

export interface MigrationEvent {
  /** Discriminator. Present on every migration event row. Absent on JobRun rows. */
  kind: MigrationEventKind;
  /** UUID-style run id. */
  runId: string;
  /** ISO 8601 when the migrator started. */
  startedAt: string;
  /** ISO 8601 when the migrator finished (or aborted). */
  completedAt: string;
  /** What triggered the run. */
  trigger: MigrationTrigger;
  /** Per-entry routing summary. The action mirrors jobsMigrate's
   *  perEntry.action, normalized to the spec's outcome vocabulary. */
  perEntry: Array<{ slug: string; action: MigrationPerEntryAction; reason?: string }>;
  /** Path to the pre-migrate backup of jobs.json. Present on completed runs. */
  backupPath?: string;
  /** instarVersion read from the bundled lock-file at migration time (when
   *  present). Absent in the transitional state where no lock-file ships. */
  instarVersion?: string;
  /** Reason for abort. Present on `migration.aborted` events. */
  abortReason?: string;
}

/**
 * Append a single migration event to `.instar/ledger/job-runs.jsonl`.
 *
 * The append is a best-effort write — failures are surfaced via the
 * returned `ok` flag rather than thrown. The caller's behavior on
 * failure is deliberately a no-op: missing telemetry is a degradation,
 * not a release-blocker.
 */
export function appendMigrationEvent(stateDir: string, event: MigrationEvent): { ok: true } | { ok: false; reason: string } {
  const ledgerDir = path.join(stateDir, 'ledger');
  const ledgerFile = path.join(ledgerDir, 'job-runs.jsonl');
  try {
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.appendFileSync(ledgerFile, JSON.stringify(event) + '\n', 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read every migration event row from `.instar/ledger/job-runs.jsonl`.
 *
 * Filters out non-`migration.*` rows (regular JobRun records). Malformed
 * lines are silently skipped to match the existing JobRunHistory.readLines
 * convention.
 */
export function readMigrationEvents(stateDir: string): MigrationEvent[] {
  const ledgerFile = path.join(stateDir, 'ledger', 'job-runs.jsonl');
  if (!fs.existsSync(ledgerFile)) return [];
  let content: string;
  try {
    content = fs.readFileSync(ledgerFile, 'utf-8').trim();
  } catch {
    return [];
  }
  if (!content) return [];
  const events: MigrationEvent[] = [];
  for (const line of content.split('\n')) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string' && parsed.kind.startsWith('migration.')) {
        events.push(parsed as MigrationEvent);
      }
    } catch {
      // Skip malformed line (consistent with readLines convention).
    }
  }
  return events;
}

/**
 * Return the latest `migration.completed` event whose `instarVersion`
 * matches the given version, or null when no such event exists. Used by
 * the release-cut gate to confirm migration completed for THIS release
 * before allowing `jobs.json` deletion.
 */
export function findCompletedFor(stateDir: string, instarVersion: string): MigrationEvent | null {
  const events = readMigrationEvents(stateDir);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'migration.completed' && e.instarVersion === instarVersion) return e;
  }
  return null;
}

/**
 * Normalize a `jobsMigrate.MigrationOutcome.perEntry` action to the spec's
 * canonical outcome vocabulary. The CLI/auto-runner uses richer action
 * names; the telemetry rolls them up.
 */
export function normalizePerEntryAction(action: string): MigrationPerEntryAction {
  switch (action) {
    case 'migrated-instar':
      return 'migrated';
    case 'forked-user':
    case 'kept-user':
      return 'forked';
    case 'renamed-user':
      return 'renamed';
    case 'failed':
      return 'failed';
    case 'deferred-in-flight':
      return 'deferred-in-flight';
    case 'skipped':
    default:
      return 'skipped';
  }
}
