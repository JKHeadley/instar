#!/usr/bin/env node
/**
 * metered-funnel.mjs — the ONLY component allowed to make metered-key LLM calls.
 * Spec: docs/planning/2026-07-01-metered-key-budget-guard-spec.md (Layer 3).
 *
 * Invariant: no metered call except through this funnel; no funnel call except
 * under budget; refusals FAIL CLOSED. Accounting is pessimistic: errors and
 * unparseable responses book the WORST-CASE estimate, never zero.
 *
 * Keys: fetched from the vault (secret-get.mjs) at call time by NAME
 * (`metered_*`). Values never touch argv of child shells, env dumps, logs,
 * ledgers, or stdout. The harness invokes this CLI and never sees key material.
 *
 * Usage:
 *   node metered-funnel.mjs call --key metered_openrouter_bench --model <id> \
 *        --prompt-file <path> [--max-tokens 256] [--label tag] [--timeout 60000]
 *   node metered-funnel.mjs status [--key NAME]
 *   node metered-funnel.mjs freeze --key NAME | unfreeze --key NAME
 *
 * Exit codes: 0 ok · 2 refused-by-gate (fail closed) · 3 provider/network error
 * (worst-case booked) · 4 config error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_HOME = path.resolve(HERE, '..', '..');
const STATE_DIR = path.join(HERE, 'state');
const CAPS_FILE = path.join(HERE, 'metered-caps.json');
const PRICES_FILE = path.join(HERE, 'metered-prices.json');

// ── Pure gate logic (unit-tested; no I/O) ────────────────────────────────
/**
 * Decide whether a call may proceed. Returns {allow, reason, estCostUsd}.
 * Fail-closed: any missing/invalid input refuses.
 */
export function gateCheck({ caps, spent, price, maxTokens, promptTokensEst }) {
  if (!caps || typeof caps !== 'object') return { allow: false, reason: 'no-caps-configured' };
  if (caps.frozen) return { allow: false, reason: 'frozen' };
  const life = Number(caps.lifetimeCapUsd);
  const daily = Number(caps.dailyCapUsd);
  if (!Number.isFinite(life) || life <= 0) return { allow: false, reason: 'invalid-lifetime-cap' };
  if (!Number.isFinite(daily) || daily <= 0) return { allow: false, reason: 'invalid-daily-cap' };
  if (!price || !Number.isFinite(price.inPerMtok) || !Number.isFinite(price.outPerMtok)) {
    return { allow: false, reason: 'unknown-price' }; // never "assume cheap"
  }
  const mt = Number(maxTokens);
  if (!Number.isFinite(mt) || mt <= 0) return { allow: false, reason: 'invalid-max-tokens' };
  const pt = Number.isFinite(Number(promptTokensEst)) ? Number(promptTokensEst) : NaN;
  if (!Number.isFinite(pt) || pt < 0) return { allow: false, reason: 'invalid-prompt-estimate' };
  // Worst case: full prompt in, full max_tokens out.
  const estCostUsd = (pt / 1e6) * price.inPerMtok + (mt / 1e6) * price.outPerMtok;
  const lifetimeSpent = Number(spent?.lifetimeUsd ?? NaN);
  const dailySpent = Number(spent?.dailyUsd ?? NaN);
  if (!Number.isFinite(lifetimeSpent) || !Number.isFinite(dailySpent)) {
    return { allow: false, reason: 'ledger-unreadable' }; // fail closed on bad ledger
  }
  if (lifetimeSpent + estCostUsd > life) return { allow: false, reason: 'lifetime-cap', estCostUsd };
  if (dailySpent + estCostUsd > daily) return { allow: false, reason: 'daily-cap', estCostUsd };
  return { allow: true, reason: 'ok', estCostUsd };
}

/** Pessimistic actual-cost: parse usage; unparseable → worst-case estimate. */
export function settleCost({ usage, price, estCostUsd }) {
  const inTok = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? NaN);
  const outTok = Number(usage?.completion_tokens ?? usage?.output_tokens ?? NaN);
  if (Number.isFinite(inTok) && Number.isFinite(outTok) && inTok >= 0 && outTok >= 0) {
    const actual = (inTok / 1e6) * price.inPerMtok + (outTok / 1e6) * price.outPerMtok;
    // Never book BELOW what the provider could charge: use max(actual, 0) but
    // if actual wildly under-runs the estimate that's fine — actual is truth.
    return { costUsd: actual, tokensIn: inTok, tokensOut: outTok, basis: 'actual' };
  }
  return { costUsd: estCostUsd, tokensIn: null, tokensOut: null, basis: 'worst-case-estimate' };
}

// ── Ledger (durable, single-writer via lock dir) ─────────────────────────
function ledgerPaths(keyName) {
  return {
    jsonl: path.join(STATE_DIR, `metered-ledger.${keyName}.jsonl`),
    rollup: path.join(STATE_DIR, `metered-rollup.${keyName}.json`),
    lock: path.join(STATE_DIR, `metered-lock.${keyName}`),
  };
}

function withLock(keyName, fn) {
  const { lock } = ledgerPaths(keyName);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale-lock reclaim: a lock older than 120s belongs to a dead caller.
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 120_000) { fs.rmdirSync(lock); continue; }
      } catch { /* raced; retry */ }
      if (Date.now() - start > 60_000) throw new Error('ledger lock timeout');
      const buf = new SharedArrayBuffer(4); // sleep without child procs
      Atomics.wait(new Int32Array(buf), 0, 0, 50);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
}

function readRollup(keyName) {
  const { rollup } = ledgerPaths(keyName);
  try {
    const j = JSON.parse(fs.readFileSync(rollup, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    return {
      lifetimeUsd: Number(j.lifetimeUsd) || 0,
      dailyUsd: j.day === today ? (Number(j.dailyUsd) || 0) : 0,
      day: today,
    };
  } catch {
    if (fs.existsSync(rollup)) return null; // exists but unreadable → fail closed upstream
    return { lifetimeUsd: 0, dailyUsd: 0, day: new Date().toISOString().slice(0, 10) };
  }
}

function bookCost(keyName, entry) {
  const { jsonl, rollup } = ledgerPaths(keyName);
  const roll = readRollup(keyName);
  if (roll === null) throw new Error('rollup unreadable — refusing to book blind');
  roll.lifetimeUsd += entry.costUsd;
  roll.dailyUsd += entry.costUsd;
  const tmp = rollup + '.tmp';
  fs.appendFileSync(jsonl, JSON.stringify(entry) + '\n');
  fs.writeFileSync(tmp, JSON.stringify(roll, null, 1));
  fs.renameSync(tmp, rollup);
  return roll;
}

// ── Config, vault, alerts ────────────────────────────────────────────────
function loadJson(p, what) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(4, `${what} unreadable at ${p}: ${e.message}`); }
}

function vaultGet(name) {
  // stdout = value; NEVER printed/logged by us. cwd MUST be the agent home —
  // secret-get.mjs resolves the vault path relative to cwd (canary run #1 bug).
  const out = execFileSync('node', [path.join(AGENT_HOME, '.instar', 'scripts', 'secret-get.mjs'), name],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: AGENT_HOME });
  const v = out.trim();
  if (!v) die(4, `vault returned empty value for ${name}`);
  return v;
}

function tryAlert(title, body) {
  try {
    const auth = vaultGet('authToken');
    const req = JSON.stringify({ id: `funnel:${title.replace(/\W+/g, '-').slice(0, 60)}`, title, body, priority: 'medium', source: 'metered-funnel' });
    execFileSync('curl', ['-s', '-m', '5', '-X', 'POST', '-H', `Authorization: Bearer ${auth}`,
      '-H', 'Content-Type: application/json', '-d', req, 'http://localhost:4042/attention'],
      { stdio: 'ignore' });
  } catch { /* alerts are best-effort; the GATE is the guarantee */ }
}

function alertThresholds(keyName, roll, caps, prevLifetime) {
  for (const frac of [0.5, 0.8]) {
    const line = caps.lifetimeCapUsd * frac;
    if (prevLifetime < line && roll.lifetimeUsd >= line) {
      tryAlert(`Metered key ${keyName} at ${frac * 100}% of lifetime budget`,
        `Spent $${roll.lifetimeUsd.toFixed(4)} of $${caps.lifetimeCapUsd} (cap file: metered-caps.json).`);
    }
  }
}

// ── Providers ────────────────────────────────────────────────────────────
const PROVIDERS = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', style: 'openai' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', style: 'openai' },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', style: 'openai' },
  deepinfra: { url: 'https://api.deepinfra.com/v1/openai/chat/completions', style: 'openai' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', style: 'anthropic' },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', style: 'openai' },
};

// Model-LIST endpoints (zero-cost metadata GETs, for the `models` command —
// the catalog scanner's read path; key custody stays inside the funnel).
// Every PROVIDERS entry MUST have a row here (paired-map test enforces it).
export const MODEL_LIST_URLS = {
  openrouter: { url: 'https://openrouter.ai/api/v1/models', style: 'openai' },
  openai: { url: 'https://api.openai.com/v1/models', style: 'openai' },
  groq: { url: 'https://api.groq.com/openai/v1/models', style: 'openai' },
  deepinfra: { url: 'https://api.deepinfra.com/v1/openai/models', style: 'openai' },
  anthropic: { url: 'https://api.anthropic.com/v1/models', style: 'anthropic' },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', style: 'openai' },
};

async function providerCall({ provider, apiKey, model, prompt, maxTokens, timeoutMs }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider ${provider}`);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (p.style === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    }
    const res = await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* handled below */ }
    return { httpStatus: res.status, json, rawLen: text.length };
  } finally { clearTimeout(t); }
}

// ── CLI ──────────────────────────────────────────────────────────────────
function die(code, msg, extra) {
  process.stdout.write(JSON.stringify({ ok: false, refused: code === 2, error: msg, ...extra }) + '\n');
  process.exit(code);
}

function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else a._.push(argv[i]);
  }
  return a;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === 'status') {
    const caps = loadJson(CAPS_FILE, 'caps');
    const out = {};
    for (const k of Object.keys(caps.keys ?? {})) {
      if (a.key && a.key !== k) continue;
      out[k] = { caps: caps.keys[k], spent: readRollup(k) };
    }
    process.stdout.write(JSON.stringify(out, null, 1) + '\n');
    return;
  }
  if (cmd === 'freeze' || cmd === 'unfreeze') {
    if (!a.key) die(4, '--key required');
    const caps = loadJson(CAPS_FILE, 'caps');
    if (!caps.keys?.[a.key]) die(4, `unknown key ${a.key} in caps file`);
    caps.keys[a.key].frozen = cmd === 'freeze';
    fs.writeFileSync(CAPS_FILE, JSON.stringify(caps, null, 1));
    process.stdout.write(JSON.stringify({ ok: true, key: a.key, frozen: caps.keys[a.key].frozen }) + '\n');
    return;
  }
  if (cmd === 'models') {
    // Zero-cost catalog read for the v2 model scanner. No budget gate (no
    // tokens are spent), but the operator kill switch (frozen) is honored —
    // a frozen key's custody is not touched for ANY purpose.
    const keyName = a.key;
    if (!keyName || !/^metered_[a-z0-9_]+$/.test(keyName)) die(4, 'valid --key (metered_*) required');
    const capsAll = loadJson(CAPS_FILE, 'caps');
    const caps = capsAll.keys?.[keyName];
    if (!caps) die(4, `unknown key ${keyName} in caps file`);
    if (caps.frozen) die(2, 'gate refused: key-frozen', { reason: 'key-frozen' });
    const listCfg = MODEL_LIST_URLS[caps.provider];
    if (!listCfg) die(4, `no model-list endpoint for provider ${caps.provider}`);
    const apiKey = vaultGet(keyName);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Number(a.timeout ?? 30_000));
    try {
      const headers = listCfg.style === 'anthropic'
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${apiKey}` };
      const res = await fetch(listCfg.url, { headers, signal: ctl.signal });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) die(3, `model-list fetch failed: HTTP ${res.status}`);
      // Normalize: OpenAI-style { data: [{id, ...}] }; OpenRouter adds pricing.
      const models = (json.data ?? []).map((m) => ({
        id: m.id,
        ...(m.pricing ? { pricing: { prompt: m.pricing.prompt, completion: m.pricing.completion } } : {}),
        ...(m.context_length ? { contextLength: m.context_length } : {}),
        ...(m.created ? { created: m.created } : {}),
      }));
      process.stdout.write(JSON.stringify({ ok: true, provider: caps.provider, count: models.length, models }) + '\n');
    } finally { clearTimeout(t); }
    return;
  }
  if (cmd !== 'call') die(4, `unknown command ${cmd ?? '(none)'} — use call|models|status|freeze|unfreeze`);

  const keyName = a.key;
  if (!keyName || !/^metered_[a-z0-9_]+$/.test(keyName)) die(4, 'valid --key (metered_*) required');
  const model = a.model;
  if (!model) die(4, '--model required');
  const promptFile = a['prompt-file'];
  if (!promptFile || !fs.existsSync(promptFile)) die(4, '--prompt-file required and must exist');
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const maxTokens = Number(a['max-tokens'] ?? 256);
  const timeoutMs = Number(a.timeout ?? 60_000);
  const label = String(a.label ?? 'unlabeled');

  const capsAll = loadJson(CAPS_FILE, 'caps');
  const caps = capsAll.keys?.[keyName];
  const provider = caps?.provider;
  const prices = loadJson(PRICES_FILE, 'prices');
  const price = prices[model];
  const promptTokensEst = Math.ceil(prompt.length / 3.2); // conservative chars/token

  // Gate + book under ONE lock so parallel callers can't both pass at the cap.
  let verdict, roll0;
  withLock(keyName, () => {
    roll0 = readRollup(keyName);
    verdict = gateCheck({ caps, spent: roll0, price, maxTokens, promptTokensEst });
    if (verdict.allow) {
      // Reserve the worst case UP FRONT (prevents concurrent over-admission).
      bookCost(keyName, { ts: new Date().toISOString(), kind: 'reserve', label, model, costUsd: verdict.estCostUsd });
    }
  });
  if (!verdict.allow) {
    tryAlert(`Metered funnel refused ${keyName}`, `reason=${verdict.reason} model=${model} label=${label}`);
    die(2, `gate refused: ${verdict.reason}`, { reason: verdict.reason });
  }

  let settle, httpStatus = null, outputText = null, ok = false, errorDetail;
  try {
    const apiKey = vaultGet(keyName);
    const res = await providerCall({ provider, apiKey, model, prompt, maxTokens, timeoutMs });
    httpStatus = res.httpStatus;
    const usage = res.json?.usage;
    settle = settleCost({ usage, price, estCostUsd: verdict.estCostUsd });
    // A 402 (payment required / prepaid balance exhausted) charges NOTHING —
    // settling it at worst-case books phantom spend against the wall (the
    // 2026-07-02 incident: 3,451 refused calls booked ~$19 of reservations).
    if (httpStatus === 402) settle = { costUsd: 0, tokensIn: null, tokensOut: null, basis: 'vendor-402-no-charge' };
    // 429 (rate-limited): the request is refused before processing — nothing is
    // charged. Settling at worst-case books phantom spend (the gemini-native
    // pro-preview case: 218 refusals ≈ $3.4 of phantom reservations).
    if (httpStatus === 429) settle = { costUsd: 0, tokensIn: null, tokensOut: null, basis: 'vendor-429-no-charge' };
    outputText = res.json?.choices?.[0]?.message?.content ?? res.json?.content?.[0]?.text ?? null;
    if (httpStatus !== 200) errorDetail = String(res.json?.error?.message ?? (res.json != null ? JSON.stringify(res.json) : '')).slice(0, 800) || undefined;
    ok = httpStatus === 200 && outputText != null;
  } catch (e) {
    settle = { costUsd: verdict.estCostUsd, tokensIn: null, tokensOut: null, basis: 'worst-case-estimate', error: String(e.message) };
  }

  // Reconcile: replace the reservation with the settled cost (delta booking).
  let rollAfter;
  withLock(keyName, () => {
    const delta = settle.costUsd - verdict.estCostUsd; // usually ≤ 0
    rollAfter = bookCost(keyName, {
      ts: new Date().toISOString(), kind: 'settle', label, model,
      costUsd: delta, basis: settle.basis, tokensIn: settle.tokensIn, tokensOut: settle.tokensOut, httpStatus,
    });
    alertThresholds(keyName, rollAfter, caps, roll0.lifetimeUsd);
  });

  process.stdout.write(JSON.stringify({
    ok, httpStatus, model, label,
    tokensIn: settle.tokensIn, tokensOut: settle.tokensOut,
    costUsd: Number(settle.costUsd.toFixed(6)), costBasis: settle.basis,
    lifetimeSpentUsd: Number(rollAfter.lifetimeUsd.toFixed(6)),
    output: ok ? outputText : null,
    error: settle.error ?? (ok ? undefined : `http-${httpStatus}`),
    errorDetail,
  }) + '\n');
  process.exit(ok ? 0 : 3);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => die(4, e.message));
