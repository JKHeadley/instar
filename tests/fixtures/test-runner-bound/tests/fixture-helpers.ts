/**
 * Shared helpers for the test-runner-bound meta-verification fixture project
 * (spec docs/specs/test-runner-concurrency-bound.md §5 "Meta-verification").
 *
 * These run INSIDE spawned vitest worker processes. Everything is env-driven
 * so the same tiny fixture suite serves every meta scenario:
 *
 *  - FIXTURE_OUT_DIR    → each worker stamps its start time at module import
 *                         (the acquire-before-fanout instrumentation, §2.2 item 5).
 *  - FIXTURE_STAMP_DIR  → stamp.test.ts records a [start,end] execution window
 *                         (the K-roots serialization proof, §5 mass-admit regression).
 *  - FIXTURE_PROBE_DIR  → probe-N.test.ts files barrier-measure ACTUAL concurrent
 *                         worker count (the ≤4 clamp validations, §2.3/§2.5).
 *
 * NOT part of the shipped product — fixture test data only.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Stamp this worker's first-seen time (called at module import of every fixture test). */
export function stampWorker(): void {
  const dir = process.env['FIXTURE_OUT_DIR'];
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `worker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`),
      JSON.stringify({ pid: process.pid, t: Date.now() }),
    );
  } catch {
    /* fixture instrumentation is best-effort */
  }
}

/**
 * Barrier-style concurrency probe. Each probe file records a start stamp,
 * then holds until it can see FIXTURE_PROBE_EXPECT start stamps (or a
 * deadline), then records its end stamp. Under a worker-pool clamp of C < N
 * probes, at most C probes can be concurrently inside their [start,end]
 * window (the (N-C+1)th start only appears after one of the first C ends) —
 * so the harness's max-overlap computation over the recorded intervals is a
 * MEASUREMENT of actual concurrent workers, not a flag assertion.
 */
export async function runProbe(name: string): Promise<void> {
  const dir = process.env['FIXTURE_PROBE_DIR'];
  if (!dir) return; // probe not active for this scenario — trivial pass
  const expected = Number(process.env['FIXTURE_PROBE_EXPECT'] ?? '5');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `start-${name}.json`),
    JSON.stringify({ name, t: Date.now(), pid: process.pid }),
  );
  const deadline = Date.now() + 4000;
  for (;;) {
    let starts = 0;
    try {
      starts = fs.readdirSync(dir).filter((f) => f.startsWith('start-')).length;
    } catch {
      /* transient read race — retry */
    }
    if (starts >= expected || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  fs.writeFileSync(
    path.join(dir, `end-${name}.json`),
    JSON.stringify({ name, t: Date.now(), pid: process.pid }),
  );
}
