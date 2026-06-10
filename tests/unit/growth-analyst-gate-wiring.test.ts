/**
 * Wiring-integrity guards for the GrowthMilestoneAnalyst developmentAgent
 * dark-feature gate (standard_development_agent_dark_feature_gate): the analyst
 * must ship LIVE on the dev agent (the dogfooding ground, e.g. echo) and DARK
 * fleet-wide, resolved via `enabled ?? !!config.developmentAgent` — NOT a
 * hardcoded `enabled: false` that ships dark even on dev agents.
 *
 * G1 (config default omits `enabled`): so the runtime gate governs.
 * G2 (migration parity): the block deep-merges under `monitoring` without
 *   clobbering operator-set fields, and never re-introduces `enabled`.
 * G3 (resolution, both sides): `enabled ?? !!developmentAgent`, explicit wins.
 * G4 (source-level): AgentServer actually resolves the gate AND feeds the
 *   resolved value into settings (so GET /growth/status is honest).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getInitDefaults, getMigrationDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';

const AGENT_SERVER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/server/AgentServer.ts'), 'utf-8');

describe('G1/G2 — growthAnalyst default ships caps but NO `enabled` (dev-gate governs)', () => {
  it('ships monitoring.growthAnalyst with settings but NO `enabled` for every agent type', () => {
    for (const t of ['managed-project', 'standalone'] as const) {
      const ga = (getInitDefaults(t).monitoring as any).growthAnalyst;
      expect(ga).toBeDefined();
      // `enabled` MUST be omitted so the server resolves it via
      // `enabled ?? !!config.developmentAgent` — the dark-ship invariant.
      expect('enabled' in ga).toBe(false);
      // The rest of the config still ships so the analyst has real settings.
      expect(ga.digestCron).toBe('0 11 * * 1');
      expect(ga.incubationWindows).toEqual({ lowRisk: 3, standard: 7, highRisk: 7 });
      expect(ga.proofOfLifeMinActivations).toBe(1);
    }
    const mig = (getMigrationDefaults('managed-project').monitoring as any).growthAnalyst;
    expect(mig).toBeDefined();
    expect('enabled' in mig).toBe(false);
  });

  it('migration deep-merges growthAnalyst into an existing monitoring block (parity)', () => {
    // Existing agent already has a monitoring block but no growthAnalyst.
    const config: any = { monitoring: { quotaTracking: true } };
    const { patched, changes } = applyDefaults(config, getMigrationDefaults('managed-project'));
    expect(patched).toBe(true);
    expect(config.monitoring.quotaTracking).toBe(true); // untouched
    expect(config.monitoring.growthAnalyst).toBeDefined();
    expect(config.monitoring.growthAnalyst.digestCron).toBe('0 11 * * 1');
    expect('enabled' in config.monitoring.growthAnalyst).toBe(false);
    expect(changes.some((c: string) => c.includes('growthAnalyst'))).toBe(true);
  });

  it('migration does NOT overwrite an operator-set growthAnalyst.enabled (force-dark a dev agent)', () => {
    const config: any = { monitoring: { growthAnalyst: { enabled: false } } };
    applyDefaults(config, getMigrationDefaults('managed-project'));
    // Operator's explicit kill-switch survives; only missing fields backfill.
    expect(config.monitoring.growthAnalyst.enabled).toBe(false);
    expect(config.monitoring.growthAnalyst.digestCron).toBe('0 11 * * 1'); // backfilled
  });
});

describe('G3 — the dev-gate resolution: enabled ?? !!developmentAgent (both sides)', () => {
  it('dev agent ON, fleet dark, explicit enabled wins both ways', () => {
    // Models the exact server-side resolution. Config block lacks `enabled`.
    const resolve = (ga: any, developmentAgent: boolean) => ga?.enabled ?? !!developmentAgent;
    const ga = (getInitDefaults('managed-project').monitoring as any).growthAnalyst;
    // developmentAgent agent (Echo) → ON.
    expect(resolve(ga, true)).toBe(true);
    // fleet agent (no dev flag) → dark.
    expect(resolve(ga, false)).toBe(false);
    // explicit enabled wins regardless of dev flag.
    expect(resolve({ ...ga, enabled: false }, true)).toBe(false);
    expect(resolve({ ...ga, enabled: true }, false)).toBe(true);
    // gate also resolves when no config block exists at all (dev agent, defaults only).
    expect(resolve(undefined, true)).toBe(true);
    expect(resolve(undefined, false)).toBe(false);
  });
});

describe('G4 — AgentServer resolves the gate and feeds it into settings (source-level)', () => {
  it('gates analyst construction on the developmentAgent standard (via the resolveDevAgentGate funnel)', () => {
    // The dev-gate resolution now goes through the resolveDevAgentGate funnel
    // (DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC) rather than a hand-rolled
    // `?? !!developmentAgent`, so lint-dev-agent-dark-gate can keep it that way.
    expect(AGENT_SERVER_SRC).toMatch(
      /resolveDevAgentGate\(\s*options\.config\.monitoring\?\.growthAnalyst\?\.enabled,\s*options\.config\s*\)/,
    );
  });

  it('feeds the gate-resolved enabled into resolveGrowthSettings (honest /growth/status)', () => {
    // The construction must pass the resolved value through so getStatus().enabled
    // reflects reality on a dev agent (config omits the flag).
    expect(AGENT_SERVER_SRC).toMatch(/enabled:\s*growthAnalystEnabled/);
    expect(AGENT_SERVER_SRC).toContain('if (growthAnalystEnabled &&');
  });
});
