/**
 * Unit (Tier 1) — the un-enablable-config-gate lint's detector
 * (lint-no-unreachable-messaging-gate.js). Regression guard for the PR #1379 class:
 * a DEFAULT-OFF gate at a `messaging.<child>.*` dot-path is unreachable on
 * array-shaped `messaging` and therefore un-enablable.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain JS lint script, no type declarations.
import { scanText, UNREACHABLE_OFF_GATE } from '../../scripts/lint-no-unreachable-messaging-gate.js';

describe('lint-no-unreachable-messaging-gate detector', () => {
  it('FLAGS the exact #1379 shape: .get(messaging.*.enabled, false)', () => {
    const src = `const enabled = ctx.liveConfig?.get<boolean>('messaging.actionClaim.enabled', false) ?? false;`;
    expect(scanText(src)).toEqual([1]);
  });

  it('flags the plain (non-generic) form and single quotes', () => {
    expect(scanText(`liveConfig.get("messaging.foo.enabled", false)`)).toEqual([1]);
    expect(scanText(`x.get('messaging.bar.baz', false)`)).toEqual([1]);
  });

  it('does NOT flag a default-TRUE messaging gate (unreachable just means it stays on)', () => {
    const src = `const on = liveConfig.get('messaging.outboundAdvisory.enabled', true) ?? true;`;
    expect(scanText(src)).toEqual([]);
  });

  it('does NOT flag a reachable TOP-LEVEL actionClaim gate (the fix shape)', () => {
    const src = `const enabled = liveConfig.get('actionClaim.enabled', false);`;
    expect(scanText(src)).toEqual([]);
  });

  it('does NOT flag a non-messaging default-off gate', () => {
    const src = `const on = liveConfig.get('monitoring.burnDetection.enabled', false);`;
    expect(scanText(src)).toEqual([]);
  });

  it('respects an inline suppression on the same line', () => {
    const src = `liveConfig.get('messaging.legacy.enabled', false) // lint-allow-messaging-gate: legacy shim`;
    expect(scanText(src)).toEqual([]);
  });

  it('respects a suppression on the immediately-preceding line', () => {
    const src = [
      `// lint-allow-messaging-gate: intentional`,
      `liveConfig.get('messaging.legacy.enabled', false)`,
    ].join('\n');
    expect(scanText(src)).toEqual([]);
  });

  it('the exported regex matches the incident line', () => {
    expect(UNREACHABLE_OFF_GATE.test(`.get('messaging.actionClaim.enabled', false)`)).toBe(true);
  });
});
