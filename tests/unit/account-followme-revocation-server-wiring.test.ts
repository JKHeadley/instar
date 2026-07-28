/**
 * WS5.2 R12 server-wiring integrity (source touchpoints) — proves the revocation data-plane is
 * actually WIRED into the running server, not just present as an isolated module:
 *   - server.ts constructs AccountFollowMeRevocation with REAL deps (cooperative wipe, durable
 *     store, attention emit) — never the in-memory test seam, never no-ops.
 *   - server.ts schedules the deadline sweep timer and threads the executor into AgentServer.
 *   - routes.ts fires it from /mandate/:id/revoke for an account-follow-me mandate.
 *   - ConfigDefaults + PostUpdateMigrator carry the reconnect-deadline default (Migration Parity).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('WS5.2 R12 server.ts construction (real deps, not no-ops)', () => {
  const src = read('src/commands/server.ts');
  it('constructs AccountFollowMeRevocation', () => {
    expect(src).toContain('new AccountFollowMeRevocation(');
  });
  it('wires the REAL cooperative wipe (buildCooperativeWipe over the SubscriptionPool)', () => {
    expect(src).toContain('buildCooperativeWipe({');
    expect(src).toMatch(/cooperativeWipe:\s*buildCooperativeWipe/);
  });
  it('wires the DURABLE pending store (not the in-memory test seam)', () => {
    expect(src).toContain('new DurablePendingWipeStore({ stateDir: config.stateDir })');
    expect(src).not.toContain('inMemoryPendingWipeStore(');
  });
  it('wires the REAL attention emitter (createAttentionItem), not a no-op', () => {
    expect(src).toMatch(/emitRevocationFailed:\s*\(item\)\s*=>/);
    expect(src).toContain("sourceContext: 'account-follow-me-revocation'");
  });
  it('gates enabled() on the SAME accountFollowMe dev-gate, read LIVE per call', () => {
    expect(src).toContain('accountFollowMeRevocationEnabled');
    expect(src).toContain("multiMachine.accountFollowMe.enabled");
  });
  it('uses the config reconnect-deadline with a sane default', () => {
    expect(src).toContain('revocationReconnectDeadlineMs');
    expect(src).toMatch(/reconnectDeadlineMs:\s*\(\)\s*=>/);
  });
  it('schedules the deadline sweep timer (unref so it never holds the process open)', () => {
    expect(src).toContain('accountFollowMeRevocation.sweepDeadlines()');
    expect(src).toContain('accountFollowMeRevocationSweepTimer');
    expect(src).toContain('accountFollowMeRevocationSweepTimer.unref?.()');
  });
  it('threads the executor into the AgentServer construction', () => {
    expect(src).toContain('inUseAccountResolver, enrollmentWizard, accountFollowMeRevocation,');
  });
});

describe('WS5.2 R12 AgentServer threading', () => {
  const src = read('src/server/AgentServer.ts');
  it('declares the option + passes it into RouteContext', () => {
    expect(src).toContain("accountFollowMeRevocation?: import('../core/AccountFollowMeRevocation.js').AccountFollowMeRevocation");
    expect(src).toContain('accountFollowMeRevocation: options.accountFollowMeRevocation ?? null');
  });
});

describe('WS5.2 R12 routes.ts trigger', () => {
  const src = read('src/server/routes.ts');
  it('RouteContext carries the executor', () => {
    expect(src).toContain("accountFollowMeRevocation?: import('../core/AccountFollowMeRevocation.js').AccountFollowMeRevocation | null");
  });
  it('the revoke route detects an account-follow-me authority and fires revoke()', () => {
    expect(src).toContain("a.action === 'account-follow-me'");
    expect(src).toContain('ctx.accountFollowMeRevocation.revoke(');
    // PER-SERVER posture: local cooperative-online wipe.
    expect(src).toContain("'cooperative-online'");
  });
  it('surfaces the honest outcome on the response (never a fabricated removed)', () => {
    expect(src).toContain('accountFollowMeRevocation');
    expect(src).toContain('res.json({ revoked: true, mandate: m');
  });
});

describe('WS5.2 R12 config defaults + migration parity', () => {
  it('ConfigDefaults ships revocationReconnectDeadlineMs (hours, not days)', () => {
    const src = read('src/config/ConfigDefaults.ts');
    expect(src).toContain('revocationReconnectDeadlineMs: 6 * 60 * 60_000');
  });
  it('PostUpdateMigrator adds the deadline to deployed agents (existence-checked, idempotent)', () => {
    const src = read('src/core/PostUpdateMigrator.ts');
    expect(src).toContain('migrateConfigAccountFollowMeRevocationDeadline');
    expect(src).toContain('multiMachine.accountFollowMe.revocationReconnectDeadlineMs');
  });
});

describe('WS5.2 R12 migrateConfigAccountFollowMeRevocationDeadline (idempotent + existence-checked)', () => {
  it('adds the field to an existing accountFollowMe block exactly once', async () => {
    const { migrateConfigAccountFollowMeRevocationDeadline } = await import(
      '../../src/core/PostUpdateMigrator.js'
    );
    const cfg: Record<string, unknown> = { multiMachine: { accountFollowMe: { maxFollowMachines: 5 } } };
    expect(migrateConfigAccountFollowMeRevocationDeadline(cfg)).toBe(true);
    expect((cfg.multiMachine as any).accountFollowMe.revocationReconnectDeadlineMs).toBe(6 * 60 * 60_000);
    // Idempotent: a second run is a no-op.
    expect(migrateConfigAccountFollowMeRevocationDeadline(cfg)).toBe(false);
  });
  it('never clobbers an operator override', async () => {
    const { migrateConfigAccountFollowMeRevocationDeadline } = await import(
      '../../src/core/PostUpdateMigrator.js'
    );
    const cfg: Record<string, unknown> = {
      multiMachine: { accountFollowMe: { revocationReconnectDeadlineMs: 999 } },
    };
    expect(migrateConfigAccountFollowMeRevocationDeadline(cfg)).toBe(false);
    expect((cfg.multiMachine as any).accountFollowMe.revocationReconnectDeadlineMs).toBe(999);
  });
  it('a pre-spec agent without the block is untouched', async () => {
    const { migrateConfigAccountFollowMeRevocationDeadline } = await import(
      '../../src/core/PostUpdateMigrator.js'
    );
    const cfg: Record<string, unknown> = { multiMachine: {} };
    expect(migrateConfigAccountFollowMeRevocationDeadline(cfg)).toBe(false);
  });
});
