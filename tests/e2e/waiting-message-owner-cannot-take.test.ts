/**
 * fb-faa9d074-e09 — E2E lifecycle, production wiring shape: the REAL QueueDrainLoop on a REAL
 * SQLite PendingInboundStore, draining through the REAL SessionRouter over the REAL
 * SessionOwnershipRegistry, with the drain's forced attempt wired as server.ts wires it
 * (router.forceReplace) and the takeover as server.ts wires it (takeOverActiveRecord).
 *
 * The incident: a Telegram message for a conversation owned by a live peer without durable
 * receive waited in the holder's queue, was retried until its tries ran out, and expired
 * unanswered (the user was told "the session stopped running"). The lifecycle now ends with
 * the message delivered on the holder and nothing reported lost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingInboundStore } from '../../src/core/PendingInboundStore.js';
import { QueueDrainLoop, type LossItem } from '../../src/core/QueueDrainLoop.js';
import { DEFAULT_INBOUND_QUEUE_CONFIG, DEFAULT_HOLD_FOR_STABILITY_CONFIG } from '../../src/core/inboundQueueConfig.js';
import { SessionRouter, type SessionRouterDeps } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore, takeOverActiveRecord } from '../../src/core/SessionOwnershipRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

const SELF = 'm_studio';
const PEER = 'm_m5';
const cap = (id: string): MachineCapacity => ({ machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'] });

describe('a message waiting on an owner that cannot take it — lifecycle (E2E)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-owner-e2e-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/waiting-message-owner-cannot-take.test.ts' }); });

  it('queued for a live peer without receive → retried → forced attempt answers it HERE; nothing lost', async () => {
    let clock = Date.parse('2026-11-16T07:00:00Z');
    const nonces = new Set<string>();
    const reg = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
    reg.cas({ type: 'place', machineId: PEER }, { sessionKey: '22', sender: SELF, nonce: 'p' });
    reg.cas({ type: 'claim', machineId: PEER }, { sessionKey: '22', sender: SELF, nonce: 'c' });

    const delivered: string[] = [];
    const losses: Array<{ items: LossItem[]; reason: string }> = [];
    let engine: QueueDrainLoop | null = null;
    let n = 0;
    const routerDeps: SessionRouterDeps = {
      selfMachineId: SELF,
      placement: new PlacementExecutor(),
      machineRegistry: () => [cap(SELF), cap(PEER)],
      resolveOwnership: (sk) => {
        const r = reg.read(sk);
        return r ? { owner: r.ownerMachineId, epoch: r.ownershipEpoch, status: r.status === 'released' ? null : r.status } : { owner: null, epoch: 0, status: null };
      },
      isMachineAlive: () => true,
      ownerSupportsForward: (m) => (m === PEER ? false : null), // the incident: ws11DeliverReceive false
      casClaimOwnership: (sk, m) => ({ ok: reg.cas({ type: 'place', machineId: m }, { sessionKey: sk, sender: SELF, nonce: `p${++n}` }).ok, epoch: reg.read(sk)?.ownershipEpoch ?? 0 }),
      confirmClaim: (sk, m) => { reg.cas({ type: 'claim', machineId: m }, { sessionKey: sk, sender: SELF, nonce: `c${++n}` }); },
      takeOverFromPeer: (sk, from) => takeOverActiveRecord(reg, sk, from, SELF, `t${++n}`)?.ok === true,
      deliverMessage: async () => { throw new Error('must never forward to a peer without receive'); },
      handleLocally: async () => {},
      spawnOnMachine: async () => { throw new Error('must never place elsewhere'); },
      queueMessage: (m, reason) => {
        const out = engine!.enqueueLive({ sessionKey: m.sessionKey, messageId: m.messageId, payload: String(m.payload) }, reason);
        return out.result as 'queued' | 'already-queued' | 'refused';
      },
      raiseAttention: () => {},
      markOwnerSuspect: () => {},
      sleep: async () => {},
    };
    const router = new SessionRouter(routerDeps);

    const store = PendingInboundStore.open('echo', dir);
    const qcfg = { ...DEFAULT_INBOUND_QUEUE_CONFIG, enabled: true, dryRun: false, maxAttempts: 3, baseBackoffMs: 1000, maxBackoffMs: 2000 };
    engine = new QueueDrainLoop({
      store, qcfg, hcfg: { ...DEFAULT_HOLD_FOR_STABILITY_CONFIG, enabled: false },
      selfMachineId: SELF,
      holdsLease: () => true,
      isStopped: () => false,
      // As server.ts: route first; queued → un-routable; handled here → inject.
      dispatchInbound: async (msg, handover) => {
        const out = await router.route({ sessionKey: msg.sessionKey, messageId: msg.messageId, payload: msg.payload });
        if (out.action === 'queued' || out.action === 'placement-blocked') return { kind: 'un-routable', reason: out.detail ?? out.action };
        if (out.action !== 'handled-locally') return { kind: 'remote-delivered' };
        if (!handover.commitReceipt()) return { kind: 'handover-refused' };
        delivered.push(msg.messageId);
        return { kind: 'local-delivered' };
      },
      forceReplace: (msg) => router.forceReplace({ sessionKey: msg.sessionKey, messageId: msg.messageId, payload: msg.payload }),
      holdVerdict: () => 'deliver',
      clearPisRecord: () => {},
      reportLoss: (items, reason) => losses.push({ items, reason }),
      reportPossiblyNotInjected: () => {},
      log: () => {},
      reportDegradation: () => {},
      now: () => clock,
      mono: () => clock,
      bootSessionId: 'boot-1',
    });
    engine.onLeaseAcquired(null);

    // The live path: the router queues it (no immediate steal from a live machine).
    const live = await router.route({ sessionKey: '22', messageId: 'tg-22', payload: 'hello?' });
    expect(live).toMatchObject({ action: 'queued', detail: 'owner-lacks-ws11-receive', acked: true });

    for (let i = 0; i < 8 && delivered.length === 0; i++) {
      clock += 5_000;
      await engine.tick();
    }

    expect(delivered).toEqual(['tg-22']);
    expect(losses).toEqual([]);
    expect(reg.read('22')).toMatchObject({ ownerMachineId: SELF, status: 'active' });
    store.close();
  });
});
