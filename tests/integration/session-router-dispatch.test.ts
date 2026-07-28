/**
 * Integration test (§L4): the SessionRouter dispatch path wired over the REAL
 * MeshRpc transport (POST /mesh/rpc, Ed25519-signed envelopes, per-command RBAC)
 * and a REAL SessionOwnershipRegistry. Proves:
 *   - deliverMessage owner-forward: router → owner server → owner writes its ledger,
 *     ACKs queued; the router advances the offset ONLY after the queued ACK.
 *   - Idempotent redelivery: the SAME messageId → owner ACKs duplicate, NOT re-processed.
 *   - Ownership CAS at dispatch: two routers CAS-claiming the same unowned session
 *     concurrently → exactly one fast-forwards (one owner), the loser does not double-place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, signEnvelope, type MeshCommand, type MeshEnvelope } from '../../src/core/MeshRpc.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { SessionRouter, type OwnershipView, type DeliverAck, type SessionRouterDeps } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}
function cap(id: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return { machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'], ...over };
}

describe('SessionRouter dispatch over MeshRpc (§L4)', () => {
  let dir: string;
  let owner: Server;
  let ledger: string[]; // messageIds the owner has durably recorded
  let processed: string[]; // messageIds the owner actually PROCESSED (not deduped)
  const keys: Record<string, { priv: string; pub: string }> = {};

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-disp-'));
    ledger = [];
    processed = [];
    for (const id of ['ROUTER', 'OWNER']) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }
    const seenMesh = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: 'OWNER',
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, n) => seenMesh.has(`${s}:${n}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => 'ROUTER', ownerOf: () => 'OWNER', placementTargetOf: () => 'OWNER' },
      recordNonce: (s, n) => seenMesh.add(`${s}:${n}`),
      handlers: {
        deliverMessage: (cmd: MeshCommand) => {
          if (cmd.type !== 'deliverMessage') return { accepted: 'queued' };
          // Idempotency: a messageId already in the ledger is a duplicate (not re-processed).
          if (ledger.includes(cmd.messageId)) return { messageId: cmd.messageId, accepted: 'duplicate' };
          ledger.push(cmd.messageId); // durable receipt BEFORE processing
          processed.push(cmd.messageId);
          return { messageId: cmd.messageId, accepted: 'queued' };
        },
      },
    });
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    owner = await listen(app);
  });
  afterEach(async () => {
    await owner.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/session-router-dispatch.test.ts' });
  });

  let nonce = 0;
  // The router's deliverMessage dep: sign a router→OWNER envelope and POST /mesh/rpc.
  function makeDeliverDep(ownerUrl: string): SessionRouterDeps['deliverMessage'] {
    return async (target, env) => {
      const envelope = signEnvelope(
        { sender: 'ROUTER', recipient: target, command: { type: 'deliverMessage', session: env.sessionKey, messageId: env.messageId, payload: env.payload, ownershipEpoch: env.ownershipEpoch }, epoch: 1, nonce: `d${++nonce}`, timestamp: Date.now() },
        (c) => sign(c, keys.ROUTER.priv),
      );
      const r = await fetch(ownerUrl + '/mesh/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) });
      if (r.status !== 200) throw new Error(`mesh rpc ${r.status}`);
      const body = await r.json();
      return body.result as DeliverAck;
    };
  }

  it('forwards an inbound message to the alive owner over deliverMessage; offset advances only on the queued ACK', async () => {
    let offsetAdvanced = false;
    const deps: SessionRouterDeps = {
      selfMachineId: 'ROUTER',
      placement: new PlacementExecutor(),
      machineRegistry: () => [cap('ROUTER'), cap('OWNER')],
      resolveOwnership: () => ({ owner: 'OWNER', epoch: 5, status: 'active' }) as OwnershipView,
      isMachineAlive: () => true,
      casClaimOwnership: (_s, _m, e) => ({ ok: true, epoch: e + 1 }),
      deliverMessage: makeDeliverDep(owner.url),
      handleLocally: async () => {},
      spawnOnMachine: async () => {},
      queueMessage: () => 'refused' as const,
      raiseAttention: () => {},
      sleep: async () => {},
    };
    const router = new SessionRouter(deps);
    const out = await router.route({ sessionKey: 'sX', messageId: 'evt-100', payload: { text: 'hello owner' } });
    if (out.acked) offsetAdvanced = true;

    expect(out).toMatchObject({ action: 'forwarded', owner: 'OWNER', acked: true });
    expect(offsetAdvanced).toBe(true);
    expect(ledger).toEqual(['evt-100']);
    expect(processed).toEqual(['evt-100']);
  });

  it('WS1.1 Slack arm: a Slack-shaped routing key forwards to the remote owner just like a Telegram topic key', async () => {
    // The SessionRouter is sessionKey-agnostic: the Slack inbound path consults it
    // on a routing key like `C0123ABCD:1716200000.001500`. This proves a Slack key
    // forwards to the owner over the real transport (the bug was the Slack inbound
    // path NEVER consulting the router at all — it injected locally regardless).
    const deps: SessionRouterDeps = {
      selfMachineId: 'ROUTER',
      placement: new PlacementExecutor(),
      machineRegistry: () => [cap('ROUTER'), cap('OWNER')],
      resolveOwnership: () => ({ owner: 'OWNER', epoch: 5, status: 'active' }) as OwnershipView,
      isMachineAlive: () => true,
      casClaimOwnership: (_s, _m, e) => ({ ok: true, epoch: e + 1 }),
      deliverMessage: makeDeliverDep(owner.url),
      handleLocally: async () => {},
      spawnOnMachine: async () => {},
      queueMessage: () => 'refused' as const,
      raiseAttention: () => {},
      sleep: async () => {},
    };
    const router = new SessionRouter(deps);
    const slackKey = 'C0123ABCD:1716200000.001500';
    const out = await router.route({ sessionKey: slackKey, messageId: 'slack-evt-1', payload: 'hi from slack' });

    expect(out).toMatchObject({ action: 'forwarded', owner: 'OWNER', acked: true });
    expect(ledger).toEqual(['slack-evt-1']);
    expect(processed).toEqual(['slack-evt-1']);
  });

  it('redelivering the SAME messageId is ACKed as duplicate and NOT re-processed (ledger dedupe)', async () => {
    const deps: SessionRouterDeps = {
      selfMachineId: 'ROUTER',
      placement: new PlacementExecutor(),
      machineRegistry: () => [cap('ROUTER'), cap('OWNER')],
      resolveOwnership: () => ({ owner: 'OWNER', epoch: 5, status: 'active' }) as OwnershipView,
      isMachineAlive: () => true,
      casClaimOwnership: (_s, _m, e) => ({ ok: true, epoch: e + 1 }),
      deliverMessage: makeDeliverDep(owner.url),
      handleLocally: async () => {},
      spawnOnMachine: async () => {},
      queueMessage: () => 'refused' as const,
      raiseAttention: () => {},
      sleep: async () => {},
    };
    const router = new SessionRouter(deps);
    const first = await router.route({ sessionKey: 'sX', messageId: 'evt-7', payload: { text: 'one' } });
    const again = await router.route({ sessionKey: 'sX', messageId: 'evt-7', payload: { text: 'one (retry)' } });

    expect(first.action).toBe('forwarded');
    expect(again.action).toBe('duplicate');
    expect(again.acked).toBe(true);
    expect(ledger).toEqual(['evt-7']); // recorded once
    expect(processed).toEqual(['evt-7']); // processed once — redelivery did NOT re-process
  });

  it('two routers CAS-claiming the SAME unowned session concurrently → exactly one owner (per the shared ref)', async () => {
    // A single shared ownership store = the shared durable ref both routers contend on.
    const store = new InMemorySessionOwnershipStore();
    const seen = new Set<string>();
    const registry = new SessionOwnershipRegistry({ store, seenNonce: (k) => seen.has(k), recordNonce: (k) => seen.add(k) });

    let casNonce = 0;
    function makeRouter(selfId: string): SessionRouter {
      const deps: SessionRouterDeps = {
        selfMachineId: selfId,
        placement: new PlacementExecutor(),
        // Both routers see OWNER as the least-loaded → both will try to place OWNER.
        machineRegistry: () => [cap(selfId, { loadAvg: 9 }), cap('OWNER', { loadAvg: 0 })],
        resolveOwnership: () => {
          const r = registry.read('race');
          if (!r) return { owner: null, epoch: 0, status: null };
          return { owner: registry.ownerOf('race'), epoch: r.epoch, status: r.status as OwnershipView['status'], target: registry.placementTargetOf('race') ?? undefined };
        },
        isMachineAlive: () => true,
        casClaimOwnership: (sessionKey, machineId) => {
          const res = registry.cas({ type: 'place', machineId }, { sessionKey, sender: selfId, nonce: `c${selfId}${++casNonce}` });
          return { ok: res.ok, epoch: res.observed?.epoch ?? 0 };
        },
        deliverMessage: makeDeliverDep(owner.url),
        handleLocally: async () => {},
        spawnOnMachine: async () => {},
        queueMessage: () => 'refused' as const,
        raiseAttention: () => {},
        sleep: async () => {},
      };
      return new SessionRouter(deps);
    }
    const r1 = makeRouter('R1');
    const r2 = makeRouter('R2');
    const [o1, o2] = await Promise.all([
      r1.route({ sessionKey: 'race', messageId: 'm-a', payload: {} }),
      r2.route({ sessionKey: 'race', messageId: 'm-b', payload: {} }),
    ]);

    const outcomes = [o1.action, o2.action].sort();
    // Exactly one router placed (spawned); the other lost the CAS and queued (transient).
    expect(outcomes).toEqual(['queued', 'spawned']);
    expect(registry.placementTargetOf('race')).toBe('OWNER'); // exactly one placement landed
  });
});
