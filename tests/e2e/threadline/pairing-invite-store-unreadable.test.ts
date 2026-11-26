/**
 * An unreadable invite store turns off invite pairing only, and says so where an operator looks
 * (docs/specs/threadline-standalone-pairing.md step 3 follow-up C).
 *
 * Real `bootstrapThreadline` on a real in-process RelayServer. `threadline/pairing-invites.json` is
 * made unreadable (a directory where the file should be: EISDIR on read), which makes core's store
 * constructor throw. The agent must still connect to the relay, invite pairing must be off, and the
 * failure must be a DegradationReporter event (what /health and the degradation digest read),
 * not only a console line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
import { createTempProject } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import { useHermeticHome } from '../../setup/hermetic-home.js';

// HOME → temp for every test here: bootstrapThreadline() writes the user-scope
// ~/.claude.json, and this file must never touch the operator's real one.
useHermeticHome();

describe('invite store unreadable (production path)', () => {
  let relay: RelayServer;
  let relayData: TempProject;
  let relayUrl: string;
  const projects: TempProject[] = [];
  const boots: Array<Awaited<ReturnType<typeof bootstrapThreadline>>> = [];

  async function boot(name: string, port: number, unreadable: boolean) {
    const p = createTempProject();
    projects.push(p);
    if (unreadable) fs.mkdirSync(path.join(p.stateDir, 'threadline', 'pairing-invites.json'), { recursive: true });
    const b = await bootstrapThreadline({
      agentName: name, ownerName: `${name}-owner`, stateDir: p.stateDir, projectDir: p.dir, port, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
    });
    boots.push(b);
    return { b, p };
  }

  const inviteDegradations = () =>
    DegradationReporter.getInstance().getRecentEvents().filter((e) => e.feature === 'Threadline.pairingInvites');

  beforeAll(async () => {
    relayData = createTempProject();
    relay = new RelayServer({
      port: 0, registryDataDir: relayData.stateDir,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
  }, 60_000);

  afterAll(async () => {
    for (const b of boots) await b.shutdown();
    for (const p of projects) p.cleanup();
    await relay?.stop();
    relayData?.cleanup();
  });

  it('CONTROL: a readable store starts invite pairing and reports nothing', async () => {
    DegradationReporter.resetForTesting();
    const { b } = await boot('fine', 4181, false);
    expect(b.relayClient?.connectionState).toBe('connected');
    expect(b.pairingInvites).toBeDefined();
    expect(inviteDegradations()).toHaveLength(0);
  });

  it('an unreadable store: Threadline still connects, invite pairing is off, and a degradation is reported', async () => {
    DegradationReporter.resetForTesting();
    const { b, p } = await boot('broken', 4182, true);
    expect(b.relayClient?.connectionState).toBe('connected');
    expect(b.pairingInvites).toBeUndefined();

    const events = inviteDegradations();
    expect(events).toHaveLength(1);
    expect(events[0].fallback).toMatch(/invite pairing is off/);
    expect(events[0].reason).toMatch(/pairing-invites\.json/);
    // The file is left as it was, never replaced with an empty store.
    expect(fs.statSync(path.join(p.stateDir, 'threadline', 'pairing-invites.json')).isDirectory()).toBe(true);
  });
});
