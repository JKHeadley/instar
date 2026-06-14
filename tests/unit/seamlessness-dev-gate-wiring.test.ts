/**
 * mm-pool-seamlessness-devgate (operator directive 2026-06-13, topic 13481): the 5
 * multiMachine.seamlessness coherence flags (ws3OneVoice, ws13Reconcile, ws41DurableAck,
 * ws43RoleGuard, ws43JournalLease) moved from hardcoded `false` in ConfigDefaults to the
 * developmentAgent gate — config OMITS them, the runtime resolves via resolveDevAgentGate
 * (live-on-dev / dark-fleet), mirroring the ws44PoolLinks/ws44PoolCache precedent.
 *
 * This test enforces the TWO halves the PR1 lesson taught us NOT to skip:
 *   A. RESOLUTION — each flag resolves true on a dev agent, false on the fleet (and the
 *      ws43JournalLeaseDryRun coherence: dev → live/false, fleet → dry-run/true).
 *   B. NO-MISSED-CONSUMER — every production read-site routes the raw config value through
 *      resolveDevAgentGate. A consumer left on the old raw `=== true` read would keep the
 *      feature DARK on a dev agent even though ConfigDefaults omits it (the exact "still-
 *      dark-on-dev = incomplete" failure mode). Asserted at the source-string seam so a
 *      regression that reverts a consumer to the raw read fails CI.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES, DARK_GATE_EXCLUSIONS } from '../../src/core/devGatedFeatures.js';

const FLAGS = [
  'ws3OneVoice',
  'ws13Reconcile',
  'ws41DurableAck',
  'ws43RoleGuard',
  'ws43JournalLease',
] as const;

const srcDir = path.join(process.cwd(), 'src');
const serverSrc = fs.readFileSync(path.join(srcDir, 'commands', 'server.ts'), 'utf-8');
const routesSrc = fs.readFileSync(path.join(srcDir, 'server', 'routes.ts'), 'utf-8');
const configDefaultsSrc = fs.readFileSync(path.join(srcDir, 'config', 'ConfigDefaults.ts'), 'utf-8');

describe('seamlessness dev-gate — A. resolution (live-on-dev / dark-fleet)', () => {
  it('ConfigDefaults OMITS each flag (no hardcoded `false` injected)', () => {
    // A fresh standalone config gets the migration defaults applied — the flags must NOT
    // be present (omitted), so resolveDevAgentGate decides per-agent.
    const dev: Record<string, any> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const seam = dev.multiMachine?.seamlessness ?? {};
    for (const f of FLAGS) {
      expect(seam[f], `${f} omitted from ConfigDefaults`).toBeUndefined();
    }
    // ws43JournalLeaseDryRun is ALSO omitted (computed coherently at the consumer).
    expect(seam.ws43JournalLeaseDryRun, 'ws43JournalLeaseDryRun omitted').toBeUndefined();
  });

  it('each flag resolves LIVE on a dev agent and DARK on the fleet', () => {
    const dev: Record<string, any> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const fleet: Record<string, any> = { developmentAgent: false };
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    for (const f of FLAGS) {
      const devSeam = dev.multiMachine?.seamlessness ?? {};
      const fleetSeam = fleet.multiMachine?.seamlessness ?? {};
      expect(resolveDevAgentGate(devSeam[f], dev), `${f} live on dev`).toBe(true);
      expect(resolveDevAgentGate(fleetSeam[f], fleet), `${f} dark on fleet`).toBe(false);
    }
  });

  it('ws43JournalLeaseDryRun resolves COHERENTLY: false (live) on dev, true (dry-run) on fleet', () => {
    const dev: Record<string, any> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const fleet: Record<string, any> = { developmentAgent: false };
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    // The consumer formula: cfg?.ws43JournalLeaseDryRun ?? !resolveDevAgentGate(undefined, config)
    const devDry = (dev.multiMachine?.seamlessness?.ws43JournalLeaseDryRun) ?? !resolveDevAgentGate(undefined, dev);
    const fleetDry = (fleet.multiMachine?.seamlessness?.ws43JournalLeaseDryRun) ?? !resolveDevAgentGate(undefined, fleet);
    expect(devDry, 'dev → live cutover (dryRun false)').toBe(false);
    expect(fleetDry, 'fleet → dry-run (dryRun true)').toBe(true);
  });

  it('an explicit operator config value still wins (force-dark false / fleet-flip true)', () => {
    const devForceDark: Record<string, any> = { developmentAgent: true };
    expect(resolveDevAgentGate(false, devForceDark)).toBe(false);
    const fleetFlip: Record<string, any> = { developmentAgent: false };
    expect(resolveDevAgentGate(true, fleetFlip)).toBe(true);
  });
});

describe('seamlessness dev-gate — B. no-missed-consumer (every read routes through resolveDevAgentGate)', () => {
  it('ws3OneVoice — SpeakerElection.enabled reads through resolveDevAgentGate(ws3Cfg().ws3OneVoice, config)', () => {
    expect(serverSrc).toMatch(/resolveDevAgentGate\(ws3Cfg\(\)\.ws3OneVoice,\s*config\)/);
    // The old raw read must be GONE (a revert would re-dark dev).
    expect(serverSrc).not.toMatch(/enabled:\s*\(\)\s*=>\s*ws3Cfg\(\)\.ws3OneVoice === true/);
  });

  it('ws13Reconcile — OwnershipReconciler.enabled reads through resolveDevAgentGate; ws13DryRun stays a plain read', () => {
    expect(serverSrc).toMatch(/resolveDevAgentGate\(ws13Cfg\(\)\.ws13Reconcile,\s*config\)/);
    expect(serverSrc).not.toMatch(/enabled:\s*\(\)\s*=>\s*ws13Cfg\(\)\.ws13Reconcile === true/);
    // ws13DryRun is the in-component rung, NOT the dev-gate — it stays a plain config read.
    expect(serverSrc).toMatch(/dryRun:\s*\(\)\s*=>\s*ws13Cfg\(\)\.ws13DryRun !== false/);
  });

  it('ws41DurableAck — routes.ts ws41DurableAckEnabled reads through resolveDevAgentGate(..., ctx.config)', () => {
    expect(routesSrc).toMatch(/resolveDevAgentGate\(\s*\(\(ctx\.config[\s\S]{0,160}?\)\.ws41DurableAck,\s*ctx\.config/);
    expect(routesSrc).not.toMatch(/\.ws41DurableAck === true;/);
  });

  it('ws43RoleGuard — scheduler.setRoleGuard enabled reads through resolveDevAgentGate', () => {
    expect(serverSrc).toMatch(/resolveDevAgentGate\(config\.multiMachine\?\.seamlessness\?\.ws43RoleGuard,\s*config\)/);
    expect(serverSrc).not.toMatch(/enabled:\s*config\.multiMachine\?\.seamlessness\?\.ws43RoleGuard === true/);
  });

  it('ws43JournalLease — setJournalLeaseCutover enabled reads through resolveDevAgentGate; dryRun is coherent', () => {
    expect(serverSrc).toMatch(/resolveDevAgentGate\(config\.multiMachine\?\.seamlessness\?\.ws43JournalLease,\s*config\)/);
    // The dryRun consumer formula (cfg ?? !resolveDevAgentGate(undefined, config)).
    expect(serverSrc).toMatch(/ws43JournalLeaseDryRun \?\? !resolveDevAgentGate\(undefined,\s*config\)/);
    // The old raw cutover-input read must be GONE.
    expect(serverSrc).not.toMatch(/enabled:\s*config\.multiMachine\?\.seamlessness\?\.ws43JournalLease === true,/);
  });

  it('ws43JournalLease — the heartbeat capability advert resolves through the gate (not the raw read)', () => {
    // The seamlessnessFlags advert advertises journal-lease only when the gate resolves
    // it live AND it is not dry-run — both via resolveDevAgentGate, never the raw === true.
    const advert = serverSrc.match(/seamlessnessFlags:\s*\{[\s\S]{0,400}?ws43JournalLease:[\s\S]{0,260}?stateSyncReceive/)![0];
    expect(advert).toMatch(/resolveDevAgentGate\(config\.multiMachine\?\.seamlessness\?\.ws43JournalLease,\s*config\)/);
    expect(advert).not.toMatch(/ws43JournalLease:\s*config\.multiMachine\?\.seamlessness\?\.ws43JournalLease === true/);
  });
});

describe('seamlessness dev-gate — registry coherence', () => {
  it('all 5 flags are registered in DEV_GATED_FEATURES by configPath', () => {
    for (const f of FLAGS) {
      const entry = DEV_GATED_FEATURES.find((e) => e.configPath === `multiMachine.seamlessness.${f}`);
      expect(entry, `${f} registered in DEV_GATED_FEATURES`).toBeDefined();
      expect(entry!.justification.length, `${f} has a real justification`).toBeGreaterThan(40);
    }
  });

  it('none of the 5 flags are in DARK_GATE_EXCLUSIONS (they are dev-gated, not dark-for-everyone)', () => {
    for (const f of FLAGS) {
      const excl = DARK_GATE_EXCLUSIONS.find((e) => e.configPath === `multiMachine.seamlessness.${f}`);
      expect(excl, `${f} NOT in DARK_GATE_EXCLUSIONS`).toBeUndefined();
    }
  });

  it('the 3 sessionPool flags stay HELD in DARK_GATE_EXCLUSIONS (shared StageAdvancer stage-gate, not cleanly dev-gatable)', () => {
    for (const cp of [
      'multiMachine.sessionPool.enabled',
      'multiMachine.sessionPool.inboundQueue.enabled',
      'multiMachine.sessionPool.holdForStability.enabled',
    ]) {
      expect(DARK_GATE_EXCLUSIONS.find((e) => e.configPath === cp), `${cp} held in exclusions`).toBeDefined();
      expect(DEV_GATED_FEATURES.find((e) => e.configPath === cp), `${cp} NOT dev-gated`).toBeUndefined();
    }
    // And they remain hardcoded `enabled: false` in ConfigDefaults (held, not omitted).
    expect(configDefaultsSrc).toMatch(/sessionPool:\s*\{\s*\n\s*enabled:\s*false/);
  });
});
