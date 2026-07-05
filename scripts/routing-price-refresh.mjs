#!/usr/bin/env node
/**
 * routing-price-refresh.mjs — the deterministic prober behind the OFF-by-default
 * `routing-price-refresh` job (docs/specs/routing-control-room-spend-alerts.md, FD-8).
 *
 * It re-confirms published per-token prices for the metered doors and writes them into
 * the MACHINE-LOCAL OBSERVED CACHE ONLY (`.instar/routing-prices.observed.json`) —
 * STRUCTURALLY never the canonical manifest (a lint + unit test assert this). Observed
 * points feed the REPORTING view + the promote-me drift hint; they are gate-INELIGIBLE
 * by construction (in Increment B the money gate reads only the canonical manifest).
 *
 * FD-8 discipline (all enforced here):
 *  - FORWARD-ONLY: every written point has `effectiveAt = today (UTC, day-aligned)`,
 *    `corrects: null`. It can never write a backdated point or a correction.
 *  - FREE-PROBE FIRST: `--scope free-probes` (default) queries only public, no-auth
 *    model-list endpoints (OpenRouter). Metered / web-verify probes are MANUAL-ONLY and
 *    refused unless a positive `--budget-usd` is passed (default 0 → refuse) — an
 *    unknown price refuses rather than guesses.
 *  - SANE-PRICE VALIDATION: a candidate failing the range / cached≤input checks is
 *    dropped (never written), matching the reporting authority's fail-closed load.
 *
 * Pure core (parse / forward-only-merge / validate) is unit-tested with fixtures — no
 * network in tests. Usage:
 *   node scripts/routing-price-refresh.mjs [--scope free-probes|+liveness|+web-verify]
 *        [--budget-usd N] [--dry-run] [--out <path>] [--project-dir <dir>] [--state-dir <dir>]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The metered (door → canonical model ids) we track prices for — kept in sync with the manifest. */
export const TRACKED = {
  'openrouter-api': ['openai/gpt-5.5', 'anthropic/claude-opus-4-8'],
  'gemini-api': ['gemini-3.1-flash-lite'],
  'groq-api': ['openai/gpt-oss-120b'],
};

/** UTC-day-aligned ISO (T00:00:00Z) for a timestamp — every observed point is day-aligned (FD-18). */
export function dayAlignedIso(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function canonical(id) {
  return String(id ?? '').trim().toLowerCase();
}

/** Sane-price validation (mirrors routingPriceAuthority.isValidPricePoint's money-safety checks). */
export function isSanePoint(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.door !== 'string' || !p.door.trim()) return false;
  if (typeof p.modelId !== 'string' || !p.modelId.trim()) return false;
  if (typeof p.inPerMtok !== 'number' || !Number.isFinite(p.inPerMtok) || p.inPerMtok < 0) return false;
  if (typeof p.outPerMtok !== 'number' || !Number.isFinite(p.outPerMtok) || p.outPerMtok < 0) return false;
  if (p.cachedInPerMtok !== undefined) {
    if (typeof p.cachedInPerMtok !== 'number' || !Number.isFinite(p.cachedInPerMtok) || p.cachedInPerMtok < 0 || p.cachedInPerMtok > p.inPerMtok) return false;
  }
  if (typeof p.effectiveAt !== 'string' || dayAlignedIso(Date.parse(p.effectiveAt)) !== p.effectiveAt) return false;
  return true;
}

/**
 * Parse OpenRouter's public /models payload into candidate observed points for the
 * TRACKED openrouter models. OpenRouter reports `pricing.prompt`/`.completion` as USD
 * PER TOKEN (string); we convert to USD per MILLION tokens. Pure.
 */
export function parseOpenRouterModels(payload, nowMs) {
  const effectiveAt = dayAlignedIso(nowMs);
  const out = [];
  const data = payload && Array.isArray(payload.data) ? payload.data : [];
  const tracked = new Set(TRACKED['openrouter-api'].map(canonical));
  for (const m of data) {
    if (!m || typeof m !== 'object') continue;
    const modelId = canonical(m.id);
    if (!tracked.has(modelId)) continue;
    const pr = m.pricing;
    if (!pr) continue;
    const inPerMtok = Number(pr.prompt) * 1e6;
    const outPerMtok = Number(pr.completion) * 1e6;
    const point = {
      door: 'openrouter-api',
      modelId,
      inPerMtok: Number.isFinite(inPerMtok) ? round6(inPerMtok) : NaN,
      outPerMtok: Number.isFinite(outPerMtok) ? round6(outPerMtok) : NaN,
      effectiveAt,
      recordedAt: new Date(nowMs).toISOString(),
      source: 'openrouter-models-api',
      corrects: null,
    };
    if (isSanePoint(point)) out.push(point);
  }
  return out;
}

/**
 * FORWARD-ONLY merge into the observed cache: keep existing observed points, and add a
 * new candidate ONLY when its effectiveAt is ≥ every existing point for the same
 * (door, model) — never rewrite history, never a same-day duplicate. Pure.
 */
export function mergeForwardOnly(existingPoints, candidates) {
  const points = Array.isArray(existingPoints) ? existingPoints.slice() : [];
  const latestByKey = new Map();
  for (const p of points) {
    const key = `${p.door} ${canonical(p.modelId)}`;
    const eff = Date.parse(p.effectiveAt);
    if (!latestByKey.has(key) || eff > latestByKey.get(key)) latestByKey.set(key, eff);
  }
  const added = [];
  for (const c of candidates) {
    if (!isSanePoint(c)) continue;
    const key = `${c.door} ${canonical(c.modelId)}`;
    const eff = Date.parse(c.effectiveAt);
    const latest = latestByKey.get(key);
    if (latest !== undefined && eff <= latest) continue; // forward-only: no backdate, no same-day dup
    points.push(c);
    latestByKey.set(key, eff);
    added.push(c);
  }
  return { points, added };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function readObserved(outPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    return Array.isArray(raw?.points) ? raw.points : [];
  } catch {
    return [];
  }
}

function writeObserved(outPath, points) {
  const body = {
    schemaVersion: 1,
    _doc: 'MACHINE-LOCAL observed price cache written ONLY by scripts/routing-price-refresh.mjs (FD-8). REPORTING-ONLY — never gate-eligible; promote to the canonical manifest via the reviewed git/PIN path. Append/forward-only.',
    points,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(body, null, 2)}\n`);
}

async function fetchOpenRouterModels(timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`openrouter models HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

function parseArgs(argv) {
  const args = { scope: 'free-probes', budgetUsd: 0, dryRun: false, out: null, projectDir: process.cwd(), stateDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') args.scope = argv[++i];
    else if (a === '--budget-usd') args.budgetUsd = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--project-dir') args.projectDir = argv[++i];
    else if (a === '--state-dir') args.stateDir = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = args.stateDir ?? path.join(args.projectDir, '.instar');
  const outPath = args.out ?? path.join(stateDir, 'routing-prices.observed.json');
  const now = Date.now();

  if (args.scope !== 'free-probes' && !(args.budgetUsd > 0)) {
    // Metered / web-verify probes are MANUAL-ONLY + budget-capped (FD-8). No budget → refuse.
    console.error(`[routing-price-refresh] scope '${args.scope}' requires a positive --budget-usd (metered probes are manual-only, budget-fail-closed). Refusing.`);
    process.exit(2);
    return;
  }

  const candidates = [];
  const notes = [];
  // Free scope: only publicly queryable doors. OpenRouter's /models is public + no-auth.
  try {
    const payload = await fetchOpenRouterModels();
    const pts = parseOpenRouterModels(payload, now);
    candidates.push(...pts);
    notes.push(`openrouter-api: ${pts.length} tracked model price(s) probed`);
  } catch (err) {
    notes.push(`openrouter-api: probe failed (${err?.message ?? err}) — skipped, no data written for this door`);
  }
  // gemini-api / groq-api need a key → out of the free scope. Honestly reported, never guessed.
  notes.push('gemini-api, groq-api: need an API key → not in free-probe scope (manual metered probe only)');

  const existing = readObserved(outPath);
  const { points, added } = mergeForwardOnly(existing, candidates);

  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, wouldAdd: added, notes }, null, 2));
    return;
  }
  if (added.length > 0) writeObserved(outPath, points);
  console.log(JSON.stringify({ added: added.length, totalObserved: points.length, out: outPath, notes }, null, 2));
}

// Only run when invoked directly (import for unit tests stays side-effect-free).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[routing-price-refresh] fatal:', err?.message ?? err);
    process.exit(1);
  });
}
