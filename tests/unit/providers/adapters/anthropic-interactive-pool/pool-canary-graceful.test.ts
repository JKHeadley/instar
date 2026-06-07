/**
 * Pool startup canary — graceful degradation (2026-06-07 incident, topic 21816).
 *
 * The startup empty-prompt canary in spawnOne USED to `throw` on a structured
 * `status: 'fail'`, which rejected start()'s Promise.all → the ENTIRE
 * subscription-path pool refused to start → all Anthropic work stranded on the
 * SDK credit pot, and under transient CPU starvation (a slow/garbled canary
 * round-trip) it re-failed every spawn and tripped the LLM circuit in a loop.
 *
 * The empty-prompt detector is protection-in-depth, not a primary failure path
 * (a session that can't verify the empty-prompt SIGNATURE can still serve real
 * prompts). So a canary fail must DEGRADE GRACEFULLY: report it, bring the
 * session ready, let the pool start. These guards pin that the refuse-to-start
 * throw can't come back.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const poolSrc = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../../../src/providers/adapters/anthropic-interactive-pool/pool.ts',
  ),
  'utf-8',
);

/** The `if (canaryResult?.status === 'fail')` block in spawnOne, up to the next `if`. */
function canaryFailBlock(): string {
  const start = poolSrc.indexOf("if (canaryResult?.status === 'fail')");
  expect(start).toBeGreaterThan(0);
  // up to the self-healed branch that follows it
  const end = poolSrc.indexOf("if (canaryResult?.status === 'self-healed')", start);
  expect(end).toBeGreaterThan(start);
  return poolSrc.slice(start, end);
}

describe('InteractivePool startup canary — graceful degradation', () => {
  it('a canary fail does NOT throw (no refuse-to-start)', () => {
    expect(canaryFailBlock()).not.toMatch(/throw\s+new/);
  });

  it('a canary fail does NOT kill or delete the session (it still comes ready)', () => {
    const block = canaryFailBlock();
    expect(block).not.toContain("session.state = 'dead'");
    expect(block).not.toContain('this.sessions.delete(');
    expect(block).not.toContain("this.emit('session:died'");
  });

  it('a canary fail still reports a degradation (the failure is surfaced, not swallowed)', () => {
    expect(canaryFailBlock()).toContain('DegradationReporter');
  });

  it('spawnOne brings the session ready unconditionally after the canary block', () => {
    // The READY transition lives AFTER the canary handling, with no early throw
    // in the fail path, so a canary fail falls through to ready.
    const canaryIdx = poolSrc.indexOf("if (!this.canaryHasRunInCurrentLifetime)");
    const readyIdx = poolSrc.indexOf("session.state = 'ready';", canaryIdx);
    expect(readyIdx).toBeGreaterThan(canaryIdx);
  });
});
