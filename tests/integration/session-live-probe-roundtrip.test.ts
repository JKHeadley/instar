/**
 * The duplicate check's probe over the real signed mesh: a peer whose bearer token differs
 * from this machine's still answers, and an older peer falls back.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { liveCopyInList, probeLiveCopyOnPeer } from '../../src/core/sessionLiveProbe.js';

const HOLDER = 'm_holder';
const STANDBY = 'm_standby';
const keys = Object.fromEntries([HOLDER, STANDBY].map((id) => {
  const kp = generateSigningKeyPair();
  return [id, { priv: kp.privateKey, pub: kp.publicKey }];
}));

async function holder(handlers: Partial<Record<MeshCommand['type'], (c: MeshCommand) => unknown>>, peers: string[] = [STANDBY]) {
  const seen = new Set<string>();
  const dispatcher = new MeshRpcDispatcher({
    verify: {
      selfMachineId: HOLDER,
      verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
      isRegisteredPeer: (s) => peers.includes(s),
      seenNonce: (s, n) => seen.has(`${s}:${n}`),
      now: () => Date.now(),
    },
    rbac: { routerHolder: () => HOLDER, ownerOf: () => null, placementTargetOf: () => null },
    recordNonce: (s, n) => seen.add(`${s}:${n}`),
    handlers,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-probe-'));
  const ctx = { config: { authToken: 'holder-token', stateDir, port: 0 }, stateDir, meshRpcDispatcher: dispatcher } as never;
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(createRoutes(ctx));
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = app.listen(0, () => resolve({
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      close: () => new Promise<void>((r) => srv.close(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/topic-history-pull-roundtrip.test.ts:close' }); r(); })),
    }));
  });
}

let n = 0;
const standby = () => new MeshRpcClient({ selfMachineId: STANDBY, sign: (c) => sign(c, keys[STANDBY].priv), nonce: () => `n${++n}`, now: () => Date.now() });
const sessions = [{ platform: 'telegram', platformId: 77 }];
const serving = {
  'session-live-probe': (c: MeshCommand) => {
    const { platform, platformId } = c as unknown as { platform: string; platformId: string };
    return { ok: true, live: liveCopyInList(sessions, platform, platformId) };
  },
};

describe('session-live-probe over the signed mesh', () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  const probe = (url: string, platformId: string, bearer: () => Promise<boolean>) => probeLiveCopyOnPeer({
    signed: () => standby().send({ machineId: HOLDER, url }, { type: 'session-live-probe', platform: 'telegram', platformId }, 0),
    bearer,
  });
  const refused = async () => { throw new Error('HTTP 401'); };

  it('both answers cross with no shared token', async () => {
    server = await holder(serving);
    expect(await probe(server.url, '77', refused)).toEqual({ ok: true, live: true });
    expect(await probe(server.url, '78', refused)).toEqual({ ok: true, live: false });
  });

  it('a peer without the handler is reached over bearer', async () => {
    server = await holder({});
    expect(await probe(server.url, '77', async () => true)).toEqual({ ok: true, live: true });
  });

  it('a machine that is not a registered peer learns nothing, and the check defers', async () => {
    server = await holder(serving, []);
    expect(await probe(server.url, '77', refused)).toEqual({ ok: false, live: false });
  });
});
