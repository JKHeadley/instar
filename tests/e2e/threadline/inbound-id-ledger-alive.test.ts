/**
 * A2A inbound message-id ledger — E2E "feature is alive" tier
 * (docs/specs/a2a-inbound-id-ledger.md).
 *
 * Production initialization path:
 *  - the controller is built with the exact `buildInboundIdLedgerController`
 *    server.ts calls at the inbound-queue sweep site (dev gate, live config),
 *    and opens the real on-disk file at boot;
 *  - a real in-repo RelayServer + the real `bootstrapThreadline` relay client
 *    deliver a peer's message, and the relay `gate-passed` consumer runs through
 *    the same `runRelayInboundWithLedger` server.ts uses — the row is written
 *    before the hand-off and a redelivered copy is re-admitted with the notice;
 *  - a real AgentServer serves the capability per probe and the read route
 *    (200, not 503); the prune runs; a backup snapshot excludes the file;
 *  - two real servers: an id handed off on server A and resent (resend:true) to
 *    server B is delivered on B with the "another of my machines" notice via
 *    the annotate-only peer read over real HTTP; with A stopped it is delivered
 *    with the plain resent-copy notice.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { RelayClient } from '../../../src/threadline/client/RelayClient.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { InboundMessageGate } from '../../../src/threadline/InboundMessageGate.js';
import {
  buildInboundIdLedgerController,
  resolveInboundIdLedgerPath,
  RESENT_COPY_NOTICE,
  PEER_HANDOFF_NOTICE,
  type InboundIdLedgerController,
} from '../../../src/threadline/InboundIdLedger.js';
import { runRelayInboundWithLedger, createPeerHandoffAnnotator, admitRelayInbound } from '../../../src/threadline/inboundIdLedgerWiring.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { BackupManager } from '../../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};

function configFor(project: TempProject, name: string, auth: string): InstarConfig {
  return {
    projectName: name, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {}, users: [],
    threadline: { relayEnabled: false, inboundIdLedger: { retentionDays: 14 } },
  } as InstarConfig;
}

function productionController(config: InstarConfig): InboundIdLedgerController {
  // Exactly the server.ts construction (live block read; enabled omitted ⇒ dev gate).
  return buildInboundIdLedgerController({
    stateDir: config.stateDir,
    agentId: config.projectName,
    developmentAgent: config.developmentAgent,
    readBlock: () => config.threadline?.inboundIdLedger,
  });
}

describe('inbound-id ledger — production path is alive', () => {
  let relay: RelayServer;
  let relayUrl: string;
  let tmp: string;
  let stateDir: string;
  let boot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let controller: InboundIdLedgerController;
  let projectA: TempProject;
  let projectB: TempProject;
  let serverA: AgentServer;
  let serverB: AgentServer;
  let controllerA: InboundIdLedgerController;
  let controllerB: InboundIdLedgerController;
  let urlA = '';
  const handled: Array<{ notice: string | null }> = [];

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-ledger-alive-'));
    stateDir = path.join(tmp, 'state');
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const kp = generateIdentityKeyPair();
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none', createdAt: new Date().toISOString(),
    }));

    // Boot order: the ledger opens before the relay starts delivering.
    controller = buildInboundIdLedgerController({
      stateDir, agentId: 'ledger-agent', developmentAgent: true, readBlock: () => ({ retentionDays: 14 }),
    });
    expect(controller.current()).not.toBeNull();
    expect(fs.existsSync(resolveInboundIdLedgerPath(stateDir, 'ledger-agent'))).toBe(true);

    boot = await bootstrapThreadline({ agentName: 'ledger-agent', stateDir, projectDir, port: 4040, relayEnabled: true, relayUrl });
    expect(boot.relayClient?.connectionState).toBe('connected');
    boot.relayClient!.on('gate-passed', (decision) => {
      void runRelayInboundWithLedger(
        decision,
        { ledger: () => controller.current(), tracker: () => null, extractMessageId: (m) => InboundMessageGate.extractMessageId(m as never) },
        async (ticket, notice) => { handled.push({ notice }); ticket?.recordHandoff('listener'); },
      );
    });

    // Two real servers for the cross-machine annotation.
    projectA = createTempProject();
    projectB = createTempProject();
    const cfgA = configFor(projectA, 'machine-a', 'tok-a');
    const cfgB = configFor(projectB, 'machine-b', 'tok-b');
    controllerA = productionController(cfgA);
    controllerB = productionController(cfgB);
    serverA = new AgentServer({ config: cfgA, sessionManager: createMockSessionManager() as never, state: projectA.state, inboundIdLedger: controllerA, handshakeManager: new HandshakeManager(projectA.stateDir, 'machine-a') } as never);
    serverB = new AgentServer({ config: cfgB, sessionManager: createMockSessionManager() as never, state: projectB.state, inboundIdLedger: controllerB } as never);
    await serverA.start();
    await serverB.start();
    const addr = (serverA as unknown as { server: { address(): { port: number } } }).server.address();
    urlA = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await serverA?.stop();
    await serverB?.stop();
    controllerA?.close();
    controllerB?.close();
    await boot?.shutdown();
    controller?.close();
    await relay.stop();
    projectA?.cleanup();
    projectB?.cleanup();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/threadline/inbound-id-ledger-alive.test.ts' });
  });

  it('a real relay delivery is recorded before the hand-off; a redelivered copy is re-admitted with the notice', async () => {
    const peerId = generateIdentityKeyPair();
    const peerFp = computeFingerprint(peerId.publicKey);
    const peer = new RelayClient(
      { relayUrl, name: `ledger-peer-${process.pid}`, framework: 'test', capabilities: ['conversation'], version: '1.0.0', visibility: 'public' },
      { fingerprint: peerFp, publicKey: peerId.publicKey, privateKey: peerId.privateKey, x25519PublicKey: deriveX25519PublicKey(peerId.privateKey), createdAt: new Date().toISOString() },
    );
    await peer.connect();
    const messageId = `e2e-${Date.now()}`;
    peer.sendMessage({
      from: peerFp, to: boot.relayClient!.fingerprint!, threadId: 'thread-e2e', messageId,
      payload: Buffer.from(JSON.stringify({ text: 'hello over the relay', type: 'chat' })).toString('base64'),
      timestamp: new Date().toISOString(),
    } as never);
    const key = `unverified:${peerFp}`;
    await waitFor(() => controller.current()!.getRow(key, messageId)?.disposition === 'handed-off');
    expect(controller.current()!.getRow(key, messageId)).toMatchObject({ ingress: 'relay-unknown-sender', path: 'listener', readmissions: 0 });
    expect(handled[handled.length - 1].notice).toBeNull();

    // A relay-flushed queued copy of the same id (the relay refuses a live same-id
    // resend inside its replay window, so re-emit the gate-passed frame it would
    // produce): a non-durable hand-off is delivered again, labelled.
    boot.relayClient!.emit('gate-passed', {
      action: 'pass', reason: 'relay-authenticated', trustLevel: 'verified', fingerprint: peerFp,
      message: { from: peerFp, threadId: 'thread-e2e', messageId, content: { content: 'hello over the relay' }, timestamp: '' },
    });
    await waitFor(() => (controller.current()!.getRow(key, messageId)?.readmissions ?? 0) === 1);
    await waitFor(() => handled.length >= 2);
    expect(handled[handled.length - 1].notice).toBe(RESENT_COPY_NOTICE);
    peer.disconnect();
  });

  it('the server advertises the capability per probe and serves the read route (200, not 503)', async () => {
    const health = await (await fetch(`${urlA}/threadline/health`)).json() as { capabilities?: string[]; protocolVersion?: number };
    expect(health.capabilities).toEqual(['inbound-id-ledger']);
    expect(health.protocolVersion).toBe(2);
    const read = await fetch(`${urlA}/a2a/inbound-ids?id=nothing`, { headers: { Authorization: 'Bearer tok-a' } });
    expect(read.status).toBe(200);
    const authed = await (await fetch(`${urlA}/health`, { headers: { Authorization: 'Bearer tok-a' } })).json() as { threadline?: { inboundIdLedger?: Record<string, unknown> } };
    expect(authed.threadline?.inboundIdLedger).toMatchObject({ operational: true, ledgerError: 0 });
  });

  it('the prune runs against the real file and a backup snapshot excludes it', () => {
    const l = controllerA.current()!;
    expect(l.runPruneTick()).toBe(0);
    const bm = new BackupManager(projectA.stateDir, { includeFiles: ['state/'] });
    const snap = bm.createSnapshot('manual');
    expect(snap.files.some((f) => f.includes('a2a-inbound-ids.'))).toBe(false);
  });

  it('an id handed off on server A and resent to server B carries the "another of my machines" notice; with A stopped, the plain notice', async () => {
    const fp = 'f'.repeat(32);
    const onA = controllerA.current()!.admit({ senderKey: fp, messageId: 'x-1', ingress: 'relay', threadId: 'thread-x' });
    if (onA.kind === 'admitted') { onA.ticket.recordHandoff('cold'); onA.ticket.finish(); }

    const annotateB = createPeerHandoffAnnotator({
      peers: () => [{ machineId: 'machine-a', url: urlA }],
      isUrlAllowed: () => true,
      authToken: 'tok-a',
      agentId: 'machine-a',
    });
    const deliver = async (id: string) => {
      const adm = await admitRelayInbound(controllerB.current(), { senderKey: fp, messageId: id, ingress: 'relay', threadId: 'thread-x', resend: true }, () => {});
      expect(adm.action).toBe('deliver');
      if (adm.action !== 'deliver') return null;
      const peerSaid = adm.needsPeerAnnotation ? await annotateB(fp, id) : false;
      adm.ticket.recordHandoff('cold');
      adm.ticket.finish();
      return { peerSaid, notice: peerSaid ? `${RESENT_COPY_NOTICE}; ${PEER_HANDOFF_NOTICE}` : adm.notice };
    };

    const first = await deliver('x-1');
    expect(first?.peerSaid).toBe(true);
    expect(first?.notice).toContain(PEER_HANDOFF_NOTICE);
    expect(controllerB.current()!.getRow(fp, 'x-1')?.disposition).toBe('handed-off'); // delivered on B, never suppressed

    await serverA.stop();
    const onA2 = controllerA.current()!.admit({ senderKey: fp, messageId: 'x-2', ingress: 'relay' });
    if (onA2.kind === 'admitted') { onA2.ticket.recordHandoff('cold'); onA2.ticket.finish(); }
    const second = await deliver('x-2');
    expect(second?.peerSaid).toBe(false);
    expect(second?.notice).toBe(RESENT_COPY_NOTICE);
  });
});
