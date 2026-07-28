/**
 * E2E: duplicate-identity name resolution through the REAL relay wire path.
 *
 * Stands up a RelayServer + real ThreadlineClients. Registers a LIVE "echo" and a
 * DEAD "echo" (same name, different key — the exact incident shape), then a sender
 * discovers + resolves the name and must land on the LIVE fingerprint, never the dead
 * twin. Per docs/specs/threadline-duplicate-identity-resolution.md. This is the wire-level
 * proof that the client-side fix closes the silent drop end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { ThreadlineClient } from '../../../src/threadline/client/ThreadlineClient.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Threadline duplicate-identity resolution — E2E (live vs dead echo)', () => {
  let server: RelayServer;
  let serverPort: number;
  const tmpDirs: string[] = [];

  const mkdir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-id-e2e-'));
    tmpDirs.push(d);
    return d;
  };
  const mkClient = (name: string) =>
    new ThreadlineClient({ name, relayUrl: `ws://127.0.0.1:${serverPort}/v1/connect`, stateDir: mkdir(), visibility: 'public' });

  beforeAll(async () => {
    server = new RelayServer({
      port: 0,
      rateLimitConfig: {
        perAgentPerMinute: 1000,
        perAgentPerHour: 10000,
        perIPPerMinute: 10000,
        globalPerMinute: 50000,
        discoveryPerMinute: 100,
        authAttemptsPerMinute: 100,
      },
      abuseDetectorConfig: {
        sybilFirstHourLimit: 10000,
        sybilSecondHourLimit: 10000,
        spamUniqueRecipientsPerMinute: 10000,
      },
    });
    await server.start();
    serverPort = server.address!.port;
  });

  afterAll(async () => {
    await server.stop();
    for (const d of tmpDirs) {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/threadline/DuplicateIdentityResolveE2E.test.ts:afterAll' });
    }
  });

  it('a sender resolves the name "echo" to the LIVE registration when a dead twin also exists', async () => {
    // Live echo — stays connected → online in the registry.
    const liveEcho = mkClient('echo');
    await liveEcho.connect();
    const liveFp = liveEcho.fingerprint;
    expect(liveFp).toBeTruthy();

    // Dead echo — different key, same name; connect then disconnect → registered but offline.
    const deadEcho = mkClient('echo');
    await deadEcho.connect();
    const deadFp = deadEcho.fingerprint;
    expect(deadFp).toBeTruthy();
    expect(deadFp).not.toBe(liveFp);
    deadEcho.disconnect();
    await sleep(300); // let the relay process the disconnect (presence → offline)

    // A third agent discovers "echo" (gets both rows w/ live status) and resolves the name.
    const sender = mkClient('sender');
    await sender.connect();
    await sender.discover({ name: 'echo' });
    const resolved = await sender.resolveAgent('echo');

    // The dead twin must never win while a live twin exists.
    expect(resolved).toBe(liveFp);
    expect(resolved).not.toBe(deadFp);

    sender.disconnect();
    liveEcho.disconnect();
  });
});
