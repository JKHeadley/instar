#!/usr/bin/env node
/**
 * regen-default-job-templates.mjs — convert getDefaultJobs() entries into
 * markdown templates under src/scaffold/templates/jobs/instar/<slug>.md.
 *
 * This is a Phase 2 helper. It runs once per default-job edit (and as part
 * of the pre-release smoke check). Output is committed to git; the script
 * just keeps the templates in sync with the canonical source-of-truth list
 * in src/commands/init.ts::getDefaultJobs.
 *
 * Only entries whose `execute.type === 'prompt'` are converted to agentmd
 * templates. Entries with `execute.type === 'script'` remain legacy
 * jobs.json entries (out of scope for agentmd; covered by the legacy code
 * path in JobScheduler).
 *
 * The body of each template is the EXACT bytes of `execute.value` — that is
 * the golden-output equivalence assertion (spec §Testing Strategy #1).
 *
 * Usage:
 *   node scripts/regen-default-job-templates.mjs            (writes files)
 *   node scripts/regen-default-job-templates.mjs --dry-run  (prints summary)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { getDefaultJobs } from '../dist/commands/init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'src', 'scaffold', 'templates', 'jobs', 'instar');

// The default port placeholder — getDefaultJobs() interpolates this into
// some prompt bodies. We use a sentinel value here so the bodies on disk
// are deterministic; at runtime, installBuiltinJobs replaces the sentinel
// with the agent's actual port. The sentinel format matches what existing
// template interpolation looks for in the codebase.
const PORT_SENTINEL = 4042;

function frontmatterFor(entry) {
  const fm = {
    name: entry.name,
    description: entry.description,
    schedule: entry.schedule,
    priority: entry.priority,
    expectedDurationMinutes: entry.expectedDurationMinutes,
    model: entry.model,
    enabled: entry.enabled,
  };
  if (Array.isArray(entry.tags) && entry.tags.length > 0) fm.tags = entry.tags;
  if (entry.gate) fm.gate = entry.gate;
  if (entry.mcpAccess) fm.mcpAccess = entry.mcpAccess;
  if (typeof entry.telegramNotify === 'boolean') fm.telegramNotify = entry.telegramNotify;
  // job-cost-reduction §5.1: script-runner keys. The entry keeps
  // execute.type 'prompt' with the full body (the rollback + narrator
  // context); these keys make the installer write a script manifest.
  if (entry.runner === 'script') {
    fm.runner = 'script';
    const script = entry.script ?? entry.scriptFile;
    if (typeof script === 'string') fm.script = script;
  }
  if (entry.scriptTimeoutMinutes !== undefined) fm.scriptTimeoutMinutes = entry.scriptTimeoutMinutes;
  if (Array.isArray(entry.anomalies) && entry.anomalies.length > 0) {
    fm.anomalies = entry.anomalies.map((a) => {
      // Each kind MUST carry its class: defaulting one would silently turn a
      // critical push into a 6-hour wait (or the reverse).
      if (!a || typeof a.kind !== 'string' || (a.class !== 'critical' && a.class !== 'recoverable')) {
        throw new Error(`${entry.slug}: anomalies entries must be { kind, class: 'critical' | 'recoverable' }`);
      }
      return { kind: a.kind, class: a.class };
    });
  }
  if (entry.runner === 'script' && entry.supervision) fm.supervision = entry.supervision;
  if (entry.scriptSupervision) fm.scriptSupervision = entry.scriptSupervision;
  if (entry.triageEvidence) fm.triageEvidence = entry.triageEvidence;
  for (const k of ['triageFields', 'triageBareOk', 'triageBareSkipped']) {
    if (Array.isArray(entry[k]) && entry[k].length > 0) fm[k] = entry[k];
  }
  // Phase 1b: every shipped default is allowed full tools to preserve today's
  // behavior. Future PRs (per-slug allowlist narrowing) will refine these.
  fm.toolAllowlist = '*';
  fm.unrestrictedTools = true;
  return fm;
}

function renderTemplate(entry) {
  const fm = frontmatterFor(entry);
  const fmYaml = yaml.dump(fm, { lineWidth: -1, noRefs: true, quotingType: '"' }).trimEnd();
  const body = entry.execute.value.endsWith('\n') ? entry.execute.value : entry.execute.value + '\n';
  return `---\n${fmYaml}\n---\n${body}`;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const defaults = getDefaultJobs(PORT_SENTINEL);
  const promptDefaults = defaults.filter((j) => j.execute && j.execute.type === 'prompt');
  const scriptDefaults = defaults.filter((j) => j.execute && j.execute.type === 'script');

  console.log(`[regen-defaults] ${defaults.length} total defaults`);
  console.log(`[regen-defaults]   ${promptDefaults.length} prompt-type → markdown templates`);
  console.log(`[regen-defaults]   ${scriptDefaults.length} script-type → legacy jobs.json (skipped)`);

  if (dryRun) {
    console.log('[regen-defaults] --dry-run: not writing files');
    for (const j of promptDefaults) console.log(`  would write ${j.slug}.md`);
    console.log('  (hand-written templates not in getDefaultJobs() are never pruned)');
    return;
  }

  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

  // Track files we wrote (only to report which templates are hand-written).
  const written = new Set();
  for (const job of promptDefaults) {
    const target = path.join(TEMPLATES_DIR, `${job.slug}.md`);
    fs.writeFileSync(target, renderTemplate(job), 'utf-8');
    written.add(`${job.slug}.md`);
    console.log(`  wrote ${job.slug}.md (${job.execute.value.length} body bytes)`);
  }

  // NEVER prune. Most shipped templates are hand-written .md files with no
  // getDefaultJobs() entry (job-cost-reduction: 16 of the 17 converted jobs),
  // so "not produced by this script" does NOT mean "stale" — the old prune
  // step would have deleted them. Retiring a default is a deliberate file
  // deletion in a PR; the installer's retired-defaults flow handles the agent side.
  const handWritten = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.md') && !written.has(f));
  if (handWritten.length > 0) {
    console.log(`  kept ${handWritten.length} hand-written template(s) not in getDefaultJobs(): ${handWritten.join(', ')}`);
  }
}

main();
