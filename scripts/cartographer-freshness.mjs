#!/usr/bin/env node
/**
 * cartographer-freshness.mjs — Tier-3 CI ratchet for the cartographer doc-tree
 * (cartographer-doc-freshness spec #2). Parity with scripts/docs-coverage.mjs:
 * a hardcoded committed FLOOR constant, a gitignored output file that is never
 * the read baseline, monotonic-by-construction, fails OPEN on a transient.
 *
 * What it measures: the freshness ratio (fresh / authorable nodes, excluding
 * `path-gone` and never-authored-WITHIN-grace) PLUS the two ABSOLUTE backlog
 * counts (never-authored-past-grace, author-failed) so a green ratio over a small
 * authored set can't hide a growing un-authored backlog (Goodhart guard).
 *
 * HONEST LIMITATION (maturity-honesty standard): cartographer state under
 * `.instar/cartographer/` is gitignored (per-machine). On a fresh CI checkout
 * there is NO committed authored state, so the tree reads as zero authorable /
 * ratio 1 / backlog 0 — the ratchet is a STRUCTURAL non-regression PLACEHOLDER
 * there ("starts loose", the docs-coverage rationale). Its real teeth engage on a
 * machine where the doc-tree HAS been scaffolded + authored (the freshnessSweep is
 * enabled): there it computes the genuine ratio and fails the build on a
 * regression below the floor or a backlog above the ceiling. The floor/ceiling
 * ship loose and are ratcheted up (a visible PR diff) as the gap closes.
 *
 * Self-contained (no dist import) so it runs in CI without a build step. It
 * re-derives staleness exactly as CartographerTree does: ONE batched
 * `git ls-tree -r -t HEAD` + the sha256-path slug for node files.
 *
 * Usage:
 *   node scripts/cartographer-freshness.mjs           # report, exit 0
 *   node scripts/cartographer-freshness.mjs --check   # exit 1 on regression
 *   node scripts/cartographer-freshness.mjs --json     # JSON to stdout
 *
 * Floors (env override):
 *   CARTOGRAPHER_FRESHNESS_FLOOR        — min fresh ratio 0..1 (default 0)
 *   CARTOGRAPHER_NEVER_AUTHORED_CEILING — max never-authored-past-grace (default 100000)
 *   CARTOGRAPHER_AUTHOR_FAILED_CEILING  — max author-failed nodes (default 100000)
 *   CARTOGRAPHER_FRESHNESS_GRACE_MS     — grace window for a new node (default 1200000 = 20m)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const JSON_ONLY = args.has('--json');
const QUIET = args.has('--quiet');

function resolveRoot() {
  if (process.env.CARTOGRAPHER_FRESHNESS_ROOT) return process.env.CARTOGRAPHER_FRESHNESS_ROOT;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'src'))) return cwd;
  return path.resolve(__dirname, '..');
}
const ROOT = resolveRoot();
const CARTO_DIR = path.join(ROOT, '.instar', 'cartographer');
const INDEX_PATH = path.join(CARTO_DIR, 'index.json');
const NODES_DIR = path.join(CARTO_DIR, 'nodes');
const OUT_PATH = path.join(ROOT, '.instar', 'cartographer-freshness.json');

// ── Hardcoded committed floors (the read baseline; output file is never it) ──
const numEnv = (env, def) => {
  const v = process.env[env];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def;
};
const FLOORS = {
  freshRatio: numEnv('CARTOGRAPHER_FRESHNESS_FLOOR', 0),
  neverAuthoredPastGraceCeiling: numEnv('CARTOGRAPHER_NEVER_AUTHORED_CEILING', 100000),
  authorFailedCeiling: numEnv('CARTOGRAPHER_AUTHOR_FAILED_CEILING', 100000),
  graceMs: numEnv('CARTOGRAPHER_FRESHNESS_GRACE_MS', 1_200_000),
};

function git(cmdArgs) {
  try {
    return execFileSync('git', cmdArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null; // fail-open — absent git/HEAD ⇒ no oids ⇒ vacuous pass
  }
}

/** path→oid for every tracked tree+blob in HEAD (+ '' = root tree). Mirrors CartographerTree.currentOids. */
function currentOids() {
  const map = new Map();
  const rootTree = git(['rev-parse', 'HEAD^{tree}']);
  if (rootTree) map.set('', rootTree.trim());
  const out = git(['ls-tree', '-r', '-t', '-z', 'HEAD']);
  if (!out) return map;
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(' ');
    const p = entry.slice(tab + 1);
    const oid = meta[2];
    if (oid && p) map.set(p, oid);
  }
  return map;
}

const slug = (p) => crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 40);

function readNodeFile(nodePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(NODES_DIR, `${slug(nodePath)}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function compute() {
  const nowMs = Date.now();
  let index = null;
  try { index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch { index = null; }

  const rootOid = (() => { const r = git(['rev-parse', 'HEAD^{tree}']); return r ? r.trim() : null; })();

  if (!index || !index.nodes) {
    // No committed/authored state (the typical CI case) — vacuous structural pass.
    return {
      generatedAt: new Date().toISOString(),
      rootOid,
      stateAuthored: false,
      nodeCount: 0, authorableCount: 0, freshCount: 0, staleCount: 0,
      neverAuthoredCount: 0, neverAuthoredWithinGrace: 0, neverAuthoredPastGrace: 0,
      authorFailedCount: 0, freshRatio: 1,
    };
  }

  const current = currentOids();
  let authorable = 0, fresh = 0, stale = 0, never = 0, neverWithin = 0, neverPast = 0, authorFailed = 0;
  for (const [nodePath, entry] of Object.entries(index.nodes)) {
    const storedHash = entry.codeHash ?? null;
    const curOid = current.get(nodePath);
    const status = storedHash == null ? 'never-authored'
      : curOid == null ? 'path-gone'
      : curOid === storedHash ? 'fresh' : 'stale';
    if (status === 'path-gone') continue;
    authorable += 1;
    if (status === 'fresh') fresh += 1;
    else if (status === 'stale') stale += 1;
    else if (status === 'never-authored') {
      never += 1;
      const node = readNodeFile(nodePath);
      const firstSeen = node?.firstSeenAt ? Date.parse(node.firstSeenAt) : nowMs;
      if (Number.isFinite(firstSeen) && nowMs - firstSeen > FLOORS.graceMs) neverPast += 1;
      else neverWithin += 1;
    }
    const node = status === 'never-authored' ? null : readNodeFile(nodePath);
    if (node?.authorFailed) authorFailed += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    rootOid,
    stateAuthored: true,
    nodeCount: Object.keys(index.nodes).length,
    authorableCount: authorable,
    freshCount: fresh,
    staleCount: stale,
    neverAuthoredCount: never,
    neverAuthoredWithinGrace: neverWithin,
    neverAuthoredPastGrace: neverPast,
    authorFailedCount: authorFailed,
    // Denominator EXCLUDES never-authored-within-grace (grace period before a new
    // node counts as debt): fresh + stale + never-authored-past-grace.
    freshRatio: (fresh + stale + neverPast) === 0 ? 1 : Number((fresh / (fresh + stale + neverPast)).toFixed(4)),
  };
}

function main() {
  const report = compute();
  report.floors = FLOORS;

  try {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  } catch { /* output is advisory; never fail the build on a write error */ }

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (!QUIET) {
    console.error(`[cartographer-freshness] authored-state=${report.stateAuthored} ratio=${report.freshRatio} ` +
      `(fresh ${report.freshCount}/${report.authorableCount}) stale=${report.staleCount} ` +
      `never-past-grace=${report.neverAuthoredPastGrace} author-failed=${report.authorFailedCount}`);
    console.error(`[cartographer-freshness] floors: ratio>=${FLOORS.freshRatio} ` +
      `never-past-grace<=${FLOORS.neverAuthoredPastGraceCeiling} author-failed<=${FLOORS.authorFailedCeiling}`);
  }

  if (CHECK) {
    const failures = [];
    if (report.freshRatio < FLOORS.freshRatio) {
      failures.push(`fresh ratio ${report.freshRatio} < floor ${FLOORS.freshRatio}`);
    }
    if (report.neverAuthoredPastGrace > FLOORS.neverAuthoredPastGraceCeiling) {
      failures.push(`never-authored-past-grace ${report.neverAuthoredPastGrace} > ceiling ${FLOORS.neverAuthoredPastGraceCeiling}`);
    }
    if (report.authorFailedCount > FLOORS.authorFailedCeiling) {
      failures.push(`author-failed ${report.authorFailedCount} > ceiling ${FLOORS.authorFailedCeiling}`);
    }
    if (failures.length > 0) {
      process.stderr.write('\n❌ cartographer-freshness check failed:\n');
      for (const f of failures) process.stderr.write(`  - ${f}\n`);
      process.exit(1);
    }
    if (!QUIET) console.error('✅ cartographer-freshness check passed.');
  }
}

main();
