#!/usr/bin/env node
/**
 * docs-coverage.mjs — measure documentation coverage of shipped capabilities.
 *
 * Walks src/ to enumerate every shipped capability (routes, commands, jobs,
 * hooks, skills, exported classes per subsystem), cross-references each
 * against README.md and site/src/content/docs/, and produces a coverage
 * report. Designed to converge by construction — deterministic enumeration,
 * not stochastic discovery.
 *
 * Born from a multi-pass agent-driven audit (May 2026) that proved manual
 * audit passes don't converge on a codebase with this much surface drift.
 * The structural answer is a programmatic check that runs in CI.
 *
 * Output:
 *   - .instar/docs-coverage.json — machine-readable inventory + per-item
 *     coverage tags (DOCUMENTED / PARTIAL / UNDOCUMENTED)
 *   - .instar/docs-coverage.md — human-readable report grouped by subsystem
 *   - exit code 0 if coverage >= threshold, 1 otherwise
 *
 * Usage:
 *   node scripts/docs-coverage.mjs           # report only, exit 0
 *   node scripts/docs-coverage.mjs --check   # exit 1 if below threshold
 *   node scripts/docs-coverage.mjs --json    # JSON to stdout
 *
 * Thresholds (override via env):
 *   INSTAR_DOCS_COVERAGE_MIN — minimum overall coverage % (default 30 — see
 *     note in --check; this is the FLOOR, not the goal. Real goal lives in
 *     the per-category limits below.)
 *   INSTAR_DOCS_COVERAGE_ROUTE_MIN, ..._COMMAND_MIN, ..._JOB_MIN, ..._HOOK_MIN
 *     — per-category floors (each default 30; tightened over time as the
 *     existing gap closes).
 *
 * The floor starts loose because the existing gap is large. The point of
 * shipping the script first is to prevent further regression while we
 * close the existing gap. Tighten the floors after each round of doc work.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const JSON_ONLY = args.has('--json');
const QUIET = args.has('--quiet');

// Resolve repo root. Order of preference:
//   1. INSTAR_DOCS_COVERAGE_ROOT env var (explicit override, used by tests)
//   2. process.cwd() if it contains a src/ directory (running from a repo)
//   3. script's parent directory (default — running from this repo)
function resolveRoot() {
  if (process.env.INSTAR_DOCS_COVERAGE_ROOT) return process.env.INSTAR_DOCS_COVERAGE_ROOT;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'src'))) return cwd;
  return path.resolve(__dirname, '..');
}
const ROOT = resolveRoot();

const SRC_DIR = path.join(ROOT, 'src');
const DOCS_DIR = path.join(ROOT, 'site/src/content/docs');
const README = path.join(ROOT, 'README.md');
const STATE_DIR = path.join(ROOT, '.instar');

// ── Thresholds ──────────────────────────────────────────────────────
const num = (env, def) => {
  const v = process.env[env];
  return v !== undefined ? Number(v) : def;
};
// Floors are calibrated to current state as of script introduction.
// Each doc-update PR should ratchet the relevant floor upward — this is
// how the script enforces non-regression while we close the existing gap.
// Floors below current measured coverage by ~2-3 percentage points to
// allow normal churn without false failures.
const THRESHOLDS = {
  overall: num('INSTAR_DOCS_COVERAGE_MIN', 55),
  route: num('INSTAR_DOCS_COVERAGE_ROUTE_MIN', 55),
  command: num('INSTAR_DOCS_COVERAGE_COMMAND_MIN', 60),
  job: num('INSTAR_DOCS_COVERAGE_JOB_MIN', 85),
  hook: num('INSTAR_DOCS_COVERAGE_HOOK_MIN', 70),
  skill: num('INSTAR_DOCS_COVERAGE_SKILL_MIN', 90),
  class: num('INSTAR_DOCS_COVERAGE_CLASS_MIN', 55),
};

// ── Capability enumeration ──────────────────────────────────────────

/** Routes registered in src/server/routes.ts via router.<verb>('path', ...). */
function enumerateRoutes() {
  const routesFile = path.join(SRC_DIR, 'server/routes.ts');
  if (!fs.existsSync(routesFile)) return [];
  const content = fs.readFileSync(routesFile, 'utf-8');
  const matches = [...content.matchAll(/router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g)];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const id = `${m[1].toUpperCase()} ${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ type: 'route', method: m[1].toUpperCase(), path: m[2], id });
  }
  return out;
}

/** Top-level command files in src/commands/. */
function enumerateCommands() {
  const dir = path.join(SRC_DIR, 'commands');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => {
      const name = f.replace(/\.ts$/, '');
      return { type: 'command', name, id: name, path: `src/commands/${f}` };
    });
}

/** Default job templates shipped with instar. */
function enumerateJobs() {
  const dir = path.join(SRC_DIR, 'scaffold/templates/jobs/instar');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const name = f.replace(/\.md$/, '');
      return { type: 'job', name, id: name, path: `src/scaffold/templates/jobs/instar/${f}` };
    });
}

/** Hook scripts in src/templates/hooks/. */
function enumerateHooks() {
  const dir = path.join(SRC_DIR, 'templates/hooks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(sh|js|mjs)$/.test(f))
    .map(f => {
      const name = f.replace(/\.(sh|js|mjs)$/, '');
      return { type: 'hook', name, id: f, path: `src/templates/hooks/${f}` };
    });
}

/** Skills under skills/. Includes user_invocable flag from frontmatter. */
function enumerateSkills() {
  const dir = path.join(ROOT, 'skills');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir)) {
    const skillFile = path.join(dir, d, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const content = fs.readFileSync(skillFile, 'utf-8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    const userInvocable = !fm || !/user_invocable:\s*["']?false["']?/i.test(fm[1]);
    out.push({ type: 'skill', name: d, id: d, userInvocable, path: `skills/${d}/SKILL.md` });
  }
  return out;
}

/** Top-level exported classes per subsystem. Identified by PascalCase filename. */
function enumerateSubsystemClasses() {
  const subsystems = [
    'core', 'monitoring', 'memory', 'lifeline', 'messaging', 'threadline',
    'scheduler', 'remediation', 'tasks', 'paste', 'privacy', 'tunnel',
    'moltbridge', 'identity', 'knowledge', 'users', 'security', 'providers',
  ];
  const out = [];
  for (const sub of subsystems) {
    const subDir = path.join(SRC_DIR, sub);
    if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) continue;
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith('.ts')) continue;
      if (f.endsWith('.test.ts') || f.endsWith('.types.ts') || f === 'index.ts' || f === 'types.ts') continue;
      const name = f.replace(/\.ts$/, '');
      // Only PascalCase top-level exports count as "classes" for coverage purposes.
      // Lowercase files are utilities not user-facing.
      if (!/^[A-Z]/.test(name)) continue;
      out.push({ type: 'class', subsystem: sub, name, id: `${sub}/${name}`, path: `src/${sub}/${f}` });
    }
  }
  return out;
}

// ── Doc loading ─────────────────────────────────────────────────────

function loadAllDocs() {
  const docs = {};
  if (fs.existsSync(README)) {
    docs['README.md'] = fs.readFileSync(README, 'utf-8');
  }
  if (fs.existsSync(DOCS_DIR)) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(md|mdx)$/.test(e.name)) {
          docs[path.relative(ROOT, full)] = fs.readFileSync(full, 'utf-8');
        }
      }
    };
    walk(DOCS_DIR);
  }
  return docs;
}

// ── Coverage scoring ────────────────────────────────────────────────

function findMentions(capability, docs) {
  // Returns list of doc paths that mention this capability.
  // Coverage strategy varies per capability type.
  let needles = [];
  switch (capability.type) {
    case 'route':
      // Match exact path (with leading /). Substring match — close enough.
      needles = [capability.path];
      break;
    case 'command':
      // Match either `instar <name>` (CLI usage) or just the bare name.
      needles = [`instar ${capability.name}`];
      break;
    case 'job':
      needles = [capability.name];
      break;
    case 'hook':
      needles = [capability.name];
      break;
    case 'skill':
      needles = [capability.name];
      break;
    case 'class':
      needles = [capability.name];
      break;
  }
  const matches = [];
  for (const [docPath, content] of Object.entries(docs)) {
    for (const needle of needles) {
      if (content.includes(needle)) {
        matches.push(docPath);
        break;
      }
    }
  }
  return matches;
}

function classifyCoverage(mentions) {
  if (mentions.length === 0) return 'UNDOCUMENTED';
  if (mentions.length === 1) return 'PARTIAL';
  return 'DOCUMENTED';
}

// ── Report generation ───────────────────────────────────────────────

function buildReport(items, docs) {
  for (const item of items) {
    const mentions = findMentions(item, docs);
    item.mentions = mentions;
    item.coverage = classifyCoverage(mentions);
  }

  const byType = {};
  for (const item of items) {
    if (!byType[item.type]) byType[item.type] = { total: 0, documented: 0, partial: 0, undocumented: 0, items: [] };
    const bucket = byType[item.type];
    bucket.total++;
    bucket.items.push(item);
    if (item.coverage === 'DOCUMENTED') bucket.documented++;
    else if (item.coverage === 'PARTIAL') bucket.partial++;
    else bucket.undocumented++;
  }

  for (const t of Object.keys(byType)) {
    const b = byType[t];
    b.coveragePct = b.total === 0 ? 100 : Math.round(((b.documented + b.partial * 0.5) / b.total) * 100);
  }

  const total = items.length;
  const documented = items.filter(i => i.coverage === 'DOCUMENTED').length;
  const partial = items.filter(i => i.coverage === 'PARTIAL').length;
  const undocumented = total - documented - partial;
  const overallPct = total === 0 ? 100 : Math.round(((documented + partial * 0.5) / total) * 100);

  return {
    generatedAt: new Date().toISOString(),
    totals: { total, documented, partial, undocumented, coveragePct: overallPct },
    thresholds: THRESHOLDS,
    byType,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Documentation Coverage Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Overall');
  lines.push('');
  lines.push(`**Coverage: ${report.totals.coveragePct}%** (${report.totals.documented} documented + ${report.totals.partial} partial of ${report.totals.total} shipped capabilities)`);
  lines.push('');
  lines.push(`Threshold (overall): ${report.thresholds.overall}% — ${report.totals.coveragePct >= report.thresholds.overall ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('## By capability type');
  lines.push('');
  lines.push('| Type | Total | Documented | Partial | Undocumented | Coverage | Floor | Status |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const t of Object.keys(report.byType).sort()) {
    const b = report.byType[t];
    const floor = report.thresholds[t] ?? '—';
    const status = floor === '—' ? '—' : (b.coveragePct >= floor ? 'PASS' : 'FAIL');
    lines.push(`| ${t} | ${b.total} | ${b.documented} | ${b.partial} | ${b.undocumented} | ${b.coveragePct}% | ${floor}% | ${status} |`);
  }
  lines.push('');
  lines.push('## Undocumented items');
  lines.push('');
  for (const t of Object.keys(report.byType).sort()) {
    const undoc = report.byType[t].items.filter(i => i.coverage === 'UNDOCUMENTED');
    if (undoc.length === 0) continue;
    lines.push(`### ${t} (${undoc.length})`);
    lines.push('');
    for (const item of undoc) {
      lines.push(`- \`${item.id}\`${item.path ? ` — \`${item.path}\`` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Partial coverage (single mention)');
  lines.push('');
  for (const t of Object.keys(report.byType).sort()) {
    const partial = report.byType[t].items.filter(i => i.coverage === 'PARTIAL');
    if (partial.length === 0) continue;
    lines.push(`### ${t} (${partial.length})`);
    lines.push('');
    for (const item of partial) {
      lines.push(`- \`${item.id}\` → mentioned only in \`${item.mentions[0]}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  if (!QUIET && !JSON_ONLY) console.error('[docs-coverage] enumerating capabilities…');

  const capabilities = [
    ...enumerateRoutes(),
    ...enumerateCommands(),
    ...enumerateJobs(),
    ...enumerateHooks(),
    ...enumerateSkills(),
    ...enumerateSubsystemClasses(),
  ];

  if (!QUIET && !JSON_ONLY) console.error(`[docs-coverage] enumerated ${capabilities.length} capabilities; loading docs…`);

  const docs = loadAllDocs();
  if (!QUIET && !JSON_ONLY) console.error(`[docs-coverage] loaded ${Object.keys(docs).length} docs; scoring…`);

  const report = buildReport(capabilities, docs);

  // Ensure state dir exists before writing.
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  // Write the JSON report (machine-readable, used by CI + watchers).
  fs.writeFileSync(path.join(STATE_DIR, 'docs-coverage.json'), JSON.stringify(report, null, 2) + '\n');

  // Write the markdown report (human-readable, committable artifact).
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(STATE_DIR, 'docs-coverage.md'), md);

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (!QUIET) {
    console.error('');
    console.error(`Overall coverage: ${report.totals.coveragePct}% (${report.totals.documented} doc + ${report.totals.partial} partial of ${report.totals.total} capabilities)`);
    for (const t of Object.keys(report.byType).sort()) {
      const b = report.byType[t];
      const floor = report.thresholds[t] ?? null;
      console.error(`  ${t.padEnd(8)} ${String(b.coveragePct).padStart(3)}%  (${b.documented}/${b.total})${floor !== null ? `  floor ${floor}%` : ''}`);
    }
    console.error('');
    console.error(`Reports written to .instar/docs-coverage.{json,md}`);
  }

  if (CHECK) {
    // CI mode — fail if any category is below its floor.
    const failures = [];
    if (report.totals.coveragePct < THRESHOLDS.overall) {
      failures.push(`overall ${report.totals.coveragePct}% < ${THRESHOLDS.overall}%`);
    }
    for (const t of Object.keys(report.byType)) {
      const floor = THRESHOLDS[t];
      if (floor === undefined) continue;
      const pct = report.byType[t].coveragePct;
      if (pct < floor) failures.push(`${t} ${pct}% < ${floor}%`);
    }
    if (failures.length > 0) {
      process.stderr.write(`\n❌ docs-coverage check failed:\n`);
      for (const f of failures) process.stderr.write(`  - ${f}\n`);
      process.stderr.write(`\nFix: add doc coverage for the items listed in .instar/docs-coverage.md, then re-run.\n`);
      process.exit(1);
    }
    if (!QUIET) console.error('✅ docs-coverage check passed.');
  }
}

main();
