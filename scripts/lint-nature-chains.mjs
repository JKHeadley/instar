#!/usr/bin/env node
/**
 * lint-nature-chains.mjs — the FD4 HARNESS-DOOR BAN, enforced at BUILD time.
 *
 * Spec: docs/specs/nature-axis-routing.md — FD4 (§188-232, "The harness-door ban"),
 * FD4.1 (§205, the pinned-concrete-id reserve), FD8 (§393, no-Fable).
 *
 * THE INVARIANT (structurally unbreakable, enforced in THREE places — §202):
 *   No FAST/SORT/JUDGE (bounded/gating) chain position may resolve to a NON-reserve
 *   model on the `claude-code` harness door. The ONE permitted claude-code position in
 *   a bounded/gating chain is the single sanctioned reserve — pinned to a CONCRETE model
 *   id (via ROUTING_LABEL_TO_MODEL_ID['claude-code']), NEVER a bare tier label (a label
 *   could resolve differently under a future CLI alias/tier remap — the Adv3 class). It is
 *   a deny-by-default ALLOWLIST, not a denylist: any claude-code id that is not the reserve
 *   fails, so a future/unrecognized capable Claude id can never slip past. WRITE is exempt —
 *   open-ended writing is the sole legitimate Opus-via-CLI lane. Additionally (FD8 §393):
 *   NO chain position (incl. WRITE) may resolve to a Fable model.
 *
 * THIS is the compile-time place of the three (§202). The other two are RUNTIME, in
 * src/core/IntelligenceRouter.ts: the resolve-time/config-load validator
 * (`validateNatureRoutingChains`) and the per-position allowlist clamp
 * (`clampToReserveOnCleanDoor` + A1's always-on `clampClaudeCliSwapModel`). The companion
 * ratchet test (tests/unit/llm-routing-nature-ratchet.test.ts) pins this SAME invariant
 * over the real imported TS symbols and asserts this lint agrees with the TS validator
 * (drift guard) — Structure > Willpower.
 *
 * This is a build RATCHET: it exits 1 on any violation (the authored v3 defaults are clean,
 * so it passes today). It reads SOURCE TEXT (the house pattern — lints run pre-compile), and
 * it hard-codes NOTHING about which id is "right": it derives the reserve id and the label→id
 * map from src/data/llmBenchCoverage.ts, so swapping the sanctioned reserve is a data edit
 * there, never a change here.
 *
 * Exit codes: 0 — every chain position clean; 1 — at least one ban violation, or a
 * parse/read error (fail-closed: an unparseable map is a build failure, not a silent pass).
 *
 * Usage:
 *   node scripts/lint-nature-chains.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const COVERAGE_SRC = path.join(ROOT, 'src', 'data', 'llmBenchCoverage.ts');

const BOUNDED_GATING_CHAINS = new Set(['FAST', 'SORT', 'JUDGE']);
const KNOWN_TIER_LABELS = new Set(['fast', 'balanced', 'capable', 'ultra', 'reasoning']);

/** Slice a top-level `export const NAME ...= {` … `\n};` block body from source. */
function sliceConstBlock(src, name) {
  const start = src.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} not found in ${path.basename(COVERAGE_SRC)}`);
  const braceOpen = src.indexOf('{', start);
  if (braceOpen < 0) throw new Error(`${name}: opening brace not found`);
  const end = src.indexOf('\n};', braceOpen);
  if (end < 0) throw new Error(`${name}: terminating '\\n};' not found`);
  return src.slice(braceOpen, end);
}

/**
 * Extract ROUTING_LABEL_TO_MODEL_ID as { [door]: { [label]: concreteId } }.
 * Each door entry is `'door': { 'label': 'id', label2: 'id2' }`.
 */
export function extractLabelMap(src) {
  const body = sliceConstBlock(src, 'ROUTING_LABEL_TO_MODEL_ID');
  const map = {};
  const doorRe = /'([^']+)':\s*\{([^}]*)\}/g;
  let dm;
  while ((dm = doorRe.exec(body)) !== null) {
    const door = dm[1];
    const inner = dm[2];
    const pairRe = /(?:'([^']+)'|([A-Za-z][\w.\-]*))\s*:\s*'([^']+)'/g;
    const labels = {};
    let pm;
    while ((pm = pairRe.exec(inner)) !== null) {
      const label = pm[1] || pm[2];
      labels[label] = pm[3];
    }
    map[door] = labels;
  }
  if (Object.keys(map).length === 0) throw new Error('ROUTING_LABEL_TO_MODEL_ID parsed empty');
  return map;
}

/**
 * Extract NATURE_ROUTING_DEFAULT_CHAINS as { FAST:[{door,model}], SORT:[...], ... }.
 * Positions are `{ door: 'x', model: 'y', ...flags }` inside each chain's `[ ... ]`.
 */
export function extractChains(src) {
  const body = sliceConstBlock(src, 'NATURE_ROUTING_DEFAULT_CHAINS');
  const chains = {};
  for (const chain of ['FAST', 'SORT', 'JUDGE', 'WRITE']) {
    const chainRe = new RegExp(`${chain}:\\s*\\[([\\s\\S]*?)\\],`);
    const m = chainRe.exec(body);
    if (!m) throw new Error(`chain ${chain} not found in NATURE_ROUTING_DEFAULT_CHAINS`);
    const posRe = /\{\s*door:\s*'([^']+)'\s*,\s*model:\s*'([^']+)'/g;
    const positions = [];
    let pm;
    while ((pm = posRe.exec(m[1])) !== null) positions.push({ door: pm[1], model: pm[2] });
    chains[chain] = positions;
  }
  return chains;
}

const isFableModel = (s) => /fable/i.test(s);

/**
 * The FD4 ban predicate over one authored position — MIRRORS
 * IntelligenceRouter.validateChainPosition. Returns a violation object or null.
 */
export function banViolationForPosition(chain, pos, index, labelMap, reserveId) {
  const resolvedModelId = labelMap[pos.door]?.[pos.model] ?? pos.model;
  if (isFableModel(resolvedModelId) || isFableModel(pos.model)) {
    return {
      chain,
      index,
      door: pos.door,
      model: pos.model,
      resolvedModelId,
      rule: 'fable-banned',
      detail: `${chain}[${index}] ${pos.door}/'${pos.model}' resolves to a Fable model ('${resolvedModelId}') — no nature chain may emit Fable (FD8 §393).`,
    };
  }
  if (!BOUNDED_GATING_CHAINS.has(chain)) return null; // WRITE exempt
  if (pos.door !== 'claude-code') return null;
  if (resolvedModelId === reserveId) return null; // allowlisted — the sanctioned pinned reserve
  const pinnedInRegistry = labelMap['claude-code']?.[pos.model] !== undefined;
  if (!pinnedInRegistry && KNOWN_TIER_LABELS.has(pos.model)) {
    return {
      chain,
      index,
      door: pos.door,
      model: pos.model,
      resolvedModelId,
      rule: 'claude-code-tier-label',
      detail: `${chain}[${index}] is claude-code/'${pos.model}' — an UNPINNED tier label; the one permitted claude-code position must be the PINNED concrete reserve id '${reserveId}' (FD4 §205).`,
    };
  }
  return {
    chain,
    index,
    door: pos.door,
    model: pos.model,
    resolvedModelId,
    rule: 'claude-code-non-reserve',
    detail: `${chain}[${index}] resolves claude-code → '${resolvedModelId}', which is NOT the sanctioned reserve '${reserveId}' (deny-by-default allowlist ban, FD4 §202-217).`,
  };
}

/** Run the full lint over source text. Returns { violations, reserveId, chains, labelMap }. */
export function runNatureChainsLint(src) {
  const labelMap = extractLabelMap(src);
  const reserveId = labelMap['claude-code']?.balanced;
  if (!reserveId) throw new Error("ROUTING_LABEL_TO_MODEL_ID['claude-code'].balanced (the reserve id) not found");
  const chains = extractChains(src);
  const violations = [];
  for (const chain of ['FAST', 'SORT', 'JUDGE', 'WRITE']) {
    chains[chain].forEach((pos, i) => {
      const v = banViolationForPosition(chain, pos, i, labelMap, reserveId);
      if (v) violations.push(v);
    });
  }
  return { violations, reserveId, chains, labelMap };
}

function main() {
  let src;
  try {
    src = fs.readFileSync(COVERAGE_SRC, 'utf8');
  } catch (err) {
    console.error(`lint-nature-chains: cannot read ${COVERAGE_SRC} — ${err.message}`);
    process.exit(1);
  }
  let result;
  try {
    result = runNatureChainsLint(src);
  } catch (err) {
    console.error(`lint-nature-chains: parse error (fail-closed — an unparseable map is a build failure) — ${err.message}`);
    process.exit(1);
  }
  if (result.violations.length === 0) {
    console.log(
      `lint-nature-chains: OK — every FAST/SORT/JUDGE claude-code position is the pinned reserve ` +
        `'${result.reserveId}', and no chain emits Fable (FD4 harness-door ban clean).`,
    );
    process.exit(0);
  }
  console.error(
    'lint-nature-chains: FD4 HARNESS-DOOR BAN VIOLATION(S) in NATURE_ROUTING_DEFAULT_CHAINS ' +
      '(src/data/llmBenchCoverage.ts):\n' +
      result.violations.map((v) => `  - [${v.rule}] ${v.detail}`).join('\n') +
      `\n\nThe one permitted claude-code FAST/SORT/JUDGE position is the pinned reserve id ` +
      `'${result.reserveId}' (author it as the registry-pinned 'balanced' label or the concrete id). ` +
      `WRITE is exempt for Opus-via-CLI, but NO chain may emit Fable. Spec: docs/specs/nature-axis-routing.md FD4/FD8.`,
  );
  process.exit(1);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) main();
