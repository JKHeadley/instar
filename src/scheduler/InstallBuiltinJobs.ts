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
import { Cron } from 'croner';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { buildPerSlugManifest, coerceDurationMinutes, coerceBool } from './buildPerSlugManifest.js';
import { validateManifest } from './AgentMdJobLoader.js';
import type { JobPriority, ModelTier } from '../core/types.js';
import { THINKING_MODES } from '../core/topicProfileValidation.js';

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

/** Job Scheduler awareness bullet (CLAUDE.md template + migration). Marker: `shippedSchedule`. */
export const BUILTIN_SCHEDULE_EDIT_AWARENESS =
  '- **Changing a BUILT-IN job\'s schedule — edit `schedule` in `.instar/jobs/schedule/<slug>.json`.** ' +
  'Updates keep it: each install records the shipped value as `shippedSchedule`, and a `schedule` that differs ' +
  'from it is treated as yours. Set it back to the shipped value to follow future defaults again. A manifest ' +
  'written before an update that adds `shippedSchedule` takes the shipped value once, so re-apply an earlier ' +
  'edit after that update. Applies at the next server restart.\n';

/**
 * Job Scheduler awareness bullet for the per-job thinking mode (docs/specs/job-launch-intent-record.md,
 * Migration parity): CLAUDE.md template + migrateClaudeMd insert, byte-identical. Content-sniff key:
 * the phrase "a job can set `thinkingMode`" (the bare word already appears in the topic-profile line).
 */
export const JOB_THINKING_MODE_SNIFF = 'a job can set `thinkingMode`';
export const JOB_THINKING_MODE_AWARENESS =
  '- **Per-job thinking mode:** a job can set `thinkingMode` in its manifest to choose how hard the engine thinks ' +
  '(`off`/`low`/`medium`/`high`/`max`; for a built-in or agentmd job that is `.instar/jobs/schedule/<slug>.json`). ' +
  'Absent means the engine default. Each run row in `GET /jobs/SLUG/history` carries a `launch` record: what was ' +
  'requested, what the launch actually sent (`applied`), what was dropped and why (`not-supported` on an engine with ' +
  'no reasoning setting, `overridden-by-effort-pin`, `invalid`), and the CLI version (`unknown` until it is read). ' +
  '`applied` means sent, not that it helped.\n';

const PORT_SENTINEL = '4042';

/** job-cost-reduction §5.1 — a shipped script's name is a bare filename. */
export const SCRIPT_FILE_RE = /^[a-z0-9-]+\.mjs$/;

/**
 * Copy the shipped `scripts/*.mjs` into `.instar/jobs/instar/scripts/`.
 * Always overwrites (built-ins are never install-if-missing) and prunes any
 * `.mjs` no longer shipped. Copied byte-for-byte: the lock-file's scriptHash
 * covers the raw bytes, so no port substitution is applied (scripts read
 * INSTAR_PORT from their environment).
 */
function installBuiltinScripts(templatesDir: string, installedDir: string, report: InstallReport): Set<string> {
  const srcDir = path.join(templatesDir, 'scripts');
  const dstDir = path.join(installedDir, 'scripts');
  const shipped = new Set<string>();
  if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir).sort()) {
      if (!f.endsWith('.mjs')) continue;
      if (!SCRIPT_FILE_RE.test(f)) {
        report.errors.push({ reason: `shipped script "${f}" refused: name must match ${SCRIPT_FILE_RE}` });
        continue;
      }
      const src = path.join(srcDir, f);
      const st = fs.lstatSync(src);
      if (!st.isFile() || st.isSymbolicLink()) {
        report.errors.push({ reason: `shipped script "${f}" refused: not a regular file` });
        continue;
      }
      const dst = path.join(dstDir, f);
      // A symlink planted at the target would redirect the write; remove it first.
      if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) {
        SafeFsExecutor.safeUnlinkSync(dst, { operation: 'installBuiltinJobs replace symlinked script' });
      }
      fs.copyFileSync(src, dst);
      shipped.add(f);
    }
  }
  if (fs.existsSync(dstDir)) {
    for (const f of fs.readdirSync(dstDir)) {
      if (!f.endsWith('.mjs') || shipped.has(f)) continue;
      try {
        SafeFsExecutor.safeUnlinkSync(path.join(dstDir, f), { operation: 'installBuiltinJobs prune stale script' });
      } catch (err) {
        report.errors.push({ reason: `Failed to prune stale script ${f}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
  return shipped;
}

function isValidCron(expr: string): boolean {
  try {
    new Cron(expr, { paused: true }).stop();
    return true;
  } catch {
    // @silent-fallback-ok — the caller reports the reset in InstallReport.errors.
    return false;
  }
}

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
  const shippedScripts = installBuiltinScripts(templatesDir, installedDir, report);

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
    let existingSchedule: string | undefined;
    let existingShippedSchedule: string | undefined;
    // Operator-set thinking mode on an installed built-in (the awareness bullet tells
    // agents to set it in this manifest) survives reinstall, like `enabled` does.
    let existingThinkingMode: string | undefined;
    if (fs.existsSync(manifestPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (typeof existing.enabled === 'boolean') existingEnabled = existing.enabled;
        if (typeof existing.disabledAtBodyHash === 'string') {
          existingDisabledAtBodyHash = existing.disabledAtBodyHash;
        }
        if (typeof existing.schedule === 'string') existingSchedule = existing.schedule;
        if (typeof existing.shippedSchedule === 'string') existingShippedSchedule = existing.shippedSchedule;
        if (typeof existing.thinkingMode === 'string'
          && (THINKING_MODES as readonly string[]).includes(existing.thinkingMode)) {
          existingThinkingMode = existing.thinkingMode;
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

    // Coerce the required numeric field (frontmatter is all-strings under
    // FAILSAFE_SCHEMA); fail loud rather than write a NaN/null manifest.
    const durationMinutes = coerceDurationMinutes(frontmatter.expectedDurationMinutes);
    if (durationMinutes === null) {
      report.errors.push({ slug, reason: `frontmatter "expectedDurationMinutes" missing or not a positive number (got ${JSON.stringify(frontmatter.expectedDurationMinutes)})` });
      continue;
    }

    // job-cost-reduction §5.1: a `runner: script` template gets a script
    // manifest whose value is a bare, validated filename — never a command.
    let execute: { type: 'agentmd' } | { type: 'script'; value: string } = { type: 'agentmd' };
    if (frontmatter.runner === 'script') {
      const scriptFile = frontmatter.script;
      if (typeof scriptFile !== 'string' || !SCRIPT_FILE_RE.test(scriptFile) || scriptFile !== `${slug}.mjs`) {
        report.errors.push({ slug, reason: `runner: script needs script: ${slug}.mjs matching ${SCRIPT_FILE_RE} (got ${JSON.stringify(scriptFile)}) — refused` });
        continue;
      }
      if (!shippedScripts.has(scriptFile)) {
        report.errors.push({ slug, reason: `runner: script names ${scriptFile}, which is not shipped — refused` });
        continue;
      }
      execute = { type: 'script', value: scriptFile };
    } else if (frontmatter.runner !== undefined) {
      report.errors.push({ slug, reason: `unknown runner ${JSON.stringify(frontmatter.runner)} — refused` });
      continue;
    }

    // Build the manifest through the single typed constructor — priority,
    // expectedDurationMinutes, model + pass-throughs are carried here (their
    // omission is the bug this fixes). The typed return means a dropped required
    // field is a compile error.
    // An operator's schedule edit survives updates (CMT-1586, fb-d075a5c4-c4c).
    // `shippedSchedule` records the template's schedule at each write, so a
    // saved `schedule` that differs from it was changed on this agent and is
    // kept; one that still matches follows a new shipped default. A manifest
    // written before this field existed cannot be told apart and takes the
    // shipped value once (today's behaviour), after which edits are kept.
    const shippedSchedule = String(frontmatter.schedule ?? '');
    let schedule = shippedSchedule;
    if (existingSchedule !== undefined && existingShippedSchedule !== undefined
      && existingSchedule.trim() && existingSchedule !== existingShippedSchedule) {
      if (isValidCron(existingSchedule)) {
        schedule = existingSchedule;
      } else {
        report.errors.push({ slug, reason: `saved schedule ${JSON.stringify(existingSchedule)} is not a valid cron expression; reset to the shipped ${JSON.stringify(shippedSchedule)}` });
      }
    }

    const manifest = buildPerSlugManifest({
      slug,
      origin: 'instar',
      schedule,
      shippedSchedule,
      priority: frontmatter.priority as JobPriority,
      expectedDurationMinutes: durationMinutes,
      enabled: existingEnabled !== undefined ? existingEnabled : frontmatter.enabled !== 'false',
      execute,
      model: frontmatter.model != null && String(frontmatter.model).trim() ? (String(frontmatter.model) as ModelTier) : undefined,
      framework: typeof frontmatter.framework === 'string' && frontmatter.framework.trim()
        ? frontmatter.framework as import('../core/intelligenceProviderFactory.js').IntelligenceFramework
        : undefined,
      frameworkModel: typeof frontmatter.frameworkModel === 'string' && frontmatter.frameworkModel.trim()
        ? frontmatter.frameworkModel
        : undefined,
      leanContext: coerceBool(frontmatter.leanContext),
      // Carried as written: the producer self-check below (validateManifest) refuses an
      // out-of-enum value by name, so an invalid frontmatter value is reported, never installed.
      thinkingMode: existingThinkingMode !== undefined
        ? existingThinkingMode as import('./AgentMdJobLoader.js').PerSlugManifest['thinkingMode']
        : frontmatter.thinkingMode != null
        ? frontmatter.thinkingMode as import('./AgentMdJobLoader.js').PerSlugManifest['thinkingMode']
        : undefined,
      tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : undefined,
      unrestrictedTools: coerceBool(frontmatter.unrestrictedTools),
      gate: frontmatter.gate != null ? String(frontmatter.gate) : undefined,
      telegramNotify:
        typeof frontmatter.telegramNotify === 'boolean'
          ? frontmatter.telegramNotify
          : frontmatter.telegramNotify === 'on-alert'
            ? 'on-alert'
            : coerceBool(frontmatter.telegramNotify),
      // Closed two-value set; anything else (typo, absent) → undefined = legacy
      // full-project-MCP behavior. validateManifest re-checks the enum below.
      mcpAccess:
        frontmatter.mcpAccess === 'none' || frontmatter.mcpAccess === 'project'
          ? frontmatter.mcpAccess
          : undefined,
      // Spec §2.8/D11 — carry the per-machine-independent flag from frontmatter
      // (FAILSAFE_SCHEMA parses it as the string "true"/"false"; coerceBool handles both).
      perMachineIndependent: coerceBool(frontmatter.perMachineIndependent),
      // Jev job-completion audit vocabulary (jev-job-supervision spec). The
      // manifest is the loader's authority, so an un-carried value is inert —
      // which would silently let the audit's own batch job audit itself.
      completionAudit:
        frontmatter.completionAudit === 'excluded'
        || frontmatter.completionAudit === 'eligible'
        || frontmatter.completionAudit === 'priority'
          ? frontmatter.completionAudit
          : undefined,
      declaredEffects: Array.isArray(frontmatter.declaredEffects)
        ? (frontmatter.declaredEffects as unknown[]).filter((e): e is string => typeof e === 'string')
        : undefined,
      conditionalEffects: Array.isArray(frontmatter.conditionalEffects)
        ? (frontmatter.conditionalEffects as unknown[]).filter((e): e is string => typeof e === 'string')
        : undefined,
      disabledAtBodyHash: existingDisabledAtBodyHash,
    });

    // Producer self-check: validate our OWN output against the loader's contract
    // and fail LOUD at generation time, rather than writing a manifest the loader
    // will silently reject at load (the failure mode this whole fix exists for).
    try {
      validateManifest(manifest, slug);
    } catch (err) {
      report.errors.push({ slug, reason: `generated manifest failed validation: ${err instanceof Error ? err.message : String(err)}` });
      continue;
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
