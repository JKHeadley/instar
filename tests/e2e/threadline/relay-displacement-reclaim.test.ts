/**
 * A machine displaced from the relay reclaims it (sagemind, 2026-10-05).
 *
 * The agent's own machine connected with the same identity and bumped the
 * owner off the relay. The owner then stopped retrying for good and was
 * unreachable over Threadline for 40 hours, while health reported
 * "recoverable". This drives the production bootstrap path against a real
 * relay: the owner is displaced, raises a degradation, and after the
 * configured pause takes the connection back.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { RelayClient } from '../../../src/threadline/client/RelayClient.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
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

describe('relay displacement reclaim (production bootstrap path)', () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-'));
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline/relay-displacement-reclaim.test.ts' });
  });

  it('the displaced owner reports a degradation, then reclaims the relay after the pause', async () => {
    const stateDir = path.join(tmpDir, 'state');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const kp = generateIdentityKeyPair();
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('base64'),
      privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none',
      createdAt: new Date().toISOString(),
    }));

    const reports: Array<{ feature: string; reason: string }> = [];
    const reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report')
      .mockImplementation((r: { feature: string; reason: string }) => { reports.push(r); });

    const owner = await bootstrapThreadline({
      agentName: 'reclaim-agent', stateDir, projectDir, port: 4040,
      relayEnabled: true, relayUrl: `ws://127.0.0.1:${port}/v1/connect`,
      relayRearmAfterDisplacedMs: 500,
    });
    try {
      expect(owner.relayClient?.connectionState).toBe('connected');

      const intruder = new RelayClient(
        { relayUrl: `ws://127.0.0.1:${port}/v1/connect`, name: 'intruder', framework: 'test', capabilities: [], version: '1.0.0', visibility: 'unlisted' },
        { fingerprint: computeFingerprint(kp.publicKey), publicKey: kp.publicKey, privateKey: kp.privateKey, x25519PublicKey: deriveX25519PublicKey(kp.privateKey), createdAt: new Date().toISOString() },
      );
      const intruderDisplaced = new Promise<void>(resolve => intruder.once('displaced', () => resolve()));
      await intruder.connect();

      await waitFor(() => owner.relayClient?.connectionState === 'disconnected');
      expect(owner.getLastRelayEvent()?.event).toBe('displaced');
      expect(reports.some(r => r.feature === 'Threadline.relay' && r.reason.includes('displaced'))).toBe(true);

      await intruderDisplaced; // the owner took the connection back
      await waitFor(() => owner.relayClient?.connectionState === 'connected');
      expect(owner.getLastRelayEvent()).toBeNull();
      intruder.disconnect();
    } finally {
      await owner.shutdown();
      reportSpy.mockRestore();
    }
  });
});
