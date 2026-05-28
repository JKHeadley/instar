/**
 * E2E: cross-machine reply-marker propagation closes the post-handoff
 * double-reply window (spec §8 G3a). A standby receives a signed reply marker
 * over /api/message-marker, applies it to its MessageProcessingLedger, and a
 * subsequent provider redelivery of that same inbound is then DEDUPED on this
 * (now-awake) machine — proving the cross-machine half of exactly-once over real
 * HTTP, through real machine-auth.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager, generateMachineId, generateSigningKeyPair, generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { MessageProcessingLedger, computeReplyIdempotencyKey } from '../../src/messaging/MessageProcessingLedger.js';
import { dedupeKeyFor } from '../../src/messaging/ingressDedup.js';
import { signRequest } from '../../src/server/machineAuth.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-auth-marker-e2e';
const TOPIC = 13481;
const MSG_ID = 8800;

function mkEnv(name: string, port: number, role: 'awake' | 'standby') {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `marker-e2e-${name}-`));
  const mgr = new MachineIdentityManager(stateDir);
  const machineId = generateMachineId();
  const signingKeys = generateSigningKeyPair();
  const encryptionKeys = generateEncryptionKeyPair();
  const b64 = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const identity = {
    machineId, signingPublicKey: b64(signingKeys.publicKey), encryptionPublicKey: b64(encryptionKeys.publicKey),
    name, platform: `${os.platform()}-${os.arch()}`, createdAt: new Date().toISOString(), capabilities: ['sessions'] as string[],
  };
  const machineDir = path.join(stateDir, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identity, null, 2));
  fs.writeFileSync(path.join(machineDir, 'signing-private.pem'), signingKeys.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(machineDir, 'encryption-private.pem'), encryptionKeys.privateKey, { mode: 0o600 });
  mgr.registerMachine(identity as any, role);
  const config = {
    projectName: `marker-${name}`, projectDir: stateDir, stateDir, port, host: '127.0.0.1', authToken: AUTH,
    claudePath: 'claude', tmuxPath: 'tmux', scheduler: { enabled: false, timezone: 'UTC' }, messaging: [], monitoring: {}, requestTimeoutMs: 30000,
  } as InstarConfig;
  return { stateDir, mgr, identity, machineId, signingKeys, config };
}

describe('Cross-machine reply-marker → dedup (real HTTP + machine-auth)', () => {
  const PORT = 19600 + Math.floor(Math.random() * 80);
  let recv: ReturnType<typeof mkEnv>;   // the standby/receiver (boots a server)
  let peer: ReturnType<typeof mkEnv>;   // the holder that signs the marker
  let server: AgentServer;
  let coord: MultiMachineCoordinator;
  let ledger: MessageProcessingLedger;

  beforeAll(async () => {
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.3.19', null);
    recv = mkEnv('recv', PORT, 'standby');
    peer = mkEnv('peer', PORT + 1, 'awake');
    // recv must know peer's identity so the signed marker verifies.
    recv.mgr.registerMachine(peer.identity as any, 'awake');
    recv.mgr.storeRemoteIdentity(peer.identity as any);

    const state = new StateManager(recv.stateDir);
    coord = new MultiMachineCoordinator(state, { stateDir: recv.stateDir });
    coord.start();
    const sess = new SessionManager({ stateDir: recv.stateDir, claudePath: 'claude', tmuxPath: 'tmux', projectDir: recv.stateDir, port: PORT });

    ledger = MessageProcessingLedger.openMemory();
    server = new AgentServer({
      config: recv.config,
      sessionManager: sess,
      state,
      coordinator: coord,
      localSigningKeyPem: recv.signingKeys.privateKey,
      messageLedger: ledger,
      currentInboundByTopic: new Map<string, string>(),
      onReplyMarker: (marker: unknown) => {
        const m = marker as { dedupeKey: string; platform: string; replyIdempotencyKey: string; epoch: number; topic?: string | null };
        ledger.applyRemoteReplyMarker(m.dedupeKey, { platform: m.platform, replyIdempotencyKey: m.replyIdempotencyKey, epoch: m.epoch, topic: m.topic ?? null });
      },
    });
    await server.start();
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    coord?.stop();
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(recv.stateDir, { recursive: true, force: true, operation: 'marker-e2e:cleanup' });
    SafeFsExecutor.safeRmSync(peer.stateDir, { recursive: true, force: true, operation: 'marker-e2e:cleanup' });
  }, 10000);

  it('a signed marker applies to the ledger, then a redelivery of that message is deduped', async () => {
    const dedupeKey = dedupeKeyFor('telegram', TOPIC, MSG_ID);
    const body = {
      marker: {
        dedupeKey,
        platform: 'telegram',
        replyIdempotencyKey: computeReplyIdempotencyKey(dedupeKey, 0),
        epoch: 1,
        topic: String(TOPIC),
      },
    };
    // Signed by the PEER (the holder that answered) — verified against recv's registry.
    const headers = signRequest(peer.machineId, peer.signingKeys.privateKey, body, 1);
    const markerResp = await fetch(`http://127.0.0.1:${PORT}/api/message-marker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    expect(markerResp.status).toBe(200);

    // The ledger now records that event as answered (cross-machine).
    expect(ledger.isActedOn(dedupeKey)).toBe(true);

    // A provider redelivery of the SAME inbound now hits this machine → deduped.
    const fwd = await fetch(`http://127.0.0.1:${PORT}/internal/telegram-forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
      body: JSON.stringify({ topicId: TOPIC, text: 'redelivered after handoff', fromUserId: 1, fromUsername: 't', fromFirstName: 'T', messageId: MSG_ID }),
    });
    expect(fwd.status).toBe(200);
    const fwdBody = (await fwd.json()) as { ok: boolean; deduped?: boolean; reason?: string };
    expect(fwdBody.deduped).toBe(true);
    expect(fwdBody.reason).toBe('already-replied');
  });

  it('rejects an UNSIGNED marker (machine-auth)', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/message-marker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marker: { dedupeKey: 'x', platform: 'telegram', replyIdempotencyKey: 'y', epoch: 1 } }),
    });
    expect(resp.status).toBe(401);
  });
});
