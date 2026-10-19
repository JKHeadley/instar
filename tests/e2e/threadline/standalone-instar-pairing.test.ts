/**
 * Threadline without Instar — the acceptance test (spec threadline-standalone-pairing D2).
 *
 * A threadline-mcp-style STANDALONE agent (packages/threadline-mcp/src/pairing.ts on
 * threadline-core, over a plain relay WebSocket authenticated the way threadline-mcp does) and a
 * real INSTAR agent (bootstrapThreadline) on a real in-process RelayServer:
 *  1. Instar invites, the standalone accepts, Instar finishes: both mutual-verified.
 *  2. The standalone invites, Instar accepts, the standalone finishes: both mutual-verified.
 *  3. A credential goes standalone → Instar encrypted to the pinned key, and Instar reads it.
 *  4. An unpaired standalone's credential send is refused before anything leaves.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createTempProject } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InviteEvent } from '../../../src/threadline/PairingInviteFlow.js';
import { StandalonePairing } from '../../../packages/threadline-mcp/src/pairing.js';
import { generateIdentityKeyPair, sign } from '@sagemindai/threadline-core';

interface Standalone { fp: string; pairing: StandalonePairing; ws: WebSocket; project: TempProject; events: InviteEvent[]; received: Array<{ kind: string; text?: string; encrypted?: boolean; credential?: boolean }> }

describe('threadline without Instar: standalone ↔ Instar', () => {
  let relay: RelayServer;
  let relayData: TempProject;
  let relayUrl: string;
  let httpBase: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  async function standalone(name: string): Promise<Standalone> {
    const project = createTempProject();
    const keys = generateIdentityKeyPair();
    const fp = keys.publicKey.subarray(0, 16).toString('hex');
    const ws = new WebSocket(relayUrl);
    const events: InviteEvent[] = [];
    const received: Standalone['received'] = [];
    const pairing = new StandalonePairing({
      stateDir: project.stateDir,
      identity: { fp, publicKey: keys.publicKey, privateKey: keys.privateKey },
      ownName: () => ({ owner: `${name}-owner`, agent: name }),
      sendEnvelope: (envelope) => ws.send(JSON.stringify({ type: 'message', envelope })),
      relayHttpBase: httpBase,
    });
    pairing.events.on('event', (e: InviteEvent) => events.push(e));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('auth timeout')), 10_000);
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'challenge') {
          ws.send(JSON.stringify({
            type: 'auth', agentId: fp, publicKey: keys.publicKey.toString('base64'),
            signature: sign(keys.privateKey, Buffer.from(frame.nonce, 'utf-8')).toString('base64'),
            metadata: { name, framework: 'claude-code', capabilities: ['chat'], version: '0.5.0' }, visibility: 'public',
          }));
        } else if (frame.type === 'auth_ok') { clearTimeout(t); resolve(); }
        else if (frame.type === 'auth_error') { clearTimeout(t); reject(new Error(frame.message)); }
        else if (frame.type === 'message') { void pairing.receive(frame.envelope).then((r) => received.push(r as never)); }
        else if (frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      });
      ws.on('error', reject);
    });
    cleanups.push(() => { ws.close(); project.cleanup(); });
    return { fp, pairing, ws, project, events, received };
  }

  async function instar(name: string, port: number) {
    const project = createTempProject();
    const boot = await bootstrapThreadline({
      agentName: name, ownerName: `${name}-owner`, stateDir: project.stateDir, projectDir: project.dir, port, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
    });
    expect(boot.relayClient?.connectionState).toBe('connected');
    const events: InviteEvent[] = [];
    boot.pairingInvites!.events.on('event', (e: InviteEvent) => events.push(e));
    const inbox: Array<{ from: string; content: unknown }> = [];
    boot.relayClient!.on('message', (m: { from: string; content: unknown }) => inbox.push(m));
    cleanups.push(async () => { await boot.shutdown(); project.cleanup(); });
    return { boot, fp: boot.relayClient!.fingerprint!.toLowerCase(), events, inbox };
  }

  beforeAll(async () => {
    relayData = createTempProject();
    relay = new RelayServer({
      port: 0, registryDataDir: relayData.stateDir,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    httpBase = `http://127.0.0.1:${relay.address!.port}`;
  }, 60_000);

  afterAll(async () => {
    for (const c of cleanups.reverse()) await c();
    await relay?.stop();
    relayData?.cleanup();
  });

  it('Instar invites, the standalone accepts, Instar finishes: both sides verified', async () => {
    const I = await instar('echo', 4271);
    const S = await standalone('desktop-agent');
    const inv = I.boot.pairingInvites!.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await S.pairing.flow.receiveInvite(inv.message) as { ok: boolean; iid: string; claimedAgent: string };
    expect(r).toMatchObject({ ok: true, claimedAgent: 'echo' });
    expect(S.pairing.flow.approveAccept(r.iid)).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(I.events.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 10_000 });
    expect(I.boot.pairingInvites!.flow.approveFinish(inv.iid)).toMatchObject({ ok: true });

    await vi.waitFor(() => {
      expect(S.pairing.keys.isCredentialShareAllowedByFingerprint(I.fp)).toBe(true);
      expect(I.boot.trustManager!.isCredentialShareAllowedByFingerprint(S.fp)).toBe(true);
    }, { timeout: 10_000 });
    expect(S.received.every((m) => m.kind === 'control')).toBe(true); // pairing ops never surfaced as messages
  }, 60_000);

  it('the standalone invites, Instar accepts, the standalone finishes; then a credential goes standalone → Instar', async () => {
    const I = await instar('scout', 4272);
    const S = await standalone('claude-desktop');
    const inv = S.pairing.flow.createInvite() as { ok: true; iid: string; message: string };
    expect(inv.message).toContain('tlinv1:');
    const r = await I.boot.pairingInvites!.flow.receiveInvite(inv.message) as { ok: boolean; iid: string };
    expect(r).toMatchObject({ ok: true });
    expect(I.boot.pairingInvites!.flow.approveAccept(r.iid)).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(S.pairing.waitingToFinish().map((i) => i.iid)).toContain(inv.iid), { timeout: 10_000 });
    expect(S.pairing.flow.approveFinish(inv.iid)).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(I.boot.trustManager!.isCredentialShareAllowedByFingerprint(S.fp)).toBe(true);
      expect(S.pairing.keys.isCredentialShareAllowedByFingerprint(I.fp)).toBe(true);
    }, { timeout: 10_000 });

    const sent = S.pairing.send(I.fp, 'the database password', { credential: true });
    expect(sent).toMatchObject({ sent: true, encrypted: true });
    await vi.waitFor(() => {
      // Instar's client emits 'message' for every envelope (its gate routes them after), so look
      // for the credential itself among what arrived from the standalone.
      const got = I.inbox.filter((m) => m.from === S.fp).map((m) => JSON.stringify(m.content));
      expect(got.some((c) => c.includes('the database password'))).toBe(true);
    }, { timeout: 10_000 });
  }, 60_000);

  it('a credential to an agent the standalone has not paired with is refused before anything is sent', async () => {
    const I = await instar('stranger', 4273);
    const S = await standalone('careful');
    const before = I.inbox.length;
    expect(S.pairing.send(I.fp, 'secret', { credential: true })).toEqual({ sent: false, reason: 'peer-not-mutually-verified' });
    await new Promise((r) => setTimeout(r, 500));
    expect(I.inbox.length).toBe(before);
  }, 60_000);
});
