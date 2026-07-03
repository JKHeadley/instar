// Meta-verification fixture — the PLAN-DRIVEN nested-child driver (§2.5/§5).
//
// Runs inside a WORKER of an outer fixture vitest root that holds a real
// semaphore slot. The harness passes FIXTURE_NESTED_PLAN (JSON array of child
// specs) + FIXTURE_NESTED_OUT (results path); this driver spawns each child
// vitest root sequentially and records { pid, code, stderrTail } per key so
// the harness can assert against the temp-universe ledger:
//
//   { key, config?, args, env?, scrubHeld? }
//
//  - config: vitest config path (defaults to the pinned-shape fixture config)
//  - scrubHeld: delete INSTAR_TEST_SEMAPHORE_HELD from the child env (the
//    §2.5 pure-ancestry skip — env alone must not be needed)
import { test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { stampWorker } from './fixture-helpers.js';

stampWorker();

const DEFAULT_CONFIG = 'tests/fixtures/test-runner-bound/vitest.fixture.config.ts';

interface PlanItem {
  key: string;
  config?: string;
  args: string[];
  env?: Record<string, string>;
  scrubHeld?: boolean;
}

interface ChildResult {
  pid: number | null;
  code: number | null;
  stderrTail: string;
}

function runChild(item: PlanItem): Promise<ChildResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Never recurse into the driver, and never leak this scenario's
    // instrumentation into the child unless the plan re-adds it.
    delete env['FIXTURE_NESTED_PLAN'];
    delete env['FIXTURE_NESTED_OUT'];
    delete env['FIXTURE_PROBE_DIR'];
    delete env['FIXTURE_PROBE_EXPECT'];
    delete env['FIXTURE_STAMP_DIR'];
    delete env['FIXTURE_OUT_DIR'];
    for (const [k, v] of Object.entries(item.env ?? {})) env[k] = v;
    if (item.scrubHeld) delete env['INSTAR_TEST_SEMAPHORE_HELD'];
    const vitestMjs = path.resolve(process.cwd(), 'node_modules/vitest/vitest.mjs');
    const child = spawn(
      process.execPath,
      [vitestMjs, 'run', '--config', item.config ?? DEFAULT_CONFIG, ...item.args],
      { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      err = (err + String(d)).slice(-4000);
    });
    child.on('close', (code) => resolve({ pid: child.pid ?? null, code, stderrTail: err }));
    child.on('error', () => resolve({ pid: child.pid ?? null, code: -1, stderrTail: err }));
  });
}

test('nested-child driver', async () => {
  const outFile = process.env['FIXTURE_NESTED_OUT'];
  const planRaw = process.env['FIXTURE_NESTED_PLAN'];
  if (!outFile || !planRaw) return; // driver not active for this scenario
  const plan: PlanItem[] = JSON.parse(planRaw);
  const results: Record<string, ChildResult> = {};
  for (const item of plan) {
    results[item.key] = await runChild(item);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
}, 240_000);
