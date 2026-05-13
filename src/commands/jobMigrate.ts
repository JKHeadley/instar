/**
 * jobMigrate — Phase 3 migration script for INSTAR-JOBS-AS-AGENTMD spec.
 *
 * Reads `.instar/jobs.json` and produces:
 *   - `.instar/jobs/instar/<slug>.md` for default jobs whose body matched
 *     the shipped template via normalized SHA-256
 *   - `.instar/jobs/user/<slug>.md` for user-authored jobs and forked
 *     defaults (body did not match the template, or slug not in the lock-file)
 *   - `.instar/jobs/schedule/<slug>.json` per-slug manifests
 *   - `.instar/jobs.json.pre-migrate-<ts>` rollback anchor
 *
 * Body match algorithm: normalize then sha256 (CRLF→LF, ZWSP/ZWNJ/ZWJ/BOM
 * strip, trimEnd + single trailing newline, sha256). Near-miss is
 * Levenshtein distance > 75% of max length — the operator gets a three-
 * choice prompt (interactive) or `--default-action` value (non-interactive).
 *
 * `--abandon` writes `.instar/jobs/.migration-abandoned.json` and deletes
 * `.instar/jobs/schedule/`, leaving `jobs.json` intact for full rollback.
 *
 * Idempotent. Safe to run multiple times. The release-cut gate refuses to
 * delete `jobs.json` until `.instar/jobs/.migration-complete.json` exists.
 *
 * Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §Migration script.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export type DefaultAction = 'fork' | 'rename' | 'skip' | 'fail';

export interface JobMigrateOptions {
  agentStateDir: string;
  packageRoot: string;
  defaultAction?: DefaultAction;
  report?: boolean;
  abandon?: boolean;
  interactive?: boolean; // tests pass false; CLI passes true
}

export interface MigrationOutcome {
  status: 'completed' | 'aborted' | 'reported' | 'abandoned';
  backupPath?: string;
  perEntry: Array<{
    slug: string;
    action: 'migrated-instar' | 'forked-user' | 'renamed-user' | 'skipped' | 'failed' | 'kept-user';
    reason?: string;
    targetPath?: string;
  }>;
  errors: string[];
}

const ZERO_WIDTH_RE = /[​-‍﻿]/g;

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(ZERO_WIDTH_RE, '').trimEnd() + '\n';
}

function sha256(s: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) matrix[i][j] = matrix[i - 1][j - 1];
      else matrix[i][j] = 1 + Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]);
    }
  }
  return matrix[a.length][b.length];
}

function nearMiss(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  if (max === 0) return false;
  return levenshtein(normalize(a), normalize(b)) <= 0.25 * max;
}

interface ShippedDefault {
  slug: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

function loadShippedDefaults(packageRoot: string): Map<string, ShippedDefault> {
  const map = new Map<string, ShippedDefault>();
  const candidates = [
    path.join(packageRoot, 'dist', 'scaffold', 'templates', 'jobs', 'instar'),
    path.join(packageRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === '.gitkeep') continue;
      const slug = path.basename(f, '.md');
      if (map.has(slug)) continue;
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!m) continue;
      let fm: Record<string, unknown>;
      try {
        fm = yaml.load(m[1], { schema: yaml.FAILSAFE_SCHEMA }) as Record<string, unknown>;
      } catch {
        continue;
      }
      map.set(slug, { slug, body: m[2], frontmatter: fm ?? {} });
    }
    if (map.size > 0) break;
  }
  return map;
}

function writeUserTemplate(userDir: string, slug: string, entry: any): string {
  fs.mkdirSync(userDir, { recursive: true });
  const fm: Record<string, unknown> = {
    name: entry.name,
    description: entry.description,
    schedule: entry.schedule,
    priority: entry.priority,
    expectedDurationMinutes: entry.expectedDurationMinutes,
    model: entry.model,
    enabled: entry.enabled !== false,
  };
  if (Array.isArray(entry.tags)) fm.tags = entry.tags;
  if (entry.gate) fm.gate = entry.gate;
  if (typeof entry.telegramNotify === 'boolean') fm.telegramNotify = entry.telegramNotify;
  // User jobs default to minimal Read allowlist per spec §Trust Model.
  fm.toolAllowlist = ['Read'];
  const fmYaml = yaml.dump(fm, { lineWidth: -1, noRefs: true, quotingType: '"' }).trimEnd();
  const body = (entry.execute && typeof entry.execute.value === 'string') ? entry.execute.value : '';
  const content = `---\n${fmYaml}\n---\n${body.endsWith('\n') ? body : body + '\n'}`;
  const target = path.join(userDir, `${slug}.md`);
  fs.writeFileSync(target, content, 'utf-8');
  return target;
}

function writeManifest(scheduleDir: string, slug: string, origin: 'instar' | 'user', entry: any): string {
  fs.mkdirSync(scheduleDir, { recursive: true });
  const manifest: Record<string, unknown> = {
    slug,
    origin,
    schedule: entry.schedule,
    enabled: entry.enabled !== false,
    execute: entry.execute && entry.execute.type === 'prompt' ? { type: 'agentmd' } : entry.execute,
    manifestVersion: 1,
  };
  const target = path.join(scheduleDir, `${slug}.json`);
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return target;
}

export function jobsMigrate(opts: JobMigrateOptions): MigrationOutcome {
  const { agentStateDir, packageRoot } = opts;
  const defaultAction: DefaultAction = opts.defaultAction ?? 'fail';
  const jobsJsonPath = path.join(agentStateDir, 'jobs.json');
  const jobsRoot = path.join(agentStateDir, 'jobs');
  const userDir = path.join(jobsRoot, 'user');
  const scheduleDir = path.join(jobsRoot, 'schedule');
  const instarDir = path.join(jobsRoot, 'instar');
  const completedMarker = path.join(jobsRoot, '.migration-complete.json');
  const abandonedMarker = path.join(jobsRoot, '.migration-abandoned.json');

  const outcome: MigrationOutcome = { status: 'completed', perEntry: [], errors: [] };

  // ── Abandon path ────────────────────────────────────────────────────
  if (opts.abandon) {
    fs.mkdirSync(jobsRoot, { recursive: true });
    if (fs.existsSync(scheduleDir)) {
      SafeFsExecutor.safeRmSync(scheduleDir, { recursive: true, force: true, operation: 'jobsMigrate abandon: remove schedule/' });
    }
    if (fs.existsSync(instarDir)) {
      SafeFsExecutor.safeRmSync(instarDir, { recursive: true, force: true, operation: 'jobsMigrate abandon: remove instar/' });
    }
    fs.writeFileSync(
      abandonedMarker,
      JSON.stringify({ abandonedAt: new Date().toISOString(), reason: 'operator-initiated abandon' }, null, 2),
      'utf-8',
    );
    outcome.status = 'abandoned';
    return outcome;
  }

  if (!fs.existsSync(jobsJsonPath)) {
    outcome.errors.push(`No jobs.json at ${jobsJsonPath}; nothing to migrate.`);
    outcome.status = 'aborted';
    return outcome;
  }

  let rawJobs: any[];
  try {
    rawJobs = JSON.parse(fs.readFileSync(jobsJsonPath, 'utf-8'));
    if (!Array.isArray(rawJobs)) throw new Error('jobs.json root must be an array');
  } catch (err) {
    outcome.errors.push(`Failed to parse jobs.json: ${err instanceof Error ? err.message : String(err)}`);
    outcome.status = 'aborted';
    return outcome;
  }

  const shipped = loadShippedDefaults(packageRoot);

  // ── Dry-run / report path ───────────────────────────────────────────
  if (opts.report) {
    for (const entry of rawJobs) {
      const slug = entry.slug;
      const action = classifyEntry(entry, shipped);
      const reason = action.kind === 'migrated-instar' ? undefined : action.reason;
      outcome.perEntry.push({ slug, action: action.kind as MigrationOutcome['perEntry'][number]['action'], reason });
    }
    outcome.status = 'reported';
    return outcome;
  }

  // ── Write backup BEFORE any destructive write ───────────────────────
  fs.mkdirSync(jobsRoot, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(agentStateDir, `jobs.json.pre-migrate-${ts}`);
  fs.copyFileSync(jobsJsonPath, backupPath);
  outcome.backupPath = backupPath;

  // ── Per-entry migration ─────────────────────────────────────────────
  for (const entry of rawJobs) {
    const slug = entry.slug;
    if (!slug || typeof slug !== 'string') {
      outcome.errors.push(`Skipping entry without slug: ${JSON.stringify(entry).slice(0, 100)}`);
      continue;
    }

    const classification = classifyEntry(entry, shipped);

    try {
      if (classification.kind === 'migrated-instar') {
        // Body matched. Write per-slug manifest pointing at the instar template.
        writeManifest(scheduleDir, slug, 'instar', entry);
        outcome.perEntry.push({ slug, action: 'migrated-instar' });
        continue;
      }

      if (classification.kind === 'near-miss-default') {
        // Body did NOT match a shipped default. Apply --default-action.
        if (defaultAction === 'fail') {
          outcome.errors.push(
            `Near-miss on default "${slug}": body does not match shipped template. ` +
            `Re-run with --default-action=fork|rename|skip.`,
          );
          outcome.status = 'aborted';
          return outcome;
        }
        if (defaultAction === 'skip') {
          outcome.perEntry.push({ slug, action: 'skipped', reason: 'near-miss, --default-action=skip' });
          continue;
        }
        const targetSlug = defaultAction === 'rename' ? `${slug}-user` : slug;
        const tgt = writeUserTemplate(userDir, targetSlug, entry);
        writeManifest(scheduleDir, targetSlug, 'user', entry);
        outcome.perEntry.push({
          slug: targetSlug,
          action: defaultAction === 'rename' ? 'renamed-user' : 'forked-user',
          reason: classification.reason,
          targetPath: tgt,
        });
        continue;
      }

      if (classification.kind === 'kept-user' || classification.kind === 'forked-user') {
        const tgt = writeUserTemplate(userDir, slug, entry);
        writeManifest(scheduleDir, slug, 'user', entry);
        outcome.perEntry.push({
          slug,
          action: classification.kind === 'kept-user' ? 'kept-user' : 'forked-user',
          reason: classification.reason,
          targetPath: tgt,
        });
        continue;
      }

      // Non-prompt entries (skill, script) — leave them in jobs.json.
      outcome.perEntry.push({ slug, action: 'skipped', reason: classification.reason });
    } catch (err) {
      outcome.errors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
      outcome.perEntry.push({ slug, action: 'failed' });
    }
  }

  // ── Completion marker (operator confirms via dashboard before jobs.json delete) ──
  // We do NOT write .migration-complete.json automatically — that's the
  // operator's job via the Dashboard "Confirm migration complete" button.
  // The release-cut gate refuses to delete jobs.json until this marker exists.

  // Remove abandonment marker if present (a new migrate run is a re-attempt).
  if (fs.existsSync(abandonedMarker)) {
    SafeFsExecutor.safeUnlinkSync(abandonedMarker, { operation: 'jobsMigrate clear abandonment marker on re-run' });
  }
  if (fs.existsSync(completedMarker)) {
    // operator may run migrate multiple times; the completion marker should
    // be recreated by the Dashboard, not by the script.
  }

  return outcome;
}

type EntryClassification =
  | { kind: 'migrated-instar' }
  | { kind: 'near-miss-default'; reason: string }
  | { kind: 'forked-user'; reason: string }
  | { kind: 'kept-user'; reason: string }
  | { kind: 'skipped'; reason: string };

function classifyEntry(entry: any, shipped: Map<string, ShippedDefault>): EntryClassification {
  if (!entry.execute || entry.execute.type !== 'prompt') {
    return { kind: 'skipped', reason: `execute.type=${entry.execute?.type ?? 'absent'} — only prompt-type entries migrate to agentmd` };
  }
  const shippedDefault = shipped.get(entry.slug);
  if (!shippedDefault) {
    // Slug not in the shipped defaults → user job.
    return { kind: 'kept-user', reason: 'slug not in shipped defaults' };
  }
  const entryBody = entry.execute.value ?? '';
  if (sha256(normalize(entryBody)) === sha256(normalize(shippedDefault.body))) {
    return { kind: 'migrated-instar' };
  }
  // Slug matches a shipped default but body differs. The --default-action
  // flag drives the resolution (fork | rename | skip | fail). The
  // Levenshtein distance is informational only for the operator-facing
  // report — it doesn't change the routing.
  const dist = levenshtein(normalize(entryBody), normalize(shippedDefault.body));
  const maxLen = Math.max(entryBody.length, shippedDefault.body.length);
  const pct = maxLen ? Math.round((dist / maxLen) * 100) : 100;
  return {
    kind: 'near-miss-default',
    reason: `body differs from shipped default (~${pct}% changed by Levenshtein)`,
  };
}
