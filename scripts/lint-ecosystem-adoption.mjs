#!/usr/bin/env node
// safe-git-allow: read-only git (merge-base, diff) to compare against the base.
/**
 * lint-ecosystem-adoption.mjs (docs/specs/ecosystem-idea-pipeline.md §8).
 *
 * A spec started from an idea carries `ecosystem-idea`, `effect-class`, `ecosystem-record-hash`,
 * `ecosystem-flags` and `ecosystem-paths`. This fails a change to the default of a listed flag,
 * beyond the development gate, unless docs/proofs/<idea>.json exists, is well formed, passes and
 * still covers the code. It asks only whether the record exists and is well formed, never whether
 * the change is good. It covers default changes in tagged specs; it cannot see an untagged PR or
 * a change with no flag, and it stops forgetting, not a determined forger.
 *
 * Exit 0 clean, 1 refused. Usage: lint-ecosystem-adoption.mjs [--base <ref>]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILES = ['src/config/ConfigDefaults.ts', 'src/core/devGatedFeatures.ts'];

export function parseSpecFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const out = {};
  let list = null;
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) { out[list].push(item[1].replace(/^["']|["']$/g, '')); continue; }
    const kv = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    list = null;
    const value = kv[2].trim();
    if (value === '' || value === '[]') { out[kv[1]] = []; list = kv[1]; } else if (value.startsWith('[')) {
      out[kv[1]] = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

/** True when the diff changes the default of a dotted config path. */
export function diffChangesDefault(diffText, flag) {
  const parts = flag.split('.');
  const leaf = parts[parts.length - 1];
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;
  for (const hunk of diffText.split(/^@@/m).slice(1)) {
    const changed = hunk.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    if (changed.some((l) => l.includes(`configPath: '${flag}'`))) return true;
    const leafRe = new RegExp(`\\b${leaf}\\b\\s*:`);
    if (changed.some((l) => leafRe.test(l)) && (!parent || new RegExp(`\\b${parent}\\b`).test(hunk))) return true;
  }
  return false;
}

/**
 * Pure check of one report. `git` answers ancestry and changed paths, so a test can use a real repo.
 * Returns a list of problems; empty means it satisfies the rule.
 */
export function checkEvidence({ spec, proof, nowMs, git }) {
  const idea = spec['ecosystem-idea'];
  const cls = spec['effect-class'];
  if (!proof) return [`${idea}: no docs/proofs/${idea}.json`];
  const problems = [];
  if (proof.idea !== idea) problems.push(`${idea}: the report names a different idea`);
  if (proof['record-hash'] !== spec['ecosystem-record-hash']) problems.push(`${idea}: record-hash does not match the spec`);
  if (proof.kind === 'exception') {
    for (const f of ['pinRef', 'scope', 'rollback', 'expiresAt', 'reviewAt']) if (!proof[f]) problems.push(`${idea}: exception is missing ${f}`);
    const exp = Date.parse(proof.expiresAt);
    if (!Number.isFinite(exp) || exp <= nowMs) problems.push(`${idea}: the exception has expired; it must be answered before this flag changes`);
    return problems;
  }
  if (proof.kind !== 'trial' && proof.kind !== 'measure') return [...problems, `${idea}: kind must be trial, measure or exception`];
  if (cls === 'reduces-capability' && proof.kind !== 'trial') problems.push(`${idea}: a reduces-capability idea needs a trial`);
  if (proof.result !== 'pass') problems.push(`${idea}: result is ${proof.result ?? 'absent'}; only pass satisfies this`);
  const paths = spec['ecosystem-paths'];
  if (!Array.isArray(paths) || paths.length === 0) problems.push(`${idea}: ecosystem-paths is empty, so nothing shows the evidence still covers the code`);
  if (!proof.testedCommit || !git.isAncestor(proof.testedCommit)) problems.push(`${idea}: testedCommit is not an ancestor of this head`);
  else {
    const stale = git.changedSince(proof.testedCommit, Array.isArray(paths) ? paths : []);
    if (stale.length) problems.push(`${idea}: code changed since the tested commit: ${stale.slice(0, 5).join(', ')}`);
  }
  if (proof.rolloutScope !== 'fleet') problems.push(`${idea}: rolloutScope ${proof.rolloutScope ?? 'absent'} does not cover a default change`);
  if (proof.kind === 'measure') {
    for (const f of ['measure', 'baseline', 'outcome']) if (proof[f] === undefined) problems.push(`${idea}: measure report is missing ${f}`);
    return problems;
  }
  const attempts = Array.isArray(proof.attempts) ? proof.attempts : [];
  if (attempts.length === 0) problems.push(`${idea}: attempts are not listed`);
  if (typeof proof.attemptBudget !== 'number' || attempts.length > proof.attemptBudget) problems.push(`${idea}: attempts exceed the pre-registered budget`);
  if (!proof.planCommit || !proof.testedCommit || !git.isAncestorOf(proof.planCommit, proof.testedCommit)) problems.push(`${idea}: the plan commit does not precede the tested commit`);
  if (typeof proof.margin !== 'number' && typeof proof.margin !== 'string') problems.push(`${idea}: no acceptable regression margin`);
  if (!proof.marginReviewedBy) problems.push(`${idea}: the margin was not reviewed by another family`);
  if (!Array.isArray(proof.measures) || proof.measures.length === 0) problems.push(`${idea}: no measures`);
  if (proof.blind !== true) problems.push(`${idea}: the judging was not blind`);
  if (proof.positiveControl?.caught !== true) problems.push(`${idea}: the positive control was not caught`);
  if (attempts.some((a) => a.result !== 'pass') && attempts[attempts.length - 1]?.confirmatory !== true) problems.push(`${idea}: a pass after a failure needs a fresh confirmatory run`);
  return problems;
}

export function lintSpecs({ specs, diffByFlag, readProof, nowMs, git }) {
  const problems = [];
  for (const spec of specs) {
    const idea = spec['ecosystem-idea'];
    if (!idea) continue;
    const cls = spec['effect-class'];
    if (!['additive-dark', 'behaviour-changing', 'reduces-capability'].includes(cls)) { problems.push(`${idea}: effect-class is missing or unknown`); continue; }
    if (!spec['ecosystem-record-hash']) problems.push(`${idea}: ecosystem-record-hash is missing`);
    const flags = Array.isArray(spec['ecosystem-flags']) ? spec['ecosystem-flags'] : [];
    const proof = readProof(idea);
    if (cls === 'reduces-capability' && flags.length === 0) {
      // Reductions are often flagless, and a flagless change has nothing else for this lint to watch.
      if (proof?.kind !== 'exception') problems.push(`${idea}: a reduces-capability spec must name a flag in ecosystem-flags, or carry an exception`);
      else problems.push(...checkEvidence({ spec, proof, nowMs, git }));
      continue;
    }
    if (flags.some((f) => diffByFlag(f))) problems.push(...checkEvidence({ spec, proof, nowMs, git }));
  }
  return problems;
}

function main() {
  const repoRoot = process.cwd();
  const baseArg = process.argv.indexOf('--base');
  const sh = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const specsDir = path.join(repoRoot, 'docs/specs');
  const specs = [];
  if (fs.existsSync(specsDir)) {
    for (const f of fs.readdirSync(specsDir)) {
      if (!f.endsWith('.md') || f.endsWith('.eli16.md')) continue;
      const text = fs.readFileSync(path.join(specsDir, f), 'utf-8');
      if (!text.includes('ecosystem-idea:')) continue;
      const parsed = parseSpecFrontmatter(text);
      if (parsed?.['ecosystem-idea']) specs.push(parsed);
    }
  }
  if (specs.length === 0) { console.log('lint-ecosystem-adoption: OK (no spec carries an idea)'); return; }
  let base = baseArg >= 0 ? process.argv[baseArg + 1] : null;
  if (!base) { try { base = sh(['merge-base', 'origin/main', 'HEAD']).trim(); } catch { base = null; } }
  if (!base) { console.log('lint-ecosystem-adoption: skipped (no base to compare against)'); return; }
  const diff = sh(['diff', '-U40', base, '--', ...DEFAULT_FILES]);
  const git = {
    isAncestor: (c) => { try { sh(['merge-base', '--is-ancestor', c, 'HEAD']); return true; } catch { return false; } },
    isAncestorOf: (a, b) => { try { sh(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } },
    changedSince: (c, paths) => (paths.length ? sh(['diff', '--name-only', c, 'HEAD', '--', ...paths]).split('\n').filter(Boolean) : []),
  };
  const readProof = (idea) => { try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/proofs', `${idea}.json`), 'utf-8')); } catch { return null; } };
  const problems = lintSpecs({ specs, diffByFlag: (f) => diffChangesDefault(diff, f), readProof, nowMs: Date.now(), git });
  if (problems.length) {
    console.error(`lint-ecosystem-adoption: refused (docs/specs/ecosystem-idea-pipeline.md §8):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`lint-ecosystem-adoption: OK (${specs.length} spec(s) carry an idea)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
