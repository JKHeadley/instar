/**
 * silent-loss-refusal-conservation — Tier-2 integration. Wires the REAL pieces of
 * the refusal path in one process against REAL file-backed stores:
 *   owner-side: SenderValidationGate (real users.json + high-water) → real
 *   createDeliverMessageHandler(validateSender, onRejected→mesh-rejections.jsonl);
 *   ingress-side: SessionRouter.deliverMessage bridges to that handler → a
 *   sender-rejected NACK becomes a first-class `rejected` outcome → the consumer
 *   fires the SenderRejectionNoticer (real MessageProcessingLedger dedupe).
 *
 * Asserts the end-to-end contract: a genuinely unresolved sender against a
 * POPULATED registry is REFUSED, TELLS the user exactly ONCE (dedupe survives a
 * redelivery), leaves a metadata-only trace (no payload), and the gate arms /
 * disarms / re-arms per registry state (degenerate vs emptied-vs-high-water).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { UserManager } from '../../src/users/UserManager.js';
import { SenderValidationGate } from '../../src/core/senderValidationGate.js';
import { classifyRegistry, setRegistryHighWater } from '../../src/core/registryHighWater.js';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { appendMeshRejection, meshRejectionsLogPath } from '../../src/core/meshRejectionLog.js';
import { SenderRejectionNoticer } from '../../src/core/senderRejectionNotice.js';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { SessionRouter, type SessionRouterDeps, type OwnershipView, type DeliverAck } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MeshCommand, MeshEnvelope, MeshCommandHandler } from '../../src/core/MeshRpc.js';
import type { MachineCapacity } from '../../src/core/types.js';

const dirs: string[] = [];
const ledgers: MessageProcessingLedger[] = [];
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-int-')); dirs.push(d); return d; }
afterEach(() => {
  for (const l of ledgers.splice(0)) try { l.close(); } catch { /* ok */ }
  for (const d of dirs.splice(0)) try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ok */ }
});
const ENV = {} as MeshEnvelope;

function buildOwnerHandler(stateDir: string, opts: { operatorUid?: () => number | null } = {}) {
  const usersFile = path.join(stateDir, 'users.json');
  const statUsers = () => { try { const s = fs.statSync(usersFile); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } };
  const gate = new SenderValidationGate({
    usersFilePath: usersFile,
    stateDir,
    statUsers,
    resolveUid: (uid) => { try { return new UserManager(stateDir).resolveFromTelegramUserId(uid) != null; } catch { return false; } },
    operatorUidForTopic: opts.operatorUid ?? (() => null),
    alert: () => {},
    log: () => {},
  });
  const handler = createDeliverMessageHandler({
    ownerEpochOf: () => null,
    recordReceipt: () => true,
    validateSender: (envelope, session) => gate.decide(Number(envelope.userId), session).verdict === 'deliver',
    onRejected: (meta) => appendMeshRejection(stateDir, { reason: meta.reason, session: meta.session, messageId: meta.messageId, senderUid: meta.senderUid }),
  });
  return { gate, handler };
}

const SELF = 'ingress';
function cap(id: string): MachineCapacity { return { machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'] }; }

function callHandler(handler: MeshCommandHandler, cmd: MeshCommand): DeliverAck {
  return handler(cmd, 'owner', {} as MeshEnvelope) as DeliverAck;
}

function buildIngressRouter(handler: MeshCommandHandler) {
  const deps: SessionRouterDeps = {
    selfMachineId: SELF,
    placement: new PlacementExecutor(),
    machineRegistry: () => [cap(SELF), cap('owner')],
    resolveOwnership: () => ({ owner: 'owner', epoch: 1, status: 'active' } as OwnershipView),
    isMachineAlive: () => true,
    casClaimOwnership: (_s, _m, e) => ({ ok: true, epoch: e + 1 }),
    // Bridge the mesh hop in-process: call the OWNER's real handler.
    deliverMessage: async (_target, env) => callHandler(handler, { type: 'deliverMessage', session: env.sessionKey, messageId: env.messageId, payload: env.payload, ownershipEpoch: env.ownershipEpoch, senderEnvelope: env.senderEnvelope } as MeshCommand),
    handleLocally: vi.fn(async () => {}),
    spawnOnMachine: vi.fn(async () => {}),
    queueMessage: () => 'refused',
    raiseAttention: () => {},
    sleep: async () => {},
  };
  return new SessionRouter(deps);
}

describe('silent-loss refusal conservation — integration', () => {
  it('POPULATED registry + unresolved sender → REJECTED end-to-end: ONE notice, metadata-only trace, dedupe on redelivery', async () => {
    const stateDir = tmp();
    // A real registry with a real user (NOT the unresolved sender 777).
    const um = new UserManager(stateDir);
    um.upsertUser({ id: 'tg-100', name: 'Op', channels: [], permissions: ['admin'], telegramUserId: 100 });

    const { handler } = buildOwnerHandler(stateDir);
    const router = buildIngressRouter(handler);
    const ledger = MessageProcessingLedger.openMemory(); ledgers.push(ledger);
    const sendTelegram = vi.fn();
    const noticer = new SenderRejectionNoticer({
      sendTelegram, alertHub: () => {},
      markRejectedDurable: (id) => ledger.markRejected(id, 0, { platform: 'mesh' }),
    });

    async function inbound(messageId: string) {
      const outcome = await router.route({ sessionKey: '42', messageId, payload: 'hello', senderEnvelope: { userId: 777 } });
      if (outcome.action === 'rejected') {
        noticer.onRejected({ adapter: 'telegram', topicId: 42, messageId, senderUid: 777, peer: outcome.owner ?? undefined });
      }
      return outcome;
    }

    const first = await inbound('msg-1');
    expect(first.action).toBe('rejected');
    // ONE user notice.
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls[0][0]).toBe(42);
    expect(String(sendTelegram.mock.calls[0][1]).toLowerCase()).toContain("couldn't confirm you");
    // A metadata-only trace row (no payload) on the deciding machine.
    const traceRaw = fs.readFileSync(meshRejectionsLogPath(stateDir), 'utf-8').trim();
    const row = JSON.parse(traceRaw);
    expect(row).toMatchObject({ reason: 'sender-rejected', session: '42', senderUid: 777 });
    expect(JSON.stringify(row)).not.toContain('hello');

    // A REDELIVERY of the SAME messageId → rejected again but ZERO additional notice.
    const dup = await inbound('msg-1');
    expect(dup.action).toBe('rejected');
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it('DEGENERATE registry (empty, no high-water) → gate DISARMS → the message is DELIVERED (fresh install), not rejected', async () => {
    const stateDir = tmp();
    fs.writeFileSync(path.join(stateDir, 'users.json'), '[]'); // never populated
    const { handler } = buildOwnerHandler(stateDir);
    const router = buildIngressRouter(handler);
    const outcome = await router.route({ sessionKey: '42', messageId: 'm', payload: 'hi', senderEnvelope: { userId: 777 } });
    // Disarmed → the handler ACCEPTS (queued) → the router forwards (not rejected).
    expect(outcome.action).not.toBe('rejected');
  });

  it('the OPERATOR is delivered against a fixture-clobbered registry via the operator-resolution disarm (the incident fix)', async () => {
    const stateDir = tmp();
    // The raw file has ONLY a fixture row (the 2026-07-01 clobber): loadUsers
    // skips it → the operator (uid 500) does not resolve → operator-resolution disarm.
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([{ id: 'u-olivia', name: 'x', channels: [], permissions: ['admin'] }]));
    const { handler } = buildOwnerHandler(stateDir, { operatorUid: () => 500 });
    const router = buildIngressRouter(handler);
    // The operator (uid 500) messages: disarmed (operator unresolvable) → delivered.
    const outcome = await router.route({ sessionKey: '42', messageId: 'op-1', payload: 'are you there?', senderEnvelope: { userId: 500 } });
    expect(outcome.action).not.toBe('rejected');
  });

  it('gate arms/disarms/re-arms per registry state incl. high-water (stat-gated)', () => {
    const stateDir = tmp();
    const usersFile = path.join(stateDir, 'users.json');
    // Start empty → degenerate.
    fs.writeFileSync(usersFile, '[]');
    expect(classifyRegistry(usersFile, stateDir).klass).toBe('degenerate');
    // Register a real user → populated + high-water set.
    const um = new UserManager(stateDir);
    um.upsertUser({ id: 'tg-1', name: 'R', channels: [], permissions: ['user'], telegramUserId: 1 });
    expect(classifyRegistry(usersFile, stateDir).klass).toBe('populated');
    // Delete the last user → emptied → high-water present → POPULATED (keep rejecting).
    um.removeUser('tg-1');
    expect(classifyRegistry(usersFile, stateDir).klass).toBe('populated');
    // sanity: a fresh dir with []+high-water is emptied-by-deletion (reject side).
    const d2 = tmp();
    fs.writeFileSync(path.join(d2, 'users.json'), '[]');
    setRegistryHighWater(d2, 'test');
    expect(classifyRegistry(path.join(d2, 'users.json'), d2).klass).toBe('populated');
  });

  it('the drain path unifies on sender-deauthorized: forceReplace yields the DISTINCT `rejected` verdict', async () => {
    // A router where placeAndClaim (CAS-lost) → forwardToOwner → sender-rejected.
    const stateDir = tmp();
    const um = new UserManager(stateDir);
    um.upsertUser({ id: 'tg-1', name: 'R', channels: [], permissions: ['user'], telegramUserId: 1 });
    const { handler } = buildOwnerHandler(stateDir);
    const deps: SessionRouterDeps = {
      selfMachineId: SELF,
      placement: new PlacementExecutor(),
      machineRegistry: () => [cap(SELF), cap('owner')],
      resolveOwnership: () => ({ owner: 'owner', epoch: 1, status: 'active' } as OwnershipView),
      isMachineAlive: () => true,
      casClaimOwnership: () => ({ ok: false, epoch: 1 }), // force the CAS-lost → forwardToOwner arm
      deliverMessage: async (_t, env) => callHandler(handler, { type: 'deliverMessage', session: env.sessionKey, messageId: env.messageId, payload: env.payload, ownershipEpoch: env.ownershipEpoch, senderEnvelope: env.senderEnvelope } as MeshCommand),
      handleLocally: vi.fn(async () => {}),
      spawnOnMachine: vi.fn(async () => {}),
      queueMessage: () => 'refused',
      raiseAttention: () => {},
      sleep: async () => {},
    };
    const router = new SessionRouter(deps);
    const res = await router.forceReplace({ sessionKey: '42', messageId: 'fr-1', payload: 'x', senderEnvelope: { userId: 777 } });
    expect(res).toBe('rejected'); // → the drain maps this to sender-deauthorized (not attempts-exhausted)
  });
});

// keep the MeshEnvelope import referenced
void ENV;
