/**
 * Built-in Skill Regenerator (PROP-337 v1)
 *
 * Closes the upgrade gap: when an inline SKILL template in
 * `installBuiltinSkills` (init.ts) is updated in a new package release,
 * existing installs never see the new content because the migrator's
 * `migrateBuiltinSkills` is non-destructive — it only writes files that
 * are missing.
 *
 * This module adds fingerprint-based drift detection and safe
 * regeneration:
 *
 *   - On first observation (or after first regeneration), the on-disk
 *     SHA-256 of each built-in SKILL.md is recorded in
 *     `.instar/state/builtin-skill-fingerprints.json`.
 *   - On each migrator run we render the CURRENT bundled template into a
 *     scratch directory by calling the existing `installBuiltinSkills`
 *     into a tempdir. The rendered content is the source-of-truth for
 *     what THIS package version intends each skill to look like.
 *   - For each skill we compare three hashes:
 *       on-disk         = SHA-256 of .claude/skills/<slug>/SKILL.md
 *       fingerprint     = SHA-256 we recorded after the last write/observe
 *       currentBundled  = SHA-256 of the freshly rendered template
 *   - Decision:
 *       missing on disk            -> install fresh
 *       on-disk == currentBundled  -> in sync (refresh fingerprint)
 *       on-disk == fingerprint     -> unmodified by user, safe to upgrade
 *                                     -> overwrite with currentBundled,
 *                                        update fingerprint
 *       else                       -> user-modified, leave alone, record
 *                                     finding (so the operator can see
 *                                     drift without losing customizations)
 *
 * Custom skills (anything not in the built-in template set) are never
 * touched — we only enumerate slugs produced by `installBuiltinSkills`.
 *
 * Design notes / scope (v1):
 *   - This handles INLINE templates owned by `installBuiltinSkills` plus
 *     the `build` skill bundled as a file in `.claude/skills/build/` of
 *     the package. Hooks, jobs, scripts, and the `autonomous` skill are
 *     out of scope for v1; PostUpdateMigrator already overwrites those
 *     unconditionally, so they don't suffer the same gap.
 *   - Default mode is `apply: true` — the call site (PostUpdateMigrator)
 *     can pass `apply: false` to get a dry-run report (useful for
 *     debugging without writing).
 *   - Failure mode: any error rendering or hashing a skill is recorded
 *     in `result.errors` but never aborts the whole migration. Worst
 *     case we no-op for that skill, which preserves the pre-PROP-337
 *     behavior.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installBuiltinSkills } from '../commands/init.js';

export interface RegeneratorResult {
  upgraded: string[];
  skipped: string[];
  errors: string[];
}

export interface RegeneratorOptions {
  projectDir: string;
  stateDir: string;
  port: number;
  apply?: boolean;
}

interface FingerprintFile {
  $schema?: string;
  schemaVersion: number;
  updatedAt: string;
  /** keyed by slug -> sha256 of the SKILL.md we wrote (or first observed) */
  skills: Record<string, { contentHash: string; observedAt: string }>;
}

const FINGERPRINT_SCHEMA_VERSION = 1;

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readFingerprints(stateDir: string): FingerprintFile {
  const file = path.join(stateDir, 'state', 'builtin-skill-fingerprints.json');
  if (!fs.existsSync(file)) {
    return {
      schemaVersion: FINGERPRINT_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      skills: {},
    };
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.skills) {
      return {
        schemaVersion: parsed.schemaVersion ?? FINGERPRINT_SCHEMA_VERSION,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        skills: parsed.skills as FingerprintFile['skills'],
      };
    }
  } catch {
    /* fall through to fresh state */
  }
  return {
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    skills: {},
  };
}

function writeFingerprints(stateDir: string, fp: FingerprintFile): void {
  const dir = path.join(stateDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fp.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, 'builtin-skill-fingerprints.json'),
    JSON.stringify(fp, null, 2),
  );
}

/**
 * Render the bundled built-in skills into a tempdir by invoking the
 * canonical `installBuiltinSkills` and snapshotting the result. Returns
 * a map from slug -> rendered SKILL.md content.
 *
 * Note: `installBuiltinSkills` itself ALSO emits the `build` and
 * `autonomous` skill bundles. We only collect SKILL.md files at the top
 * level of each skill folder, since those are the in-scope artifacts
 * for v1. Subdirectories (autonomous/scripts, autonomous/hooks) are
 * intentionally ignored.
 */
export function renderBundledSkills(port: number): Record<string, string> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-skill-render-'));
  try {
    installBuiltinSkills(tmpRoot, port);
    const slugs = fs.readdirSync(tmpRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    const out: Record<string, string> = {};
    for (const slug of slugs) {
      const skillFile = path.join(tmpRoot, slug, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        out[slug] = fs.readFileSync(skillFile, 'utf-8');
      }
    }
    return out;
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Run drift detection + regeneration. Returns a structured result with
 * per-skill outcomes for the migrator to merge into its own log.
 *
 * Idempotent: a no-op run after a successful run produces all-skipped.
 */
export function regenerateBuiltinSkills(opts: RegeneratorOptions): RegeneratorResult {
  const result: RegeneratorResult = { upgraded: [], skipped: [], errors: [] };
  const apply = opts.apply !== false;
  const skillsDir = path.join(opts.projectDir, '.claude', 'skills');

  let bundled: Record<string, string>;
  try {
    bundled = renderBundledSkills(opts.port);
  } catch (err) {
    result.errors.push(
      `builtin-skill-regen: failed to render bundled templates: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const fingerprints = readFingerprints(opts.stateDir);
  let dirty = false;

  for (const [slug, bundledContent] of Object.entries(bundled)) {
    try {
      const skillDir = path.join(skillsDir, slug);
      const skillFile = path.join(skillDir, 'SKILL.md');
      const bundledHash = sha256(bundledContent);

      if (!fs.existsSync(skillFile)) {
        // Missing on disk — install fresh. This duplicates the existing
        // non-destructive path in `migrateBuiltinSkills`, but is harmless
        // (we just wrote what that method would have written). It also
        // ensures fingerprint is recorded on a fresh install.
        if (apply) {
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(skillFile, bundledContent);
          fingerprints.skills[slug] = {
            contentHash: bundledHash,
            observedAt: new Date().toISOString(),
          };
          dirty = true;
          result.upgraded.push(`skills/${slug}/SKILL.md (installed)`);
        } else {
          result.upgraded.push(`skills/${slug}/SKILL.md (would install)`);
        }
        continue;
      }

      const onDisk = fs.readFileSync(skillFile, 'utf-8');
      const onDiskHash = sha256(onDisk);
      const fp = fingerprints.skills[slug];

      if (onDiskHash === bundledHash) {
        // In sync — refresh fingerprint if missing/outdated.
        if (!fp || fp.contentHash !== bundledHash) {
          fingerprints.skills[slug] = {
            contentHash: bundledHash,
            observedAt: new Date().toISOString(),
          };
          dirty = true;
        }
        result.skipped.push(`skills/${slug}/SKILL.md (in sync)`);
        continue;
      }

      if (fp && fp.contentHash === onDiskHash) {
        // On-disk file matches our fingerprint — user has not modified
        // it since the last install/observe. Bundled hash differs, so
        // the template was upgraded upstream. Safe to regenerate.
        if (apply) {
          fs.writeFileSync(skillFile, bundledContent);
          fingerprints.skills[slug] = {
            contentHash: bundledHash,
            observedAt: new Date().toISOString(),
          };
          dirty = true;
          result.upgraded.push(`skills/${slug}/SKILL.md (regenerated from upgraded template)`);
        } else {
          result.upgraded.push(`skills/${slug}/SKILL.md (would regenerate)`);
        }
        continue;
      }

      // No fingerprint OR on-disk diverges from both fingerprint and
      // bundled. Treat as user-customized; preserve and record.
      result.skipped.push(
        `skills/${slug}/SKILL.md (user-modified — preserving; bundled drift detected)`,
      );

      // First-observe seeding: if there's no fingerprint at all, record
      // the current on-disk hash so future template upgrades can
      // recognize "user has not touched it since now". This converts
      // pre-PROP-337 installs into PROP-337-aware ones over time.
      if (!fp) {
        fingerprints.skills[slug] = {
          contentHash: onDiskHash,
          observedAt: new Date().toISOString(),
        };
        dirty = true;
      }
    } catch (err) {
      result.errors.push(
        `skills/${slug}/SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (dirty && apply) {
    try {
      writeFingerprints(opts.stateDir, fingerprints);
    } catch (err) {
      result.errors.push(
        `builtin-skill-regen: failed to write fingerprints: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
