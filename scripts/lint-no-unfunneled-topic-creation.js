#!/usr/bin/env node
/**
 * lint-no-unfunneled-topic-creation.js — refuses raw Telegram topic creation
 * outside the budgeted funnel.
 *
 * Part of the "Bounded Notification Surface" standard
 * (docs/STANDARDS-REGISTRY.md), born from the THIRD topic-spam incident
 * (2026-06-05). `TelegramAdapter.createForumTopic` is the ONE chokepoint
 * where forum topics are born, and it enforces the last-resort auto-topic
 * budget. A feature that calls the Telegram Bot API's `createForumTopic`
 * method directly (via `apiCall(...)`, a hand-rolled fetch, or curl in a
 * shipped script) bypasses that budget — which is exactly how notification
 * floods ship.
 *
 * Rule: outside the allowlist below, no source file may contain a direct
 * `createForumTopic` Telegram-API invocation that is not the funnel method
 * itself (`adapter.createForumTopic(...)` / `findOrCreateForumTopic(...)`
 * calls are fine — they ARE the funnel).
 *
 * Flagged patterns:
 *   - apiCall('createForumTopic' / apiCall("createForumTopic"  (any receiver)
 *   - /bot<token>/createForumTopic-style raw URL fragments in .ts/.js
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-unfunneled-topic-creation.js            # full repo
 *   node scripts/lint-no-unfunneled-topic-creation.js --staged   # staged files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ── Allowlist (closed). Adding entries requires review of WHY the callsite
//    cannot route through the funnel, and how its volume is bounded. ──────
const ALLOWLIST = new Set([
  // THE funnel — the budget lives here.
  'src/messaging/TelegramAdapter.ts',
  // The lifeline runs in a separate process without a TelegramAdapter
  // instance. Its single createForumTopic call is the create-once,
  // self-healing '🛡️ Lifeline' system topic — cardinality fixed at 1.
  'src/lifeline/TelegramLifeline.ts',
  // Setup-wizard doc string: a curl EXAMPLE shown to the codex driver, not
  // an executed call path.
  'src/commands/setup-wizard/codex-driver.ts',
  // This lint file mentions the patterns it greps for.
  'scripts/lint-no-unfunneled-topic-creation.js',
]);

const SCAN_DIRS = ['src', 'scripts', 'templates'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh']);

const PATTERNS = [
  // Direct API-method invocation through any apiCall-style seam.
  /apiCall\(\s*['"`]createForumTopic['"`]/,
  // Raw Bot-API URL construction (fetch/curl in shipped scripts).
  /\/bot[^\s'"`]*\/createForumTopic/,
  // Hand-rolled method param, e.g. { method: 'createForumTopic' }.
  /method\s*:\s*['"`]createForumTopic['"`]/,
];

function listFiles() {
  const staged = process.argv.includes('--staged');
  if (staged) {
    // Read-only staged-file detection (same bootstrap escape as the other
    // lint scripts — runs pre-compile, can't use the TS funnel).
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
  const full = path.join(ROOT, normalized);
  let content;
  try {
    content = fs.readFileSync(full, 'utf-8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of PATTERNS) {
      if (pattern.test(lines[i])) {
        console.error(
          `${normalized}:${i + 1} — raw createForumTopic invocation outside the budgeted funnel. ` +
          `Route through TelegramAdapter.createForumTopic / findOrCreateForumTopic (declare an origin/label), ` +
          `or add an allowlist entry here with a bounded-volume justification.`,
        );
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\nlint-no-unfunneled-topic-creation: ${violations} violation(s). ` +
    `See docs/STANDARDS-REGISTRY.md "Bounded Notification Surface".`);
  process.exit(1);
}
console.log('lint-no-unfunneled-topic-creation: clean');
