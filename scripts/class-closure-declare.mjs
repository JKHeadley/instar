#!/usr/bin/env node
/**
 * class-closure-declare — the AUTHOR's declaration helper for the Class-Closure
 * Gate (docs/specs/class-closure-gate.md → Piece 1 host). It merges a
 * `classClosure` block into the MOST-RECENT committed decision-audit entry
 * (`.instar/instar-dev-decisions/<ts>-<slug>.json`) — the machine-readable host
 * the gate lint validates.
 *
 * Self-contained ESM (no build step), idempotent (re-running with the same block
 * is a no-op). The block is supplied EITHER as a whole JSON string via
 * `--json '{"defectClass":"...","closure":"guard",...}'`, OR assembled from flags:
 *
 *   node scripts/class-closure-declare.mjs \
 *     --class injection-credulity --closure guard \
 *     --citation src/core/promptClauses.ts#authorityClause \
 *     --enforcement gate --how-caught "the authority clause separates ..." \
 *     --pr 1290 --component CoherenceReviewer
 *
 * For a gap: `--closure gap --gap-item ACT-1234`.
 * For a novel class: `--class novel --novel-json '{"nearestExistingClass":"...","includes":[...],"excludes":[...],"severity":"normal"}'`.
 *
 * It only WRITES the review host; it does not touch the registry or grade the
 * guard (the lint does the grading). Prints the merged block to stdout.
 */

import fs from 'node:fs';
import path from 'node:path';

const DECISIONS_REL = path.join('.instar', 'instar-dev-decisions');
const TRACES_REL = path.join('.instar', 'instar-dev-traces');

/** Parse `--key value` / `--flag` pairs into a plain object. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * Build a classClosure block from parsed args. Throws on a structurally-invalid
 * request (so a bad declaration is caught at author time, not just at lint time).
 * @returns {object} the classClosure block.
 */
export function buildClassClosureBlock(args) {
  if (args.json) {
    let parsed;
    try {
      parsed = JSON.parse(args.json);
    } catch (err) {
      throw new Error(`--json is not valid JSON: ${err && err.message ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('--json must be an object');
    return normalizeBlock(parsed);
  }

  const block = {};
  if (!args.class || typeof args.class !== 'string') throw new Error('--class <id|novel> is required');
  block.defectClass = args.class;
  const closure = args.closure;
  // 'n/a' is the NEGATIVE declaration (docs/specs/self-action-convergence.md →
  // E3): a genuine one-shot / user-driven action, not a self-triggered loop —
  // the trace-level analog of the D4 lint's allowlist entry. Requires a reason.
  if (closure !== 'guard' && closure !== 'gap' && closure !== 'n/a') {
    throw new Error("--closure must be 'guard', 'gap', or 'n/a' (negative declaration)");
  }
  block.closure = closure;

  if (closure === 'n/a') {
    if (!args.reason || typeof args.reason !== 'string') {
      throw new Error("closure 'n/a' (negative declaration) requires --reason \"<why this is a one-shot / user-driven action, not a loop>\"");
    }
    block.reason = args.reason;
  } else if (closure === 'guard') {
    if (!args.citation || typeof args.citation !== 'string') throw new Error("closure 'guard' requires --citation <path|route|symbol>");
    block.guardEvidence = {
      enforcementType: typeof args.enforcement === 'string' ? args.enforcement : undefined,
      citation: args.citation,
      howCaught: typeof args['how-caught'] === 'string' ? args['how-caught'] : undefined,
    };
  } else {
    if (!args['gap-item'] || typeof args['gap-item'] !== 'string') throw new Error("closure 'gap' requires --gap-item <evolution-action-id>");
    block.gapItem = args['gap-item'];
  }

  if (args.pr !== undefined) {
    const n = Number(args.pr);
    if (!Number.isFinite(n)) throw new Error('--pr must be a number');
    block.prNumber = n;
  }
  if (typeof args.component === 'string') block.component = args.component;

  if (args.class === 'novel') {
    if (!args['novel-json']) throw new Error("--class novel requires --novel-json '{...}' with full class semantics");
    let nc;
    try {
      nc = JSON.parse(args['novel-json']);
    } catch (err) {
      throw new Error(`--novel-json is not valid JSON: ${err && err.message ? err.message : String(err)}`);
    }
    if (!nc || typeof nc !== 'object' || !nc.nearestExistingClass) {
      throw new Error('--novel-json must carry nearestExistingClass (+ includes/excludes/severity)');
    }
    block.novelClass = nc;
  }

  return normalizeBlock(block);
}

/** Strip undefined leaves so the written block is minimal + idempotent-comparable. */
function normalizeBlock(block) {
  const out = {};
  for (const [k, v] of Object.entries(block)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = normalizeBlock(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Find the most-recent decision-audit entry file (by ts field, else filename). */
export function findMostRecentDecisionEntry(repoRoot) {
  const dir = path.join(repoRoot, DECISIONS_REL);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  let best = null;
  for (const f of files) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    } catch {
      continue;
    }
    const tsKey = typeof entry.ts === 'string' ? entry.ts : f;
    if (best === null || tsKey > best.tsKey || (tsKey === best.tsKey && f > best.file)) {
      best = { file: f, entry, tsKey };
    }
  }
  return best ? { file: path.join(dir, best.file), entry: best.entry } : null;
}

/**
 * Merge the block into the most-recent entry + write it back. Idempotent — a
 * re-run with an identical block returns { changed: false }.
 * @returns {{ changed: boolean, file: string, block: object }}
 */
export function applyDeclaration(repoRoot, block) {
  const target = findMostRecentDecisionEntry(repoRoot);
  if (!target) {
    throw new Error(`no decision-audit entry found under ${DECISIONS_REL} to attach the declaration to`);
  }
  const before = JSON.stringify(target.entry.classClosure ?? null);
  const after = JSON.stringify(block);
  if (before === after) {
    return { changed: false, file: target.file, block };
  }
  target.entry.classClosure = block;
  fs.writeFileSync(target.file, `${JSON.stringify(target.entry, null, 2)}\n`, 'utf-8');
  return { changed: true, file: target.file, block };
}

/** Find the most-recent instar-dev TRACE file (by mtime). */
export function findMostRecentTrace(repoRoot) {
  const dir = path.join(repoRoot, TRACES_REL);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  let best = null;
  for (const f of files) {
    const full = path.join(dir, f);
    let mtime;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (best === null || mtime > best.mtime) best = { file: full, mtime };
  }
  if (!best) return null;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(best.file, 'utf-8'));
  } catch {
    return null;
  }
  return { file: best.file, entry };
}

/**
 * Merge the block into the most-recent instar-dev TRACE (the E3 declaration
 * host — the same place `specPath`/`tier`/`causalAutopsy` live, authored BEFORE
 * the commit). Idempotent. The precommit's writeDecisionAudit then persists it
 * into the machine-readable decision-audit entry.
 * @returns {{ changed: boolean, file: string, block: object }}
 */
export function applyDeclarationToTrace(repoRoot, block) {
  const target = findMostRecentTrace(repoRoot);
  if (!target) {
    throw new Error(`no instar-dev trace found under ${TRACES_REL} to attach the declaration to (run the /instar-dev skill first)`);
  }
  const before = JSON.stringify(target.entry.classClosure ?? null);
  const after = JSON.stringify(block);
  if (before === after) {
    return { changed: false, file: target.file, block };
  }
  target.entry.classClosure = block;
  fs.writeFileSync(target.file, `${JSON.stringify(target.entry, null, 2)}\n`, 'utf-8');
  return { changed: true, file: target.file, block };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const repoRoot = process.env.CLASS_CLOSURE_REPO_ROOT || process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const toTrace = args['to-trace'] === true;
  let block;
  try {
    block = buildClassClosureBlock(args);
  } catch (err) {
    console.error(`class-closure-declare: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  let result;
  try {
    result = toTrace ? applyDeclarationToTrace(repoRoot, block) : applyDeclaration(repoRoot, block);
  } catch (err) {
    console.error(`class-closure-declare: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  console.log(`class-closure-declare: ${result.changed ? 'wrote' : 'no change (idempotent)'} classClosure into ${path.relative(repoRoot, result.file)}${toTrace ? ' (trace host)' : ''}`);
  console.log(JSON.stringify(result.block, null, 2));
  process.exit(0);
}
