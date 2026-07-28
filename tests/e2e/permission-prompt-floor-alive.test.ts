/**
 * E2E — the PermissionPromptAutoResolver is an ALWAYS-ON floor.
 *
 * Spec: docs/specs/framework-permission-prompt-robustness.md
 *
 * "Feature is alive" assertion for an always-on SAFETY FLOOR that has NO API route
 * and NO persisted `enabled` flag (so a full server-boot 200-vs-503 e2e does not
 * apply — there is nothing to 503). The aliveness contract here is: with a default
 * (empty) config the floor reads ON in two independent surfaces —
 *   1. the guard-posture map (`GET /guards` reads this) computes the key TRUE;
 *   2. a constructed resolver's `guardStatus()` reports `enabled: true`.
 * Only an explicit `emergencyDisable:true` turns it off — there is no stale-flag
 * trap that could leave a deployed agent silently unprotected.
 */

import { describe, it, expect } from 'vitest';
import { extractGuardPosture } from '../../src/monitoring/guardPosture.js';
import { PermissionPromptAutoResolver } from '../../src/monitoring/PermissionPromptAutoResolver.js';

const KEY = 'monitoring.permissionPromptAutoResolver.enabled';

function noopDeps(emergencyDisabled = false) {
  return {
    sendKey: () => true,
    reCaptureTail: async () => null,
    isGenerating: () => false,
    raiseDefect: () => {},
    appendAudit: () => {},
    now: () => Date.now(),
    emergencyDisabled: () => emergencyDisabled,
  };
}

describe('E2E — permission-prompt floor is alive by default', () => {
  it('guard posture computes the floor ON for a default config', () => {
    // A realistic config always has a `monitoring` block; the floor reads ON from
    // it with NO persisted `enabled` field (the no-stale-trap design).
    expect(extractGuardPosture({ monitoring: {} })[KEY]).toBe(true);
    // A bare `{}` has no monitoring block at all — the degenerate case — so it
    // adds no spurious floor key (consistent with the GuardPostureTripwire
    // "empty/garbage config ⇒ empty posture" robustness invariant).
    expect(extractGuardPosture({})[KEY]).toBeUndefined();
  });

  it('a constructed resolver reports guardStatus().enabled === true by default', () => {
    const resolver = new PermissionPromptAutoResolver(noopDeps());
    expect(resolver.guardStatus().enabled).toBe(true);
  });

  it('both surfaces agree the floor is OFF only on an explicit emergencyDisable', () => {
    expect(
      extractGuardPosture({
        monitoring: { permissionPromptAutoResolver: { emergencyDisable: true } },
      })[KEY],
    ).toBe(false);
    const resolver = new PermissionPromptAutoResolver(noopDeps(true));
    expect(resolver.guardStatus().enabled).toBe(false);
  });

  it('a fresh resolver has empty, bounded state maps', () => {
    const resolver = new PermissionPromptAutoResolver(noopDeps());
    expect(resolver.stateSizes()).toEqual({ episodes: 0, persistMenus: 0 });
  });
});
