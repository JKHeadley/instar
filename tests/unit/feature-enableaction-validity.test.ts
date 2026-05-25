/**
 * enableAction-validity guard.
 *
 * Every FeatureDefinition advertises an enableAction/disableAction the agent
 * uses to toggle the feature. If that action patches a config key the API
 * refuses to change, the toggle is a lie (it 400s) — the exact `dispatches`
 * bug found in the topic-12702 "built but dark" investigation, where
 * `dispatches`'s enableAction patched a key absent from the PATCH /config
 * allowlist.
 *
 * This test asserts every enableAction/disableAction targets a real, accepted
 * surface: either a PATCH /config whose body keys are all in the (exported,
 * single-source-of-truth) allowlist, or one of the dedicated feature endpoints.
 * Its ABSENCE is what let the dispatches bug ship.
 *
 * Spec: docs/specs/enable-layer-coherence.md
 */

import { describe, it, expect } from 'vitest';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { PATCHABLE_CONFIG_KEYS } from '../../src/server/routes.js';

// Dedicated (non-/config) endpoints that real routes implement for toggling.
// Each must correspond to an actually-registered route (verified separately by
// the route's own tests); listed here so the validity check knows they're valid
// enable surfaces rather than failing them as "unknown target".
const KNOWN_TOGGLE_ENDPOINTS = new Set<string>([
  '/api/files/config',   // dashboard-file-viewer — PATCH, dedicated handler
  '/telemetry/enable',   // baseline-telemetry — POST
  '/telemetry/disable',  // baseline-telemetry — POST
]);

interface ToggleAction {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function checkAction(featureId: string, kind: string, action: ToggleAction | undefined): void {
  if (!action) return; // some features may omit one direction
  const { method, path, body } = action;
  expect(method, `${featureId}.${kind}: missing method`).toBeTruthy();
  expect(path, `${featureId}.${kind}: missing path`).toBeTruthy();

  if (path === '/config' && method === 'PATCH') {
    // Every top-level config key the action patches must be API-patchable.
    const keys = Object.keys(body ?? {});
    expect(keys.length, `${featureId}.${kind}: PATCH /config with empty body`).toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        PATCHABLE_CONFIG_KEYS.has(key),
        `${featureId}.${kind} patches config key "${key}" which is NOT in the PATCH /config allowlist — the toggle would 400. ` +
          `Add "${key}" to PATCHABLE_CONFIG_KEYS in src/server/routes.ts, or fix the enableAction.`,
      ).toBe(true);
    }
    return;
  }

  // Non-/config actions must target a known dedicated toggle endpoint.
  expect(
    KNOWN_TOGGLE_ENDPOINTS.has(path),
    `${featureId}.${kind} targets "${method} ${path}", which is neither PATCH /config nor a known dedicated toggle endpoint. ` +
      `If this is a real endpoint, add it to KNOWN_TOGGLE_ENDPOINTS; otherwise the toggle points at nothing.`,
  ).toBe(true);
}

describe('FeatureDefinition enableAction/disableAction validity', () => {
  it('every feature has at least an enableAction', () => {
    for (const def of BUILTIN_FEATURES) {
      expect(def.enableAction, `${def.id}: missing enableAction`).toBeTruthy();
    }
  });

  for (const def of BUILTIN_FEATURES) {
    it(`${def.id}: enable/disable actions target a real, patchable surface`, () => {
      checkAction(def.id, 'enableAction', def.enableAction as unknown as ToggleAction);
      checkAction(def.id, 'disableAction', def.disableAction as unknown as ToggleAction);
    });
  }

  it('regression: the dispatches enableAction is now patchable (the original bug)', () => {
    const dispatches = BUILTIN_FEATURES.find(f => f.id === 'dispatches');
    expect(dispatches, 'dispatches feature definition should exist').toBeTruthy();
    const body = (dispatches!.enableAction as unknown as ToggleAction).body ?? {};
    for (const key of Object.keys(body)) {
      expect(PATCHABLE_CONFIG_KEYS.has(key), `dispatches patches "${key}"`).toBe(true);
    }
  });
});
