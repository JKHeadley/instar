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

/* ────────────────────────────────────────────────────────────────────────────
 * FD4.2 — the R-rule STRUCTURAL-EXCLUSION lints (R3–R8), enforced at BUILD time.
 * Spec: docs/specs/nature-axis-routing.md FD5(c) §296-314; LLM-ROUTING-REGISTRY
 * hard rules #3/#5/#6.
 *
 * R3/R4/R5/R7 are POSITION bans over the authored chains — MIRRORING the pure TS
 * predicate IntelligenceRouter.validateChainPositionRRule (a companion drift-guard
 * test asserts the two agree). R6/R8 are COMPONENT-scoped structural pins over the
 * per-component maps that live config can NEVER override, so they are BUILD-LINT
 * ONLY. All are fail-closed: an unparseable map is a build failure, not a silent pass.
 * ──────────────────────────────────────────────────────────────────────────── */

const STRICT_FORMAT_CHAINS = new Set(['FAST', 'SORT']);
const R3_QWEN = /qwen/i;
const R4_GEMINI_CLI_DOOR = 'gemini-cli';
const R5_WEAK_GATE = /gpt-oss-20b|llama-4-scout/i;
const R7_DEEPSEEK = /deepseek/i;

/**
 * The FD4.2 R-rule POSITION-ban predicate over one authored position (R3/R4/R5/R7) —
 * MIRRORS IntelligenceRouter.validateChainPositionRRule. Returns a violation or null.
 */
export function rruleViolationForPosition(chain, pos, index, labelMap) {
  const resolvedModelId = labelMap[pos.door]?.[pos.model] ?? pos.model;
  const modelText = `${pos.model} ${resolvedModelId}`;
  const v = (rule, detail) => ({ chain, index, door: pos.door, model: pos.model, resolvedModelId, rule, detail });

  if (STRICT_FORMAT_CHAINS.has(chain) && R3_QWEN.test(modelText)) {
    return v(
      'rrule-r3-qwen-strict-format',
      `${chain}[${index}] ${pos.door}/'${pos.model}' is a qwen-tier model in a strict-format (FAST/SORT) ` +
        `position — R3: qwen-tier chronically reason-burns and self-clips bounded-contract JSON (0.116/0.028).`,
    );
  }
  if (chain !== 'JUDGE') return null;
  if (pos.door === R4_GEMINI_CLI_DOOR) {
    return v(
      'rrule-r4-gemini-cli-judge',
      `JUDGE[${index}] is the '${R4_GEMINI_CLI_DOOR}' door — R4: consumer Flash 2.5 fell for a judge-directed ` +
        `injection; it may never take an injection-exposed JUDGE (safety-gate) position.`,
    );
  }
  if (R5_WEAK_GATE.test(modelText)) {
    return v(
      'rrule-r5-weak-model-judge',
      `JUDGE[${index}] ${pos.door}/'${pos.model}' — R5: gpt-oss-20b / llama-4-scout may never take a gate ` +
        `(JUDGE) verdict position (injection-credulous / over-conservative contract-breakers).`,
    );
  }
  if (R7_DEEPSEEK.test(modelText) || R7_DEEPSEEK.test(pos.door)) {
    return v(
      'rrule-r7-deepseek-judge',
      `JUDGE[${index}] ${pos.door}/'${pos.model}' is a DeepSeek door/model — R7: DeepSeek may never take an ` +
        `injection-exposed JUDGE (safety-gate) position.`,
    );
  }
  return null;
}

/** Extract the quoted string members of a `new Set([ ... ])` const (fail-closed on absence). */
export function extractStringSet(src, name) {
  const start = src.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} not found in ${path.basename(COVERAGE_SRC)}`);
  const open = src.indexOf('[', start);
  const close = src.indexOf(']', open);
  if (open < 0 || close < 0) throw new Error(`${name}: 'new Set([...])' body not found`);
  const body = src.slice(open + 1, close);
  const out = [];
  const re = /'([^']+)'/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/** Extract LLM_ROUTING_NATURE as { [component]: chain }. */
export function extractNatureMap(src) {
  const body = sliceConstBlock(src, 'LLM_ROUTING_NATURE');
  const map = {};
  const re = /(?:'([^']+)'|([A-Za-z_][\w-]*))\s*:\s*\{\s*nature:\s*'[^']+'\s*,\s*chain:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = re.exec(body)) !== null) map[m[1] || m[2]] = m[3];
  if (Object.keys(map).length === 0) throw new Error('LLM_ROUTING_NATURE parsed empty');
  return map;
}

/** Extract LLM_ROUTING_INJECTION_EXPOSURE as { [component]: boolean exposed } from the exposed()/notExposed() sugar. */
export function extractExposureMap(src) {
  const body = sliceConstBlock(src, 'LLM_ROUTING_INJECTION_EXPOSURE');
  const map = {};
  const re = /(?:'([^']+)'|([A-Za-z_][\w-]*))\s*:\s*(exposed|notExposed)\(/g;
  let m;
  while ((m = re.exec(body)) !== null) map[m[1] || m[2]] = m[3] === 'exposed';
  if (Object.keys(map).length === 0) throw new Error('LLM_ROUTING_INJECTION_EXPOSURE parsed empty');
  return map;
}

/**
 * R6 (build-lint only) — every claude-banned (doc-tree/cartographer) component that HAS a
 * nature/chain must route through a chain with NO claude-code door position. Structural pin:
 * a future edit giving a doc-tree component a Claude-containing chain fails the build.
 */
export function r6Violations(src, chains) {
  const banned = extractStringSet(src, 'NATURE_ROUTING_CLAUDE_BANNED_COMPONENTS');
  if (banned.length === 0) throw new Error('NATURE_ROUTING_CLAUDE_BANNED_COMPONENTS parsed empty (fail-closed)');
  const natureChain = extractNatureMap(src);
  const out = [];
  for (const comp of banned) {
    const chain = natureChain[comp];
    if (!chain) continue; // no nature/chain yet ⇒ structurally cannot route anywhere (vacuously off-Claude)
    const positions = chains[chain] ?? [];
    positions.forEach((pos, i) => {
      if (pos.door === 'claude-code') {
        out.push({
          chain,
          index: i,
          door: pos.door,
          model: pos.model,
          resolvedModelId: pos.model,
          rule: 'rrule-r6-claude-banned-component',
          detail:
            `component '${comp}' is Claude-banned (doc-tree/cartographer, R6) but its ${chain} chain routes to a ` +
            `claude-code door at [${i}] — R6 (absolute): a doc-tree component may never route to any claude-code door.`,
        });
      }
    });
  }
  return out;
}

/**
 * R8 (build-lint only) — the input-classifier components are pinned off Flash-Lite. Assert
 * (a) each is `exposed: true` in the injection map (so the FD5b gate skips non-injection doors
 * for them), and (b) every authored `flash-lite` position sits on a METERED door — so it is
 * structurally skipped in Increment A and no input-classifier can reach it.
 */
export function r8Violations(src, chains) {
  const inputClassifiers = extractStringSet(src, 'NATURE_ROUTING_INPUT_CLASSIFIER_COMPONENTS');
  if (inputClassifiers.length === 0)
    throw new Error('NATURE_ROUTING_INPUT_CLASSIFIER_COMPONENTS parsed empty (fail-closed)');
  const exposure = extractExposureMap(src);
  const metered = new Set(extractStringSet(src, 'METERED_ROUTING_DOORS'));
  const out = [];
  // (a) each input-classifier must be statically injection-exposed.
  for (const comp of inputClassifiers) {
    if (exposure[comp] !== true) {
      out.push({
        chain: 'n/a',
        index: -1,
        door: 'n/a',
        model: comp,
        resolvedModelId: comp,
        rule: 'rrule-r8-input-classifier-not-exposed',
        detail:
          `input-classifier component '${comp}' must be marked injection-exposed (exposed: true) in ` +
          `LLM_ROUTING_INJECTION_EXPOSURE — R8: so the FD5b gate skips non-injection doors for it. ` +
          `(found: ${exposure[comp] === false ? 'exposed: false' : 'absent'})`,
      });
    }
  }
  // (b) any authored flash-lite position must be behind the metered gate (unreachable in Increment A).
  for (const chain of ['FAST', 'SORT', 'JUDGE', 'WRITE']) {
    (chains[chain] ?? []).forEach((pos, i) => {
      if (/flash-lite/i.test(pos.model) && !metered.has(pos.door)) {
        out.push({
          chain,
          index: i,
          door: pos.door,
          model: pos.model,
          resolvedModelId: pos.model,
          rule: 'rrule-r8-flash-lite-reachable',
          detail:
            `${chain}[${i}] places flash-lite on non-metered door '${pos.door}' — R8: Flash-Lite must stay behind ` +
            `the metered gate so input-classifier components (which walk FAST/SORT) can never land on it.`,
        });
      }
    });
  }
  return out;
}

/** Run ALL FD4.2 R-rule lints (R3–R8) over source text. Returns { violations }. */
export function runNatureRuleLints(src) {
  const labelMap = extractLabelMap(src);
  const chains = extractChains(src);
  const violations = [];
  // R3/R4/R5/R7 — position bans over the authored chains.
  for (const chain of ['FAST', 'SORT', 'JUDGE', 'WRITE']) {
    chains[chain].forEach((pos, i) => {
      const v = rruleViolationForPosition(chain, pos, i, labelMap);
      if (v) violations.push(v);
    });
  }
  // R6/R8 — component-scoped structural pins over the maps.
  violations.push(...r6Violations(src, chains));
  violations.push(...r8Violations(src, chains));
  return { violations, chains, labelMap };
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
  let ruleResult;
  try {
    result = runNatureChainsLint(src);
    ruleResult = runNatureRuleLints(src);
  } catch (err) {
    console.error(`lint-nature-chains: parse error (fail-closed — an unparseable map is a build failure) — ${err.message}`);
    process.exit(1);
  }
  const allViolations = [...result.violations, ...ruleResult.violations];
  if (allViolations.length === 0) {
    console.log(
      `lint-nature-chains: OK — FD4 harness-door ban clean (claude-code FAST/SORT/JUDGE is the pinned reserve ` +
        `'${result.reserveId}', no Fable), AND the FD4.2 R-rule structural exclusions (R3–R8) all hold.`,
    );
    process.exit(0);
  }
  console.error(
    'lint-nature-chains: NATURE-CHAIN VIOLATION(S) in src/data/llmBenchCoverage.ts ' +
      '(FD4 harness-door ban and/or FD4.2 R-rule structural exclusions R3–R8):\n' +
      allViolations.map((v) => `  - [${v.rule}] ${v.detail}`).join('\n') +
      `\n\nThe one permitted claude-code FAST/SORT/JUDGE position is the pinned reserve id ` +
      `'${result.reserveId}'; WRITE is exempt for Opus-via-CLI but NO chain may emit Fable; and the R-rules ` +
      `(R3 qwen∉strict-format, R4 gemini-cli∉JUDGE, R5 gpt-oss-20b/llama-4-scout∉JUDGE, R6 doc-tree∉claude-code, ` +
      `R7 DeepSeek∉JUDGE, R8 input-classifiers off Flash-Lite) are structural. Spec: docs/specs/nature-axis-routing.md FD4/FD5c/FD8.`,
  );
  process.exit(1);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) main();
