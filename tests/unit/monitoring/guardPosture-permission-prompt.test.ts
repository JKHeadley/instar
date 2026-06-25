/**
 * guardPosture — permissionPromptAutoResolver floor visibility.
 *
 * Spec: docs/specs/framework-permission-prompt-robustness.md
 *
 * The resolver is an always-on SAFETY FLOOR with NO persisted `enabled` flag — its
 * posture key is COMPUTED from the inverted `emergencyDisable` switch (absent ⇒ on).
 * This is the no-stale-trap design: a deployed agent can never be silently stuck with
 * the floor off because someone persisted `enabled: false`. These tests pin that the
 * computed posture key is `true` by default and `false` ONLY when `emergencyDisable`
 * is explicitly set.
 */

import { describe, it, expect } from 'vitest';
import { extractGuardPosture } from '../../../src/monitoring/guardPosture.js';

const KEY = 'monitoring.permissionPromptAutoResolver.enabled';

describe('extractGuardPosture — permissionPromptAutoResolver floor', () => {
  it('section absent (monitoring:{}) ⇒ floor reads ON (true)', () => {
    const posture = extractGuardPosture({ monitoring: {} });
    expect(posture[KEY]).toBe(true);
  });

  it('present WITHOUT emergencyDisable ⇒ floor still ON (true)', () => {
    const posture = extractGuardPosture({
      monitoring: { permissionPromptAutoResolver: {} },
    });
    expect(posture[KEY]).toBe(true);
  });

  it('emergencyDisable:true ⇒ floor reads OFF (false)', () => {
    const posture = extractGuardPosture({
      monitoring: { permissionPromptAutoResolver: { emergencyDisable: true } },
    });
    expect(posture[KEY]).toBe(false);
  });

  it('emergencyDisable:false ⇒ floor reads ON (true) — only `true` disables', () => {
    const posture = extractGuardPosture({
      monitoring: { permissionPromptAutoResolver: { emergencyDisable: false } },
    });
    expect(posture[KEY]).toBe(true);
  });

  it('a degenerate config with no monitoring block adds no spurious floor key', () => {
    // The floor's always-on / no-persisted-`enabled` design is proven by the
    // `monitoring:{}` cases above: the key reads ON from just a monitoring block,
    // with no `enabled` field anywhere. A bare `{}` (or undefined/null) has no
    // monitoring block at all, so — consistent with the GuardPostureTripwire
    // "empty/garbage config ⇒ empty posture" robustness invariant — it adds NO
    // spurious floor key. (Every real agent has a monitoring block, so the floor
    // is always present in production posture.)
    expect(extractGuardPosture({})).toEqual({});
    expect(extractGuardPosture(undefined)).toEqual({});
    expect(extractGuardPosture(null)).toEqual({});
  });
});
