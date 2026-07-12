/**
 * ACT-562 §5 — the LLM-decision provenance WIRING flag is registered in
 * DEV_GATED_FEATURES (docs/specs/llm-decision-provenance-wiring.md). The
 * existing devGatedFeatures-wiring.test.ts loop then guards its both-sides
 * resolution permanently; this test pins that the flag is present (else the
 * dark-gate lint / the wiring loop would silently not cover it).
 */
import { describe, it, expect } from 'vitest';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';

const CONFIG_PATH = 'provenance.llmDecisionWiring.enabled';

describe('provenance.llmDecisionWiring — dev-gate registry', () => {
  it('is registered in DEV_GATED_FEATURES exactly once', () => {
    const matches = DEV_GATED_FEATURES.filter((f) => f.configPath === CONFIG_PATH);
    expect(matches.length).toBe(1);
    expect(matches[0].justification.length).toBeGreaterThan(11);
  });

  it('ConfigDefaults OMITS `enabled` (NOT hardcoded false — #1001) so the gate decides', () => {
    // applyDefaults must NOT inject an `enabled:false` under the wiring block.
    const cfg = { developmentAgent: false } as Record<string, unknown>;
    applyDefaults(cfg, getMigrationDefaults('standalone'));
    const wiring = (cfg as { provenance?: { llmDecisionWiring?: { enabled?: unknown } } }).provenance?.llmDecisionWiring;
    expect(wiring).toBeDefined();
    expect(wiring?.enabled).toBeUndefined();
  });

  it('resolves LIVE on a dev agent and DARK on the fleet', () => {
    const devCfg = { developmentAgent: true } as Record<string, unknown>;
    const fleetCfg = { developmentAgent: false } as Record<string, unknown>;
    applyDefaults(devCfg, getMigrationDefaults('standalone'));
    applyDefaults(fleetCfg, getMigrationDefaults('standalone'));
    const read = (c: Record<string, unknown>) =>
      (c as { provenance?: { llmDecisionWiring?: { enabled?: boolean } } }).provenance?.llmDecisionWiring?.enabled;
    expect(resolveDevAgentGate(read(devCfg), { developmentAgent: true })).toBe(true);
    expect(resolveDevAgentGate(read(fleetCfg), { developmentAgent: false })).toBe(false);
  });
});
