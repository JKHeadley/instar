#!/usr/bin/env node
/**
 * Framework-id literal ratchet (docs/specs/job-launch-intent-record.md, acceptance criterion 4,
 * D6, D7).
 *
 * WHY
 * ---
 * 2.0 Rule 30 forbids engine special-casing outside the adapter tree. Today's code has a lot of
 * it, grandfathered. This lint stops it GROWING: it counts every string literal whose whole value
 * is a framework id (claude-code, codex-cli, gemini-cli, pi-cli, grok-build) in `src/**\/*.ts`,
 * outside `src/providers/adapters/` and the two id type definitions, and compares the counts with
 * the checked-in baseline (`scripts/framework-name-ratchet-baseline.json`).
 *
 * It fails when the TOTAL grows past the baseline total, or when the summed per-file growth is
 * larger than the summed per-file decreases. So a PR may move counts between files (a split, or a
 * rename that re-keys the baseline) as long as nothing net is added. Lowering a count is always
 * fine; lower the baseline in the same PR (`--write`) so the floor follows the code down.
 *
 * WHAT IT IS NOT
 * --------------
 * A floor, not a proof. A literal is an AST string literal or a template with no substitutions;
 * comments never count, substrings never count, and constants, concatenation and `startsWith`
 * get past it. It is a deterministic CI comparison against a checked-in number, never a runtime
 * action. Choosing the proxy and editing the baseline are reviewed-PR policy.
 *
 * CLI: node scripts/lint-framework-name-ratchet.mjs [--root DIR] [--baseline FILE] [--write]
 *   Scans DIR/src (default: this repo). Exit 0 when the ratchet holds, 1 (with reasons) otherwise.
 *   --write rewrites the baseline from the current counts (only ever after a reviewed decrease).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const FRAMEWORK_IDS = new Set(['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli', 'grok-build']);
export const DEFAULT_EXCLUDE = ['src/providers/adapters/', 'src/core/frameworkFacts.ts', 'src/core/intelligenceProviderFactory.ts'];

const isExcluded = (p, exclude) => exclude.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));

/** Count whole-value framework-id literals per file. Files with a zero count are omitted. */
export function countFrameworkLiterals(files, { exclude = DEFAULT_EXCLUDE } = {}) {
  const perFile = {};
  let total = 0;
  for (const f of files) {
    if (isExcluded(f.path, exclude)) continue;
    const sf = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    let n = 0;
    const visit = (node) => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && FRAMEWORK_IDS.has(node.text)) n++;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (n) {
      perFile[f.path] = n;
      total += n;
    }
  }
  return { total, perFile };
}

/** Compare counts with a baseline of the same shape. A missing key counts as 0. */
export function checkRatchet(counts, baseline) {
  const reasons = [];
  const basePer = baseline?.perFile ?? {};
  const nowPer = counts?.perFile ?? {};
  const baseTotal = typeof baseline?.total === 'number' ? baseline.total : Object.values(basePer).reduce((a, b) => a + b, 0);
  if (counts.total > baseTotal) {
    reasons.push(`framework-id literals outside the adapters grew: ${baseTotal} -> ${counts.total}`);
  }
  let grew = 0;
  let shrank = 0;
  const grown = [];
  for (const file of [...new Set([...Object.keys(basePer), ...Object.keys(nowPer)])].sort()) {
    const before = basePer[file] ?? 0;
    const after = nowPer[file] ?? 0;
    if (after > before) {
      grew += after - before;
      grown.push(`${file}: ${before} -> ${after}`);
    } else if (after < before) {
      shrank += before - after;
    }
  }
  if (grew > shrank) {
    reasons.push(`per-file growth (${grew}) is not offset by decreases elsewhere (${shrank}): ${grown.join('; ')}`);
  }
  return { ok: reasons.length === 0, reasons };
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Read every `src/**\/*.ts` under root as `{ path, content }` with repo-relative POSIX paths. */
export function readSourceFiles(root) {
  return walk(path.join(root, 'src')).map((f) => ({
    path: path.relative(root, f).split(path.sep).join('/'),
    content: fs.readFileSync(f, 'utf-8'),
  }));
}

function main(argv) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let root = repo;
  let baselineFile = path.join(repo, 'scripts', 'framework-name-ratchet-baseline.json');
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else if (argv[i] === '--baseline') baselineFile = path.resolve(argv[++i]);
    else if (argv[i] === '--write') write = true;
    else {
      console.error(`lint-framework-name-ratchet: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  const counts = countFrameworkLiterals(readSourceFiles(root), { exclude: DEFAULT_EXCLUDE });
  if (write) {
    fs.writeFileSync(baselineFile, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`lint-framework-name-ratchet: baseline written (${counts.total} literal(s) across ${Object.keys(counts.perFile).length} file(s)).`);
    return 0;
  }
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  } catch (err) {
    console.error(`lint-framework-name-ratchet: cannot read baseline ${baselineFile}: ${err.message}`);
    return 1;
  }
  const result = checkRatchet(counts, baseline);
  if (!result.ok) {
    console.error('lint-framework-name-ratchet: FAILED — framework-id string literals outside src/providers/adapters/ must not grow (2.0 Rule 30).');
    for (const r of result.reasons) console.error(`  - ${r}`);
    console.error('  Move the engine-specific branch into its adapter, or key it off an existing per-engine table. A reviewed decrease may lower the baseline with --write.');
    return 1;
  }
  const slack = (baseline.total ?? 0) - counts.total;
  console.log(`lint-framework-name-ratchet: clean — ${counts.total} framework-id literal(s) outside the adapters across ${Object.keys(counts.perFile).length} file(s)${slack > 0 ? ` (${slack} under the baseline; lower it with --write)` : ''}.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
