/**
 * Unit — the boot prerequisite consumes the operator's binary-path lever, and
 * does so WITHOUT changing anything for an agent that configures nothing.
 *
 * ROUND-23. `sessions.frameworkBinaryPaths` was merged into the SPAWN map fifty
 * lines below `checkFrameworkPrerequisite` and never fed INTO it. So `claude-code`
 * had an escape hatch for a relocated install (`sessions.claudePath` seeds its
 * detection) and the other FOUR frameworks had none: an operator whose grok,
 * codex, gemini or pi binary lives outside the detection paths could configure the
 * correct path, watch it be honoured for spawning, and still be refused at boot.
 *
 * Two properties are asserted here, and the SECOND is the one that makes the fix
 * safe to ship:
 *   1. a configured path that genuinely EXISTS satisfies the prerequisite;
 *   2. an agent with NO configured paths gets a byte-identical merge — the fix is
 *      additive, so it cannot change boot for the overwhelming majority who never
 *      set the field.
 *
 * And the guard that keeps (1) from becoming a hole: a configured path we can
 * POSITIVELY show is absent is DROPPED, so a stale or hand-written entry cannot
 * fake a prerequisite for a binary that is not installed. That asymmetry is the
 * whole reason feeding this map into the check is safe rather than reckless.
 */

import { describe, it, expect } from 'vitest';
import { mergeOperatorBinaryPaths } from '../../src/core/Config.js';

describe('operator binary paths — what reaches the boot prerequisite', () => {
  const DETECTED = { 'claude-code': '/usr/local/bin/claude' };

  it('an agent that configures NOTHING gets a byte-identical map (the fix is additive)', () => {
    // The load-bearing no-regression property. If this ever fails, the change
    // stopped being additive and started deciding boot for agents that never
    // opted into anything.
    expect(mergeOperatorBinaryPaths(DETECTED, undefined)).toEqual(DETECTED);
    expect(mergeOperatorBinaryPaths(DETECTED, {})).toEqual(DETECTED);
  });

  it('a configured path that EXISTS is honoured — the gap this closes', () => {
    // Before the fix this value reached the spawn map but not the prerequisite,
    // so a grok agent with a relocated binary was refused at boot while being
    // perfectly able to spawn.
    const merged = mergeOperatorBinaryPaths(
      DETECTED,
      { 'grok-build': '/opt/custom/grok' },
      { exists: (p) => p === '/opt/custom/grok' },
    );
    expect(merged['grok-build']).toBe('/opt/custom/grok');
    expect(merged['claude-code']).toBe(DETECTED['claude-code']);
  });

  it('CONTROL: a configured path that is PROVABLY ABSENT is dropped, not honoured', () => {
    // Without this, feeding the map into the prerequisite would let a stale entry
    // assert a binary exists when it does not — turning a boot refusal into a
    // spawn failure later, which is strictly worse. The check must be capable of
    // saying no, or property (1) above is not a fix but a bypass.
    const merged = mergeOperatorBinaryPaths(
      DETECTED,
      { 'grok-build': '/opt/gone/grok' },
      { exists: () => false, warn: () => {} },
    );
    expect(merged['grok-build']).toBeUndefined();
  });

  it('CONTROL: a bare command name is NOT treated as absent (it resolves via PATH)', () => {
    // The existence probe only applies to something path-shaped. A bare name is
    // resolved by the OS at spawn time and must not be second-guessed here, or a
    // legitimate `grok` on PATH would be discarded.
    const merged = mergeOperatorBinaryPaths(
      DETECTED,
      { 'grok-build': 'grok' },
      { exists: () => false, warn: () => {} },
    );
    expect(merged['grok-build']).toBe('grok');
  });
});
