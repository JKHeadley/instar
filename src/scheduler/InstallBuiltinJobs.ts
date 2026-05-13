/**
 * InstallBuiltinJobs — Phase 2 installer for instar-default jobs.
 *
 * Copies the shipped agentmd templates from the installed npm package into
 * the agent's `.instar/jobs/instar/` directory and creates the corresponding
 * per-slug manifest under `.instar/jobs/schedule/`. Idempotent. Safe to call
 * on init and on every update.
 *
 * Sources (in this order; first existing wins):
 *   1. <packageRoot>/dist/scaffold/templates/jobs/instar/  (npm-installed)
 *   2. <packageRoot>/src/scaffold/templates/jobs/instar/   (in-tree dev)
 *
 * Targets:
 *   .instar/jobs/instar/<slug>.md
 *   .instar/jobs/schedule/<slug>.json
 *   .instar/jobs/instar.lock.json   (copied from <packageRoot>/dist/jobs/)
 *   .instar/keys/instar-release-pub.pem (copied from <packageRoot>/dist/keys/)
 *
 * Per the Seamless Migration Guarantee (spec §Seamless Migration Guarantee):
 *
 *   - This function NEVER touches `.instar/jobs/user/` (invariant 4).
 *   - This function NEVER deletes or overwrites a user-edited body
 *     (`.instar/jobs/instar/<slug>.md` is overwritten on update — that's
 *     the contract; users who edited a default should fork via Phase 4
 *     Dashboard "Unfork" before updating).
 *   - When a slug is no longer in the templates dir, its `.instar/jobs/instar/<slug>.md`
 *     is removed; the per-slug schedule manifest is moved to retired-defaults
 *     (Phase 4-Dashboard surface) and its `enabled` flipped to false.
 *
 * Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §Concrete Paths + §PostUpdateMigrator.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface InstallBuiltinJobsOptions {
  /** Agent state directory root (typically `<projectDir>/.instar`). */
  agentStateDir: string;
  /** Installed npm package root (typically `node_modules/instar` or the
   *  repo root in dev). The installer searches `dist/scaffold/...` first,
   *  then `src/scaffold/...` as a dev-mode fallback. */
  packageRoot: string;
  /** Agent's HTTP server port. Replaces the `PORT_SENTINEL` token (4042)
   *  baked into the shipped templates so the on-disk content matches what
   *  `getDefaultJobs()` produces today. */
  port: number;
}

export interface InstallReport {
  installed: string[];      // slugs that gained or refreshed their .md
  retired: string[];        // slugs removed from templates (now retired)
  errors: Array<{ slug?: string; reason: string }>;
}

const PORT_SENTINEL = '4042';

export function installBuiltinJobs(opts: InstallBuiltinJobsOptions): InstallReport {
  const { agentStateDir, packageRoot, port } = opts;

  const templatesDir = resolveTemplatesDir(packageRoot);
  if (!templatesDir) {
    return {
      installed: [],
      retired: [],
      errors: [
        {
          reason:
            'No agentmd templates directory found under <packageRoot>/dist/scaffold/templates/jobs/instar/ ' +
            'nor <packageRoot>/src/scaffold/templates/jobs/instar/. Skipping built-in job install.',
        },
      ],
    };
  }

  const installedDir = path.join(agentStateDir, 'jobs', 'instar');
  const scheduleDir = path.join(agentStateDir, 'jobs', 'schedule');
  const userDir = path.join(agentStateDir, 'jobs', 'user');
  const keysDir = path.join(agentStateDir, 'keys');
  fs.mkdirSync(installedDir, { recursive: true });
  fs.mkdirSync(scheduleDir, { recursive: true });
  fs.mkdirSync(keysDir, { recursive: true });
  // User dir is created by Phase 3 migrate; we just verify it stays a
  // regular directory if it exists (defense-in-depth for invariant 4).
  if (fs.existsSync(userDir)) {
    const stat = fs.lstatSync(userDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return {
        installed: [],
        retired: [],
        errors: [
          {
            reason:
              `User namespace at ${userDir} is not a regular directory ` +
              `(symlink or file). Refusing to install built-in jobs — fix this first.`,
          },
        ],
      };
    }
  }

  const templateFiles = fs
    .readdirSync(templatesDir)
    .filter((f) => f.endsWith('.md') && f !== '.gitkeep')
    .sort();

  const report: InstallReport = { installed: [], retired: [], errors: [] };
  const shippedSlugs = new Set<string>();

  for (const file of templateFiles) {
    const slug = path.basename(file, '.md');
    shippedSlugs.add(slug);

    let raw = fs.readFileSync(path.join(templatesDir, file), 'utf-8');
    // Substitute the per-agent port. The sentinel `4042` was baked into the
    // template by regen-default-job-templates.mjs; replacing it here keeps
    // the on-disk content in sync with what the agent's runtime expects.
    if (port !== Number(PORT_SENTINEL)) {
      raw = raw.replaceAll(`:-${PORT_SENTINEL}}`, `:-${port}}`);
    }

    const targetMd = path.join(installedDir, file);
    fs.writeFileSync(targetMd, raw, 'utf-8');

    // Generate the per-slug manifest if it doesn't already exist. If the
    // manifest exists, we preserve `enabled` and `disabledAtBodyHash` from
    // the on-disk version (operator may have disabled the default).
    const manifestPath = path.join(scheduleDir, `${slug}.json`);
    let existingEnabled: boolean | undefined;
    let existingDisabledAtBodyHash: string | undefined;
    if (fs.existsSync(manifestPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (typeof existing.enabled === 'boolean') existingEnabled = existing.enabled;
        if (typeof existing.disabledAtBodyHash === 'string') {
          existingDisabledAtBodyHash = existing.disabledAtBodyHash;
        }
      } catch {
        // malformed; we'll overwrite with a fresh one
      }
    }

    const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) {
      report.errors.push({ slug, reason: 'Template missing YAML frontmatter' });
      continue;
    }
    let frontmatter: Record<string, unknown>;
    try {
      const parsed = yaml.load(match[1], { schema: yaml.FAILSAFE_SCHEMA });
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('frontmatter must be an object');
      }
      frontmatter = parsed as Record<string, unknown>;
    } catch (err) {
      report.errors.push({ slug, reason: `Failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const manifest: Record<string, unknown> = {
      slug,
      origin: 'instar',
      schedule: frontmatter.schedule,
      enabled: existingEnabled !== undefined ? existingEnabled : frontmatter.enabled !== 'false',
      execute: { type: 'agentmd' },
      manifestVersion: 1,
    };
    if (existingDisabledAtBodyHash) {
      manifest.disabledAtBodyHash = existingDisabledAtBodyHash;
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    report.installed.push(slug);
  }

  // Retire defaults that are no longer shipped.
  if (fs.existsSync(installedDir)) {
    for (const f of fs.readdirSync(installedDir)) {
      if (!f.endsWith('.md')) continue;
      const slug = path.basename(f, '.md');
      if (shippedSlugs.has(slug)) continue;

      // Remove the installed body. The per-slug manifest is left in place
      // with enabled:false and a retiredAt timestamp so the operator can
      // see it in the Dashboard. Spec §Retired-defaults flow.
      try {
        SafeFsExecutor.safeUnlinkSync(path.join(installedDir, f), { operation: 'installBuiltinJobs retire default' });
        const manifestPath = path.join(scheduleDir, `${slug}.json`);
        if (fs.existsSync(manifestPath)) {
          try {
            const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            existing.enabled = false;
            existing.retiredAt = new Date().toISOString();
            existing.retiredReason = 'instar-default-removed';
            fs.writeFileSync(manifestPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
          } catch {
            // manifest malformed — leave alone
          }
        }
        report.retired.push(slug);
      } catch (err) {
        report.errors.push({ slug, reason: `Failed to retire: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  // Copy the signed lock-file + public key.
  const lockSrc = path.join(packageRoot, 'dist', 'jobs', 'instar.lock.json');
  const lockDst = path.join(agentStateDir, 'jobs', 'instar.lock.json');
  if (fs.existsSync(lockSrc)) {
    fs.copyFileSync(lockSrc, lockDst);
  } else {
    // No signed lock-file shipped (build did not have a signing key). Remove
    // any stale lock-file so the runtime sees `absent` → lockTrust=untrusted-no-lockfile.
    if (fs.existsSync(lockDst)) {
      SafeFsExecutor.safeUnlinkSync(lockDst, { operation: 'installBuiltinJobs remove stale lockfile' });
    }
  }

  const pubSrc = path.join(packageRoot, 'dist', 'keys', 'instar-release-pub.pem');
  const pubDst = path.join(keysDir, 'instar-release-pub.pem');
  if (fs.existsSync(pubSrc)) {
    fs.copyFileSync(pubSrc, pubDst);
  }

  return report;
}

function resolveTemplatesDir(packageRoot: string): string | null {
  const candidates = [
    path.join(packageRoot, 'dist', 'scaffold', 'templates', 'jobs', 'instar'),
    path.join(packageRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      // Verify there's at least one .md file (otherwise we'd skip silently).
      const hasMd = fs.readdirSync(c).some((f) => f.endsWith('.md'));
      if (hasMd) return c;
    }
  }
  return null;
}
