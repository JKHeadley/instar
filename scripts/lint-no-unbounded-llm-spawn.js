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
const PATTERNS = PROVIDER_CLASSES.map((cls) => new RegExp(`\\bnew\\s+${cls}\\s*\\(`));

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
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Comment-only mentions are documentation, not a construction.
    const trimmed = lines[i].trimStart();
    if (/^(\/\/|\*|\/\*|#)/.test(trimmed)) continue;
    for (const pattern of PATTERNS) {
      if (pattern.test(lines[i])) {
        console.error(
          `${normalized}:${i + 1} — direct LLM-CLI provider construction outside the spawn-cap funnel. ` +
          `Build it through buildIntelligenceProvider() (which installs the host-wide spawn cap + circuit breaker), ` +
          `or add an allowlist entry here with a spawn-bounding justification.`,
        );
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\nlint-no-unbounded-llm-spawn: ${violations} violation(s). ` +
    `See docs/specs/forkbomb-prevention-simple.md (§P1 — every spawn-capable provider must ride the spawn-cap funnel).`);
  process.exit(1);
}
console.log('lint-no-unbounded-llm-spawn: clean');
