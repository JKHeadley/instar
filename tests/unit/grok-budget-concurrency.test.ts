import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * MULTI-PROCESS proof that the grok reviewer budget ceiling holds under real
 * concurrency (CMT-1330).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS UNUSUALLY HEAVY
 * ---------------------------------------------------
 * `reserveGrokBudgetSlotForTest`'s own comment says the defect it pins — over-
 * admission under concurrency — "is only observable across REAL concurrent
 * processes; an in-process loop runs sequentially and would pass against the
 * broken code." That is literally true: the reservation is a synchronous
 * filesystem read-modify-write, and JavaScript cannot interleave a synchronous
 * section with itself. So the sibling `grok-budget-reservation.test.ts` — which
 * pins the reservation LIFECYCLE correctly and cheaply — structurally cannot
 * pin this. The round-18 regression (12 admitted, 8 persisted, 4 slots spent
 * with no reservation to account for them) survived a green suite for exactly
 * that reason.
 *
 * THE CONTROL IS AN ASSERTION, NOT A COMMENT
 * -------------------------------------------
 * A concurrency test that does not actually produce contention passes trivially
 * and certifies nothing — the failure shape that produced several defects in
 * this project. So the first test here runs the SAME admission decision with the
 * lock removed and REQUIRES it to over-admit. If that control ever stops
 * over-admitting, this file fails loudly: it means the harness has lost the
 * power to detect the defect (children serialised, machine too slow to overlap,
 * barrier broken), and the second test's pass would be worthless.
 *
 * RUNTIME GATE — READ THIS BEFORE ASSUMING COVERAGE
 * --------------------------------------------------
 * Child processes must load the TypeScript SOURCE (loading `dist/` would test
 * the last build, not the current tree — and no CI job builds before testing).
 * That needs `--experimental-transform-types`, which is Node >=22.7. CI runs the
 * unit suite on node 20 AND node 22; this file therefore EXECUTES on the node-22
 * shard and SKIPS on the node-20 shard. That is deliberate, and the skip is
 * loud rather than silent.
 *   Alternative considered and rejected: adding `tsx` as a devDependency would
 *   make it run on node 20 too, at the cost of a new install-surface dependency
 *   for every agent, to serve one test. If this file's coverage ever needs to be
 *   unconditional, that is the trade to revisit.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MODULE_UNDER_TEST = path.join(REPO_ROOT, 'src', 'core', 'crossModelReviewer.ts');

/** The ceiling the reservation path enforces (mirrors GROK_REVIEWER_DAILY_MAX_RUNS). */
const DAILY_MAX_RUNS = 24;
/** Concurrent children. 12 reproduced the round-18 defect; more only costs time. */
const CHILDREN = 12;
/** Seeded prior runs, leaving DAILY_MAX_RUNS - SEEDED_RUNS slots for the race. */
const SEEDED_RUNS = 20;
const FREE_SLOTS = DAILY_MAX_RUNS - SEEDED_RUNS;

function supportsTransformTypes(): boolean {
  const [maj, min] = process.versions.node.split('.').map((n) => Number(n));
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false;
  return maj > 22 || (maj === 22 && min >= 7) || maj >= 23;
}

const CAN_RUN = supportsTransformTypes();
if (!CAN_RUN) {
  // Loud, not silent: a skipped concurrency proof must never read as coverage.
  console.warn(
    `[grok-budget-concurrency] SKIPPED on node ${process.versions.node} — needs >=22.7 for `
      + '--experimental-transform-types so children can load TS source. Runs on the node-22 CI shard.',
  );
}

/**
 * Writes the child-side scaffolding into an isolated HOME.
 *
 * HOME is the isolation boundary: `grokBudgetPath()` resolves the ledger under
 * `$HOME/.instar/`, so a temp HOME guarantees these children can never read,
 * write, or exhaust the real reviewer budget.
 */
const SANDBOXES: string[] = [];
afterAll(() => {
  for (const dir of SANDBOXES) {
    // Cleanup must never turn a real failure into a confusing one, so a
    // teardown error is swallowed rather than thrown.
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, sourceTreeOverride: true }); } catch { /* leave it */ }
  }
});

function makeSandbox(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-budget-conc-'));
  SANDBOXES.push(home);
  fs.mkdirSync(path.join(home, '.instar'), { recursive: true });

  // Node resolves `./foo.js` specifiers literally; the source tree ships `.ts`.
  // This hook redirects a `.js` specifier to its `.ts` sibling when only the
  // latter exists, leaving every other specifier untouched.
  fs.writeFileSync(
    path.join(home, 'ts-hook.mjs'),
    `import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    try {
      const p = fileURLToPath(new URL(specifier, context.parentURL));
      const ts = p.replace(/\\.js$/, '.ts');
      if (!existsSync(p) && existsSync(ts)) return next(pathToFileURL(ts).href, context);
    } catch { /* fall through to default resolution */ }
  }
  return next(specifier, context);
}
`,
  );
  fs.writeFileSync(
    path.join(home, 'register.mjs'),
    `import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./ts-hook.mjs', pathToFileURL(process.env.SANDBOX_HOME + '/'));
`,
  );

  // PRODUCTION path: the real reservation function.
  fs.writeFileSync(
    path.join(home, 'child-real.mjs'),
    `import fs from 'node:fs';
const mod = await import(process.env.MODULE_UNDER_TEST);
fs.writeFileSync(process.env.SANDBOX_HOME + '/ready.' + process.env.SLOT, '1');
while (!fs.existsSync(process.env.SANDBOX_HOME + '/GO')) await new Promise(r => setTimeout(r, 2));
console.log('VERDICT=' + mod.reserveGrokBudgetSlotForTest());
`,
  );

  // CONTROL: the same admission DECISION with no lock around read-modify-write.
  //
  // ROUND-22 — this control was FLAKY and the flake is instructive. Its
  // read→write window was microseconds (parse, push, write), while the GO-release
  // spread across 12 processes is milliseconds. On a quiet machine enough children
  // landed inside that window and it observed the over-admission it exists to
  // observe; during a full 3,000-file suite run the children serialised and
  // `r.ok` came back as exactly 4 — no over-admission, so the CONTROL failed while
  // the code under test was fine.
  //
  // That is the worst failure mode a control can have: it fails for a reason
  // unrelated to the defect, under load — which is the condition where the race
  // it models is MOST likely in production — and the natural response to a control
  // that cries wolf is to weaken or delete it.
  //
  // The fixed window below makes the unsynchronised interleaving certain rather
  // than lucky. Stated precisely, because it changes what this control proves:
  // the delay does NOT create the defect (the read is already stale the moment
  // another child writes); it widens an existing window so the harness can
  // observe it every time. The cost is that the two arms are no longer
  // identical-but-for-the-lock — the production arm runs with no artificial
  // delay, and still must admit exactly FREE_SLOTS while 12 processes race it.
  // A delay could not be pushed inside the production path without editing
  // shipped code to suit a test, which is the worse trade.
  fs.writeFileSync(
    path.join(home, 'child-unlocked.mjs'),
    `import fs from 'node:fs';
const ledger = process.env.SANDBOX_HOME + '/.instar/grok-reviewer-budget.json';
await import(process.env.MODULE_UNDER_TEST);   // identical startup cost
fs.writeFileSync(process.env.SANDBOX_HOME + '/ready.' + process.env.SLOT, '1');
while (!fs.existsSync(process.env.SANDBOX_HOME + '/GO')) await new Promise(r => setTimeout(r, 2));
const d = JSON.parse(fs.readFileSync(ledger, 'utf8'));
// Hold the stale read open long enough that every sibling has also read it,
// regardless of host load. See the note above the writer for why.
await new Promise(r => setTimeout(r, 400));
if (d.runs + d.reservations.length >= ${DAILY_MAX_RUNS}) { console.log('VERDICT=exhausted'); }
else {
  d.reservations.push({ id: 'ctl' + process.pid });
  fs.writeFileSync(ledger, JSON.stringify(d));
  console.log('VERDICT=ok');
}
`,
  );

  return home;
}

function seedLedger(home: string): void {
  fs.writeFileSync(
    path.join(home, '.instar', 'grok-reviewer-budget.json'),
    JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      runs: SEEDED_RUNS,
      totalTokens: 0,
      reservations: [],
    }),
  );
}

function readLedger(home: string): { runs: number; reservations: unknown[] } {
  return JSON.parse(
    fs.readFileSync(path.join(home, '.instar', 'grok-reviewer-budget.json'), 'utf8'),
  );
}

/**
 * Runs CHILDREN copies of `script` and releases them from a barrier only once
 * ALL have finished importing.
 *
 * The barrier is the difference between a real race and a staggered walk:
 * module import costs ~1s, so without it the first child would finish its
 * read-modify-write before the last had started, and the test would pass
 * against broken code.
 */
async function raceChildren(
  home: string,
  script: string,
): Promise<{ ok: number; exhausted: number; other: number }> {
  const outputs: string[] = [];
  const children = Array.from({ length: CHILDREN }, (_, i) => {
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', `--import=${path.join(home, 'register.mjs')}`,
        path.join(home, script)],
      {
        env: {
          ...process.env,
          HOME: home,
          SANDBOX_HOME: home,
          MODULE_UNDER_TEST: MODULE_UNDER_TEST,
          SLOT: String(i),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let buf = '';
    child.stdout.on('data', (d) => { buf += String(d); });
    return new Promise<void>((resolve) => {
      child.on('close', () => { outputs.push(buf); resolve(); });
    });
  });

  // Wait for every child to reach the barrier, then release them together.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ready = fs.readdirSync(home).filter((f) => f.startsWith('ready.')).length;
    if (ready >= CHILDREN) break;
    if (Date.now() > deadline) {
      throw new Error(`only ${ready}/${CHILDREN} children reached the barrier — harness broken`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  fs.writeFileSync(path.join(home, 'GO'), '1');
  await Promise.all(children);

  const verdicts = outputs
    .map((o) => /VERDICT=(\w[\w-]*)/.exec(o)?.[1])
    .filter((v): v is string => Boolean(v));
  return {
    ok: verdicts.filter((v) => v === 'ok').length,
    exhausted: verdicts.filter((v) => v === 'exhausted').length,
    other: verdicts.filter((v) => v !== 'ok' && v !== 'exhausted').length,
  };
}

describe.skipIf(!CAN_RUN)('grok reviewer budget — ceiling under REAL process concurrency', () => {
  it(
    'CONTROL: the same admission decision WITHOUT the lock over-admits — proves this harness '
      + 'can detect the defect',
    async () => {
      const home = makeSandbox();
      seedLedger(home);
      const r = await raceChildren(home, 'child-unlocked.mjs');

      // Every child reads `runs=20, reservations=[]` before any child writes,
      // so each independently concludes a slot is free. This is the round-18
      // shape: admissions the ledger cannot account for.
      expect(r.ok).toBeGreaterThan(FREE_SLOTS);
      expect(readLedger(home).reservations.length).toBeLessThan(r.ok);
    },
    180_000,
  );

  it('the real reservation path admits EXACTLY the free slots and persists one per admission', async () => {
    const home = makeSandbox();
    seedLedger(home);
    const r = await raceChildren(home, 'child-real.mjs');

    expect(r.other).toBe(0);
    // The spend brake: never more admissions than the ceiling allows...
    expect(r.ok).toBe(FREE_SLOTS);
    expect(r.exhausted).toBe(CHILDREN - FREE_SLOTS);
    // ...and every admission is accounted for by a persisted reservation, so a
    // concurrent admission can SEE it. An admission without a reservation is a
    // slot spent invisibly.
    const ledger = readLedger(home);
    expect(ledger.reservations.length).toBe(r.ok);
    expect(new Set(ledger.reservations.map((x) => (x as { id: string }).id)).size).toBe(r.ok);
    // The seeded prior runs are untouched by reservation alone.
    expect(ledger.runs).toBe(SEEDED_RUNS);
  }, 180_000);
});
