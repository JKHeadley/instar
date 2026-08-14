#!/usr/bin/env node
/**
 * lint-no-unbounded-llm-spawn.js — refuses a raw LLM-CLI provider construction
 * outside the spawn-cap funnel.
 *
 * Part of the SIMPLE fork-bomb prevention design
 * (docs/specs/forkbomb-prevention-simple.md §P1). The host-wide concurrent-spawn
 * cap is enforced by the SpawnCapIntelligenceProvider wrapper, which is installed
 * at EVERY return arm of `buildIntelligenceProvider` (the factory funnel). Any
 * code that constructs an LLM-CLI provider DIRECTLY —
 *   new ClaudeCliIntelligenceProvider(...)
 *   new CodexCliIntelligenceProvider(...)
 *   new GeminiCliIntelligenceProvider(...)
 *   new PiCliIntelligenceProvider(...)
 * — bypasses that wrapper, re-introducing an UN-CAPPED spawn path: the exact
 * 2026-06-20 fork-bomb vector (one `claude -p` per call, zero concurrency
 * control). That bypass must fail CI, not be discovered on the next OOM.
 *
 * RULE: outside the allowlist below, no source file may construct one of those
 * providers directly. Route through `buildIntelligenceProvider(...)` (the
 * factory), which applies the spawn cap + circuit breaker.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-unbounded-llm-spawn.js            # full repo
 *   node scripts/lint-no-unbounded-llm-spawn.js --staged   # staged files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// The LLM-CLI provider classes — constructing any of them is a SPAWN-capable
// path (their evaluate() shells out to the CLI binary).
const PROVIDER_CLASSES = [
  'ClaudeCliIntelligenceProvider',
  'CodexCliIntelligenceProvider',
  'GeminiCliIntelligenceProvider',
  'PiCliIntelligenceProvider',
];

// ── Allowlist (closed). Adding an entry requires review of WHY the callsite
//    cannot route through buildIntelligenceProvider() (where the spawn-cap
//    wrapper is installed), and how its spawn is otherwise bounded. ─────────
const ALLOWLIST = new Set([
  // THE funnel — the spawn-cap wrapper is installed here, around every
  // construction (wrapForFunnel).
  'src/core/intelligenceProviderFactory.ts',
  // The provider definitions themselves (their own class bodies).
  'src/core/ClaudeCliIntelligenceProvider.ts',
  'src/core/CodexCliIntelligenceProvider.ts',
  'src/core/GeminiCliIntelligenceProvider.ts',
  'src/core/PiCliIntelligenceProvider.ts',
  // This lint file mentions the symbols it greps for.
  'scripts/lint-no-unbounded-llm-spawn.js',
]);

const SCAN_DIRS = ['src', 'scripts', 'templates'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// `new <ProviderClass>(` — the construction. An IMPORT of the class is fine
// (the factory imports them); only a direct `new …(` outside the funnel is a
// bypass.
//
// ALIAS + NAMESPACE AWARE (2026-08-14). The original matched the class NAME as
// literal text, so two ordinary import styles walked straight past a SAFETY
// floor — the spawn cap added after the 2026-06-20 OOM fork-bomb:
//
//   import { ClaudeCliIntelligenceProvider as Provider } from '...';
//   new Provider(...)                       // real uncapped construction, invisible
//
//   import * as mod from '...';
//   new mod.ClaudeCliIntelligenceProvider(...)   // also invisible: `\bnew\s+Cls`
//                                                // cannot match across `mod.`
//
// Found by a peer-agent audit for checks defeatable by renaming. Resolve the
// local bindings FIRST, then match constructions under any of them.

/** Every local name a provider class is bound to in this file, plus namespace forms. */
export function localProviderBindings(content, cls) {
  const names = new Set([cls]);
  // `import { Cls as Alias }` and `const { Cls: Alias } = await import(...)`
  for (const m of content.matchAll(new RegExp(`\\b${cls}\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g'))) names.add(m[1]);
  for (const m of content.matchAll(new RegExp(`\\b${cls}\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'g'))) names.add(m[1]);
  return [...names];
}

/**
 * Line numbers (1-based) in `content` that construct a spawn-capable provider,
 * under ANY local binding or namespace qualifier. Comment-only lines excluded.
 */
export function findProviderConstructions(content, classes = PROVIDER_CLASSES) {
  const hits = [];
  const lines = content.split('\n');
  const perClass = classes.map((cls) => ({
    cls,
    names: localProviderBindings(content, cls),
  }));
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (/^(\/\/|\*|\/\*|#)/.test(trimmed)) continue;
    for (const { cls, names } of perClass) {
      const bare = names.some((n) => new RegExp(`\\bnew\\s+${n}\\s*\\(`).test(lines[i]));
      // `new <ns>.<Cls>(` — a namespace import the bare form cannot see.
      const viaNs = new RegExp(`\\bnew\\s+[A-Za-z_$][\\w$]*\\.${cls}\\s*\\(`).test(lines[i]);
      if (bare || viaNs) { hits.push({ line: i + 1, cls }); break; }
    }
  }
  return hits;
}

function listFiles() {
  const staged = process.argv.includes('--staged');
  if (staged) {
    const out = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf-8' });
    return out.split('\n').filter(Boolean);
  }
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit;

  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (EXTENSIONS.has(path.extname(e.name))) files.push(path.relative(ROOT, full));
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d));
  return files;
}

// ── CLI body ─────────────────────────────────────────────────────────────
// Guarded so the exported detector above can be imported by tests WITHOUT
// running the scan — this module calls process.exit(1) on a violation, so an
// unguarded import would kill any test run the moment the repo had one.
// Same pattern as scripts/eli16-pr-description-check.mjs.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
let violations = 0;
for (const rel of listFiles()) {
  const normalized = rel.split(path.sep).join('/');
  if (ALLOWLIST.has(normalized)) continue;
  if (!EXTENSIONS.has(path.extname(normalized))) continue;
  // Test files exercise the providers directly with stubs / real spawns under
  // controlled conditions — they are not a production spawn path.
  if (/(^|\/)tests\//.test(normalized) || /\.test\.[cm]?[jt]sx?$/.test(normalized)) continue;
  const full = path.isAbsolute(normalized) ? normalized : path.join(ROOT, normalized);
  let content;
  try {
    content = fs.readFileSync(full, 'utf-8');
  } catch {
    continue;
  }
  for (const hit of findProviderConstructions(content)) {
    console.error(
      `${normalized}:${hit.line} — direct LLM-CLI provider construction outside the spawn-cap funnel. ` +
      `Build it through buildIntelligenceProvider() (which installs the host-wide spawn cap + circuit breaker), ` +
      `or add an allowlist entry here with a spawn-bounding justification.`,
    );
    violations++;
  }
}

if (violations > 0) {
  console.error(`\nlint-no-unbounded-llm-spawn: ${violations} violation(s). ` +
    `See docs/specs/forkbomb-prevention-simple.md (§P1 — every spawn-capable provider must ride the spawn-cap funnel).`);
  process.exit(1);
}
console.log('lint-no-unbounded-llm-spawn: clean');
}
