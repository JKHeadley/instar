// safe-git-allow: test fixture cleanup uses fs.rmSync on mkdtemp dirs only.
/**
 * lint-journal-actuation-ban — one declared limitation closed, one measured and left open.
 *
 * COHERENCE-JOURNAL-SPEC §3.9: no actuator (kill / spawn / place / transfer / reap)
 * may READ the replicated journal. Replicated data is stale by construction, so an
 * actuator trusting a replica's "session closed" can kill or double-place against
 * reality — the journal would CAUSE the duplicate-session incidents it diagnoses.
 *
 * The shipped check declared BOTH of its gaps in its own header, honestly:
 *   "Guardrail, not proof … this catches the direct pattern"
 *   "Grow this list when a new actuator class lands"
 *
 * DEFECT 1 — CLOSED. Reproduced against the SHIPPED lint before any edit: a dynamic
 * `await import('…CoherenceJournalReader.js')` appended to a REAL listed actuator
 * (src/core/SessionManager.ts) reported "clean", because the match required the
 * `from` keyword that import() lacks. CONTROL: the plain static import in the same
 * file → CAUGHT. The probe could say yes, which is what makes the EVADES verdict
 * mean anything.
 *
 * DEFECT 2 — MEASURED, AND DELIBERATELY LEFT OPEN. Automatic discovery of actuators
 * by declared-name shape was built and run against the real tree: it flagged nine
 * sites in three files and every one was a part-of-speech or granularity error, not
 * a §3.9 breach (see the lint header for the three, with names). This lint blocks
 * commits, so over-blocking correct code is the more expensive failure — a
 * reporting surface reading the journal is CORRECT. The STALENESS half is closable
 * mechanically and is closed: a curated entry that vanished from the tree was
 * renamed and silently left the ban.
 *
 * Driven as a SUBPROCESS against a temp `--root`, never by importing the module:
 * this lint runs its scan at module scope and calls process.exit(), so importing it
 * would kill the test run the moment the repo had a real violation. Exit code alone
 * is never the assertion — a crash also exits 1 — so every violation case asserts on
 * the REPORTED TEXT as well.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LINT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/lint-journal-actuation-ban.js',
);

/** Mirrors ACTUATOR_FILES. Every one must exist or the staleness check fires. */
const CURATED = [
  'src/core/SessionManager.ts',
  'src/core/SessionRouter.ts',
  'src/core/SessionOwnershipRegistry.ts',
  'src/monitoring/SessionWatchdog.ts',
  'src/monitoring/SessionMonitor.ts',
  'src/core/SessionMaintenanceRunner.ts',
  'src/core/AutonomousSessions.ts',
  'src/lifeline/ServerSupervisor.ts',
];

let root: string;

/** Write a file under the temp root, creating parents. */
const put = (rel: string, body: string): void => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jab-'));
  // Seed every curated actuator as innocuous. A test that cares about one
  // overwrites it; the staleness test deletes one on purpose.
  for (const rel of CURATED) put(rel, 'export const noop = () => {};\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Run the lint against the temp root. Returns BOTH status and output — never one alone. */
const run = (): { status: number; out: string } => {
  try {
    const out = execFileSync('node', [LINT, '--root', root], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

/** A violation must EXIT 1 **and** name the offending file — a crash also exits 1. */
const expectCaught = (r: { status: number; out: string }, rel: string): void => {
  expect(r.status, `expected a violation exit; output was:\n${r.out}`).toBe(1);
  expect(r.out, 'exited 1 WITHOUT naming the file — it probably crashed').toContain(rel);
};

const READER = "'../monitoring/CoherenceJournalReader.js'";

describe('DEFECT 1 — every way a module can load the reader', () => {
  it('CONTROL: a clean tree passes, and says so', () => {
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('clean');
  });

  it('CONTROL: the plain STATIC import is caught (this is what already worked)', () => {
    put('src/core/SessionManager.ts', `import { CoherenceJournalReader } from ${READER};\nexport const kill = () => CoherenceJournalReader;\n`);
    expectCaught(run(), 'src/core/SessionManager.ts');
  });

  it('a DYNAMIC import in a listed actuator is caught (was "clean")', () => {
    put('src/core/SessionManager.ts', `export async function read() { return await import(${READER}); }\n`);
    expectCaught(run(), 'src/core/SessionManager.ts');
  });

  it('require() of the reader is caught', () => {
    put('src/core/SessionManager.ts', `const r = require(${READER});\nexport const kill = () => r;\n`);
    expectCaught(run(), 'src/core/SessionManager.ts');
  });

  // ── The opposite direction. This lint BLOCKS commits, so a guard that flags correct
  //    code is the more expensive failure — two withdrawals earlier in this window came
  //    from exactly that over-tightening. These must pass under the fix.
  it('CONTROL: an actuator importing the WRITER is not flagged — actuators may emit', () => {
    put('src/core/SessionManager.ts', "import { CoherenceJournalWriter } from '../monitoring/CoherenceJournalWriter.js';\nexport const kill = () => CoherenceJournalWriter;\n");
    const r = run();
    expect(r.status, `writer import must not be flagged; output:\n${r.out}`).toBe(0);
  });

  it('CONTROL: the reader named only in a COMMENT is not flagged', () => {
    put('src/core/SessionManager.ts', `// never import ${READER} here — §3.9\nexport const kill = () => {};\n`);
    expect(run().status).toBe(0);
  });

  it('CONTROL: a block comment mentioning a dynamic import of the reader is not flagged', () => {
    put('src/core/SessionManager.ts', `/*\n * Do not: await import(${READER})\n */\nexport const kill = () => {};\n`);
    const r = run();
    expect(r.status, `prose describing the ban must not BE a violation; output:\n${r.out}`).toBe(0);
  });

  it('CONTROL: `import type` is not flagged — it is erased, so it cannot act on stale data', () => {
    put('src/core/SessionManager.ts', `import type { OwnAutonomousRuns } from ${READER};\nexport const kill = (_r: OwnAutonomousRuns) => {};\n`);
    const r = run();
    expect(r.status, `a type-only import creates no runtime coupling; output:\n${r.out}`).toBe(0);
  });

  it('a MIXED import that pulls the runtime binding alongside a type IS caught', () => {
    put('src/core/SessionManager.ts', `import { type OwnAutonomousRuns, CoherenceJournalReader } from ${READER};\nexport const kill = () => CoherenceJournalReader;\n`);
    expectCaught(run(), 'src/core/SessionManager.ts');
  });

  it('CONTROL: a NON-actuator module may read the journal — that is the whole point', () => {
    put('src/server/CoherenceRoutes.ts', `import { CoherenceJournalReader } from ${READER};\nexport const read = () => CoherenceJournalReader;\n`);
    expect(run().status, 'a reporting surface reading the journal is CORRECT').toBe(0);
  });
});

describe('DEFECT 2 — the declared population', () => {
  it('a curated actuator that VANISHED from the tree is a violation, not a skipped line', () => {
    // The mechanically-closable half: `if (!existsSync) continue` meant a renamed
    // actuator silently left the ban and the lint still reported clean.
    fs.rmSync(path.join(root, 'src/core/SessionRouter.ts'));
    expectCaught(run(), 'src/core/SessionRouter.ts');
  });

  it('KNOWN GAP: a NEW actuator not on the curated list is NOT caught', () => {
    // Pinned deliberately, not by omission. Discovery-by-name-shape was built and
    // measured against the real tree: nine flags across three files, all part-of-speech
    // or granularity errors ("reaper" as a noun in reporting code; the 22k-line
    // composition root; a runtime-erased `import type`). Closing this needs an
    // authoritative actuator population, not a heuristic. If someone closes it, this
    // test SHOULD fail — that is the signal to delete it.
    put('src/core/SessionEvictor.ts', `import { CoherenceJournalReader } from ${READER};\nexport function reapSessions() { return new CoherenceJournalReader(); }\n`);
    expect(run().status, 'if this now fails, the gap was closed — update the header and delete this test').toBe(0);
  });
});

describe('the lint must not render a verdict on a tree it did not scan', () => {
  it('a root with no src/ EXITS NON-ZERO instead of reporting clean', () => {
    // Found by pointing the fixed lint at a path that did not exist: it walked
    // nothing and printed "clean". Absence is the cheapest result to obtain, and a
    // clean verdict over zero files is indistinguishable from a genuinely clean tree.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jab-empty-'));
    try {
      let status = 0;
      let out = '';
      try {
        out = execFileSync('node', [LINT, '--root', empty], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        status = err.status ?? -1;
        out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
      expect(status, `scanned nothing but exited ${status}; output:\n${out}`).not.toBe(0);
      expect(out).toContain('scanned nothing');
      expect(out).not.toContain('clean');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
