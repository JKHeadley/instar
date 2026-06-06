// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration test (WORKING-SET-HANDOFF-SPEC §3.2/§6): the working-set pull
 * over the REAL signed MeshRpc transport, end to end, at near-cap sizes.
 *
 * Two in-process machines:
 *  - Machine A (producer) serves its working files through a
 *    WorkingSetPullServer behind a real MeshRpcDispatcher on a loopback
 *    `/mesh/rpc` express route — exactly the server's wiring, REAL
 *    `express.json({limit})` body parsing on the path.
 *  - Machine B (receiver) drives a WorkingSetPuller whose `send` is a real
 *    MeshRpcClient → Ed25519 sign/verify, recipient binding, nonce dedupe.
 *
 * Proves (§6 integration):
 *  1. Full chunked round-trip at near-cap content size through the REAL
 *     express.json + MeshRpcClient path (body-parser + 5s timeout exercised
 *     for real, not mocked) — multiple sequential offset-cursor requests,
 *     whole-file hash verified, content cross-checked against the SOURCE
 *     machine's on-disk original read directly by the test (an oracle
 *     independent of the puller's report).
 *  2. want-outside-fresh-manifest refused through the full stack.
 *  3. Divergent local file → alongside copy through the full stack.
 *  4. Mixed-version honesty: a dispatcher WITHOUT the handler answers
 *     no-handler (501-class) — the caller treats it as verb-unsupported.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';

import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import {
  WorkingSetPullServer,
  WorkingSetPuller,
  type ServeResult,
  type WorkingSetPullCmd,
} from '../../src/core/WorkingSetPull.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE_A = 'm_producer';
const MACHINE_B = 'm_receiver';
const TOPIC = 77;

interface Server {
  url: string;
  close: () => Promise<void>;
}
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      }),
    );
  });
}

describe('working-set-pull round-trip (B pulls from A over real signed MeshRpc, §3.2)', () => {
  let dirA: string;
  let dirB: string;
  let server: Server;
  let wsServerA: WorkingSetPullServer;
  const keys: Record<string, { priv: string; pub: string }> = {};
  let n = 0;

  const BATCH = 256 * 1024; // 256KB chunks → a near-cap file takes several requests

  beforeEach(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-int-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-int-b-'));
    fs.mkdirSync(path.join(dirA, 'autonomous'), { recursive: true });
    for (const id of [MACHINE_A, MACHINE_B]) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }

    wsServerA = new WorkingSetPullServer({
      stateDir: dirA,
      readRuns: () => ({ entries: [], liveRun: false, artifactPaths: [], truncated: false }),
      pullMaxBatchBytes: BATCH,
    });

    const seen = new Set<string>();
    const dispatcherA = new MeshRpcDispatcher({
      verify: {
        selfMachineId: MACHINE_A,
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, nn) => seen.has(`${s}:${nn}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, nn) => seen.add(`${s}:${nn}`),
      handlers: {
        'working-set-pull': (cmd: MeshCommand) =>
          wsServerA.handle(cmd as WorkingSetPullCmd),
      },
    });

    const ctx: any = {
      config: { authToken: 'test', stateDir: dirA, port: 0 },
      stateDir: dirA,
      meshRpcDispatcher: dispatcherA,
    };
    const app = express();
    app.use(express.json({ limit: '12mb' })); // the REAL body ceiling (§3.2)
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/integration/working-set-pull-roundtrip.test.ts' });
    SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/integration/working-set-pull-roundtrip.test.ts' });
  });

  function pullerB(): WorkingSetPuller {
    const client = new MeshRpcClient({
      selfMachineId: MACHINE_B,
      sign: (c) => sign(c, keys[MACHINE_B].priv),
      nonce: () => `n${++n}`,
      now: () => Date.now(),
    });
    return new WorkingSetPuller({
      stateDir: dirB,
      send: async (cmd) => {
        const res = await client.send({ machineId: MACHINE_A, url: server.url }, cmd, 0);
        if (!res.ok) throw new Error(`mesh ${res.status}: ${res.reason}`);
        return res.result as ServeResult;
      },
      senderShortId: MACHINE_A,
      stillCurrent: () => true,
      pullMaxBatchBytes: BATCH,
    });
  }

  it('near-cap chunked round-trip: a 1.5MB file crosses in multiple REAL signed requests, content oracle-verified', async () => {
    // Near-cap: well over several 256KB chunks, exercising the REAL
    // express.json parse + MeshRpcClient timeout per request.
    const content = crypto.randomBytes(Math.floor(1.5 * 1024 * 1024));
    const srcPath = path.join(dirA, 'autonomous', `${TOPIC}.local.md`);
    fs.writeFileSync(srcPath, content);

    const report = await pullerB().pullTopic(TOPIC);
    expect(report.files).toHaveLength(1);
    expect(report.files[0].outcome).toBe('written');
    expect(report.assembledBytes).toBe(content.length);

    // INDEPENDENT ORACLE (§6): the landed bytes equal the SOURCE machine's
    // on-disk original read directly by the test — not the puller's report,
    // not the server's self-reported hash.
    const sourceOriginal = fs.readFileSync(srcPath);
    const landed = fs.readFileSync(path.join(dirB, 'autonomous', `${TOPIC}.local.md`));
    expect(landed.equals(sourceOriginal)).toBe(true);
  }, 30000);

  it('want outside the fresh manifest is refused through the full stack', async () => {
    fs.writeFileSync(path.join(dirA, 'autonomous', `${TOPIC}.local.md`), 'real file');
    fs.writeFileSync(path.join(dirA, 'config.json'), '{"secret":"never"}');

    const client = new MeshRpcClient({
      selfMachineId: MACHINE_B,
      sign: (c) => sign(c, keys[MACHINE_B].priv),
      nonce: () => `n${++n}`,
      now: () => Date.now(),
    });
    const res = await client.send(
      { machineId: MACHINE_A, url: server.url },
      { type: 'working-set-pull', topic: TOPIC, want: [{ relPath: 'config.json', offset: 0 }] },
      0,
    );
    expect(res.ok).toBe(true);
    const out = res.result as ServeResult;
    expect(out.refused).toEqual([{ relPath: 'config.json', reason: 'refusedPolicy' }]);
    expect(out.blobs ?? []).toHaveLength(0);
  });

  it('divergent local file lands ALONGSIDE through the full stack — never overwritten', async () => {
    fs.writeFileSync(path.join(dirA, 'autonomous', `${TOPIC}.local.md`), 'A version');
    const destDir = path.join(dirB, 'autonomous');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, `${TOPIC}.local.md`), 'B version');

    const report = await pullerB().pullTopic(TOPIC);
    expect(report.files[0].outcome).toBe('alongside');
    expect(fs.readFileSync(path.join(destDir, `${TOPIC}.local.md`), 'utf-8')).toBe('B version');
    const copies = fs.readdirSync(destDir).filter((f) => f.includes('.from-'));
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(destDir, copies[0]), 'utf-8')).toBe('A version');
  });

  it('mixed-version: a peer without the handler answers no-handler (501-class) — quiet back-off material', async () => {
    // A dispatcher with NO working-set-pull handler = an old peer that knows
    // the RBAC class but has no implementation → 'no-handler', mapped 501.
    const seen2 = new Set<string>();
    const oldDispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: MACHINE_A,
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, nn) => seen2.has(`${s}:${nn}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, nn) => seen2.add(`${s}:${nn}`),
      handlers: {},
    });
    const ctx: any = { config: { authToken: 'test', stateDir: dirA, port: 0 }, stateDir: dirA, meshRpcDispatcher: oldDispatcher };
    const app = express();
    app.use(express.json({ limit: '12mb' }));
    app.use(createRoutes(ctx));
    const oldServer = await listen(app);
    try {
      const client = new MeshRpcClient({
        selfMachineId: MACHINE_B,
        sign: (c) => sign(c, keys[MACHINE_B].priv),
        nonce: () => `o${++n}`,
        now: () => Date.now(),
      });
      const res = await client.send(
        { machineId: MACHINE_A, url: oldServer.url },
        { type: 'working-set-pull', topic: TOPIC, manifestOnly: true },
        0,
      );
      expect(res.ok).toBe(false);
      expect(res.status).toBe(501);
    } finally {
      await oldServer.close();
    }
  });
});
