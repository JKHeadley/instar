/**
 * MigrationInvariants — runtime verifier for the Seamless Migration Guarantee.
 *
 * Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §Gate wiring (PostUpdateMigrator runtime gate).
 *
 * Re-verifies invariants 1, 2, 4 of §Seamless Migration Guarantee against
 * staged on-disk state AFTER `jobsMigrate` completes but BEFORE the
 * PostUpdateMigrator considers the migration final. Failure produces a
 * structured result the caller uses to roll back via
 * `jobsMigrate({ abandon: true })` (fail-closed, invariant 9).
 *
 * Invariant 6 (in-flight protection) is structurally satisfied at update-
 * apply time because no jobs run mid-update; the migrator runs BEFORE the
 * new scheduler instance comes up. This module's contract does NOT cover
 * invariant 6 — the caller documents that boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface InvariantCheckOptions {
  agentStateDir: string;
  /** The pre-migration jobs.json content as parsed JSON. The caller MUST
   *  read this before invoking `jobsMigrate`, since the migration may
   *  rewrite the file's effective semantics by adding markers, etc. */
  preMigrationJobs: any[];
  /** Optional user-namespace mtime+content snapshot taken BEFORE migration.
   *  When provided, invariant 4 (user namespace untouched) is asserted by
   *  comparing the post-migration state against this snapshot. Absent → the
   *  invariant is marked `skipped` rather than `failed`. */
  preMigrationUserSnapshot?: UserNamespaceSnapshot;
}

export interface UserNamespaceSnapshot {
  /** Map of `<slug>.md` → file content. */
  files: Record<string, string>;
  /** Map of `<slug>.md` → mtimeMs. */
  mtimes: Record<string, number>;
}

export interface InvariantResult {
  invariant: 1 | 2 | 4;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  details?: Record<string, unknown>;
}

export interface VerificationOutcome {
  ok: boolean;
  results: InvariantResult[];
  /** A single human-readable summary suitable for surfacing to the operator. */
  summary: string;
}

/**
 * Capture the current state of `.instar/jobs/user/` for later invariant-4
 * comparison. Cheap — used by the auto-migrate runner.
 */
export function snapshotUserNamespace(agentStateDir: string): UserNamespaceSnapshot {
  const userDir = path.join(agentStateDir, 'jobs', 'user');
  const snap: UserNamespaceSnapshot = { files: {}, mtimes: {} };
  if (!fs.existsSync(userDir)) return snap;
  for (const f of fs.readdirSync(userDir)) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(userDir, f);
    try {
      snap.files[f] = fs.readFileSync(p, 'utf-8');
      snap.mtimes[f] = fs.statSync(p).mtimeMs;
    } catch {
      // Skip unreadable entries — they couldn't have been touched by the migrator either.
    }
  }
  return snap;
}

/**
 * Verify invariants 1, 2, 4 against the on-disk state. Caller is responsible
 * for ensuring the state being verified is "post-jobsMigrate-completed."
 */
export function verifyMigrationInvariants(opts: InvariantCheckOptions): VerificationOutcome {
  const results: InvariantResult[] = [];

  results.push(verifyInvariant1ZeroJobLoss(opts));
  results.push(verifyInvariant2ZeroScheduleDrift(opts));
  results.push(verifyInvariant4UserNamespaceUntouched(opts));

  const failed = results.filter((r) => r.status === 'failed');
  const ok = failed.length === 0;
  const summary = ok
    ? `All migration invariants verified (${results.filter((r) => r.status === 'passed').length} passed, ${results.filter((r) => r.status === 'skipped').length} skipped).`
    : `Migration invariant verification FAILED: ${failed.map((r) => `#${r.invariant} ${r.reason ?? ''}`).join('; ')}`;

  return { ok, results, summary };
}

// ── Invariant 1: Zero job loss ──────────────────────────────────────────

function verifyInvariant1ZeroJobLoss(opts: InvariantCheckOptions): InvariantResult {
  const { agentStateDir, preMigrationJobs } = opts;
  const scheduleDir = path.join(agentStateDir, 'jobs', 'schedule');
  const userDir = path.join(agentStateDir, 'jobs', 'user');

  if (!fs.existsSync(scheduleDir)) {
    // No schedule dir means nothing was migrated. That's a failure ONLY if
    // there were prompt entries in jobs.json to migrate. Otherwise it's a
    // no-op (e.g., the agent only has script/skill defaults).
    const hadPromptEntries = preMigrationJobs.some(
      (e) => e && typeof e === 'object' && e.execute && e.execute.type === 'prompt',
    );
    if (hadPromptEntries) {
      return {
        invariant: 1,
        status: 'failed',
        reason: 'schedule directory does not exist after migration despite prompt-typed entries in jobs.json',
      };
    }
    return { invariant: 1, status: 'passed' };
  }

  const scheduleSlugs = new Set(
    fs
      .readdirSync(scheduleDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.basename(f, '.json')),
  );

  // Also accept renamed entries (slug → <slug>-user).
  const userSlugs = new Set(
    fs.existsSync(userDir)
      ? fs.readdirSync(userDir).filter((f) => f.endsWith('.md')).map((f) => path.basename(f, '.md'))
      : [],
  );

  const missing: string[] = [];
  for (const entry of preMigrationJobs) {
    if (!entry || typeof entry !== 'object' || typeof entry.slug !== 'string') continue;
    const slug = entry.slug;
    if (scheduleSlugs.has(slug)) continue;
    if (scheduleSlugs.has(`${slug}-user`)) continue;
    if (userSlugs.has(slug)) continue;
    if (userSlugs.has(`${slug}-user`)) continue;
    // Non-prompt entries (script/skill) are documented to remain in jobs.json.
    if (entry.execute && entry.execute.type !== 'prompt') continue;
    missing.push(slug);
  }

  if (missing.length > 0) {
    return {
      invariant: 1,
      status: 'failed',
      reason: `${missing.length} pre-migration slug(s) have no post-migration manifest or user fork: ${missing.join(', ')}`,
      details: { missingSlugs: missing },
    };
  }

  return { invariant: 1, status: 'passed' };
}

// ── Invariant 2: Zero schedule drift ────────────────────────────────────

function verifyInvariant2ZeroScheduleDrift(opts: InvariantCheckOptions): InvariantResult {
  const { agentStateDir, preMigrationJobs } = opts;
  const scheduleDir = path.join(agentStateDir, 'jobs', 'schedule');
  if (!fs.existsSync(scheduleDir)) {
    return { invariant: 2, status: 'skipped', reason: 'no schedule directory to verify' };
  }

  const driftedSlugs: Array<{ slug: string; field: string; pre: unknown; post: unknown }> = [];

  for (const entry of preMigrationJobs) {
    if (!entry || typeof entry !== 'object' || typeof entry.slug !== 'string') continue;
    if (entry.execute && entry.execute.type !== 'prompt') continue;

    const slug = entry.slug;
    const manifestPath = path.join(scheduleDir, `${slug}.json`);
    if (!fs.existsSync(manifestPath)) continue; // forked/renamed — invariant 1 handled

    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      driftedSlugs.push({ slug, field: 'manifest', pre: 'parseable', post: 'malformed' });
      continue;
    }

    if (typeof manifest.schedule === 'string' && manifest.schedule !== entry.schedule) {
      driftedSlugs.push({ slug, field: 'schedule', pre: entry.schedule, post: manifest.schedule });
    }
    const preEnabled = entry.enabled !== false;
    const postEnabled = manifest.enabled !== false;
    if (preEnabled !== postEnabled) {
      driftedSlugs.push({ slug, field: 'enabled', pre: preEnabled, post: postEnabled });
    }
  }

  if (driftedSlugs.length > 0) {
    return {
      invariant: 2,
      status: 'failed',
      reason: `${driftedSlugs.length} entries drifted: ${driftedSlugs.map((d) => `${d.slug}/${d.field}`).join(', ')}`,
      details: { driftedSlugs },
    };
  }

  return { invariant: 2, status: 'passed' };
}

// ── Invariant 4: User namespace untouched ──────────────────────────────

function verifyInvariant4UserNamespaceUntouched(opts: InvariantCheckOptions): InvariantResult {
  const { agentStateDir, preMigrationUserSnapshot } = opts;
  if (!preMigrationUserSnapshot) {
    return {
      invariant: 4,
      status: 'skipped',
      reason: 'no pre-migration user-namespace snapshot provided',
    };
  }

  const userDir = path.join(agentStateDir, 'jobs', 'user');
  const currentFiles = new Set<string>();
  const violations: Array<{ file: string; kind: 'removed' | 'modified' }> = [];

  if (fs.existsSync(userDir)) {
    for (const f of fs.readdirSync(userDir)) {
      if (!f.endsWith('.md')) continue;
      currentFiles.add(f);
      if (preMigrationUserSnapshot.files[f] === undefined) {
        // Added — only allowed if jobsMigrate did an explicit fork. We can't
        // distinguish here, so this is informational, not a violation.
        continue;
      }
      const currentContent = fs.readFileSync(path.join(userDir, f), 'utf-8');
      if (currentContent !== preMigrationUserSnapshot.files[f]) {
        violations.push({ file: f, kind: 'modified' });
      }
    }
  }

  for (const f of Object.keys(preMigrationUserSnapshot.files)) {
    if (!currentFiles.has(f)) violations.push({ file: f, kind: 'removed' });
  }

  if (violations.length > 0) {
    return {
      invariant: 4,
      status: 'failed',
      reason: `${violations.length} user-namespace file(s) modified or removed: ${violations.map((v) => `${v.file} (${v.kind})`).join(', ')}`,
      details: { violations },
    };
  }

  return { invariant: 4, status: 'passed' };
}

/**
 * Compute a stable canonical hash of a pre-migration entry for diff
 * reporting. Used by Invariant 2 internally; exported for tests.
 */
export function canonicalScheduleHash(entry: any): string {
  const canonical = JSON.stringify({
    slug: entry.slug,
    schedule: entry.schedule,
    enabled: entry.enabled !== false,
    priority: entry.priority,
    model: entry.model,
  });
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}
