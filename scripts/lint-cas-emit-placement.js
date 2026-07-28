#!/usr/bin/env node
/**
 * lint-cas-emit-placement — COHERENCE-JOURNAL-SPEC §3.3 structural guard.
 *
 * Every ownership-CAS call site must pair with an `emitPlacement` so topic
 * placement history can never silently grow a hole: session-lifecycle gets a
 * single saveSession funnel (status is derivable inside), but placement
 * `reason` is CALLER knowledge — the emit lives at the call sites, and THIS
 * lint is what makes call-site completeness structural instead of memorable
 * (the "three saveSession sites" lesson, applied via CI instead of a funnel).
 *
 * Carve-outs (pinned in the converged spec):
 *  - the `cas(` method DEFINITION (SessionOwnershipRegistry.ts) is excluded;
 *  - emits are counted per `cas(` TOKEN, not per function (the mesh ownAction
 *    dispatcher packs four calls in one body);
 *  - the injected `casClaimOwnership(` token is part of the funnel set — but
 *    only its IMPLEMENTATION site needs the pairing (the SessionRouter calls
 *    the injected dep whose impl carries the emit), so consumer `.deps.`/`d.`
 *    invocations are exempt;
 *  - tests and the journal/lint files themselves are exempt.
 *
 * Guardrail, not proof: a wrapper could still hide a CAS. The declared duty
 * stays "every ownership mutation pairs an emit"; this catches the direct
 * patterns (Signal vs Authority — the lint is the signal, review the authority).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Lines around a hit in which the paired emitPlacement must appear. */
const PAIR_WINDOW = 12;

const CAS_TOKEN = /\bownReg\.cas\(|\bownershipRegistry\.cas\(|\bsessionOwnershipRegistry\.cas\(/;
const EXEMPT_FILES = new Set([
  path.join('src', 'core', 'SessionOwnershipRegistry.ts'), // the definition + internal store
  path.join('src', 'core', 'CoherenceJournal.ts'),
]);

function* walk(dir) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === 'node_modules' || name.name === 'dist') continue;
      yield* walk(p);
    } else if (/\.(ts|js|mjs)$/.test(name.name)) {
      yield p;
    }
  }
}

const violations = [];
let casSites = 0;

for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file);
  if (EXEMPT_FILES.has(rel)) continue;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!CAS_TOKEN.test(lines[i])) continue;
    casSites++;
    const lo = Math.max(0, i - PAIR_WINDOW);
    const hi = Math.min(lines.length - 1, i + PAIR_WINDOW);
    const windowText = lines.slice(lo, hi + 1).join('\n');
    if (!/emitPlacement\s*\(/.test(windowText)) {
      violations.push(`${rel}:${i + 1}: ownership CAS call without a paired emitPlacement within ±${PAIR_WINDOW} lines`);
    }
  }
}

if (violations.length > 0) {
  console.error('lint-cas-emit-placement: VIOLATIONS\n');
  for (const v of violations) console.error('  ' + v);
  console.error(
    `\nEvery ownership-CAS call site must pair an emitPlacement (COHERENCE-JOURNAL-SPEC §3.3).` +
    `\nIf the reason is caller knowledge you do not have here, you are probably at the wrong layer.`,
  );
  process.exit(1);
}

console.log(`lint-cas-emit-placement: clean (${casSites} CAS call site(s), all paired)`);
