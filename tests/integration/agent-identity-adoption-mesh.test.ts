// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration (a2a-single-agent-identity §Tests): two in-process servers paired over
 * the REAL `/mesh/rpc` route + MeshRpcDispatcher, with real Ed25519 machine keys and real
 * X25519 registry encryption keys. Machine B boots with NO agent identity and a registry
 * naming A; it observes A (signed), adopts over `agent-identity-request`, and holds the SAME
 * private key A holds. A stub peer publishing a DIFFERENT fingerprint → B refuses and the
 * item names both; a forged answer is ignored. The verbs ride the registered-peer RBAC
 * class: a stranger's envelope is refused before any handler runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, generateEncryptionKeyPair, pemToBase64, sign, verify } from '../../src/core/MachineIdentity.js';
import { AgentIdentityServer, AgentIdentityAdoptionLoop, readAgentIdentityOnDisk, verifyObserveResponse, type AdoptionAttentionItem, type ObserveCommand, type RequestCommand } from '../../src/core/AgentIdentityAdoption.js';
import { AgentIdentityAudit } from '../../src/core/AgentIdentityAudit.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Listening { url: string; close: () => Promise<void> }
async function listen(app: express.Express): Promise<Listening> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) }));
  });
}

interface Machine {
  id: string;
  nick: string;
  stateDir: string;
  signing: { publicKey: string; privateKey: string };
  enc: { publicKey: string; privateKey: string };
  server?: Listening;
  identityServer?: AgentIdentityServer;
}

function writeIdentity(stateDir: string, kp = generateIdentityKeyPair()): { fingerprint: string; privateKey: Buffer } {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({ publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'), privateKeyEncryption: 'none', createdAt: '2026-05-01T00:00:00.000Z' }), { mode: 0o600 });
  return { fingerprint: computeFingerprint(kp.publicKey), privateKey: kp.privateKey };
}

describe('agent-identity adoption over the real /mesh/rpc (two servers)', () => {
  const AGENT = 'echo';
  let root: string;
  const machines = new Map<string, Machine>();
  const closers: Array<() => Promise<void>> = [];

  /** Registry-style lookups shared by every machine (the pairing wrote each other's keys). */
  const registryActive = (id: string) => machines.has(id);
  const verifySig = (machineId: string, canonical: string, sig: string): boolean => {
    const m = machines.get(machineId);
    return !!m && verify(canonical, sig, m.signing.publicKey);
  };

  function machine(id: string, nick: string): Machine {
    const m: Machine = { id, nick, stateDir: path.join(root, id), signing: generateSigningKeyPair(), enc: generateEncryptionKeyPair() };
    fs.mkdirSync(m.stateDir, { recursive: true });
    machines.set(id, m);
    return m;
  }

  /** Boot a machine's HTTP side: the real routes + a real dispatcher whose handlers are the real AgentIdentityServer. */
  async function boot(m: Machine, opts: { observeRequester?: (id: string) => Promise<{ state: 'provisioned' | 'not-provisioned'; fingerprint: string | null } | null> } = {}): Promise<void> {
    const seen = new Set<string>();
    let n = 0;
    const client = new MeshRpcClient({ selfMachineId: m.id, sign: (c) => sign(c, m.signing.privateKey), nonce: () => `${m.id}:${++n}:${Date.now()}` });
    m.identityServer = new AgentIdentityServer({
      stateDir: m.stateDir,
      agentName: AGENT,
      selfMachineId: m.id,
      sign: (c) => sign(c, m.signing.privateKey),
      isMachineActive: registryActive,
      registryEncryptionPublicKey: (id) => (machines.get(id) ? pemToBase64(machines.get(id)!.enc.publicKey) : null),
      // The void-check over the REAL wire: observe the requester back through ITS server.
      observeRequester: opts.observeRequester ?? (async (id) => {
        const peer = machines.get(id);
        if (!peer?.server) return null;
        const nonce = `vc-${Date.now()}-${++n}`;
        const r = await client.send({ machineId: id, url: peer.server.url }, { type: 'agent-identity-observe', agentName: AGENT, requesterNonce: nonce }, 0, { timeoutMs: 5000 });
        if (!r.ok) return null;
        const v = verifyObserveResponse(r.result, { machineId: id, requesterNonce: nonce }, verifySig);
        return v.state === 'unreachable' ? null : { state: v.state, fingerprint: v.fingerprint };
      }),
      audit: new AgentIdentityAudit(m.stateDir),
    });
    const identityServer = m.identityServer;
    const dispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: m.id,
        verify: (c, s, sender) => verifySig(sender, c, s),
        isRegisteredPeer: registryActive,
        seenNonce: (s, nn) => seen.has(`${s}:${nn}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => 'm_a', ownerOf: () => m.id, placementTargetOf: () => m.id },
      recordNonce: (s, nn) => seen.add(`${s}:${nn}`),
      handlers: {
        'agent-identity-observe': (cmd: MeshCommand, sender) => identityServer.observe(cmd as ObserveCommand, sender),
        'agent-identity-request': (cmd: MeshCommand, sender) => identityServer.request(cmd as RequestCommand, sender),
      },
    });
    const ctx: any = { config: { authToken: 'test', stateDir: m.stateDir, port: 0, projectName: AGENT }, stateDir: m.stateDir, meshRpcDispatcher: dispatcher };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    m.server = await listen(app);
    closers.push(m.server.close);
  }

  /** The adoption loop on `self`, sending over the REAL mesh client to each sibling's server. */
  function loopOn(self: Machine, siblings: Machine[], items: AdoptionAttentionItem[], resolved: string[]): AgentIdentityAdoptionLoop {
    let n = 0;
    const client = new MeshRpcClient({ selfMachineId: self.id, sign: (c) => sign(c, self.signing.privateKey), nonce: () => `${self.id}:${++n}:${Date.now()}` });
    const send = async (sib: { machineId: string }, cmd: MeshCommand) => {
      const peer = machines.get(sib.machineId);
      if (!peer?.server) return { ok: false as const, reason: 'transport' as const };
      try {
        const r = await client.send({ machineId: sib.machineId, url: peer.server.url }, cmd, 0, { timeoutMs: 5000 });
        if (r.ok) return { ok: true as const, result: r.result };
        return { ok: false as const, reason: r.reason === 'no-handler' ? ('no-handler' as const) : ('transport' as const) };
      } catch {
        return { ok: false as const, reason: 'transport' as const };
      }
    };
    return new AgentIdentityAdoptionLoop({
      stateDir: self.stateDir,
      agentName: AGENT,
      selfMachineId: self.id,
      enabled: () => true,
      listActiveSiblings: () => siblings.map((s) => ({ machineId: s.id, nickname: s.nick })),
      observe: send,
      request: send,
      verifySig,
      ownEncryptionPrivateKeyPem: () => self.enc.privateKey,
      onInstalled: () => undefined,
      raiseItem: (i) => items.push(i),
      resolveItem: (id) => resolved.push(id),
      audit: new AgentIdentityAudit(self.stateDir),
      requestIntervalMs: 0,
      escalateAfterRefusals: 1,
      escalateAfterMs: 0,
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-mesh-'));
    machines.clear();
  });
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/agent-identity-adoption-mesh.test.ts' });
  });

  it('B boots with no identity, observes A over the signed mesh, adopts, and holds the SAME key (two witnesses, no local memory)', async () => {
    const a = machine('m_a', 'mini');
    const c = machine('m_c', 'laptop');
    const b = machine('m_b', 'studio');
    const kp = generateIdentityKeyPair();
    const idA = writeIdentity(a.stateDir, kp);
    writeIdentity(c.stateDir, kp);
    await boot(a); await boot(c); await boot(b);
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    const items: AdoptionAttentionItem[] = [];
    const resolved: string[] = [];
    const loop = loopOn(b, [a, c], items, resolved);
    const d = await loop.runOnce();
    expect(d).toMatchObject({ ok: true, mode: 'two-witnesses', fingerprint: idA.fingerprint });
    const now = readAgentIdentityOnDisk(b.stateDir)!;
    expect(now.fingerprint).toBe(idA.fingerprint);
    expect(now.privateKey.equals(idA.privateKey)).toBe(true);
    expect(items.map((i) => i.id)).toEqual([`agent-identity-adopted:echo:m_b:${idA.fingerprint}`]);
    expect(resolved).toContain(loop.itemId);
    // Both sides audited; neither carries key bytes.
    for (const m of [a, b]) {
      const audit = fs.readFileSync(path.join(m.stateDir, 'logs', 'agent-identity.jsonl'), 'utf-8');
      expect(audit).not.toContain(idA.privateKey.toString('base64'));
      expect(audit).toContain(idA.fingerprint);
    }
    expect(fs.readFileSync(path.join(a.stateDir, 'logs', 'agent-identity.jsonl'), 'utf-8')).toContain('identity-served');
  });

  it('a stub peer publishing a DIFFERENT fingerprint → B refuses `disagree` and the item names both; nothing is written', async () => {
    const a = machine('m_a', 'mini');
    const c = machine('m_c', 'laptop');
    const b = machine('m_b', 'studio');
    const idA = writeIdentity(a.stateDir);
    const idC = writeIdentity(c.stateDir);
    await boot(a); await boot(c); await boot(b);
    const items: AdoptionAttentionItem[] = [];
    const loop = loopOn(b, [a, c], items, []);
    expect(await loop.runOnce()).toMatchObject({ ok: false, reason: 'disagree' });
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    const item = items.find((i) => i.id === loop.itemId)!;
    expect(item.priority).toBe('high');
    expect(item.body).toContain(idA.fingerprint.slice(0, 8));
    expect(item.body).toContain(idC.fingerprint.slice(0, 8));
  });

  it('a forged answer (a peer signing with a key the registry does not pin) is ignored as unreachable', async () => {
    const a = machine('m_a', 'mini');
    const b = machine('m_b', 'studio');
    const idA = writeIdentity(a.stateDir);
    await boot(a); await boot(b);
    // The forger: a machine whose registry signing key differs from the key it signs with.
    a.signing = { ...a.signing, publicKey: generateSigningKeyPair().publicKey };
    const items: AdoptionAttentionItem[] = [];
    const loop = loopOn(b, [a], items, []);
    const d = await loop.runOnce();
    expect(d).toMatchObject({ ok: false, reason: 'cannot-tell' });
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    expect(idA.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the verbs are registered-peer class: a stranger\'s signed envelope is refused before any handler runs', async () => {
    const a = machine('m_a', 'mini');
    writeIdentity(a.stateDir);
    await boot(a);
    const stranger = { id: 'm_stranger', signing: generateSigningKeyPair() };
    let n = 0;
    const client = new MeshRpcClient({ selfMachineId: stranger.id, sign: (c) => sign(c, stranger.signing.privateKey), nonce: () => `s:${++n}` });
    const r = await client.send({ machineId: 'm_a', url: a.server!.url }, { type: 'agent-identity-request', agentName: AGENT, expectedFingerprint: 'ab'.repeat(16), requesterNonce: 'x' }, 0);
    expect(r.ok).toBe(false);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(path.join(a.stateDir, 'logs', 'agent-identity.jsonl'))).toBe(false); // the handler never ran
  });

  it('the void-check over the real wire: a requester that PUBLISHES an identity is refused requester-publishes-identity', async () => {
    const a = machine('m_a', 'mini');
    const b = machine('m_b', 'studio');
    const idA = writeIdentity(a.stateDir);
    writeIdentity(b.stateDir); // B already has one
    await boot(a); await boot(b);
    let n = 0;
    const client = new MeshRpcClient({ selfMachineId: b.id, sign: (c) => sign(c, b.signing.privateKey), nonce: () => `b:${++n}` });
    const r = await client.send({ machineId: 'm_a', url: a.server!.url }, { type: 'agent-identity-request', agentName: AGENT, expectedFingerprint: idA.fingerprint, requesterNonce: 'rn' }, 0, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ ok: false, refusal: 'requester-publishes-identity' });
  });
});
