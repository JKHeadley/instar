/**
 * The local-verify `verifierVersion`: a content hash of the verifier code that actually
 * runs, not the package version (spec local-verify-merge-authority.md §2 step 6). A record
 * written under a different verifierVersion is not trusted at boot. With the package
 * version, every release (three on 2026-10-22) discarded every green record; with a
 * content hash, a release that leaves the verifier untouched keeps its records, and one
 * that changes anything the verdict depends on still re-verifies.
 *
 * Inputs (hashed in a fixed order):
 *  - the REAL local import graph (type-only imports skipped, as the build erases them) from
 *    the child entry (`runVerifyMain`) and the server-side modules that give a record its
 *    meaning (VERIFIER_ROOTS), followed through `src/core`, `src/feedback-factory` and
 *    `scripts/` (SafeGitExecutor, SafeFsExecutor, hostTestRunnerSemaphore, reviewGate, the
 *    floor script, …), by package-relative path and content;
 *  - the protected-path list's VALUE as passed to the child;
 *  - `process.version` (the run child is spawned with the same node);
 *  - computePolicyHash() (lane configs, inventory rules, harness globs, deadlines).
 * Works on an install (`dist/**.js`) and from source (`src/**.ts`, where a `.js`
 * specifier resolves to its `.ts` file).
 *
 * NOT an input: the `typescript` version. The skip ratchet resolves its parser from the
 * run worktree `npm ci` just installed (skipRatchet.ts, PR #2326), so the parser is a
 * property of the PR's tree, not of the verifier. Until 2026-10-24 (`vh2:`) the version
 * hashed `typescript/package.json` as resolved by Node's lookup from the installed
 * package — a walk UP the parent chain that, on an install under an agent home, lands in
 * the agent home's own mutable `node_modules`. `npm ci` there (an unrelated folder)
 * emptied and refilled it, so the verifier version flipped between two values across
 * server restarts and every flip voided every pending record (`verifier-mismatch`).
 * Nothing ambient is hashed any more: only files inside the package, the values the
 * server passes, and the node the child is spawned with.
 *
 * The run child recomputes this at start and refuses to run (`verifier-mismatch`) when it
 * differs from the value the server passed, so a dist replaced on disk under a still-running
 * old server is never recorded under the old server's version.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePolicyHash } from './policy.js';

const MODULE_EXT = /\.(js|mjs|cjs|ts)$/;
// Relative specifiers in static imports/exports, side-effect imports and dynamic imports.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+)\1/g;

const TYPE_ONLY_IMPORT = /^\s*(?:import|export)\s+type\b[\s\S]*?\bfrom\s*(['"])[^'"\n]+\1;?/gm;

/**
 * The graph roots: the run child's entry and the server-side modules that decide what a
 * record means or authorizes (journal/index, main health, record shape, the status
 * reconciler and its review check). Wiring and routes are left out:
 * they import config and HTTP plumbing that changes with most releases and never alters a
 * verdict.
 */
export const VERIFIER_ROOTS: readonly string[] = Object.freeze(['runVerifyMain', 'LocalVerifyService', 'mainHealth', 'record', 'policy', 'StatusReconciler', 'unhandledErrorsReporter']);

function rootFile(dir: string, name: string): string | null {
  for (const ext of ['.js', '.ts']) {
    const f = path.join(dir, name + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** The directory this module was loaded from (the installed verifier). */
export function installedVerifierDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts');
  if (!MODULE_EXT.test(base)) candidates.push(base + '.js', base + '.ts', path.join(base, 'index.js'), path.join(base, 'index.ts'));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

/** Every file reachable through relative imports from `roots` (roots included). Sorted, absolute. */
export function localImportGraph(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const stack = roots.map((r) => path.resolve(r));
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    let text: string;
    try { text = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    seen.add(f);
    // Type-only imports are erased in the build: skip them so source and dist hash the same graph.
    text = text.replace(TYPE_ONLY_IMPORT, '');
    for (const m of text.matchAll(SPECIFIER)) {
      const r = resolveSpecifier(f, m[2]);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return [...seen].sort();
}

export interface VerifierVersionInputs {
  /** The protected-path list the server passes the child (its VALUE is hashed, not its source file). */
  protectedList?: readonly string[];
  /** Override for tests; defaults to process.version. */
  nodeVersion?: string;
}

/**
 * `vh3:<hex>` over the verifier's local import graph, the protected list, the node version
 * and the policy hash. Deterministic: package-relative paths in sorted order. The `vh3`
 * salt and prefix distinguish records written under `vh2` (which hashed the ambient
 * typescript resolution) once; those re-verify as a version change, as any input change does.
 */
export function computeVerifierVersion(
  dir: string = installedVerifierDir(),
  policyHash: string = computePolicyHash(),
  inputs: VerifierVersionInputs = {},
): string {
  const roots = VERIFIER_ROOTS.map((n) => rootFile(dir, n)).filter((f): f is string => f !== null);
  const files = localImportGraph(roots);
  const root = path.resolve(dir, '..', '..');
  const h = crypto.createHash('sha256');
  h.update('local-verify-verifier-v3\0');
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    h.update(`file:${rel}\0`);
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  h.update(`node:${inputs.nodeVersion ?? process.version}\0`);
  h.update(`protected:${JSON.stringify(inputs.protectedList ?? [])}\0`);
  h.update(`policy:${policyHash}`);
  return `vh3:${h.digest('hex').slice(0, 32)}`;
}
