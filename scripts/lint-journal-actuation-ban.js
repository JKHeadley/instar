#!/usr/bin/env node
/**
 * lint-journal-actuation-ban — COHERENCE-JOURNAL-SPEC §3.9 structural guard.
 *
 * The journal is SIGNAL, never AUTHORITY: replicated journal data is stale by
 * construction (heartbeat-cadenced), and an actuator that trusted a replica's
 * "session closed" could kill or double-place against reality — the journal
 * would CAUSE the duplicate-session incidents it exists to diagnose.
 *
 * Enforcement: no ACTUATOR module (kill / spawn / place / transfer / reap
 * surfaces) may import the journal READER. The reader is deliberately a
 * separate module from the writer so this ban has a precise import target —
 * actuators MAY hold the writer (they emit), they may never read.
 *
 * ── 2026-08-14: the header used to declare TWO limitations. One is now closed,
 * one is NOT, and pretending otherwise would be the worse outcome.
 *
 * CLOSED — "this catches the direct pattern". The match required the `from`
 * keyword, so `await import(...)` and `require(...)` walked straight past it.
 * Reproduced against the shipped lint on a REAL listed actuator: it reported
 * "clean". Now every module-loading form is matched, comments are stripped
 * first (so a §3.9 reference in prose can never be a violation), and a
 * runtime-erased `import type` is correctly NOT a violation.
 *
 * NOT CLOSED — "grow this list when a new actuator class lands". The population
 * is still curated by hand. Automatic discovery was BUILT, MEASURED AGAINST THIS
 * TREE, AND REJECTED on the evidence: inferring "is this an actuator?" from
 * declared names flagged nine sites in three files, and every one was a
 * granularity or part-of-speech error rather than a §3.9 breach —
 *   · `src/server/routes.ts` matched on `readReaperPeerText`, `isReaperSnapshot`,
 *     `reaperPoolHealth`: "reaper" as a NOUN in code that REPORTS ON the reaper,
 *     which is exactly the correct-code case (a reporting surface may read).
 *   · `src/commands/server.ts` is the 22k-line composition root — every module's
 *     authority is wired through it, so any file-level verdict on it is wrong in
 *     one direction or the other.
 *   · `src/core/WorkingSetPull.ts` matched a runtime-erased `import type`.
 * A guard that blocks commits must not rest on a heuristic with that error rate;
 * over-blocking correct code is the more expensive failure here. What IS closed
 * mechanically is the STALENESS half: a curated entry that no longer exists on
 * disk means an actuator was renamed or moved and silently fell off the ban —
 * that is now a hard failure instead of a skipped line.
 *
 * Still a guardrail, not a proof: a determined consumer can re-read the JSONL by
 * hand or reach the reader through a re-export. The declared §3.9 duty is the
 * authority; this catches the mechanical patterns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : path.resolve(__dirname, '..');

/**
 * Actuator modules: anything holding kill/spawn/place/transfer/reap authority.
 * Grow this list when a new actuator class lands — adding here is cheap;
 * debugging a journal-driven double-kill is not. See the header for why this
 * stays curated rather than inferred.
 */
const ACTUATOR_FILES = [
  'src/core/SessionManager.ts',
  'src/core/SessionRouter.ts',
  'src/core/SessionOwnershipRegistry.ts',
  'src/monitoring/SessionWatchdog.ts',
  'src/monitoring/SessionMonitor.ts',
  'src/core/SessionMaintenanceRunner.ts',
  'src/core/AutonomousSessions.ts',
  'src/lifeline/ServerSupervisor.ts',
];

/**
 * Every way a module can LOAD the reader at runtime. The old pattern required
 * `from`, which is precisely the token a dynamic import does not have.
 */
const LOADS_READER =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"][^'"]*CoherenceJournalReader(?:\.js)?['"]/;

/**
 * `import type { X } from '…Reader.js'` is erased at compile time — it creates
 * no runtime coupling and therefore cannot act on stale data. Borrowing a TYPE
 * from the reader is legal; holding the reader is not. A MIXED import such as
 * `import { type A, CoherenceJournalReader }` does not match this and is still
 * caught, which is correct — it pulls in the runtime binding.
 */
const TYPE_ONLY_IMPORT = /^\s*import\s+type\s/;

/**
 * Blank out comments, preserving length and line count so reported line numbers
 * stay true. Quote-aware, so a `//` inside a string literal is not mistaken for
 * a comment. This is what keeps "the reader named in a comment" legal no matter
 * how wide the load-matching gets.
 */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  let state = 'code'; // code | line | block | single | double | tick
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'tick';
      i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i++; continue; }
      out[i] = ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i++; continue;
    }
    // inside a string literal: honour escapes, then look for the closing quote
    if (c === '\\') { i += 2; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'tick' && c === '`')) {
      state = 'code';
    }
    i++;
  }
  return out.join('');
}

/**
 * A lint that reports "clean" because it scanned NOTHING is worse than no lint:
 * absence is the cheapest result to obtain, and it is indistinguishable from a
 * genuinely clean tree. Refuse to render a verdict on a root with no src/.
 */
if (!fs.existsSync(path.join(ROOT, 'src'))) {
  console.error(`lint-journal-actuation-ban: no src/ under ${ROOT} — scanned nothing, so no verdict.`);
  process.exit(2);
}

const violations = [];

for (const rel of ACTUATOR_FILES) {
  const file = path.join(ROOT, rel);

  // The staleness half of the declared-population gap: a curated actuator that
  // is no longer here was renamed or moved, and silently left the ban behind.
  if (!fs.existsSync(file)) {
    violations.push(
      `${rel}: listed actuator is missing from the tree — renamed or moved? It has silently left the §3.9 ban. Update ACTUATOR_FILES.`,
    );
    continue;
  }

  const lines = stripComments(fs.readFileSync(file, 'utf-8')).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!LOADS_READER.test(lines[i])) continue;
    if (TYPE_ONLY_IMPORT.test(lines[i])) continue;
    violations.push(
      `${rel}:${i + 1}: actuator loads the journal READER (forbidden by §3.9 — the journal answers questions, live systems decide)`,
    );
  }
}

if (violations.length > 0) {
  console.error('lint-journal-actuation-ban: VIOLATIONS\n');
  for (const v of violations) console.error('  ' + v);
  console.error('\nReplicated journal data is stale by construction. Read the live store instead.');
  process.exit(1);
}
console.log(`lint-journal-actuation-ban: clean (${ACTUATOR_FILES.length} actuator modules, none load the reader)`);
