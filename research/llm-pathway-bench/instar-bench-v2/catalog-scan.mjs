#!/usr/bin/env node
// catalog-scan.mjs — INSTAR-Bench v2 recurring model-catalog scanner.
//
// Operator requirement (Justin, 2026-07-02, topic 29723): "part of this project
// should include regular scans for updated model lists and newly available
// models which should be included in the benchmarks."
//
// What it does, per run:
//   1. Discovers this agent's doors (routes.mjs — provider-adaptive, missing
//      doors are skips, never failures).
//   2. For each metered door, pulls the LIVE model catalog through the budget
//      funnel's zero-cost `models` command (key custody stays in the funnel).
//   3. Diffs against bench-models.json: NEW ids are added flagged
//      `benchStatus:'new-unbenchmarked'` (the next bench run picks them up —
//      spec §7: new-model enrollment triggers Wave-1 smoke); ids that vanish
//      are marked `delistedAt` but KEPT (bench history stays interpretable).
//   4. Curation: only families we actually bench are auto-added (FAMILY_
//      PATTERNS below); everything else is counted + reported, never silently
//      dropped (No Silent Caps). Full raw catalog snapshot kept per provider.
//   5. On new models: ONE aggregated attention item (flood-rule compliant).
//
// Usage: node catalog-scan.mjs --stamp 2026-07-02 [--dry-run] [--no-attention]
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRoutes } from './routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const STAMP = arg('stamp', new Date().toISOString().slice(0, 10));
const DRY = process.argv.includes('--dry-run');
const NO_ATTN = process.argv.includes('--no-attention');
const MODELS_FILE = join(HERE, 'bench-models.json');
const REPORT = join(HERE, 'catalog-scan-reports.jsonl');
const SNAPDIR = join(HERE, 'catalog-snapshots');

// Families we bench — a NEW chat model matching one of these is auto-added
// (flagged new-unbenchmarked). Deliberately broad within each family; the
// bench run itself decides quality. Non-matching models are counted +
// reported in the scan report, never silently dropped.
const FAMILY_PATTERNS = [
  /^openai\//i, /^anthropic\//i, /^google\/gemini/i, /^z-ai\/glm/i, /^zhipu/i,
  /^qwen\//i, /^deepseek\//i, /^moonshotai\//i, /^meta-llama\/llama/i,
  /^mistralai\//i, /^x-ai\/grok/i, /^openai\/gpt-oss/i,
  // Groq bare ids (no vendor prefix on some rows):
  /^llama-/i, /^qwen\//i, /^openai\/gpt-oss/i, /^gpt-oss/i, /^kimi/i, /^moonshot/i,
];
// Never auto-add: non-chat modalities (the bench drives chat completions).
const EXCLUDE_PATTERNS = [/whisper/i, /tts/i, /embed/i, /guard/i, /moderation/i, /orpheus/i, /rerank/i, /vision-only/i];

function isBenchable(id) {
  if (EXCLUDE_PATTERNS.some((p) => p.test(id))) return false;
  return FAMILY_PATTERNS.some((p) => p.test(id));
}

function funnelModels(key) {
  const funnel = join(HERE, '..', 'metered-funnel.mjs');
  const r = spawnSync(process.execPath, [funnel, 'models', '--key', key], {
    encoding: 'utf8', timeout: 45000, cwd: join(HERE, '..'),
  });
  try {
    const j = JSON.parse((r.stdout || '').trim().split('\n').pop());
    return j.ok ? j : { ok: false, error: 'unparseable' };
  } catch { return { ok: false, error: (r.stderr || 'no output').slice(0, 200) }; }
}

// ---- Load current matrix (seed from v1 pathways.json on first run) ----
function loadCurrent() {
  if (existsSync(MODELS_FILE)) return JSON.parse(readFileSync(MODELS_FILE, 'utf8'));
  const seed = { seededFrom: 'pathways.json', doors: {} };
  const v1 = join(HERE, '..', 'pathways.json');
  if (existsSync(v1)) {
    const reg = JSON.parse(readFileSync(v1, 'utf8'));
    for (const p of reg.pathways) {
      const door = p.framework === 'funnel' ? `metered:${p.key}` : p.framework;
      (seed.doors[door] ??= { models: [] }).models.push({
        id: p.model, tier: p.tier ?? null, routeId: p.id, benchStatus: 'benched-v1',
      });
    }
  }
  return seed;
}

// ---- Scan ----
const current = loadCurrent();
const routes = discoverRoutes();
const report = { stamp: STAMP, doorsScanned: [], skipped: routes.skipped, added: [], delisted: [], excludedCounts: {} };
mkdirSync(SNAPDIR, { recursive: true });

for (const door of routes.available) {
  if (door.kind !== 'metered-funnel') continue; // CLI subscription lists are curated manually (they change rarely and have no list API)
  const live = funnelModels(door.key);
  if (!live.ok) { report.doorsScanned.push({ door: door.door, ok: false, error: live.error }); continue; }

  // Full raw snapshot (history; lets us answer "when did X appear?").
  writeFileSync(join(SNAPDIR, `${door.family}-${STAMP}.json`), JSON.stringify(live, null, 1));

  const doorKey = `metered:${door.key}`;
  const entry = (current.doors[doorKey] ??= { models: [] });
  const known = new Set(entry.models.map((m) => m.id));
  const liveIds = new Set(live.models.map((m) => m.id));

  // FIRST scan of a door = quiet BASELINE: record the whole benchable catalog
  // as 'catalog-baseline' (visible, queryable, NOT benched, NO notification).
  // Only models appearing in LATER scans are "newly available" — those get
  // 'new-unbenchmarked' + the aggregated attention item. This is what keeps
  // "include new models in the benchmarks" from meaning "bench 187 old ones".
  const baselineMode = !entry.baselinedAt;

  let excluded = 0;
  for (const m of live.models) {
    if (known.has(m.id)) continue;
    if (!isBenchable(m.id)) { excluded++; continue; }
    entry.models.push({
      id: m.id,
      benchStatus: baselineMode ? 'catalog-baseline' : 'new-unbenchmarked',
      firstSeen: STAMP,
      ...(m.pricing ? { pricing: m.pricing } : {}), ...(m.contextLength ? { contextLength: m.contextLength } : {}),
    });
    if (!baselineMode) report.added.push({ door: doorKey, id: m.id });
  }
  if (baselineMode) entry.baselinedAt = STAMP;
  for (const m of entry.models) {
    if (!liveIds.has(m.id) && !m.delistedAt) { m.delistedAt = STAMP; report.delisted.push({ door: doorKey, id: m.id }); }
  }
  report.excludedCounts[doorKey] = excluded; // No Silent Caps — the count is visible
  report.doorsScanned.push({ door: door.door, ok: true, liveCount: live.count });
}

current.lastScan = STAMP;
if (!DRY) {
  writeFileSync(MODELS_FILE, JSON.stringify(current, null, 1));
  appendFileSync(REPORT, JSON.stringify(report) + '\n');
}

// ---- Aggregated notification (one item per scan, never per model) ----
if (report.added.length && !DRY && !NO_ATTN) {
  try {
    const cfg = JSON.parse(readFileSync(join(HERE, '..', '..', '..', '.instar', 'config.json'), 'utf8'));
    const port = cfg.port ?? 4042;
    const body = report.added.map((a) => `${a.id} (${a.door})`).join(', ');
    spawnSync('curl', ['-s', '-X', 'POST', '-H', `Authorization: Bearer ${cfg.authToken}`,
      '-H', 'Content-Type: application/json',
      `http://localhost:${port}/attention`,
      '-d', JSON.stringify({
        id: `bench-catalog:${STAMP}`,
        title: `${report.added.length} new model(s) available for INSTAR-Bench`,
        body: `New since last scan: ${body}. Flagged new-unbenchmarked — the next bench run includes them (Wave-1 smoke first).`,
        priority: 'low', source: 'bench-catalog-scan',
      })], { timeout: 10000 });
  } catch { /* notification is best-effort; the report file is the durable record */ }
}

console.error(`[catalog-scan] ${STAMP}: +${report.added.length} new, ${report.delisted.length} delisted, doors=${report.doorsScanned.length}, skips=${report.skipped.length}`);
console.log(JSON.stringify({ stamp: STAMP, added: report.added.length, delisted: report.delisted.length, dry: DRY }));
process.exit(0);
