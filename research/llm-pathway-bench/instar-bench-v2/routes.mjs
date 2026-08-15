#!/usr/bin/env node
// routes.mjs — INSTAR-Bench v2 provider-adaptive route discovery.
//
// Answers, on ANY instar agent: "which model routes can THIS machine bench
// right now?" — and never fails because a provider is missing (operator
// requirement, 2026-07-02: 'robustly support/adapt to whatever provider the
// agent has; should not fail if some providers are missing'). A missing door
// is a SKIP with a named reason, not an error; exit code is 0 even with zero
// routes (callers read `available.length`).
//
// Doors probed:
//   CLI subscriptions: claude, codex, pi, gemini  (binary presence + version)
//   Metered funnel:    vault keys named metered_<provider>_* (NAMES only —
//                      values never leave the vault; freeze state honored)
//
// Model matrix: bench-models.json (kept fresh by catalog-scan.mjs). Falls
// back to ../pathways.json entries when bench-models.json is absent, so
// discovery works on a fresh agent before the first catalog scan.
//
// Usage: node routes.mjs [--json] [--agent-home PATH]
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const AS_JSON = process.argv.includes('--json');
// Agent home: explicit flag → env → walk up from here (research/llm-pathway-bench/instar-bench-v2 → agent home).
const AGENT_HOME = resolve(arg('agent-home', process.env.INSTAR_AGENT_HOME || join(HERE, '..', '..', '..')));

// ---- CLI door probing (subscription frameworks) ----
// Common install locations beyond PATH (macOS homebrew, npm-global).
const EXTRA_BINS = [
  '/opt/homebrew/bin', '/usr/local/bin',
  join(process.env.HOME || '', '.npm-global', 'bin'),
  // asdf shims (how codex is installed on the reference dev machine — the
  // Bash tool's PATH may not include shims even when a login shell's does).
  join(process.env.HOME || '', '.asdf', 'shims'),
];
function findBinary(name) {
  const w = spawnSync('which', [name], { encoding: 'utf8' });
  if (w.status === 0 && w.stdout.trim()) return w.stdout.trim();
  for (const dir of EXTRA_BINS) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
function binaryVersion(bin) {
  // Cheap, bounded; a hung --version must not wedge discovery.
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000 });
  if (r.status === 0) return (r.stdout || r.stderr || '').trim().split('\n')[0].slice(0, 80);
  return null;
}

const CLI_DOORS = [
  { door: 'claude-code', binary: 'claude', subsidized: true, family: 'anthropic-subscription' },
  { door: 'codex-cli', binary: 'codex', subsidized: true, family: 'openai-subscription' },
  { door: 'pi-cli', binary: 'pi', subsidized: true, family: 'multi-subscription' },
  { door: 'gemini-cli', binary: 'gemini', subsidized: true, family: 'google-subscription' },
];

// ---- Metered door probing (vault key NAMES only, never values) ----
function vaultKeyNames() {
  const script = join(AGENT_HOME, '.instar', 'scripts', 'secret-get.mjs');
  if (!existsSync(script)) return { names: [], reason: 'no-vault-script' };
  // --names prints "name (len N)" lines to STDERR by design (values-safe).
  const r = spawnSync(process.execPath, [script, '--names'], {
    encoding: 'utf8', timeout: 20000, cwd: AGENT_HOME,
  });
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  const names = [...text.matchAll(/^\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(?:\(|—|-|:)/gm)].map((m) => m[1]);
  if (!names.length && r.status !== 0) return { names: [], reason: 'vault-unreadable' };
  return { names: [...new Set(names)] };
}
function funnelKeyState(keyName) {
  const funnel = join(HERE, '..', 'metered-funnel.mjs');
  if (!existsSync(funnel)) return { usable: false, reason: 'no-funnel' };
  const r = spawnSync(process.execPath, [funnel, 'status', '--key', keyName], {
    encoding: 'utf8', timeout: 15000, cwd: join(HERE, '..'),
  });
  try {
    const j = JSON.parse((r.stdout || '').trim().split('\n').pop());
    if (j.frozen) return { usable: false, reason: 'key-frozen' };
    return { usable: true, remaining: j.remainingUsd ?? j.remaining ?? null };
  } catch {
    // status unreadable → treat as usable-unknown; the funnel itself is the
    // fail-closed wall at call time (discovery must not double-guess it).
    return { usable: true, remaining: null, note: 'status-unreadable (funnel gates at call time)' };
  }
}

// ---- Model matrix ----
function loadModelMatrix() {
  const v2 = join(HERE, 'bench-models.json');
  if (existsSync(v2)) return { source: 'bench-models.json', doc: JSON.parse(readFileSync(v2, 'utf8')) };
  // Fallback: derive from v1 pathways.json so a fresh agent still benches.
  const v1 = join(HERE, '..', 'pathways.json');
  if (existsSync(v1)) {
    const reg = JSON.parse(readFileSync(v1, 'utf8'));
    const doc = { doors: {} };
    for (const p of reg.pathways) {
      const door = p.framework === 'funnel' ? `metered:${p.key}` : p.framework;
      (doc.doors[door] ??= { models: [] }).models.push({ id: p.model, tier: p.tier ?? null, routeId: p.id });
    }
    return { source: 'pathways.json (v1 fallback)', doc };
  }
  return { source: 'none', doc: { doors: {} } };
}

// ---- Discovery ----
export function discoverRoutes() {
  const available = [];
  const skipped = [];
  const matrix = loadModelMatrix();

  for (const d of CLI_DOORS) {
    const bin = findBinary(d.binary);
    if (!bin) { skipped.push({ door: d.door, reason: 'binary-not-found' }); continue; }
    const version = binaryVersion(bin);
    const models = matrix.doc.doors?.[mapCliDoorKey(d.door)]?.models
      ?? matrix.doc.doors?.[d.binary]?.models ?? [];
    available.push({
      door: d.door, kind: 'cli-subscription', subsidized: d.subsidized, family: d.family,
      binary: bin, version, models,
      // Auth liveness is NOT probed here (a real call costs quota + can hang);
      // the runner treats per-route auth failures as data, never a crash.
      authProbed: false,
    });
  }

  const vault = vaultKeyNames();
  if (!vault.names.length) {
    skipped.push({ door: 'metered:*', reason: vault.reason ?? 'no-metered-keys-in-vault' });
  } else {
    const meteredKeys = vault.names.filter((n) => /^metered_/i.test(n));
    if (!meteredKeys.length) skipped.push({ door: 'metered:*', reason: 'no-metered-keys-in-vault' });
    for (const key of meteredKeys) {
      const provider = (key.match(/^metered_([a-z0-9]+)_/i) || [])[1] ?? 'unknown';
      const state = funnelKeyState(key);
      if (!state.usable) { skipped.push({ door: `metered:${key}`, reason: state.reason }); continue; }
      const models = matrix.doc.doors?.[`metered:${key}`]?.models
        ?? matrix.doc.doors?.[provider]?.models ?? [];
      available.push({
        door: `metered:${key}`, kind: 'metered-funnel', subsidized: provider === 'groq', // groq free tier
        family: provider, key, models, remainingUsd: state.remaining ?? null,
        ...(state.note ? { note: state.note } : {}),
      });
    }
  }

  return { agentHome: AGENT_HOME, matrixSource: matrix.source, available, skipped };
}

// v1 pathways.json uses short framework names; CLI_DOORS use instar door ids.
function mapCliDoorKey(door) {
  return { 'claude-code': 'claude', 'codex-cli': 'codex', 'pi-cli': 'pi', 'gemini-cli': 'gemini' }[door] ?? door;
}

// ---- CLI entry ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = discoverRoutes();
  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 1));
  } else {
    console.error(`[routes] matrix: ${result.matrixSource}`);
    for (const a of result.available) {
      console.error(`  ✓ ${a.door} (${a.kind}${a.subsidized ? ', subsidized' : ''}) — ${a.models.length} models${a.remainingUsd != null ? `, $${a.remainingUsd} left` : ''}`);
    }
    for (const s of result.skipped) console.error(`  – ${s.door}: ${s.reason} (skipped, not an error)`);
    console.log(JSON.stringify({ available: result.available.length, skipped: result.skipped.length }));
  }
  process.exit(0); // ALWAYS 0 — missing providers are data, not failure.
}
