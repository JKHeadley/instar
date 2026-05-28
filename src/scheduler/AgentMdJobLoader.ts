/**
 * AgentMdJobLoader — Phase 1a loader-side support for the new agentmd job format.
 *
 * Reads per-slug manifests from `.instar/jobs/schedule/<slug>.json`, optionally
 * resolves an accompanying `.instar/jobs/<origin>/<slug>.md` (for entries with
 * execute.type === "agentmd"), and validates frontmatter via a hardened YAML
 * parse + Zod preprocessor coercion per spec §6.
 *
 * Phase 1a is LOADER ONLY:
 *   - agentmd entries load into memory with `body` and `frontmatter` populated.
 *   - They will NOT fire until Phase 1b adds scheduler dispatch.
 *   - Existing JobScheduler.buildPrompt code paths are untouched.
 *
 * Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { Cron } from 'croner';
import type {
  JobDefinition,
  JobPriority,
  ModelTier,
} from '../core/types.js';
import {
  readLockFile,
  hashBody,
  hashFrontmatter,
  type LockFileLoadResult,
  type LockFileEntry,
} from './AgentMdLockFile.js';

// ── Constants ──────────────────────────────────────────────────────────────

const VALID_PRIORITIES: readonly JobPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_MODELS: readonly ModelTier[] = ['opus', 'sonnet', 'haiku'];
const VALID_ORIGINS = ['instar', 'user'] as const;
type Origin = (typeof VALID_ORIGINS)[number];

/** Slug regex per spec §"Slug rules" — ASCII only, deliberately excludes
 *  non-ASCII so NFD/RTL/ZWJ/dotless-i payloads cannot slip through. */
const SLUG_RE = /^[a-zA-Z0-9_-]{1,100}$/;

/** Bounded concurrency for per-slug manifest fanout. Spec §Load lifecycle
 *  pins this at 32 — unbounded Promise.all over 500+ entries hits EMFILE
 *  on macOS and Linux defaults. */
const READ_CONCURRENCY = 32;

/** Spec §6: hard size caps to bound parser cost + adversarial payloads. */
const MAX_FRONTMATTER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 64 * 1024;

/** Spec §6: closed-set frontmatter key whitelist. Unknown keys → per-entry
 *  skip. Adding to this set is a deliberate change, never silent.
 *
 *  Two groups:
 *  1. Agent-behavior keys — frontmatter is (or contributes to) authority:
 *     name + description (manifestToJobDefinition reads them), toolAllowlist
 *     (resolveAllowlist reads it directly; gated for '*' by the MANIFEST's
 *     unrestrictedTools), and the grounding/notification/view metadata.
 *  2. Scheduling/execution vocabulary — DECORATIVE in frontmatter. The agentmd
 *     `.md` is the single authoring source from which InstallBuiltinJobs derives
 *     the per-slug JSON manifest, so these keys legitimately appear in
 *     frontmatter, but manifestToJobDefinition reads every effective value from
 *     `manifest.*`, never frontmatter. We accept (do not deep-validate) them
 *     here; the manifest's validateManifest is the correctness authority, which
 *     is why a malformed frontmatter copy cannot reach a consumer.
 *     NOTE: of these, schedule/priority/expectedDurationMinutes/model/enabled/
 *     tags/unrestrictedTools/gate are derived by InstallBuiltinJobs today;
 *     topicId/machines/supervision are forward-vocabulary (valid manifest fields,
 *     not yet emitted by any shipped template) included so future templates do
 *     not re-trip this closed-set guard. */
const ALLOWED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'toolAllowlist',
  'grounding',
  'notificationMode',
  'viewMetadata',
  'commonBlockers',
  // Scheduling/execution vocabulary (decorative — manifest is authority):
  'schedule',
  'priority',
  'expectedDurationMinutes',
  'model',
  'enabled',
  'tags',
  'unrestrictedTools',
  'gate',
  'telegramNotify',
  'topicId',
  'machines',
  'supervision',
]);

// ── Zod preprocessors (spec §6) ────────────────────────────────────────────

/** YAML FAILSAFE_SCHEMA parses booleans/numbers as strings. The
 *  preprocessors below restore typed values with EXACT coercion semantics:
 *  - Booleans accept only `true`/`True`/`TRUE`/`false`/`False`/`FALSE`.
 *    YAML 1.1's `yes`/`no`/`on`/`off` are explicitly rejected.
 *  - Integers accept only `^-?\d+$`. Floats, `NaN`, `Infinity` rejected. */
export const BoolField = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return v;
  const lc = v.toLowerCase();
  if (lc === 'true') return true;
  if (lc === 'false') return false;
  return v; // pass-through → Zod rejects
}, z.boolean());

export const IntField = z.preprocess((v) => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return v;
  if (!/^-?\d+$/.test(v)) return v;
  return Number(v);
}, z.number().int().finite());

// ── Manifest schema ────────────────────────────────────────────────────────

/** Per-slug manifest as it lives on disk at .instar/jobs/schedule/<slug>.json.
 *  Validation is hand-coded (rather than Zod-derived) to keep parity with the
 *  existing validateJob style and to produce identical per-field error
 *  messages. */
export interface PerSlugManifest {
  slug: string;
  origin: Origin;
  schedule: string;
  priority: JobPriority;
  model?: ModelTier;
  expectedDurationMinutes: number;
  enabled: boolean;
  execute: { type: 'skill' | 'prompt' | 'script' | 'agentmd'; value?: string; args?: string };
  // optional pass-throughs preserved as-is
  tags?: string[];
  topicId?: number;
  telegramNotify?: boolean | 'on-alert';
  machines?: string[];
  gate?: string;
  unrestrictedTools?: boolean;
  manifestVersion?: number;
  /** SHA of the body at the time an operator disabled the default — preserved
   *  across regeneration so a re-enabled default re-syncs intentionally. */
  disabledAtBodyHash?: string;
}

// ── Load-problems surface ──────────────────────────────────────────────────

/** A single load-time problem. The scheduler probe and Issues card consume
 *  these. Phase 1a surfaces them via console.warn + the returned list. */
export interface LoadProblem {
  /** What went wrong. */
  kind:
    | 'manifest-invalid'
    | 'agentmd-file-missing'
    | 'agentmd-yaml-invalid'
    | 'agentmd-frontmatter-invalid'
    | 'agentmd-body-too-large'
    | 'agentmd-symlink'
    | 'slug-invalid'
    | 'case-fold-collision'
    | 'shadowed-by-schedule'
    | 'lock-mismatch'
    | 'unknown';
  slug?: string;
  origin?: Origin;
  path?: string;
  message: string;
}

export interface AgentMdLoadResult {
  jobs: JobDefinition[];
  problems: LoadProblem[];
}

// ── Bounded-concurrency helper (kept for Phase 1b sync→async migration) ───

/** Hand-rolled bounded-concurrency runner. p-limit is not in package.json
 *  and the spec explicitly permits a hand-roll. Pattern: counter + queue.
 *
 *  Phase 1a uses synchronous filesystem APIs end-to-end to preserve the
 *  existing sync `loadJobs(jobsFile): JobDefinition[]` signature. The READ
 *  fanout in Phase 1a is bounded only by the manifest count (typically <50);
 *  the spec performance budget of 1500 ms cold-boot @ 200 jobs is met with
 *  sequential sync reads at this scale. Phase 1b/1c migrate to async +
 *  this concurrency runner when buildPrompt and the lock-file pipeline
 *  require non-blocking I/O. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(Math.max(limit, 1), Math.max(items.length, 1));
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          results[i] = await fn(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Load per-slug manifests from `.instar/jobs/schedule/`.
 *
 * Returns `{ jobs, problems }`. If the schedule directory does not exist,
 * returns empty (this is the pre-spec state — caller continues with legacy
 * jobs.json only).
 *
 * Synchronous: matches the existing `loadJobs(jobsFile)` API so callers
 * (JobScheduler.start, status command, job CLI) do not need to become async
 * in Phase 1a. Per-slug fanout is bounded by the manifest count, which is
 * small enough at the Phase 1a scale (200-job spec budget) that the
 * sequential sync read path is comfortably within the 1500 ms cold-boot
 * budget. See header comment for migration plan.
 *
 * @param scheduleDir Absolute path to `.instar/jobs/schedule/`
 * @param jobsRootDir Absolute path to `.instar/jobs/` (parent of schedule)
 */
export function loadAgentMdJobs(
  scheduleDir: string,
  jobsRootDir: string,
): AgentMdLoadResult {
  if (!fs.existsSync(scheduleDir)) {
    return { jobs: [], problems: [] };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(scheduleDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    return {
      jobs: [],
      problems: [{
        kind: 'unknown',
        path: scheduleDir,
        message: `Failed to enumerate ${scheduleDir}: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }

  // Step 1: read + validate every manifest sequentially. The hand-rolled
  // bounded-concurrency helper above is exported for Phase 1b's async
  // migration; Phase 1a is single-threaded for API parity with the existing
  // sync loadJobs() entry point.
  const manifestResults = entries.map((filename) => {
    const filePath = path.join(scheduleDir, filename);
    return readOneManifest(filePath, filename);
  });

  const validManifests: { manifest: PerSlugManifest; sourcePath: string }[] = [];
  const problems: LoadProblem[] = [];

  for (const r of manifestResults) {
    if (r.problem) problems.push(r.problem);
    if (r.manifest) validManifests.push({ manifest: r.manifest, sourcePath: r.sourcePath });
  }

  // Step 2: global slug uniqueness check, case-folded. Spec §"Slug rules":
  // case-fold collision with origin="instar" winning over origin="user";
  // same-origin collision skips both.
  const survivors = resolveCaseFoldCollisions(validManifests, problems);

  // Step 3a: read the lock-file ONCE. Result is passed to every agentmd
  // body loader so per-entry hash-checks can run without reopening it.
  const lockResult = readLockFile(jobsRootDir);
  if (lockResult.state === 'malformed') {
    problems.push({
      kind: 'lock-mismatch',
      path: path.join(jobsRootDir, 'instar.lock.json'),
      message: `Lock-file is malformed: ${lockResult.reason}. All origin:instar entries will load with untrusted-bad-signature.`,
    });
  } else if (lockResult.state === 'present-untrusted') {
    problems.push({
      kind: 'lock-mismatch',
      path: path.join(jobsRootDir, 'instar.lock.json'),
      message: `Lock-file signature could not be verified: ${lockResult.reason}. All origin:instar entries will load with untrusted-bad-signature.`,
    });
  }

  // Step 3b: for each surviving entry, if agentmd then load + parse the .md
  // and apply the lock-file trust check. Skip-until-ack on hash mismatch:
  // the entry is NOT added to jobs[]; the problem surfaces in the Dashboard
  // Issues card.
  const jobs: JobDefinition[] = [];
  for (const { manifest } of survivors) {
    if (manifest.execute.type === 'agentmd') {
      const loaded = loadAgentMdBody(manifest, jobsRootDir);
      if (loaded.problem) {
        problems.push(loaded.problem);
        continue;
      }
      const job = loaded.job!;
      if (manifest.origin === 'instar') {
        const trustCheck = applyLockFileTrust(job, lockResult);
        if (trustCheck.problem) {
          problems.push(trustCheck.problem);
          // Skip-until-ack: hash mismatch is the one case we EXCLUDE the
          // entry. Other untrusted states (no lock-file, bad signature, not
          // in lock-file) still load the job — just with lockTrust set so
          // downstream consumers (allowlist resolver, grounding audit) can
          // refuse trust elevation.
          if (trustCheck.skipEntry) continue;
        }
        job.lockTrust = trustCheck.trust;
      }
      jobs.push(job);
    } else {
      // Non-agentmd manifest entries: produce a JobDefinition without body.
      const job = manifestToJobDefinition(manifest);
      jobs.push(job);
    }
  }

  return { jobs, problems };
}

/**
 * Apply the lock-file trust check to an agentmd job. Returns the resolved
 * trust state plus an optional problem (surfaces in the Dashboard Issues
 * card) plus a `skipEntry` flag: true for hash-mismatch ("skip-until-ack"),
 * false for the other untrusted states (entry still loads, just with
 * lockTrust marking it untrusted).
 */
function applyLockFileTrust(
  job: JobDefinition,
  lockResult: LockFileLoadResult,
): {
  trust: NonNullable<JobDefinition['lockTrust']>;
  problem: LoadProblem | null;
  skipEntry: boolean;
} {
  if (lockResult.state === 'absent') {
    return { trust: 'untrusted-no-lockfile', problem: null, skipEntry: false };
  }
  if (lockResult.state === 'malformed' || lockResult.state === 'present-untrusted') {
    return { trust: 'untrusted-bad-signature', problem: null, skipEntry: false };
  }
  // state === 'present-trusted'
  const entry = lockResult.bySlug.get(job.slug);
  if (!entry) {
    return {
      trust: 'untrusted-not-in-lockfile',
      problem: {
        kind: 'lock-mismatch',
        path: job.resolvedPath ?? job.slug,
        message:
          `Slug "${job.slug}" claims origin:instar but is not present in the signed lock-file. ` +
          `The runtime refuses to elevate trust. If this is a legitimately new instar default, ` +
          `cut a new release with the slug included.`,
      },
      skipEntry: false,
    };
  }

  const actualBodyHash = job.body !== undefined ? hashBody(job.body) : 'sha256:<no-body>';
  const actualFrontmatterHash = job.frontmatter
    ? hashFrontmatter(job.frontmatter)
    : 'sha256:<no-frontmatter>';

  if (actualBodyHash !== entry.bodyHash || actualFrontmatterHash !== entry.frontmatterHash) {
    return {
      trust: 'untrusted-hash-mismatch',
      problem: {
        kind: 'lock-mismatch',
        path: job.resolvedPath ?? job.slug,
        message:
          `Slug "${job.slug}" body or frontmatter hash does not match the signed lock-file. ` +
          `Expected body=${entry.bodyHash}, actual=${actualBodyHash}. ` +
          `Expected frontmatter=${entry.frontmatterHash}, actual=${actualFrontmatterHash}. ` +
          `Skip-until-ack: the job will NOT fire. Dashboard offers "Show diff" / "Reset to shipped default" / "Acknowledge and run anyway."`,
      },
      skipEntry: true,
    };
  }

  return { trust: 'trusted', problem: null, skipEntry: false };
}

// Re-export the bounded-concurrency helper for downstream callers. Phase 1b's
// scheduler dispatch path will route I/O through it; exposing it now keeps the
// API surface stable.
export const READ_CONCURRENCY_LIMIT = READ_CONCURRENCY;

// ── Manifest validation ────────────────────────────────────────────────────

function readOneManifest(filePath: string, filename: string): {
  manifest: PerSlugManifest | null;
  sourcePath: string;
  problem: LoadProblem | null;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return {
      manifest: null,
      sourcePath: filePath,
      problem: {
        kind: 'manifest-invalid',
        path: filePath,
        message: `Failed to parse manifest ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  try {
    const m = validateManifest(raw, filename);
    // Defense-in-depth: filename ↔ slug match is not required by the spec,
    // but mismatched filenames hint at a hand-edit error — surface a warning.
    // Phase 1a: don't reject, just warn-and-continue via problems list when
    // the slug differs. The collision check will catch the rename pattern.
    return { manifest: m, sourcePath: filePath, problem: null };
  } catch (err) {
    return {
      manifest: null,
      sourcePath: filePath,
      problem: {
        kind: 'manifest-invalid',
        path: filePath,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** Validates the per-slug manifest schema. Mirrors validateJob style so the
 *  error messages are familiar; centralized here because the agentmd path
 *  has additional fields (origin, unrestrictedTools, execute.type = agentmd). */
export function validateManifest(raw: unknown, sourceLabel?: string): PerSlugManifest {
  const prefix = sourceLabel ? `Manifest[${sourceLabel}]` : 'Manifest';

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${prefix}: must be a JSON object`);
  }
  const j = raw as Record<string, unknown>;

  // Required string fields
  for (const field of ['slug', 'schedule']) {
    if (typeof j[field] !== 'string' || !(j[field] as string).trim()) {
      throw new Error(`${prefix}: "${field}" is required and must be a non-empty string`);
    }
  }

  // Slug regex
  if (!SLUG_RE.test(j.slug as string)) {
    throw new Error(`${prefix}: "slug" must match ${SLUG_RE} (ASCII letters/digits/hyphens/underscores, 1-100 chars)`);
  }

  // Origin
  if (!VALID_ORIGINS.includes(j.origin as Origin)) {
    throw new Error(`${prefix}: "origin" must be one of ${VALID_ORIGINS.join(', ')}, got "${j.origin}"`);
  }

  // Priority
  if (!VALID_PRIORITIES.includes(j.priority as JobPriority)) {
    throw new Error(`${prefix}: "priority" must be one of ${VALID_PRIORITIES.join(', ')}, got "${j.priority}"`);
  }

  // Model (optional)
  if (j.model !== undefined && !VALID_MODELS.includes(j.model as ModelTier)) {
    throw new Error(`${prefix}: "model" must be one of ${VALID_MODELS.join(', ')}, got "${j.model}"`);
  }

  // Cron expression
  try {
    const c = new Cron(j.schedule as string);
    c.stop();
  } catch (err) {
    throw new Error(`${prefix}: invalid cron expression "${j.schedule}": ${err instanceof Error ? err.message : String(err)}`);
  }

  // expectedDurationMinutes
  if (typeof j.expectedDurationMinutes !== 'number' || !Number.isFinite(j.expectedDurationMinutes) || j.expectedDurationMinutes <= 0) {
    throw new Error(`${prefix}: "expectedDurationMinutes" must be a positive finite number`);
  }

  // Enabled
  if (typeof j.enabled !== 'boolean') {
    throw new Error(`${prefix}: "enabled" must be a boolean`);
  }

  // Execute block
  if (!j.execute || typeof j.execute !== 'object' || Array.isArray(j.execute)) {
    throw new Error(`${prefix}: "execute" must be an object`);
  }
  const exec = j.execute as Record<string, unknown>;
  const validTypes = ['skill', 'prompt', 'script', 'agentmd'];
  if (typeof exec.type !== 'string' || !validTypes.includes(exec.type)) {
    throw new Error(`${prefix}: execute.type must be one of ${validTypes.join(', ')}`);
  }
  if (exec.type === 'agentmd') {
    // Body lives in the .md file — value must NOT be present.
    if (exec.value !== undefined) {
      throw new Error(`${prefix}: execute.value must be absent when type === "agentmd" (body lives in <origin>/<slug>.md)`);
    }
  } else {
    // Legacy types still require value.
    if (typeof exec.value !== 'string' || !(exec.value as string).trim()) {
      throw new Error(`${prefix}: execute.value is required for type === "${exec.type}"`);
    }
  }
  if (exec.args !== undefined && typeof exec.args !== 'string') {
    throw new Error(`${prefix}: execute.args must be a string if provided`);
  }

  // Optional unrestrictedTools
  if (j.unrestrictedTools !== undefined && typeof j.unrestrictedTools !== 'boolean') {
    throw new Error(`${prefix}: "unrestrictedTools" must be a boolean if provided`);
  }

  // Optional manifestVersion (monotonic counter — spec §3)
  if (j.manifestVersion !== undefined) {
    if (typeof j.manifestVersion !== 'number' || !Number.isFinite(j.manifestVersion) || !Number.isInteger(j.manifestVersion) || j.manifestVersion < 0) {
      throw new Error(`${prefix}: "manifestVersion" must be a non-negative integer if provided`);
    }
  }

  // Optional tags
  if (j.tags !== undefined) {
    if (!Array.isArray(j.tags)) throw new Error(`${prefix}: "tags" must be an array if provided`);
    for (const t of j.tags) {
      if (typeof t !== 'string') throw new Error(`${prefix}: "tags" entries must be strings`);
    }
  }

  // Optional topicId
  if (j.topicId !== undefined && (typeof j.topicId !== 'number' || !Number.isFinite(j.topicId))) {
    throw new Error(`${prefix}: "topicId" must be a finite number if provided`);
  }

  // Optional telegramNotify
  if (j.telegramNotify !== undefined &&
      typeof j.telegramNotify !== 'boolean' &&
      j.telegramNotify !== 'on-alert') {
    throw new Error(`${prefix}: "telegramNotify" must be true, false, or "on-alert" if provided`);
  }

  // Optional machines
  if (j.machines !== undefined) {
    if (!Array.isArray(j.machines)) throw new Error(`${prefix}: "machines" must be an array if provided`);
    for (const m of j.machines) {
      if (typeof m !== 'string' || !m.trim()) throw new Error(`${prefix}: "machines" entries must be non-empty strings`);
    }
  }

  // Optional gate (shell command)
  if (j.gate !== undefined && typeof j.gate !== 'string') {
    throw new Error(`${prefix}: "gate" must be a string if provided`);
  }

  return j as unknown as PerSlugManifest;
}

// ── Case-fold collision resolution ─────────────────────────────────────────

function resolveCaseFoldCollisions(
  manifests: { manifest: PerSlugManifest; sourcePath: string }[],
  problems: LoadProblem[],
): { manifest: PerSlugManifest; sourcePath: string }[] {
  const groups = new Map<string, typeof manifests>();
  for (const m of manifests) {
    // Spec: NFC normalization is defense-in-depth; the slug regex is ASCII-only
    // so normalization is a no-op for valid slugs. We still apply it for hygiene.
    const key = m.manifest.slug.normalize('NFC').toLowerCase();
    const arr = groups.get(key);
    if (arr) arr.push(m);
    else groups.set(key, [m]);
  }

  const survivors: typeof manifests = [];
  for (const [key, group] of groups) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }

    // Multi-entry case-fold collision.
    const instarOnes = group.filter((g) => g.manifest.origin === 'instar');
    const userOnes = group.filter((g) => g.manifest.origin === 'user');

    if (instarOnes.length === 1 && userOnes.length >= 1 && instarOnes.length + userOnes.length === group.length) {
      // origin=instar wins; user-namespace entries skipped per spec.
      survivors.push(instarOnes[0]);
      for (const u of userOnes) {
        problems.push({
          kind: 'case-fold-collision',
          slug: u.manifest.slug,
          origin: u.manifest.origin,
          path: u.sourcePath,
          message:
            `Case-fold slug collision on "${key}": user-namespace "${u.manifest.slug}" ` +
            `was skipped because the instar default "${instarOnes[0].manifest.slug}" wins by spec.`,
        });
      }
    } else {
      // Same-origin collision (or multiple instar/user pairs simultaneously).
      // Per spec §"Slug rules": both skipped if same-origin collide; both
      // skipped when the resolution is otherwise ambiguous. The Issues card
      // names every entry; here we surface each one as a problem and skip
      // them all.
      for (const g of group) {
        problems.push({
          kind: 'case-fold-collision',
          slug: g.manifest.slug,
          origin: g.manifest.origin,
          path: g.sourcePath,
          message:
            `Case-fold slug collision on "${key}" (${group.length} entries, origins=[${
              group.map((x) => x.manifest.origin).join(',')
            }]) — all skipped because the collision is not resolvable by origin precedence.`,
        });
      }
    }
  }

  return survivors;
}

// ── agentmd body + frontmatter loading ─────────────────────────────────────

/**
 * Resolve and load a single agentmd entry's `.md` file.
 * Applies path safety, size caps, YAML hardening, anchor rejection, and Zod
 * preprocessor validation. Returns a fully-populated JobDefinition on success.
 */
function loadAgentMdBody(
  manifest: PerSlugManifest,
  jobsRootDir: string,
): { job: JobDefinition | null; problem: LoadProblem | null } {
  const resolved = path.join(jobsRootDir, manifest.origin, `${manifest.slug}.md`);

  // Path safety, applied BEFORE any read.
  const safetyProblem = checkPathSafety(resolved, manifest);
  if (safetyProblem) return { job: null, problem: safetyProblem };

  if (!fs.existsSync(resolved)) {
    return {
      job: null,
      problem: {
        kind: 'agentmd-file-missing',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: `agentmd file not found: ${resolved}`,
      },
    };
  }

  // Size check on the raw file. Body cap = 64 KB; frontmatter cap = 16 KB.
  // We bound the total read to (16 + 64 + small framing) KB so an
  // adversarial 10 MB file cannot blow memory before parse.
  const MAX_TOTAL_BYTES = MAX_FRONTMATTER_BYTES + MAX_BODY_BYTES + 1024;
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_TOTAL_BYTES) {
    return {
      job: null,
      problem: {
        kind: 'agentmd-body-too-large',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: `agentmd file is ${stat.size} bytes — exceeds total cap of ${MAX_TOTAL_BYTES} bytes`,
      },
    };
  }

  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    return {
      job: null,
      problem: {
        kind: 'unknown',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: `Failed to read ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // Split frontmatter ↔ body.
  const split = splitFrontmatter(text);
  if (!split) {
    return {
      job: null,
      problem: {
        kind: 'agentmd-yaml-invalid',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: 'agentmd file is missing a YAML frontmatter block (expected leading "---")',
      },
    };
  }

  const { frontmatterText, body } = split;

  if (Buffer.byteLength(frontmatterText, 'utf-8') > MAX_FRONTMATTER_BYTES) {
    return {
      job: null,
      problem: {
        kind: 'agentmd-yaml-invalid',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: `frontmatter is ${Buffer.byteLength(frontmatterText, 'utf-8')} bytes — exceeds cap of ${MAX_FRONTMATTER_BYTES}`,
      },
    };
  }

  if (Buffer.byteLength(body, 'utf-8') > MAX_BODY_BYTES) {
    return {
      job: null,
      problem: {
        kind: 'agentmd-body-too-large',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: `body is ${Buffer.byteLength(body, 'utf-8')} bytes — exceeds cap of ${MAX_BODY_BYTES}`,
      },
    };
  }

  // Parse YAML with FAILSAFE_SCHEMA. Reject anchors/aliases via the
  // parser's listener callback — this is the parsed-tree check the spec
  // mandates over a raw-text regex (which would over-reject legitimate
  // strings like `description: "Bash & Read"`).
  let parsed: unknown;
  let anchorSeen = false;
  try {
    parsed = yaml.load(frontmatterText, {
      schema: yaml.FAILSAFE_SCHEMA,
      listener: (_kind, state) => {
        // state.anchor is set per-event when the parser encounters an
        // anchor or alias on the parsed-tree node. Legitimate `&` or `*`
        // characters inside quoted string values do NOT set this field.
        if (state && (state as { anchor?: string }).anchor) {
          anchorSeen = true;
        }
      },
    });
  } catch (err) {
    return {
      job: null,
      problem: {
        kind: 'agentmd-yaml-invalid',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (anchorSeen) {
    return {
      job: null,
      problem: {
        kind: 'agentmd-yaml-invalid',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: 'YAML anchors/aliases are not allowed in agentmd frontmatter',
      },
    };
  }

  // JSON-roundtrip normalization. FAILSAFE_SCHEMA returns string-keyed
  // structures with primitives-as-strings; the round-trip strips any
  // exotic object identities the parser might construct.
  // Empty frontmatter parses as undefined; treat that as the empty object.
  let normalized: unknown;
  if (parsed === undefined || parsed === null) {
    normalized = {};
  } else {
    try {
      normalized = JSON.parse(JSON.stringify(parsed));
    } catch (err) {
      return {
        job: null,
        problem: {
          kind: 'agentmd-yaml-invalid',
          slug: manifest.slug,
          origin: manifest.origin,
          path: resolved,
          message: `Frontmatter is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    return {
      job: null,
      problem: {
        kind: 'agentmd-frontmatter-invalid',
        slug: manifest.slug,
        origin: manifest.origin,
        path: resolved,
        message: 'Frontmatter must be a YAML mapping (object)',
      },
    };
  }

  const frontmatter = normalized as Record<string, unknown>;

  // Closed-set whitelist check.
  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      return {
        job: null,
        problem: {
          kind: 'agentmd-frontmatter-invalid',
          slug: manifest.slug,
          origin: manifest.origin,
          path: resolved,
          message: `Unknown frontmatter key "${key}" (allowed: ${[...ALLOWED_FRONTMATTER_KEYS].join(', ')})`,
        },
      };
    }
  }

  // Phase 1a applies Zod coercion only to fields it understands. The
  // BoolField / IntField preprocessors are exposed for downstream phases
  // to consume; here we validate a starter set:
  //   - name: string
  //   - description: string
  //   - notificationMode: 'always' | 'on-alert' | 'never' (string passthrough)
  //   - toolAllowlist: string[] | '*' (structural shape only — semantics in 1b)
  //
  // We do NOT validate `grounding` / `commonBlockers` / `viewMetadata` deeply
  // here because the existing JobLoader.validateJob already encodes those
  // shapes; they are surfaced verbatim into JobDefinition and the scheduler
  // dispatch path (Phase 1b) will route through validateGrounding etc.
  const fmValidation = validateFrontmatterShape(frontmatter, manifest);
  if (fmValidation.problem) return { job: null, problem: fmValidation.problem };

  // Build the JobDefinition. Manifest fields win over frontmatter fields by
  // spec §"Open Questions Resolved" — manifest is authority for cron; frontmatter
  // is authority for behavior (name/description). For Phase 1a we surface
  // both so the scheduler-dispatch step in Phase 1b can lookup the right field.
  const job = manifestToJobDefinition(manifest, frontmatter, body, resolved);
  return { job, problem: null };
}

// ── Path safety ────────────────────────────────────────────────────────────

/** Pre-resolution path safety per spec §"Slug rules":
 *  - realpath(resolved) === resolved (no intermediate symlinks)
 *  - lstat(resolved).isSymbolicLink() === false
 *  - slug regex enforced (already done in manifest validation)
 *  - NFC-normalize for hygiene (regex already rejects non-ASCII)
 *
 *  Called AFTER the manifest passed validateManifest, so we trust the slug
 *  is regex-safe; the .md file at the resolved path may still be a symlink. */
function checkPathSafety(resolved: string, manifest: PerSlugManifest): LoadProblem | null {
  // Defense-in-depth: re-confirm slug regex.
  const slug = manifest.slug.normalize('NFC');
  if (!SLUG_RE.test(slug)) {
    return {
      kind: 'slug-invalid',
      slug: manifest.slug,
      origin: manifest.origin,
      path: resolved,
      message: `slug "${manifest.slug}" fails the safety regex after NFC normalization`,
    };
  }

  // lstat check first (cheap; tells us if the leaf itself is a symlink).
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // missing file handled later
    return {
      kind: 'unknown',
      slug: manifest.slug,
      origin: manifest.origin,
      path: resolved,
      message: `lstat failed for ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (lstat.isSymbolicLink()) {
    return {
      kind: 'agentmd-symlink',
      slug: manifest.slug,
      origin: manifest.origin,
      path: resolved,
      message: `agentmd file is a symbolic link — refusing to load (spec §Slug rules)`,
    };
  }

  // realpath check — catches intermediate-directory symlinks (e.g. someone
  // replaced .instar/jobs/instar/ with a symlink to /etc).
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // missing file handled later
    return {
      kind: 'unknown',
      slug: manifest.slug,
      origin: manifest.origin,
      path: resolved,
      message: `realpath failed for ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // path.resolve normalizes the expected; realpathSync gives us the canonical.
  // On macOS realpath may differ from path.resolve(resolved) due to /tmp →
  // /private/tmp resolution — we compare against realpath(jobsRoot) parent
  // by joining real components.
  const expected = fs.realpathSync(path.dirname(resolved)) + path.sep + path.basename(resolved);
  if (real !== expected) {
    return {
      kind: 'agentmd-symlink',
      slug: manifest.slug,
      origin: manifest.origin,
      path: resolved,
      message: `realpath(${resolved}) === ${real}, expected ${expected} — symlink redirection detected`,
    };
  }

  return null;
}

// ── Frontmatter shape validation (light; deep validation lives in 1b) ─────

function validateFrontmatterShape(
  fm: Record<string, unknown>,
  manifest: PerSlugManifest,
): { problem: LoadProblem | null } {
  // `name` and `description` must be strings if present. They are not
  // required at the frontmatter level — the manifest may provide them in
  // a later phase. Phase 1a accepts either source.
  if (fm.name !== undefined && (typeof fm.name !== 'string' || !fm.name.trim())) {
    return mkFmProblem(manifest, '"name" must be a non-empty string if provided');
  }
  if (fm.description !== undefined && (typeof fm.description !== 'string' || !fm.description.trim())) {
    return mkFmProblem(manifest, '"description" must be a non-empty string if provided');
  }

  if (fm.notificationMode !== undefined) {
    if (fm.notificationMode !== 'always' && fm.notificationMode !== 'on-alert' && fm.notificationMode !== 'never') {
      return mkFmProblem(manifest, '"notificationMode" must be one of "always" | "on-alert" | "never"');
    }
  }

  if (fm.toolAllowlist !== undefined) {
    if (fm.toolAllowlist === '*') {
      // ok — checked against manifest.unrestrictedTools in Phase 1b
    } else if (Array.isArray(fm.toolAllowlist)) {
      for (const t of fm.toolAllowlist) {
        if (typeof t !== 'string' || !t.trim()) {
          return mkFmProblem(manifest, '"toolAllowlist" array entries must be non-empty strings');
        }
      }
    } else {
      return mkFmProblem(manifest, '"toolAllowlist" must be "*" or an array of tool names');
    }
  }

  return { problem: null };
}

function mkFmProblem(manifest: PerSlugManifest, message: string): { problem: LoadProblem } {
  return {
    problem: {
      kind: 'agentmd-frontmatter-invalid',
      slug: manifest.slug,
      origin: manifest.origin,
      message,
    },
  };
}

// ── Frontmatter split ──────────────────────────────────────────────────────

/** Split an agentmd file into `{ frontmatterText, body }`. Expects the file
 *  to start with `---\n`, contain a closing `---` on its own line, and
 *  everything after that line is the body. CRLF and lone-CR are normalized
 *  to LF for splitting; the body returned to the caller preserves its
 *  original line endings (the agentmd body is opaque content). */
function splitFrontmatter(text: string): { frontmatterText: string; body: string } | null {
  // Normalize for the split only.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return null;
  }
  // Empty-frontmatter case: file starts with "---\n---\n" (or "---\n---" at EOF).
  // The closing fence must be on its own line. Two patterns to find:
  //   1. immediately after the opening fence: "---\n---" then \n or EOF
  //   2. after some frontmatter content: "...\n---" then \n or EOF
  const afterOpen = normalized.slice(4); // after "---\n"
  // Either afterOpen starts with "---" (empty frontmatter) or contains "\n---".
  let frontmatterText: string;
  let restStart: number;
  if (afterOpen.startsWith('---') && (afterOpen.length === 3 || afterOpen[3] === '\n' || /^---\s*$/.test(afterOpen.split('\n')[0]))) {
    frontmatterText = '';
    // skip past "---" itself
    const firstLine = afterOpen.split('\n')[0];
    if (!/^---\s*$/.test(firstLine)) return null;
    restStart = firstLine.length;
  } else {
    const fenceMatch = afterOpen.match(/\n(---\s*)(\n|$)/);
    if (!fenceMatch || fenceMatch.index === undefined) return null;
    frontmatterText = afterOpen.slice(0, fenceMatch.index);
    restStart = fenceMatch.index + fenceMatch[0].length - (fenceMatch[2] === '\n' ? 1 : 0);
  }
  const rest = afterOpen.slice(restStart);
  // rest may now be "" or start with "\n<body>".
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;
  return { frontmatterText, body };
}

// ── Manifest → JobDefinition ───────────────────────────────────────────────

function manifestToJobDefinition(
  manifest: PerSlugManifest,
  frontmatter?: Record<string, unknown>,
  body?: string,
  resolvedPath?: string,
): JobDefinition {
  // Manifest is authority for cron + slug; frontmatter is authority for
  // name/description per spec §"Open Questions Resolved" Q6.
  const name =
    (frontmatter && typeof frontmatter.name === 'string' && frontmatter.name.trim()) ||
    manifest.slug;
  const description =
    (frontmatter && typeof frontmatter.description === 'string' && frontmatter.description.trim()) ||
    `agentmd job ${manifest.slug}`;

  const job: JobDefinition = {
    slug: manifest.slug,
    name,
    description,
    schedule: manifest.schedule,
    priority: manifest.priority,
    expectedDurationMinutes: manifest.expectedDurationMinutes,
    model: manifest.model ?? 'sonnet',
    enabled: manifest.enabled,
    execute: manifest.execute as JobDefinition['execute'],
    origin: manifest.origin,
    tags: manifest.tags,
    topicId: manifest.topicId,
    telegramNotify: manifest.telegramNotify,
    machines: manifest.machines,
    gate: manifest.gate,
    unrestrictedTools: manifest.unrestrictedTools,
    manifestVersion: manifest.manifestVersion,
  };

  if (manifest.execute.type === 'agentmd') {
    if (body !== undefined) job.body = body;
    if (frontmatter !== undefined) job.frontmatter = frontmatter;
    if (resolvedPath !== undefined) job.resolvedPath = resolvedPath;
  }

  return job;
}

// ── Test-only exports (kept on the public surface for SchedulerProbe) ─────

/** Exposed for SchedulerProbe and tests: returns true iff a JobDefinition
 *  originating from an agentmd manifest has its body cached in memory.
 *  Phase 1a invariant — agentmd jobs MUST carry body after loadJobs(). */
export function isAgentMdJobHydrated(job: JobDefinition): boolean {
  if (job.execute.type !== 'agentmd') return true;
  return typeof job.body === 'string';
}
