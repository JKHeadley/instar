#!/usr/bin/env node
/**
 * lint-no-opus-claude-cli-gating.js — INSTAR-Bench v3, Task-4 S2 (bench rules R1/R2).
 *
 * Opus-via-Claude-Code-CLI is the one MEASURED-BANNED route for bounded/gating
 * verdicts: identical Opus 4.8 scores 99.1% via clean API vs 81.7% via the Claude
 * Code CLI (a 17.4-pt door penalty), and on the emergency-stop classifier it missed
 * canonical STOP commands (73%). The Claude Code harness wraps every prompt in ~20k
 * tokens of "helpful coding agent" framing, turning a skeptical judge into a
 * credulous assistant. R1 forbids routing bounded verdicts through that door; R2
 * forbids the emergency-stop classifier on it specifically.
 *
 * This lint enforces the ban STRUCTURALLY, in two prongs:
 *
 *  PRONG A — the runtime guardrail must stay intact. The IntelligenceRouter clamps
 *    a bounded/gating failure-swap onto `claude-code` from the `capable` tier
 *    (=Opus) down to `balanced` (=Sonnet CLI reserve). If someone deletes that
 *    clamp, a swap could once again land Opus-via-CLI on a gate. The lint fails if
 *    the `clampClaudeCliSwapModel` guardrail is missing from src/core/
 *    IntelligenceRouter.ts or is no longer invoked in the swap loop. Structure >
 *    Willpower: the guard cannot be silently removed.
 *
 *  PRONG B — no committed config statically routes a gating call to opus×claude-CLI.
 *    Scans committed JSON config for the dangerous COMBINATION: `frameworkDefaultModels
 *    ['claude-code']` set to an Opus model AND `claude-code` reachable as a gating
 *    route (listed in `componentFrameworks.failureSwap`, or set as the framework for
 *    the `sentinel`/`gate` categories, or a per-component override). Either alone is
 *    fine (Opus-CLI as the CHAIN WRITE quality lane is legitimate); the two together
 *    are the banned bounded-verdict route.
 *
 * Exit codes: 0 — clean; 1 — guardrail missing (A) or a dangerous config found (B).
 *
 * Usage:
 *   node scripts/lint-no-opus-claude-cli-gating.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const ROUTER_SRC = path.join(ROOT, 'src', 'core', 'IntelligenceRouter.ts');

/** Model ids / tier aliases that resolve to Opus on claude-code. */
const OPUS_MODELS = ['capable', 'opus', 'claude-opus'];

/**
 * PRONG A — the router still contains AND invokes the R1/R2 clamp guardrail.
 * @param {string} routerSrc
 * @returns {string[]} problems (empty = OK)
 */
export function checkGuardrailIntact(routerSrc) {
  const problems = [];
  // The helper must be DEFINED (exported for its unit test) …
  if (!/export function clampClaudeCliSwapModel\b/.test(routerSrc)) {
    problems.push(
      'src/core/IntelligenceRouter.ts: the R1/R2 guardrail `clampClaudeCliSwapModel` is missing — ' +
        'a bounded/gating failure-swap could once again resolve to Opus-via-Claude-CLI.',
    );
  }
  // … AND invoked inside the swap path (a defined-but-unused helper guards nothing).
  const invocations = (routerSrc.match(/clampClaudeCliSwapModel\s*\(/g) || []).length;
  // One for the `export function` signature, at least one real call site.
  if (invocations < 2) {
    problems.push(
      'src/core/IntelligenceRouter.ts: `clampClaudeCliSwapModel` is defined but never invoked in the ' +
        'failure-swap loop — the R1/R2 clamp is inert. Wire it where the swap `attemptOptions` is built.',
    );
  }
  return problems;
}

/**
 * @param {unknown} model
 * @returns {boolean} true if this model string resolves to Opus.
 */
function isOpusModel(model) {
  if (typeof model !== 'string') return false;
  const m = model.toLowerCase();
  return OPUS_MODELS.some((o) => m.includes(o));
}

/**
 * Extract a `componentFrameworks`-shaped block from a parsed config object,
 * checking both the top level and the `sessions` nesting used in .instar/config.json.
 * @param {any} cfg
 * @returns {{ componentFrameworks?: any, frameworkDefaultModels?: any } | null}
 */
function extractRoutingConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const sessions = cfg.sessions && typeof cfg.sessions === 'object' ? cfg.sessions : {};
  const componentFrameworks = cfg.componentFrameworks ?? sessions.componentFrameworks;
  const frameworkDefaultModels = cfg.frameworkDefaultModels ?? sessions.frameworkDefaultModels;
  if (componentFrameworks === undefined && frameworkDefaultModels === undefined) return null;
  return { componentFrameworks, frameworkDefaultModels };
}

/**
 * PRONG B — is `claude-code` reachable as a GATING route in this componentFrameworks
 * block? (failureSwap tail, or the framework for a gate/sentinel category, or an override.)
 * @param {any} componentFrameworks
 * @returns {boolean}
 */
function claudeCodeIsGatingRoute(componentFrameworks) {
  if (!componentFrameworks || typeof componentFrameworks !== 'object') return false;
  const cf = componentFrameworks;
  if (Array.isArray(cf.failureSwap) && cf.failureSwap.includes('claude-code')) return true;
  if (cf.categories && typeof cf.categories === 'object') {
    if (cf.categories.gate === 'claude-code' || cf.categories.sentinel === 'claude-code') return true;
  }
  if (cf.overrides && typeof cf.overrides === 'object') {
    if (Object.values(cf.overrides).includes('claude-code')) return true;
  }
  if (cf.default === 'claude-code') return true;
  return false;
}

/**
 * PRONG B — evaluate one parsed config object. Returns a reason string if it routes
 * a gating call to Opus×claude-CLI, else null.
 * @param {any} cfg
 * @returns {string | null}
 */
export function checkConfigObject(cfg) {
  const routing = extractRoutingConfig(cfg);
  if (!routing) return null;
  const claudeDefault = routing.frameworkDefaultModels?.['claude-code'];
  if (!isOpusModel(claudeDefault)) return null; // claude-code default isn't Opus → safe
  if (!claudeCodeIsGatingRoute(routing.componentFrameworks)) return null; // not a gating route → safe
  return (
    `frameworkDefaultModels['claude-code'] = '${claudeDefault}' (Opus) AND claude-code is reachable as a ` +
    `gating route (failureSwap / gate|sentinel category / override) — this is the banned Opus×claude-CLI ` +
    `bounded-verdict door (R1/R2). Use a non-Opus tier for the claude-code gating fallback (sonnet/haiku), ` +
    `or remove claude-code from the gating route.`
  );
}

/**
 * Recursively collect committed JSON config files worth scanning. We only care
 * about files that could carry a componentFrameworks block; scanning every JSON in
 * the tree is wasteful and node_modules is excluded.
 * @param {string} dir
 * @param {string[]} acc
 */
function collectConfigJson(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectConfigJson(full, acc);
    } else if (e.isFile() && e.name.endsWith('.json')) {
      acc.push(full);
    }
  }
}

/**
 * @param {string[]} files
 * @returns {{ file: string, reason: string }[]}
 */
export function scanConfigFiles(files) {
  const problems = [];
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Cheap pre-filter: only parse files that mention componentFrameworks.
    if (!raw.includes('componentFrameworks')) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // not our concern — other lints/CI cover malformed JSON
    }
    const reason = checkConfigObject(parsed);
    if (reason) problems.push({ file, reason });
  }
  return problems;
}

function main() {
  const problems = [];

  // PRONG A
  let routerSrc = '';
  try {
    routerSrc = fs.readFileSync(ROUTER_SRC, 'utf8');
  } catch (err) {
    console.error(`lint-no-opus-claude-cli-gating: cannot read IntelligenceRouter.ts — ${err.message}`);
    process.exit(1);
  }
  problems.push(...checkGuardrailIntact(routerSrc));

  // PRONG B
  const configFiles = [];
  collectConfigJson(ROOT, configFiles);
  const configProblems = scanConfigFiles(configFiles);
  for (const p of configProblems) {
    problems.push(`${path.relative(ROOT, p.file)}: ${p.reason}`);
  }

  if (problems.length === 0) {
    console.log(
      'lint-no-opus-claude-cli-gating: OK — R1/R2 clamp intact; no config routes a gating call to Opus×claude-CLI.',
    );
    process.exit(0);
  }
  console.error('lint-no-opus-claude-cli-gating: FAILED (INSTAR-Bench v3 R1/R2):');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) main();
