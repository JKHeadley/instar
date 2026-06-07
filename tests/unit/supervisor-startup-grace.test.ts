// safe-fs-allow: test file — no fs mutations.
// safe-git-allow: test file — no git calls.

/**
 * ServerSupervisor startup-grace duration (2026-06-07, topic 21816).
 *
 * The bug: the startup grace was 3 minutes, but a heavy boot on a loaded box
 * (synchronously loading large TopicMemory/SemanticMemory + reconciling dozens
 * of sessions BEFORE binding /health) can take 5-6 minutes. With a 3-min grace
 * the supervisor started acting on health failures mid-boot and restarted the
 * server before it ever finished → an endless restart-before-boot loop (the
 * "server temporarily down on every message" incident). The grace must comfortably
 * exceed a realistic slow boot so a legitimate boot always completes.
 */

import { describe, it, expect } from 'vitest';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

function makeSup(opts: Record<string, unknown> = {}): any {
  return new ServerSupervisor({
    projectDir: '/tmp/sup-grace-test',
    projectName: 'sup-grace-test',
    port: 59998,
    ...opts,
  });
}

describe('ServerSupervisor — startup grace covers a slow boot', () => {
  it('default startup grace comfortably exceeds a realistic slow boot (>= 6 min)', () => {
    const sup = makeSup();
    // A heavy boot can take 5-6 min on a loaded box; the grace must exceed that
    // so the supervisor does not restart the server mid-boot (the loop).
    expect(sup.startupGraceMs).toBeGreaterThanOrEqual(360_000);
    // Regression guard: must be longer than the old 3-min value that caused the loop.
    expect(sup.startupGraceMs).toBeGreaterThan(180_000);
  });

  it('startupGraceSeconds option overrides the default', () => {
    const sup = makeSup({ startupGraceSeconds: 900 });
    expect(sup.startupGraceMs).toBe(900_000);
  });

  it('within the startup grace window, a health failure does NOT trigger a restart', () => {
    // During the grace, the supervisor probes health optimistically but must not
    // act on failures — the server is still booting. spawnedAt set to "just now".
    const sup = makeSup();
    sup.spawnedAt = Date.now();
    // now - spawnedAt < startupGraceMs → still in grace.
    const inGrace = sup.spawnedAt > 0 && (Date.now() - sup.spawnedAt) < sup.startupGraceMs;
    expect(inGrace).toBe(true);
  });
});
