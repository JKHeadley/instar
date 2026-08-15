#!/usr/bin/env node
// ab-run.mjs — INSTAR-Bench v2 prompt A/B harness.
//
// Tests a PROPOSED prompt edit against the incumbent: same task, same cases,
// same routes, same sample count — only the promptTemplate differs. Emits a
// verdict with RATCHET semantics (spec §4): the edit wins ONLY if it fixes at
// least one previously-failing cell AND regresses ZERO previously-passing
// cells (per route×case, majority across samples). Anything else is not a
// clean win and must not ship.
//
// Usage:
//   node ab-run.mjs --task <task-id> --variant <path-to-variant-task.json> \
//     --stamp <ab-id> [--samples 2] [--routes-filter ...]
//
// The variant file is a FULL task file (same id, edited promptTemplate) —
// typically authored by the forensic judge's proposedEdit.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const TASK = arg('task', null);
const VARIANT = arg('variant', null);
const STAMP = arg('stamp', null);
const SAMPLES = arg('samples', '2');
const ROUTES = arg('routes-filter', '');
// Which task directory the INCUMBENT (arm A) reads. Default 'tasks' (the
// critical set). Wave-2 / full-registry components live in 'tasks-wave2' — pass
// --base-taskdir tasks-wave2 so both arms A/B share the same wave-2 incumbent.
const BASE_TASKDIR = arg('base-taskdir', 'tasks');
if (!TASK || !VARIANT || !STAMP) { console.error('--task, --variant, --stamp required'); process.exit(4); }

function runArm(armName, taskDirOverride) {
  const args = ['run2.mjs', '--stamp', `${STAMP}-${armName}`, '--samples', SAMPLES, '--tasks-filter', TASK];
  if (ROUTES) args.push('--routes-filter', ROUTES);
  const env = { ...process.env };
  // Arm B swaps the task dir via a scratch copy with the variant in place.
  const r = spawnSync(process.execPath, args, {
    cwd: HERE, encoding: 'utf8', timeout: 3_600_000,
    env: taskDirOverride ? { ...env, IB2_TASKDIR: taskDirOverride } : env,
  });
  const last = (r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(last); } catch { throw new Error(`${armName} arm failed: ${(r.stderr || '').slice(-400)}`); }
}

// run2.mjs reads tasks/ relative to itself; support override via env by
// building a scratch dir clone with the variant substituted.
const SCRATCH = join(HERE, `.ab-scratch-${STAMP}`);
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
cpSync(join(HERE, BASE_TASKDIR), SCRATCH, { recursive: true });
const variantDoc = JSON.parse(readFileSync(VARIANT, 'utf8'));
if (variantDoc.id !== TASK) { console.error(`variant id ${variantDoc.id} ≠ --task ${TASK}`); process.exit(4); }
writeFileSync(join(SCRATCH, `${TASK}.json`), JSON.stringify(variantDoc, null, 1));

// Arm A reads the unmodified incumbent from BASE_TASKDIR; when that's the
// default 'tasks', run2's own default applies (null), otherwise point it there.
const ARM_A_DIR = BASE_TASKDIR === 'tasks' ? null : join(HERE, BASE_TASKDIR);
if (!process.argv.includes('--compare-only')) {
  const armA = runArm('A', ARM_A_DIR);     // incumbent prompt (wave-2 base if set)
  const armB = runArm('B', SCRATCH);       // proposed prompt
}
rmSync(SCRATCH, { recursive: true, force: true });

// ---- Compare per route×case (majority across samples) ----
function loadCells(stamp) {
  const raw = readFileSync(join(HERE, '..', 'results', 'instar-bench-v2', stamp, 'raw.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const cells = new Map();
  let infraDropped = 0;
  for (const r of raw) {
    if (r.pass === null) continue; // judged tasks have no deterministic cell
    // Infra-class failures (provider 429/auth/transport/timeout) are evidence
    // about the DOOR at that moment, never about the prompt — excluding them
    // keeps a Groq rate-limit from masquerading as a prompt regression
    // (ab-tone-gate finding, 2026-07-02: groq-llama4-scout 429 counted as a
    // regression and blocked a 41-cell win).
    if (r.pass === false && INFRA_CLASSES.has(r.failureClass)) { infraDropped++; continue; }
    const key = `${r.route}::${r.caseId}`;
    const c = cells.get(key) ?? { route: r.route, caseId: r.caseId, pass: 0, total: 0 };
    c.total++; if (r.pass) c.pass++;
    cells.set(key, c);
  }
  const verdicts = new Map();
  for (const [k, c] of cells) if (c.total > 0) verdicts.set(k, c.pass * 2 > c.total); // strict majority over non-infra samples
  loadCells.lastInfraDropped = infraDropped;
  return verdicts;
}
const INFRA_CLASSES = new Set(['rate-limit', 'auth', 'cli-error', 'timeout', 'error']);
const A = loadCells(`${STAMP}-A`);
const infraA = loadCells.lastInfraDropped;
const B = loadCells(`${STAMP}-B`);
const infraB = loadCells.lastInfraDropped;

const fixed = [], regressed = [], unchanged = [];
for (const [key, aPass] of A) {
  const bPass = B.get(key);
  if (bPass === undefined) continue; // route missing in B (transient) — not counted either way
  if (!aPass && bPass) fixed.push(key);
  else if (aPass && !bPass) regressed.push(key);
  else unchanged.push(key);
}
const cleanWin = fixed.length > 0 && regressed.length === 0;
const verdict = {
  stamp: STAMP, task: TASK, variant: VARIANT,
  cells: A.size, fixed, regressed, unchangedCount: unchanged.length,
  infraExcluded: { armA: infraA, armB: infraB },
  cleanWin,
  ruling: cleanWin ? 'CLEAN-WIN (ships per ratified policy)' : regressed.length ? 'REGRESSION (must not ship)' : 'NO-GAIN (must not ship)',
};
const OUT = join(HERE, '..', 'results', 'instar-bench-v2', `${STAMP}-verdict.json`);
writeFileSync(OUT, JSON.stringify(verdict, null, 1));
console.error(`[ab] ${verdict.ruling} — fixed ${fixed.length}, regressed ${regressed.length}, cells ${A.size} → ${OUT}`);
console.log(JSON.stringify(verdict));
