#!/usr/bin/env node
/**
 * standards-coverage.mjs — Tier-3 CI ratchet for the Standards Enforcement-Coverage
 * Audit (cartographer-conformance-audit spec #3, Part E). Parity with
 * scripts/docs-coverage.mjs + scripts/cartographer-freshness.mjs: a hardcoded
 * committed FLOOR on the enforced ratio + a hard ZERO ceiling on dangling refs,
 * a gitignored output file that is NEVER the read baseline, deterministic by
 * construction, fails OPEN on a transient (missing registry ⇒ vacuous pass).
 *
 * What it measures: for each constitutional standard in docs/STANDARDS-REGISTRY.md,
 * whether the structural guard its prose NAMES (a `*.test.ts`/`no-*` ratchet, a
 * `scripts/lint-*`, a gate marker/route, a `docs/specs/*`) actually resolves on
 * disk. It reports:
 *   - enforcedRatio = (ratchet + gate + lint) / total — fails the build if it drops
 *     below the committed floor (a new standard shipped with NO verifiable guard).
 *   - danglingCount = refs a standard names that are NOT on disk — fails the build if
 *     ABOVE ZERO (a guard file removed while a standard still cites it: a broken
 *     guarantee, the loudest signal).
 *
 * Self-contained (no dist import) so it runs in CI without a build step — it
 * re-implements the same deterministic parse → extract → verify the auditor does.
 *
 * Usage:
 *   node scripts/standards-coverage.mjs           # report, exit 0
 *   node scripts/standards-coverage.mjs --check    # exit 1 on regression
 *   node scripts/standards-coverage.mjs --json     # JSON to stdout
 *
 * Floors (env override):
 *   STANDARDS_ENFORCED_RATIO_FLOOR  — min enforced ratio 0..1 (default 0 — starts
 *                                     loose, ratcheted up as gaps close)
 *   STANDARDS_DANGLING_CEILING      — max dangling refs (default 0 — zero tolerance)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const JSON_ONLY = args.has('--json');
const QUIET = args.has('--quiet');

function resolveRoot() {
  if (process.env.STANDARDS_COVERAGE_ROOT) return process.env.STANDARDS_COVERAGE_ROOT;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'src'))) return cwd;
  return path.resolve(__dirname, '..');
}
const ROOT = resolveRoot();
const REGISTRY_PATH = path.join(ROOT, 'docs', 'STANDARDS-REGISTRY.md');
const OUT_PATH = path.join(ROOT, '.instar', 'standards-coverage.json');

// ── Hardcoded committed floors (the read baseline; output file is never it) ──
const numEnv = (env, def) => {
  const v = process.env[env];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def;
};
const FLOORS = {
  // Starts at 0 ("starts loose", the docs-coverage rationale) — the script's first
  // job is to PREVENT regression (a new unguarded standard / a removed guard file)
  // while the existing gap closes. Ratchet this upward (a visible PR diff) as the
  // documented-only set shrinks.
  enforcedRatio: numEnv('STANDARDS_ENFORCED_RATIO_FLOOR', 0),
  // Zero tolerance: a standard must NEVER cite a guard that doesn't exist.
  danglingCeiling: numEnv('STANDARDS_DANGLING_CEILING', 0),
};

// ── Deterministic parse → extract → verify (mirrors the auditor, self-contained) ──

const STANDARDS_FAMILY_RE = /^##\s+(The Root|The Substrate|Building|Shipping|Interaction)\b/;
const ANY_H2_RE = /^##\s+/;
const ARTICLE_RE = /^###\s+(.+?)\s*$/;
function fieldAfter(line, label) {
  const m = line.match(new RegExp(`^\\*\\*${label}\\.\\*\\*\\s*(.*)$`));
  return m ? m[1].trim() : null;
}
function parseRegistry(markdown) {
  const lines = markdown.split('\n');
  const articles = [];
  let fam = null, cur = null;
  const flush = () => { if (cur && cur.rule) articles.push(cur); cur = null; };
  for (const line of lines) {
    const fm = line.match(STANDARDS_FAMILY_RE);
    if (fm) { flush(); fam = fm[1]; continue; }
    if (ANY_H2_RE.test(line) && !fm) { flush(); fam = null; continue; }
    if (!fam) continue;
    const am = line.match(ARTICLE_RE);
    if (am) { flush(); cur = { family: fam, name: am[1].trim(), rule: '', inPractice: '', appliedThrough: '' }; continue; }
    if (!cur) continue;
    const r = fieldAfter(line, 'Rule'); if (r !== null) { cur.rule = r; continue; }
    const ip = fieldAfter(line, 'In practice'); if (ip !== null) { cur.inPractice = ip; continue; }
    const at = fieldAfter(line, 'Applied through'); if (at !== null) { cur.appliedThrough = at; continue; }
  }
  flush();
  return articles;
}

const FILE_RE = /`([a-zA-Z0-9_./-]+\.(?:ts|js|mjs|cjs|md|json|sh))`/g;
const ROUTE_RE = /`(GET|POST|PUT|DELETE|PATCH)\s+(\/[a-zA-Z0-9/_:-]+)`/g;
const MARKER_RE = /\b([A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,})\b/g;
const SYMBOL_RE = /`([A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z][a-zA-Z0-9]*)?)`/g;
const ENFORCEMENT_PATH_PREFIXES = ['tests/', 'scripts/', 'src/', 'docs/', '.github/', '.instar/', '.husky/'];
const isEnforcementPath = (p) => ENFORCEMENT_PATH_PREFIXES.some((pre) => p.startsWith(pre));
const dedupe = (xs) => [...new Set(xs)];

function extractRefs(a) {
  const text = `${a.inPractice ?? ''}\n${a.appliedThrough ?? ''}`;
  const files = [];
  for (const m of text.matchAll(FILE_RE)) { if (isEnforcementPath(m[1])) files.push(m[1]); }
  const routes = [];
  for (const m of text.matchAll(ROUTE_RE)) routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  const markers = [];
  for (const m of text.matchAll(MARKER_RE)) markers.push(m[1]);
  for (const m of text.matchAll(SYMBOL_RE)) markers.push(m[1].split('.')[0]);
  return { files: dedupe(files).sort(), routes: dedupe(routes).sort(), markers: dedupe(markers).sort() };
}

const KIND_RANK = { ratchet: 4, gate: 3, lint: 2, 'spec-only': 1 };
function classifyFileGuard(ref) {
  const base = ref.split('/').pop() ?? ref;
  if (/\.test\.(ts|js|mjs)$/.test(base) || base.startsWith('no-') || /-coverage\.(mjs|js)$/.test(base)) return 'ratchet';
  if (ref.startsWith('scripts/') && base.startsWith('lint-')) return 'lint';
  if (ref.startsWith('.husky/') || /precommit/i.test(base)) return 'gate';
  if (ref.startsWith('scripts/')) return 'lint';
  if (ref.startsWith('docs/')) return 'spec-only';
  if (ref.startsWith('src/')) return 'gate';
  return 'spec-only';
}

function loadRouteTable() {
  const out = new Set();
  const serverDir = path.join(ROOT, 'src', 'server');
  let files;
  try { files = fs.readdirSync(serverDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')); } catch { return out; }
  const re = /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(path.join(serverDir, f), 'utf-8'); } catch { continue; }
    for (const m of content.matchAll(re)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return out;
}

function buildSymbolIndex(wanted) {
  const found = new Set();
  if (wanted.size === 0) return found;
  const srcDir = path.join(ROOT, 'src');
  try { if (!fs.statSync(srcDir).isDirectory()) return found; } catch { return found; }
  const escaped = [...wanted].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');
  let readBytes = 0;
  const MAX = 64 * 1024 * 1024;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.size === wanted.size) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) {
        if (readBytes > MAX) return;
        let content;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        readBytes += content.length;
        for (const m of content.matchAll(re)) found.add(m[1]);
      }
    }
  };
  walk(srcDir);
  return found;
}

function compute() {
  let markdown = null;
  try { markdown = fs.readFileSync(REGISTRY_PATH, 'utf-8'); } catch { markdown = null; }
  if (markdown === null) {
    // Missing registry (a transient / a partial checkout) → vacuous pass (fail-open).
    return {
      generatedAt: new Date().toISOString(),
      registryFound: false,
      total: 0, byKind: { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 },
      enforcedRatio: 1, gaps: [], danglingCount: 0, danglingByStandard: [],
    };
  }

  const articles = parseRegistry(markdown);
  const routeTable = loadRouteTable();
  const extracted = articles.map((a) => ({ a, refs: extractRefs(a) }));
  const wanted = new Set();
  for (const { refs } of extracted) for (const m of refs.markers) wanted.add(m);
  const symbolIndex = buildSymbolIndex(wanted);

  const byKind = { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 };
  const gaps = [];
  const danglingByStandard = [];
  let danglingCount = 0;

  for (const { a, refs } of extracted) {
    const guards = [];
    const dangling = [];
    for (const ref of refs.files) {
      const verified = fs.existsSync(path.join(ROOT, ref));
      if (verified) guards.push(classifyFileGuard(ref)); else dangling.push(ref);
    }
    for (const ref of refs.routes) {
      const verified = routeTable.has(ref);
      if (verified) guards.push('gate'); else dangling.push(ref);
    }
    for (const ref of refs.markers) {
      const verified = symbolIndex.has(ref);
      if (verified) guards.push('gate'); else dangling.push(ref);
    }
    let best = null;
    for (const g of guards) { if (best === null || KIND_RANK[g] > KIND_RANK[best]) best = g; }
    const kind = best ?? 'documented-only';
    byKind[kind] += 1;
    if (kind === 'documented-only') gaps.push(a.name);
    if (dangling.length > 0) { danglingByStandard.push({ standard: a.name, refs: dangling.sort() }); danglingCount += dangling.length; }
  }

  const total = articles.length;
  const enforced = byKind.ratchet + byKind.gate + byKind.lint;
  const enforcedRatio = total === 0 ? 1 : Number((enforced / total).toFixed(4));
  return {
    generatedAt: new Date().toISOString(),
    registryFound: true,
    total, byKind, enforcedRatio, gaps, danglingCount, danglingByStandard,
  };
}

function main() {
  const report = compute();
  report.floors = FLOORS;
  report.inputHash = (() => {
    let reg = '';
    try { reg = fs.readFileSync(REGISTRY_PATH, 'utf-8'); } catch { reg = ''; }
    return crypto.createHash('sha256').update(reg).digest('hex').slice(0, 16);
  })();

  try {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  } catch { /* output is advisory; never fail the build on a write error */ }

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (!QUIET) {
    console.error(`[standards-coverage] registry=${report.registryFound} total=${report.total} ` +
      `enforced-ratio=${report.enforcedRatio} (ratchet ${report.byKind.ratchet} / gate ${report.byKind.gate} / ` +
      `lint ${report.byKind.lint} / spec-only ${report.byKind['spec-only']} / gap ${report.byKind['documented-only']}) ` +
      `dangling=${report.danglingCount}`);
    console.error(`[standards-coverage] floors: enforced-ratio>=${FLOORS.enforcedRatio} dangling<=${FLOORS.danglingCeiling}`);
  }

  if (CHECK) {
    const failures = [];
    if (report.enforcedRatio < FLOORS.enforcedRatio) {
      failures.push(`enforced ratio ${report.enforcedRatio} < floor ${FLOORS.enforcedRatio}`);
    }
    if (report.danglingCount > FLOORS.danglingCeiling) {
      failures.push(`dangling refs ${report.danglingCount} > ceiling ${FLOORS.danglingCeiling}` +
        (report.danglingByStandard.length
          ? ` — ${report.danglingByStandard.map((d) => `${d.standard}: [${d.refs.join(', ')}]`).join('; ')}`
          : ''));
    }
    if (failures.length > 0) {
      process.stderr.write('\n❌ standards-coverage check failed:\n');
      for (const f of failures) process.stderr.write(`  - ${f}\n`);
      process.stderr.write('\nFix: build a guard for an unguarded standard (raise the ratio), or repair the dangling reference (the cited guard file was renamed/removed).\n');
      process.exit(1);
    }
    if (!QUIET) console.error('✅ standards-coverage check passed.');
  }
}

main();
