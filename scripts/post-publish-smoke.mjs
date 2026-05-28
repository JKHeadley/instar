#!/usr/bin/env node
/**
 * post-publish-smoke.mjs — regression gate that a freshly-published instar
 * tarball actually installs + runs.
 *
 * Track A of MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS (re-scoped). The 2026-05-27
 * "empty dist" scare turned out to be self-inflicted (an rsync --delete), NOT a
 * publish bug — the published tarball was complete. So this is NOT fixing an
 * active bug; it's cheap regression insurance: if the publish pipeline EVER
 * ships a tarball missing its compiled output, this catches it within minutes
 * of release instead of when an agent's fresh install fails in the wild.
 *
 * What it does (in CI, right after `npm publish`):
 *   1. Wait for npm to propagate the just-published version (bounded retry).
 *   2. `npm install instar@<version>` into a throwaway prefix.
 *   3. Run the installed `dist/cli.js --version`.
 *   4. Assert it reports <version>. Exit 1 (fail the release workflow) otherwise.
 *
 * Usage:  node scripts/post-publish-smoke.mjs <version>
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Pure: does the `instar --version` output report the expected version? */
export function versionMatches(cliOutput, expected) {
  // cli prints the bare version (commander default) possibly with surrounding whitespace/newlines.
  return cliOutput.split(/\s+/).map((s) => s.trim()).includes(expected);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForPropagation(version, deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const published = execFileSync('npm', ['view', `instar@${version}`, 'version'], { encoding: 'utf-8' }).trim();
      if (published === version) return true;
    } catch { /* not propagated yet */ }
    await sleep(10_000);
  }
  return false;
}

async function main() {
  const version = process.argv[2];
  if (!version) { console.error('Usage: post-publish-smoke.mjs <version>'); process.exit(2); }

  console.log(`[smoke] waiting for instar@${version} to propagate on npm…`);
  if (!await waitForPropagation(version, 180_000)) {
    console.error(`[smoke] instar@${version} did not appear on npm within 3m`);
    process.exit(1);
  }

  const prefix = mkdtempSync(path.join(tmpdir(), 'instar-smoke-'));
  console.log(`[smoke] clean-installing instar@${version} into ${prefix}`);
  execFileSync('npm', ['install', '--prefix', prefix, `instar@${version}`], { encoding: 'utf-8', stdio: 'inherit' });

  const cli = path.join(prefix, 'node_modules', 'instar', 'dist', 'cli.js');
  if (!existsSync(cli)) {
    console.error(`[smoke] FAIL: ${cli} missing — the published tarball shipped without its compiled dist.`);
    process.exit(1);
  }

  const out = execFileSync('node', [cli, '--version'], { encoding: 'utf-8' });
  if (!versionMatches(out, version)) {
    console.error(`[smoke] FAIL: \`instar --version\` reported "${out.trim()}", expected "${version}".`);
    process.exit(1);
  }

  console.log(`[smoke] ✓ instar@${version} clean-installs and runs (--version → ${version}).`);
  process.exit(0);
}

// Only run main() when invoked directly (not when imported by the unit test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(`[smoke] error: ${err?.message ?? err}`); process.exit(1); });
}
