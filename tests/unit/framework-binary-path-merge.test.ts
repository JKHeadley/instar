import { describe, it, expect } from 'vitest';
import { mergeOperatorBinaryPaths } from '../../src/core/Config.js';

/**
 * Round-11 made `sessions.frameworkBinaryPaths` in config.json actually take
 * effect — before that it was read by nothing, so an operator pointing at a
 * relocated install was silently ignored.
 *
 * Round-21 found what that fix cost when it landed unguarded. Because those
 * values had always been inert, a deployed agent could be carrying a stale or
 * hand-written entry that had never mattered. The moment operator values
 * started winning, that entry decided which binary gets SPAWNED — with no
 * existence check, for every framework, on every agent, including agents with
 * nothing to do with the change that introduced it.
 *
 * The asymmetry below is the point: PROVABLY absent is dropped, merely
 * unresolvable is honoured. An operator's explicit instruction must not be
 * overridden by a negative we cannot demonstrate.
 */
describe('mergeOperatorBinaryPaths', () => {
  const detected = { 'claude-code': '/detected/claude', 'codex-cli': '/detected/codex' };

  it('CONTROL: an operator path that EXISTS wins over detection', () => {
    // This is round-11's fix, and it must keep working — the guard is not
    // allowed to quietly undo it.
    const merged = mergeOperatorBinaryPaths(
      detected,
      { 'claude-code': '/operator/claude' },
      { exists: () => true, warn: () => {} },
    );
    expect(merged['claude-code']).toBe('/operator/claude');
    expect(merged['codex-cli']).toBe('/detected/codex');
  });

  it('drops a configured path that provably does not exist, and says so', () => {
    const warnings: string[] = [];
    const merged = mergeOperatorBinaryPaths(
      detected,
      { 'claude-code': '/operator/STALE-claude' },
      { exists: (p) => p !== '/operator/STALE-claude', warn: (m) => warnings.push(m) },
    );
    expect(merged['claude-code']).toBe('/detected/claude');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/operator/STALE-claude');
  });

  it('HONOURS a bare command name — PATH resolution happens at spawn, not here', () => {
    // Treating "cannot check" as "absent" would override an explicit operator
    // instruction on the strength of a negative we never demonstrated.
    const merged = mergeOperatorBinaryPaths(
      detected,
      { 'codex-cli': 'codex' },
      { exists: () => false, warn: () => {} },
    );
    expect(merged['codex-cli']).toBe('codex');
  });

  it('HONOURS a path whose existence probe throws', () => {
    const merged = mergeOperatorBinaryPaths(
      detected,
      { 'claude-code': '/operator/claude' },
      { exists: () => { throw new Error('EACCES'); }, warn: () => {} },
    );
    expect(merged['claude-code']).toBe('/operator/claude');
  });

  it('ignores blank and non-string entries rather than spawning nothing', () => {
    const merged = mergeOperatorBinaryPaths(
      detected,
      { 'claude-code': '   ', 'codex-cli': undefined as unknown as string },
      { exists: () => true, warn: () => {} },
    );
    expect(merged['claude-code']).toBe('/detected/claude');
    expect(merged['codex-cli']).toBe('/detected/codex');
  });

  it('adds a framework the host has no detection for', () => {
    const merged = mergeOperatorBinaryPaths(
      detected,
      { 'grok-build': '/operator/grok' },
      { exists: () => true, warn: () => {} },
    );
    expect(merged['grok-build']).toBe('/operator/grok');
  });

  it('is a pure passthrough of detection when nothing is configured', () => {
    expect(mergeOperatorBinaryPaths(detected, undefined, { exists: () => true })).toEqual(detected);
    expect(mergeOperatorBinaryPaths(detected, {}, { exists: () => true })).toEqual(detected);
  });
});
