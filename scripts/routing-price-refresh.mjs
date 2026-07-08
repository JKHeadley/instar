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

/**
 * Web-verify (FD-8, operator-directed schedule 2026-07-07): DETERMINISTIC
 * extraction from the providers' OFFICIAL pricing pages — the two doors whose
 * prices are published on web pages only (Groq, Google). CONSERVATIVE by
 * construction: any ambiguity yields NO point (an unknown price refuses rather
 * than guesses); every candidate still passes isSanePoint + the plausibility
 * clamp before the forward-only merge. No LLM, no metered spend — the fetch is
 * free; any future LLM-assisted extraction stays manual + budget-capped.
 */

/** Strip tags to a pipe-delimited text stream (the page-shape the fixtures pin). */
function stripHtml(html) {
  return String(html ?? '').replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ');
}

/** Groq page model labels for the tracked ids (the table names models in marketing case). */
const GROQ_LABELS = { 'openai/gpt-oss-120b': /GPT OSS 120B/i };

/** parseGroqPricingHtml — the groq.com/pricing table rows (fixture: pricing-page-groq). */
export function parseGroqPricingHtml(html, nowMs) {
  const points = [];
  const rows = String(html ?? '').split(/<tr>/i);
  for (const [modelId, label] of Object.entries(GROQ_LABELS)) {
    if (!TRACKED['groq-api'].includes(modelId)) continue;
    const row = rows.find((r) => label.test(stripHtml(r)));
    if (!row) continue; // model row absent → refuse (page reshaped)
    const txt = stripHtml(row);
    const input = /Input Token Price[^$]*\$([0-9]+(?:\.[0-9]+)?)/i.exec(txt);
    const output = /Output Token Price[^$]*\$([0-9]+(?:\.[0-9]+)?)/i.exec(txt);
    if (!input || !output) continue; // shape drifted → refuse, never guess
    points.push({
      door: 'groq-api',
      modelId: canonical(modelId),
      inPerMtok: Number(input[1]),
      outPerMtok: Number(output[1]),
      effectiveAt: dayAlignedIso(nowMs),
      recordedAt: new Date(nowMs).toISOString(),
      source: 'groq-pricing-page',
      corrects: null,
    });
  }
  return points;
}

/** parseGooglePricingHtml — the ai.google.dev/pricing model card (fixture: pricing-page-google). */
export function parseGooglePricingHtml(html, nowMs) {
  const points = [];
  const txt = stripHtml(html);
  for (const modelId of TRACKED['gemini-api']) {
    const at = txt.indexOf(canonical(modelId));
    if (at < 0) continue;
    const card = txt.slice(at, at + 2500);
    // The PAID text rate only: "$X (text ..." — never the audio rate, never the free tier.
    const input = /Input price[^$]*\$([0-9]+(?:\.[0-9]+)?) \(text/i.exec(card);
    // Output: the first plain dollar figure after the label (thinking tokens included per the page).
    const output = /Output price[^$]*\$([0-9]+(?:\.[0-9]+)?)/i.exec(card);
    if (!input || !output) continue; // shape drifted → refuse, never guess
    points.push({
      door: 'gemini-api',
      modelId: canonical(modelId),
      inPerMtok: Number(input[1]),
      outPerMtok: Number(output[1]),
      effectiveAt: dayAlignedIso(nowMs),
      recordedAt: new Date(nowMs).toISOString(),
      source: 'google-pricing-page',
      corrects: null,
    });
  }
  return points;
}

/**
 * Plausibility clamp vs the canonical manifest (parser-drift protection): an
 * extracted price wildly off the reviewed one (>10x either way on either axis)
 * is REFUSED — a reshaped marketing page must never flood the observed cache.
 * No canonical point → the clamp passes (a brand-new door has no baseline).
 */
export function plausibleVsCanonical(point, manifest) {
  const pts = (manifest?.points ?? []).filter(
    (p) => p.door === point.door && canonical(p.modelId) === canonical(point.modelId),
  );
  if (pts.length === 0) return true;
  const newest = pts[pts.length - 1];
  const ok = (a, b) => !(a > 0 && b > 0) || (a / b <= 10 && b / a <= 10);
  return ok(point.inPerMtok, newest.inPerMtok) && ok(point.outPerMtok, newest.outPerMtok);
}

/**
 * Read the CALLER-SUPPLIED plausibility baseline (`--plausibility-baseline <path>`)
 * for the clamp. The prober itself is structurally BASELINE-BLIND: it never names
 * any reviewed price file in its own source (S2-2 — this script is observed-cache-
 * only; the reviewed baseline's location is the CALLER's knowledge, see spec
 * Layer 1 / FD-8). Absent/corrupt/unset → null → the clamp passes (no baseline).
 */
function readBaseline(p) {
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
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
    else if (a === '--plausibility-baseline') args.plausibilityBaseline = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = args.stateDir ?? path.join(args.projectDir, '.instar');
  const outPath = args.out ?? path.join(stateDir, 'routing-prices.observed.json');
  const now = Date.now();

  if (args.scope !== 'free-probes' && args.scope !== '+web-verify' && !(args.budgetUsd > 0)) {
    // Metered probes are MANUAL-ONLY + budget-capped (FD-8). No budget → refuse.
    // '+web-verify' is exempt: its DETERMINISTIC page fetch spends nothing (no
    // LLM, no metered key) — any future LLM-assisted extraction stays behind a
    // positive budget (fail-closed at 0 for that path).
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
  if (args.scope === '+web-verify') {
    // Web-verify (operator-directed schedule): DETERMINISTIC extraction from the
    // OFFICIAL pricing pages of the doors without machine-readable price APIs.
    // Conservative fail-closed parsers + the plausibility clamp vs canonical;
    // an unparseable page yields an honest note, never a guessed price.
    const manifest = readBaseline(args.plausibilityBaseline);
    const pages = [
      { door: 'groq-api', url: 'https://groq.com/pricing', parse: parseGroqPricingHtml },
      { door: 'gemini-api', url: 'https://ai.google.dev/pricing', parse: parseGooglePricingHtml },
    ];
    for (const page of pages) {
      try {
        const html = await fetchText(page.url);
        const pts = page.parse(html, now).filter((pt) => {
          if (!isSanePoint(pt)) return false;
          if (!plausibleVsCanonical(pt, manifest)) {
            notes.push(`${page.door}: extracted price for ${pt.modelId} REFUSED by the plausibility clamp (>10x off the reviewed price — likely a reshaped page)`);
            return false;
          }
          return true;
        });
        candidates.push(...pts);
        notes.push(`${page.door}: ${pts.length} price(s) extracted from the official pricing page${pts.length === 0 ? ' (page shape not confidently parseable — refused, never guessed)' : ''}`);
      } catch (err) {
        notes.push(`${page.door}: pricing-page fetch failed (${err?.message ?? err}) — skipped, no data written for this door`);
      }
    }
  } else {
    // gemini-api / groq-api need a key → out of the free scope. Honestly reported, never guessed.
    notes.push('gemini-api, groq-api: need an API key → not in free-probe scope (manual metered probe / scheduled web-verify)');
  }

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
