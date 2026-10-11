/**
 * ACT-1306 a — the relay connection follows the serving lease (instar#2122).
 *
 * Relay standby used to be keyed on `multiMachine.telegramPolling === false`. A
 * standby that left the flag unset connected with the agent's shared identity
 * and displaced the awake machine's relay (Luna, 8 Oct, step 4a). With a live
 * `relayOwner` predicate, two real bootstraps sharing one identity against a
 * real relay hand the connection over as the lease moves, and the machine that
 * lost the lease does not reclaim it after being displaced.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 50));
  }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('relay follows the serving lease (production bootstrap path)', () => {
  let server: RelayServer;
  let port: number;
  let tmpDir: string;

  beforeAll(async () => {
    server = new RelayServer({
      port: 0,
      rateLimitConfig: {
        perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000,
        globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100,
      },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await server.start();
    port = server.address!.port;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-follows-lease-'));
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline/relay-follows-lease.test.ts' });
  });

  it('only the lease holder connects, the connection moves with the lease, and the old holder does not reclaim it', async () => {
    const kp = generateIdentityKeyPair();
    const machine = (name: string) => {
      const stateDir = path.join(tmpDir, name, 'state');
      const projectDir = path.join(tmpDir, name, 'project');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
        publicKey: kp.publicKey.toString('base64'),
        privateKey: kp.privateKey.toString('base64'),
        privateKeyEncryption: 'none',
        createdAt: new Date().toISOString(),
      }));
      return { stateDir, projectDir };
    };
    const reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const lease = { holder: 'laptop' as 'laptop' | 'studio' };
    const standbyChanges: Record<string, boolean[]> = { laptop: [], studio: [] };
    const boot = (name: 'laptop' | 'studio') => bootstrapThreadline({
      agentName: 'lease-agent', ...machine(name), port: 4040,
      relayEnabled: true, relayUrl: `ws://127.0.0.1:${port}/v1/connect`,
      relayRearmAfterDisplacedMs: 300,
      relayOwner: () => lease.holder === name,
      onRelayStandbyChange: (standby) => standbyChanges[name].push(standby),
      relayOwnerCheckMs: 100,
      relayReleaseAfterChecks: 2,
    });

    const laptop = await boot('laptop');
    const studio = await boot('studio');
    try {
      // Boot: only the holder connects; the standby defers and says so.
      expect(laptop.relayClient?.connectionState).toBe('connected');
      expect(studio.relaySuppressedByStandby).toBe(true);
      expect(studio.isRelayReleasedForStandby?.()).toBe(true);
      await sleep(400);
      expect(laptop.relayClient?.connectionState).toBe('connected'); // the standby never displaced it
      expect(studio.relayClient?.connectionState).toBe('disconnected');

      // The lease moves to the studio.
      lease.holder = 'studio';
      await waitFor(() => studio.relayClient?.connectionState === 'connected');
      await waitFor(() => laptop.isRelayReleasedForStandby?.() === true);
      expect(standbyChanges.studio).toEqual([true, false]);
      expect(standbyChanges.laptop).toEqual([true]);

      // Past the displacement rearm window: the old holder stays off the relay.
      await sleep(800);
      expect(laptop.relayClient?.connectionState).toBe('disconnected');
      expect(studio.relayClient?.connectionState).toBe('connected');

      // And back again.
      lease.holder = 'laptop';
      await waitFor(() => laptop.relayClient?.connectionState === 'connected');
      await waitFor(() => studio.isRelayReleasedForStandby?.() === true);
      await sleep(800);
      expect(laptop.relayClient?.connectionState).toBe('connected');
    } finally {
      await laptop.shutdown();
      await studio.shutdown();
      reportSpy.mockRestore();
    }
  });

  it('without relayOwner the bootstrap connects at once, exactly as before', async () => {
    const kp = generateIdentityKeyPair();
    const stateDir = path.join(tmpDir, 'solo', 'state');
    const projectDir = path.join(tmpDir, 'solo', 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none', createdAt: new Date().toISOString(),
    }));
    const solo = await bootstrapThreadline({
      agentName: 'solo-agent', stateDir, projectDir, port: 4040,
      relayEnabled: true, relayUrl: `ws://127.0.0.1:${port}/v1/connect`,
    });
    try {
      expect(solo.relayClient?.connectionState).toBe('connected');
      expect(solo.relaySuppressedByStandby).toBe(false);
      expect(solo.isRelayReleasedForStandby?.()).toBe(false);
    } finally {
      await solo.shutdown();
    }
  });
});
