/**
 * Moved-conversation history over the real signed mesh: a holder whose bearer token
 * differs from this machine's still serves history, and an older holder falls back.
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
import { createTopicHistoryPullHandler, pullMovedTopicHistory } from '../../src/core/topicHistoryPull.js';

const HOLDER = 'm_holder';
const STANDBY = 'm_standby';
const TOPIC = 77;
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-pull-'));
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
const history = [{ fromUser: true, text: 'before the move', senderName: 'Justin', timestamp: '2026-11-04T10:00:00Z' }];
const serving = { 'topic-history-pull': (c: MeshCommand) => createTopicHistoryPullHandler({ readHistory: () => history })(c as never) };

describe('topic-history-pull over the signed mesh', () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  const pull = (url: string, bearer: () => Promise<unknown[] | null>) => pullMovedTopicHistory({
    signedPull: (topic) => standby().send({ machineId: HOLDER, url }, { type: 'topic-history-pull', topic }, 0),
    bearerFetch: bearer,
  }, TOPIC);

  it('history crosses with no shared token', async () => {
    server = await holder(serving);
    const res = await pull(server.url, async () => { throw new Error('bearer must not be used'); });
    expect(res).toEqual({ via: 'signed', messages: history });
  });

  it('a holder without the handler answers no-handler, and the bearer fallback carries it', async () => {
    server = await holder({});
    const res = await pull(server.url, async () => [{ fromUser: false, text: 'via bearer' }]);
    expect(res).toMatchObject({ via: 'bearer', messages: [{ text: 'via bearer' }] });
  });

  it('a machine that is not a registered peer gets nothing', async () => {
    server = await holder(serving, []);
    const res = await pull(server.url, async () => null);
    expect(res).toEqual({ via: 'none', messages: [] });
  });
});
