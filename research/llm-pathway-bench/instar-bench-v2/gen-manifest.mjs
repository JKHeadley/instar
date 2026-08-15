#!/usr/bin/env node
// gen-manifest.mjs — emit a reproducible run manifest for a bench run stamp.
// Captures the provenance needed to re-run or audit a result: bench-code git SHA,
// each task battery's SHA256 (prompt provenance), the door→model resolution, and
// the price/caps table SHAs. Deterministic; no network.
//
// Usage: node gen-manifest.mjs --stamp crit-metered
//        writes ../results/instar-bench-v2/<stamp>/run-manifest.json
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const STAMP = arg('stamp', null);
if (!STAMP) { console.error('--stamp <id> required'); process.exit(1); }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha = (p) => existsSync(p) ? sha256(readFileSync(p)) : null;

// 1. bench-code git provenance (SHA + dirty flag over this dir's tracked files)
let gitSha = null, gitDirty = null;
try {
  gitSha = execSync('git rev-parse HEAD', { cwd: HERE }).toString().trim();
  gitDirty = execSync('git status --porcelain -- .', { cwd: HERE }).toString().trim().length > 0;
} catch { /* not in a repo / git missing — provenance degrades honestly to null */ }

// 2. task-battery prompt provenance: SHA256 per task file
const taskDir = join(HERE, 'tasks');
const tasks = existsSync(taskDir)
  ? readdirSync(taskDir).filter(f => f.endsWith('.json')).sort().map(f => {
      const p = join(taskDir, f);
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      const cases = Array.isArray(doc.cases) ? doc.cases.length : (Array.isArray(doc) ? doc.length : null);
      return { file: f, sha256: fileSha(p), cases };
    })
  : [];

// 3. door → model resolution actually present in the run's raw.jsonl
const rawPath = join(HERE, '..', 'results', 'instar-bench-v2', STAMP, 'raw.jsonl');
const doorModels = {};
let rowCount = 0;
if (existsSync(rawPath)) {
  for (const line of readFileSync(rawPath, 'utf8').trim().split('\n')) {
    try {
      const r = JSON.parse(line); rowCount++;
      const door = r.door || 'unknown';
      (doorModels[door] ??= new Set()).add(`${r.route}::${r.model || '?'}`);
    } catch { /* skip malformed */ }
  }
}
const doors = Object.fromEntries(Object.entries(doorModels).map(([d, s]) => [d, [...s].sort()]));

// 3b. door VERSION provenance — which CLI binary/version (or metered endpoint kind)
// served each door. Local probes only (no network): discoverRoutes shells the
// installed CLIs for --version.
let doorVersions = {};
try {
  const { discoverRoutes } = await import('./routes.mjs');
  const disc = await discoverRoutes();
  const groups = Object.values(disc).find(Array.isArray) ?? [];
  for (const g of groups) {
    doorVersions[g.door] = { kind: g.kind ?? null, binary: g.binary ?? null, version: g.version ?? null };
  }
} catch (e) { console.error(`[gen-manifest] WARN door-version discovery failed: ${e.message}`); }

// 4. price + caps table provenance
const priceSha = fileSha(join(HERE, '..', 'metered-prices.json'));
const capsSha = fileSha(join(HERE, '..', 'metered-caps.json'));

const manifest = {
  _schema: 'instar-bench/run-manifest@1',
  stamp: STAMP,
  // NOTE: generatedAt intentionally omitted — pass via CI/env if a timestamp is
  // wanted; scripts here run without wall-clock to stay deterministic/reproducible.
  benchCode: { gitSha, gitDirty },
  taskBatteries: { count: tasks.length, files: tasks },
  doorsBenched: doors,
  doorVersions,
  rawRowCount: rowCount,
  priceTable: { file: 'metered-prices.json', sha256: priceSha },
  capsTable: { file: 'metered-caps.json', sha256: capsSha },
  infraNoisePolicy: 'Environmental failures (rate-limit, auth, binary-missing, spawn-throw, spawn-error, no-invocation) are excluded from pass/total scoring (reported as infra counts in summary.json) and re-run on --resume; budget-refused/vendor-wall rows are never recorded at all. Route-behavior failures (timeout, refusal, cli-error, model-error, empty-output) STAY scored as failures — a router must care about them. Cost is booked to vendor truth, not reserved worst-case.',
  reproduce: `node run2.mjs --stamp ${STAMP} --samples <n> --routes-filter <f> --resume`,
};

const outPath = join(HERE, '..', 'results', 'instar-bench-v2', STAMP, 'run-manifest.json');
writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log('wrote', outPath);
console.log(`  gitSha=${gitSha?.slice(0, 10)} dirty=${gitDirty} · ${tasks.length} batteries · ${Object.keys(doors).length} doors · ${rowCount} rows`);
