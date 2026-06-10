import { describe, it, expect } from 'vitest';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';

describe('resolveDevAgentGate — developmentAgent dark-feature gate', () => {
  describe('omitted explicit value (the expected default — config OMITS enabled)', () => {
    it('resolves LIVE on a development agent', () => {
      expect(resolveDevAgentGate(undefined, { developmentAgent: true })).toBe(true);
    });

    it('resolves DARK on the fleet (developmentAgent false)', () => {
      expect(resolveDevAgentGate(undefined, { developmentAgent: false })).toBe(false);
    });

    it('resolves DARK on the fleet (developmentAgent absent)', () => {
      expect(resolveDevAgentGate(undefined, {})).toBe(false);
    });

    it('resolves DARK when the config object itself is undefined', () => {
      expect(resolveDevAgentGate(undefined, undefined)).toBe(false);
    });
  });

  describe('explicit value always wins (operator override)', () => {
    it('explicit false force-darks even a development agent', () => {
      expect(resolveDevAgentGate(false, { developmentAgent: true })).toBe(false);
    });

    it('explicit true is the fleet-flip (live even with developmentAgent false)', () => {
      expect(resolveDevAgentGate(true, { developmentAgent: false })).toBe(true);
    });

    it('explicit true on a dev agent stays live', () => {
      expect(resolveDevAgentGate(true, { developmentAgent: true })).toBe(true);
    });
  });

  describe('nullish semantics (not falsy) — the #1001-class trap', () => {
    it('treats only undefined as "omitted" — explicit false is honored, never coerced to the gate', () => {
      // The whole point: `enabled: false` must NOT fall through to the dev-agent
      // default. `??` (not `||`) guarantees this. This is the inverse of the
      // #1001 bug, where a hardcoded false robbed dev agents of the live default.
      expect(resolveDevAgentGate(false, { developmentAgent: true })).toBe(false);
      expect(resolveDevAgentGate(undefined, { developmentAgent: true })).toBe(true);
    });
  });
});
