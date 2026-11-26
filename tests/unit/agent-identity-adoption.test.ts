// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * AC2 (a2a-single-agent-identity §1.2–§1.3): an identity-less paired machine adopts the
 * `reachable-agree` identity over SIGNED responses — one witness with local memory adopts
 * (including across a server restart in the unprovisioned posture), one witness without
 * memory refuses `single-witness`, two witnesses without memory adopt, and a disagreement,
 * forged answer, keypair mismatch or last-known mismatch refuses with the named reason.
 * Real keys throughout — never opaque strings. Audit rows never carry key bytes.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentIdentityServer,
  AgentIdentityAdoptionLoop,
  canonicalObserve,
  decideAdoption,
  identityLeaseEligible,
  installAdoptedIdentity,
  openAdoptionEnvelope,
  readAgentIdentityOnDisk,
  readAgentIdentityPosture,
  sealAgentIdentity,
  openSealedAgentIdentity,
  verifyObserveResponse,
  type AdoptionObservation,
  type AdoptionAttentionItem,
  type ObserveResponse,
  type RequestResponse,
} from '../../src/core/AgentIdentityAdoption.js';
import { AgentIdentityAudit, findKeyMaterial } from '../../src/core/AgentIdentityAudit.js';
import { fingerprintOf } from '../../src/core/AgentIdentityHandover.js';
import { generateSigningKeyPair, generateEncryptionKeyPair, pemToBase64, sign, verify } from '../../src/core/MachineIdentity.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const rm = (d: string) => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/agent-identity-adoption.test.ts' });

interface Machine {
  id: string;
  nick: string;
  stateDir: string;
  signing: { publicKey: string; privateKey: string };
  enc: { publicKey: string; privateKey: string };
}

function machine(id: string, nick = id): Machine {
  return {
    id,
    nick,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), `adopt-${id}-`)),
    signing: generateSigningKeyPair(),
    enc: generateEncryptionKeyPair(),
  };
}

function writeAgentIdentity(stateDir: string, kp = generateIdentityKeyPair()): { fingerprint: string; publicKey: Buffer; privateKey: Buffer } {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({ version: 1, publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'), privateKeyEncryption: 'none', createdAt: '2026-05-01T00:00:00.000Z' }), { mode: 0o600 });
  return { fingerprint: computeFingerprint(kp.publicKey), publicKey: kp.publicKey, privateKey: kp.privateKey };
}

function writeLastKnown(stateDir: string, fingerprint: string): void {
  fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'threadline', 'agent-info.json'), JSON.stringify({ name: 'echo', fingerprint }));
}

/** A fleet: machines keyed by id, with a registry-style key lookup and signed-RPC fakes. */
class Fleet {
  readonly machines = new Map<string, Machine>();
  readonly servers = new Map<string, AgentIdentityServer>();
  readonly audits = new Map<string, AgentIdentityAudit>();
  /** Per-machine tamper hook: rewrite a machine's raw observe answer (forgery simulation). */
  readonly tamper = new Map<string, (r: ObserveResponse) => unknown>();
  constructor(readonly agentName = 'echo') {}

  add(m: Machine): Machine {
    this.machines.set(m.id, m);
    const audit = new AgentIdentityAudit(m.stateDir);
    this.audits.set(m.id, audit);
    this.servers.set(
      m.id,
      new AgentIdentityServer({
        stateDir: m.stateDir,
        agentName: this.agentName,
        selfMachineId: m.id,
        sign: (c) => sign(c, m.signing.privateKey),
        isMachineActive: (id) => this.machines.has(id),
        registryEncryptionPublicKey: (id) => (this.machines.get(id) ? pemToBase64(this.machines.get(id)!.enc.publicKey) : null),
        observeRequester: async (id) => {
          const s = this.servers.get(id);
          return s ? s.observe({ type: 'agent-identity-observe', agentName: this.agentName, requesterNonce: 'void-check' }, m.id) : null;
        },
        audit,
      }),
    );
    return m;
  }

  verifySig = (machineId: string, canonical: string, sig: string): boolean => {
    const m = this.machines.get(machineId);
    return !!m && verify(canonical, sig, m.signing.publicKey);
  };

  loop(self: Machine, opts: { enabled?: boolean; items?: AdoptionAttentionItem[]; resolved?: string[]; now?: () => number; siblings?: string[]; revoked?: number; onInstalled?: (fp: string) => void } = {}): AgentIdentityAdoptionLoop {
    const items = opts.items ?? [];
    const resolved = opts.resolved ?? [];
    return new AgentIdentityAdoptionLoop({
      stateDir: self.stateDir,
      agentName: this.agentName,
      selfMachineId: self.id,
      enabled: () => opts.enabled ?? true,
      listActiveSiblings: () => (opts.siblings ?? [...this.machines.keys()]).filter((id) => id !== self.id).map((id) => ({ machineId: id, nickname: this.machines.get(id)?.nick ?? id })),
      revokedSiblingCount: () => opts.revoked ?? 0,
      observe: async (sib, cmd) => {
        const s = this.servers.get(sib.machineId);
        if (!s) return { ok: false, reason: 'transport' };
        const raw = s.observe(cmd, self.id);
        const t = this.tamper.get(sib.machineId);
        return { ok: true, result: t ? t(raw) : raw };
      },
      request: async (sib, cmd) => {
        const s = this.servers.get(sib.machineId);
        if (!s) return { ok: false, reason: 'no-handler' };
        return { ok: true, result: await s.request(cmd, self.id) };
      },
      verifySig: this.verifySig,
      ownEncryptionPrivateKeyPem: () => self.enc.privateKey,
      onInstalled: (fp) => opts.onInstalled?.(fp),
      raiseItem: (i) => items.push(i),
      resolveItem: (id) => resolved.push(id),
      audit: this.audits.get(self.id),
      now: opts.now,
      requestIntervalMs: 0,
      escalateAfterRefusals: 1,
      escalateAfterMs: 0,
    });
  }
}

describe('§1.2 observe — answered from DISK, signed, never from the cache', () => {
  it('a provisioned sibling answers its on-disk fingerprint, signed by its machine key; a moved-aside file reads not-provisioned at once', () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const id = writeAgentIdentity(a.stateDir);
    const srv = fleet.servers.get('m_a')!;
    const r1 = srv.observe({ type: 'agent-identity-observe', agentName: 'echo', requesterNonce: 'n1' }, 'm_b');
    expect(r1).toMatchObject({ state: 'provisioned', fingerprint: id.fingerprint, requesterNonce: 'n1', responderMachineId: 'm_a' });
    expect(verify(canonicalObserve({ fingerprint: r1.fingerprint, state: r1.state, requesterNonce: 'n1', responderMachineId: 'm_a' }), r1.sig, a.signing.publicKey)).toBe(true);
    fs.renameSync(path.join(a.stateDir, 'identity.json'), path.join(a.stateDir, 'identity.json.superseded-x'));
    const r2 = srv.observe({ type: 'agent-identity-observe', agentName: 'echo', requesterNonce: 'n2' }, 'm_b');
    expect(r2).toMatchObject({ state: 'not-provisioned', fingerprint: null });
    rm(a.stateDir);
  });

  it('verifyObserveResponse: a forged, mis-nonced or malformed answer is `unreachable` — never agreement or disagreement', () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    writeAgentIdentity(a.stateDir);
    const ok = fleet.servers.get('m_a')!.observe({ type: 'agent-identity-observe', agentName: 'echo', requesterNonce: 'n' }, 'm_b');
    expect(verifyObserveResponse(ok, { machineId: 'm_a', requesterNonce: 'n' }, fleet.verifySig).state).toBe('provisioned');
    expect(verifyObserveResponse({ ...ok, fingerprint: 'ff'.repeat(16) }, { machineId: 'm_a', requesterNonce: 'n' }, fleet.verifySig)).toMatchObject({ state: 'unreachable', reason: 'bad-signature' });
    expect(verifyObserveResponse(ok, { machineId: 'm_a', requesterNonce: 'other' }, fleet.verifySig)).toMatchObject({ state: 'unreachable', reason: 'nonce-mismatch' });
    expect(verifyObserveResponse({ hello: 1 }, { machineId: 'm_a', requesterNonce: 'n' }, fleet.verifySig)).toMatchObject({ state: 'unreachable', reason: 'malformed' });
    rm(a.stateDir);
  });
});

describe('§1.2 request — typed, SIGNED serving refusals; an AAD-bound sealed grant', () => {
  async function setup() {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    const id = writeAgentIdentity(a.stateDir);
    return { fleet, a, b, id, srv: fleet.servers.get('m_a')! };
  }
  const req = (fp: string, nonce = 'rn') => ({ type: 'agent-identity-request' as const, agentName: 'echo', expectedFingerprint: fp, requesterNonce: nonce });

  it('serves a grant whose sealed key hashes to the published value and opens ONLY under the requester\'s AAD', async () => {
    const { fleet, a, b, id, srv } = await setup();
    const r = await srv.request(req(id.fingerprint), 'm_b');
    expect(r.ok).toBe(true);
    const opened = openAdoptionEnvelope({ response: r, responderMachineId: 'm_a', selfMachineId: 'm_b', expectedFingerprint: id.fingerprint, requesterNonce: 'rn', ownEncryptionPrivateKeyPem: b.enc.privateKey, verifySig: fleet.verifySig });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.identity.publicKey.equals(id.publicKey)).toBe(true);
      expect(opened.identity.privateKey.equals(id.privateKey)).toBe(true);
      expect(opened.adoptedFrom.machineId).toBe('m_a');
    }
    // The same grant replayed as a DIFFERENT requester cannot be opened (AAD binds the requester id).
    const replay = openAdoptionEnvelope({ response: r, responderMachineId: 'm_a', selfMachineId: 'm_c', expectedFingerprint: id.fingerprint, requesterNonce: 'rn', ownEncryptionPrivateKeyPem: b.enc.privateKey, verifySig: fleet.verifySig });
    expect(replay).toMatchObject({ ok: false, rejection: 'undecryptable' });
    rm(a.stateDir); rm(b.stateDir);
  });

  it('the sealing primitive is domain-separated from secret-sync and fails CLOSED on an AAD mismatch', () => {
    const b = machine('m_b');
    const payload = { identity: { publicKey: 'x', privateKey: 'y', createdAt: 'z' } };
    const aad = { verb: 'agent-identity-request' as const, requesterMachineId: 'm_b', requesterNonce: 'n', fingerprint: 'ab'.repeat(16) };
    const sealed = sealAgentIdentity(payload, pemToBase64(b.enc.publicKey), aad);
    const priv = crypto.createPrivateKey(b.enc.privateKey);
    expect(openSealedAgentIdentity(sealed, priv, aad)).toEqual(payload);
    expect(() => openSealedAgentIdentity(sealed, priv, { ...aad, requesterNonce: 'other' })).toThrow(/AAD mismatch/);
    expect(() => openSealedAgentIdentity({ ...sealed, aad: { ...aad, requesterNonce: 'other' } }, priv, { ...aad, requesterNonce: 'other' })).toThrow(); // GCM tag fails: the AAD was authenticated at seal time
    rm(b.stateDir);
  });

  it('every serving refusal is named and SIGNED; a tampered refusal counts as unreachable', async () => {
    const { fleet, a, b, id, srv } = await setup();
    const open = (r: RequestResponse, nonce = 'rn') => openAdoptionEnvelope({ response: r, responderMachineId: 'm_a', selfMachineId: 'm_b', expectedFingerprint: id.fingerprint, requesterNonce: nonce, ownEncryptionPrivateKeyPem: b.enc.privateKey, verifySig: fleet.verifySig });

    expect(open(await srv.request({ ...req(id.fingerprint), agentName: 'other' }, 'm_b'))).toMatchObject({ ok: false, rejection: 'refused', refusal: 'agent-mismatch' });
    expect(open(await srv.request(req(id.fingerprint), 'm_stranger'))).toMatchObject({ ok: false, rejection: 'refused', refusal: 'not-registered' });
    expect(open(await srv.request(req('00'.repeat(16)), 'm_b'))).toMatchObject({ ok: false, rejection: 'refused', refusal: 'fingerprint-mismatch' });
    // The void-check: a requester that PUBLISHES an identity is refused.
    writeAgentIdentity(b.stateDir);
    expect(open(await srv.request(req(id.fingerprint), 'm_b'))).toMatchObject({ ok: false, rejection: 'refused', refusal: 'requester-publishes-identity' });
    fs.renameSync(path.join(b.stateDir, 'identity.json'), path.join(b.stateDir, 'identity.json.superseded-test'));
    // A real grant, then rate-limited (one share per requester per interval, retryAfterMs carried).
    expect((await srv.request(req(id.fingerprint), 'm_b')).ok).toBe(true);
    const limited = await srv.request(req(id.fingerprint), 'm_b');
    expect(open(limited)).toMatchObject({ ok: false, rejection: 'refused', refusal: 'rate-limited' });
    expect(typeof (limited as { retryAfterMs?: number }).retryAfterMs).toBe('number');
    // Tampered refusal (a LAN peer rewriting the reason) → unreachable, never a steering refusal.
    expect(open({ ...(limited as object), refusal: 'no-usable-identity' } as RequestResponse)).toMatchObject({ ok: false, rejection: 'unreachable' });
    expect(open({ ok: false, refusal: 'no-usable-identity' } as unknown as RequestResponse)).toMatchObject({ ok: false, rejection: 'unreachable' });
    // No usable identity on the server.
    fs.renameSync(path.join(a.stateDir, 'identity.json'), path.join(a.stateDir, 'identity.json.superseded-test'));
    const c = fleet.add(machine('m_c'));
    expect(open(await srv.request(req(id.fingerprint), 'm_c'))).toMatchObject({ ok: false, rejection: 'refused', refusal: 'no-usable-identity' });
    rm(a.stateDir); rm(b.stateDir); rm(c.stateDir);
  });

  it('a grant whose sealed key does not hash to the value, or carries a mismatched keypair, is rejected before anything is written', async () => {
    const { fleet, a, b, id } = await setup();
    const good = await fleet.servers.get('m_a')!.request(req(id.fingerprint), 'm_b');
    expect(good.ok).toBe(true);
    // Forge: re-sign a grant for a different fingerprint with a key the requester does not pin.
    const other = generateSigningKeyPair();
    fleet.machines.get('m_a')!.signing = other; // the pin no longer matches the signer
    expect(openAdoptionEnvelope({ response: good, responderMachineId: 'm_a', selfMachineId: 'm_b', expectedFingerprint: id.fingerprint, requesterNonce: 'rn', ownEncryptionPrivateKeyPem: b.enc.privateKey, verifySig: fleet.verifySig })).toMatchObject({ ok: false, rejection: 'bad-signature' });
    rm(a.stateDir); rm(b.stateDir);
  });
});

describe('§1.3 decideAdoption — reachable-agree, pinned by local memory, else refuse', () => {
  const FP1 = 'aa'.repeat(16);
  const FP2 = 'bb'.repeat(16);
  const w = (machineId: string, fingerprint: string | null, state: AdoptionObservation['state'] = 'provisioned'): AdoptionObservation => ({ machineId, state, fingerprint });

  it('one witness WITH memory adopts (one-witness+pin); without memory refuses single-witness; two without memory adopt', () => {
    expect(decideAdoption({ observations: [w('a', FP1)], lastKnownFingerprint: FP1 })).toMatchObject({ ok: true, fingerprint: FP1, mode: 'one-witness+pin' });
    expect(decideAdoption({ observations: [w('a', FP1)], lastKnownFingerprint: null })).toMatchObject({ ok: false, reason: 'single-witness' });
    expect(decideAdoption({ observations: [w('a', FP1), w('b', FP1)], lastKnownFingerprint: null })).toMatchObject({ ok: true, mode: 'two-witnesses', witnesses: ['a', 'b'] });
  });

  it('a disagreement refuses; a not-provisioned responder is excluded, never counted as disagreement; an unreachable sibling does not block', () => {
    expect(decideAdoption({ observations: [w('a', FP1), w('b', FP2)], lastKnownFingerprint: FP1 })).toMatchObject({ ok: false, reason: 'disagree' });
    expect(decideAdoption({ observations: [w('a', FP1), w('b', FP1), w('c', null, 'not-provisioned')], lastKnownFingerprint: null })).toMatchObject({ ok: true, observed: { k: 3, n: 3 } });
    expect(decideAdoption({ observations: [w('a', FP1), w('b', FP1), w('laptop', null, 'unreachable')], lastKnownFingerprint: null })).toMatchObject({ ok: true, observed: { k: 2, n: 3 } });
  });

  it('last-known mismatch refuses and names both values; revoked-only names the standalone case; nobody reachable is cannot-tell', () => {
    const d = decideAdoption({ observations: [w('a', FP2)], lastKnownFingerprint: FP1 });
    expect(d).toMatchObject({ ok: false, reason: 'last-known-mismatch' });
    if (!d.ok) expect(d.detail).toContain(FP1) && expect(d.detail).toContain(FP2);
    expect(decideAdoption({ observations: [], lastKnownFingerprint: null, revokedCount: 2 })).toMatchObject({ ok: false, reason: 'revoked-only' });
    expect(decideAdoption({ observations: [w('a', null, 'unreachable')], lastKnownFingerprint: FP1 })).toMatchObject({ ok: false, reason: 'cannot-tell' });
  });
});

describe('§1.2 install — a VOID-fill only, under the lock', () => {
  it('fills a void; refuses a present different identity; a second install of the same key is a no-op; a present-but-invalid file is never written over', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
    const kp = generateIdentityKeyPair();
    const r1 = installAdoptedIdentity({ stateDir: d, identity: { publicKey: kp.publicKey, privateKey: kp.privateKey, createdAt: '' }, origin: 'adopted-from-sibling', selfMachineId: 'm', adoptedFrom: { machineId: 'a', at: 'x' } });
    expect(r1).toMatchObject({ ok: true, alreadyPresent: false, fingerprint: computeFingerprint(kp.publicKey) });
    const stat = fs.statSync(path.join(d, 'identity.json'));
    expect(stat.mode & 0o077).toBe(0);
    const file = JSON.parse(fs.readFileSync(path.join(d, 'identity.json'), 'utf-8')) as { provenance: { origin: string; adoptedFrom: { machineId: string } } };
    expect(file.provenance).toMatchObject({ origin: 'adopted-from-sibling', adoptedFrom: { machineId: 'a' } });
    expect(installAdoptedIdentity({ stateDir: d, identity: { publicKey: kp.publicKey, privateKey: kp.privateKey, createdAt: '' }, origin: 'adopted-from-sibling', selfMachineId: 'm', adoptedFrom: null })).toMatchObject({ ok: true, alreadyPresent: true });
    const other = generateIdentityKeyPair();
    expect(installAdoptedIdentity({ stateDir: d, identity: { publicKey: other.publicKey, privateKey: other.privateKey, createdAt: '' }, origin: 'adopted-from-sibling', selfMachineId: 'm', adoptedFrom: null })).toMatchObject({ ok: false, reason: 'identity-present' });
    fs.writeFileSync(path.join(d, 'identity.json'), '{ garbage');
    expect(readAgentIdentityPosture(d)).toMatchObject({ state: 'invalid' });
    expect(installAdoptedIdentity({ stateDir: d, identity: { publicKey: other.publicKey, privateKey: other.privateKey, createdAt: '' }, origin: 'adopted-from-sibling', selfMachineId: 'm', adoptedFrom: null })).toMatchObject({ ok: false, reason: 'identity-present' });
    expect(fs.readFileSync(path.join(d, 'identity.json'), 'utf-8')).toBe('{ garbage');
    rm(d);
  });
});

describe('§1.2 the adoption loop — end to end over signed fakes', () => {
  it('one witness + local memory adopts, installs the SAME key, resolves the missing item, raises the adopted item, runs the reload lever', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a', 'mini'));
    const b = fleet.add(machine('m_b', 'studio'));
    const id = writeAgentIdentity(a.stateDir);
    writeLastKnown(b.stateDir, id.fingerprint);
    const items: AdoptionAttentionItem[] = [];
    const resolved: string[] = [];
    let reloaded: string | null = null;
    const loop = fleet.loop(b, { items, resolved, onInstalled: (fp) => { reloaded = fp; } });
    const d = await loop.runOnce();
    expect(d).toMatchObject({ ok: true, mode: 'one-witness+pin' });
    const onDisk = readAgentIdentityOnDisk(b.stateDir);
    expect(onDisk?.fingerprint).toBe(id.fingerprint);
    expect(onDisk?.privateKey.equals(id.privateKey)).toBe(true);
    expect(reloaded).toBe(id.fingerprint);
    expect(resolved).toContain(loop.itemId);
    expect(items.map((i) => i.id)).toContain(`agent-identity-adopted:echo:m_b:${id.fingerprint}`);
    expect(items[0].body).toMatch(/proves agreement among the machines I could reach, not correctness/);
    expect(loop.status()).toMatchObject({ provisioned: true, installedFingerprint: id.fingerprint });
    rm(a.stateDir); rm(b.stateDir);
  });

  it('the local memory survives a server restart in the unprovisioned posture: a FRESH loop on the same dir still adopts on one witness', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    const id = writeAgentIdentity(a.stateDir);
    writeLastKnown(b.stateDir, id.fingerprint);
    // First boot: the sibling is unreachable (asleep) → cannot-tell, nothing written.
    const first = fleet.loop(b, { siblings: [] });
    expect(await first.runOnce()).toMatchObject({ ok: false, reason: 'cannot-tell' });
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(b.stateDir, 'threadline', 'agent-info.json'), 'utf-8')).fingerprint).toBe(id.fingerprint);
    // "Restart": a new loop instance over the same disk.
    const second = fleet.loop(b);
    expect(await second.runOnce()).toMatchObject({ ok: true, mode: 'one-witness+pin' });
    expect(readAgentIdentityOnDisk(b.stateDir)?.fingerprint).toBe(id.fingerprint);
    rm(a.stateDir); rm(b.stateDir);
  });

  it('one witness WITHOUT memory refuses single-witness and the item names it; two witnesses adopt', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a', 'mini'));
    const b = fleet.add(machine('m_b', 'studio'));
    const id = writeAgentIdentity(a.stateDir);
    const items: AdoptionAttentionItem[] = [];
    const loop = fleet.loop(b, { items });
    expect(await loop.runOnce()).toMatchObject({ ok: false, reason: 'single-witness' });
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    expect(items.some((i) => i.id === loop.itemId && /single-witness/.test(i.body) && /1 of 1 active/.test(i.body))).toBe(true);
    // A second witness wakes up.
    const c = fleet.add(machine('m_c', 'laptop'));
    writeAgentIdentity(c.stateDir, { publicKey: id.publicKey, privateKey: id.privateKey });
    expect(await loop.runOnce()).toMatchObject({ ok: true, mode: 'two-witnesses' });
    expect(readAgentIdentityOnDisk(b.stateDir)?.fingerprint).toBe(id.fingerprint);
    rm(a.stateDir); rm(b.stateDir); rm(c.stateDir);
  });

  it('a disagreement, a forged answer and a last-known mismatch each refuse with the named reason; the last-known item names the adopt-from-a-sibling path', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a', 'mini'));
    const c = fleet.add(machine('m_c', 'laptop'));
    const b = fleet.add(machine('m_b', 'studio'));
    const idA = writeAgentIdentity(a.stateDir);
    writeAgentIdentity(c.stateDir); // a different key → disagreement
    const items: AdoptionAttentionItem[] = [];
    const loop = fleet.loop(b, { items });
    expect(await loop.runOnce()).toMatchObject({ ok: false, reason: 'disagree' });
    expect(items.at(-1)?.body).toMatch(/publish different identities/);
    // Forge the laptop's answer: it now "claims" mini's value but the signature is over its own.
    fleet.tamper.set('m_c', (r) => ({ ...r, fingerprint: idA.fingerprint }));
    const forged = await loop.runOnce();
    // The forged answer is unreachable, so only mini remains: single witness, no memory.
    expect(forged).toMatchObject({ ok: false, reason: 'single-witness' });
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    // Last-known mismatch: this machine remembers a value nobody publishes.
    fleet.tamper.delete('m_c');
    fleet.machines.delete('m_c');
    writeLastKnown(b.stateDir, 'cd'.repeat(16));
    const mismatch = await loop.runOnce();
    expect(mismatch).toMatchObject({ ok: false, reason: 'last-known-mismatch' });
    const item = items.at(-1)!;
    expect(item.id).toBe(loop.itemId);
    expect(item.body).toMatch(/own memory .* disagrees with what its siblings publish/);
    expect(item.body).toMatch(/instar identity adopt --from <sibling>/);
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    rm(a.stateDir); rm(b.stateDir); rm(c.stateDir);
  });

  it('a present-but-invalid file refuses `identity-file-invalid` every round, never writes, and names the CLI lever', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    const id = writeAgentIdentity(a.stateDir);
    writeLastKnown(b.stateDir, id.fingerprint);
    fs.writeFileSync(path.join(b.stateDir, 'identity.json'), JSON.stringify({ publicKey: 'nope' }));
    const items: AdoptionAttentionItem[] = [];
    const loop = fleet.loop(b, { items });
    expect(await loop.runOnce()).toBeNull();
    expect(loop.status().lastRefusal).toBe('identity-file-invalid');
    expect(fs.readFileSync(path.join(b.stateDir, 'identity.json'), 'utf-8')).toBe(JSON.stringify({ publicKey: 'nope' }));
    expect(items.at(-1)?.body).toMatch(/instar identity adopt --from <sibling>/);
    rm(a.stateDir); rm(b.stateDir);
  });

  it('the kill switch: adoption disabled → no request, no install, one item naming the switch — but it STILL observes (the lease rule reads it)', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    const id = writeAgentIdentity(a.stateDir);
    writeLastKnown(b.stateDir, id.fingerprint);
    const items: AdoptionAttentionItem[] = [];
    const loop = fleet.loop(b, { items, enabled: false });
    await loop.runOnce();
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    expect(loop.status().requests).toBe(0);
    expect(items.at(-1)?.body).toMatch(/agentIdentity\.adoption\.enabled:false/);
    // The observation is what makes this machine yield the lease to the provisioned sibling.
    expect(loop.lastObservations).toMatchObject([{ machineId: 'm_a', state: 'provisioned', fingerprint: id.fingerprint }]);
    expect(identityLeaseEligible({ notProvisioned: true, observations: loop.lastObservations, isOnline: () => true })).toBe(false);
    rm(a.stateDir); rm(b.stateDir);
  });

  it('§1.1 lease rule, both sides: yields ONLY to a live provisioned sibling; lone / asleep / unprovisioned-sibling / provisioned-self keep serving', () => {
    const prov = { machineId: 'm_a', state: 'provisioned' as const, fingerprint: 'f'.repeat(32) };
    const noId = { machineId: 'm_c', state: 'not-provisioned' as const, fingerprint: null };
    const dark = { machineId: 'm_d', state: 'unreachable' as const, fingerprint: null };
    const online = (ids: string[]) => (id: string) => ids.includes(id);
    expect(identityLeaseEligible({ notProvisioned: true, observations: [prov], isOnline: online(['m_a']) })).toBe(false); // yield
    expect(identityLeaseEligible({ notProvisioned: true, observations: [], isOnline: online([]) })).toBe(true); // lone machine
    expect(identityLeaseEligible({ notProvisioned: true, observations: [prov], isOnline: online([]) })).toBe(true); // sibling asleep
    expect(identityLeaseEligible({ notProvisioned: true, observations: [prov], isOnline: () => null })).toBe(true); // presence unknown is not "live"
    expect(identityLeaseEligible({ notProvisioned: true, observations: [noId, dark], isOnline: online(['m_c', 'm_d']) })).toBe(true); // nobody holds the identity
    expect(identityLeaseEligible({ notProvisioned: false, observations: [prov], isOnline: online(['m_a']) })).toBe(true); // provisioned self never yields
  });

  it('a round whose deps throw (the corrupt-registry posture) is audited and survived — never an unhandled rejection', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    writeAgentIdentity(a.stateDir);
    const base = fleet.loop(b);
    let calls = 0;
    const loop = new AgentIdentityAdoptionLoop({
      ...(base as unknown as { d: ConstructorParameters<typeof AgentIdentityAdoptionLoop>[0] }).d,
      listActiveSiblings: () => { calls += 1; throw new Error('REGISTRY_CORRUPT: unparseable'); },
    });
    await expect(loop.runOnce()).resolves.toBeNull();
    await expect(loop.runOnce()).resolves.toBeNull();
    expect(calls).toBe(2);
    const rows = fleet.audits.get('m_b')!.read({}).filter((r) => r.event === 'adoption-refused' && (r as { reason?: string }).reason === 'round-error');
    expect(rows).toHaveLength(1); // one row per distinct error, not one per tick
    expect(readAgentIdentityOnDisk(b.stateDir)).toBeNull();
    rm(a.stateDir); rm(b.stateDir);
  });

  it('a machine that booted WITH its identity idles, then re-enters the posture and re-adopts when the file disappears (one counted cycle)', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    const id = writeAgentIdentity(a.stateDir);
    fs.copyFileSync(path.join(a.stateDir, 'identity.json'), path.join(b.stateDir, 'identity.json'));
    writeLastKnown(b.stateDir, id.fingerprint);
    const items: AdoptionAttentionItem[] = [];
    let lost = 0;
    const base = fleet.loop(b, { items });
    const loop = new AgentIdentityAdoptionLoop({
      ...(base as unknown as { d: ConstructorParameters<typeof AgentIdentityAdoptionLoop>[0] }).d,
      onIdentityLost: () => { lost += 1; },
    });
    await loop.runOnce();
    expect(loop.status()).toMatchObject({ provisioned: true, requests: 0 });
    expect(fleet.audits.get('m_b')!.read({}).some((r) => r.event === 'posture-not-provisioned')).toBe(false); // never claimed for a provisioned boot
    fs.renameSync(path.join(b.stateDir, 'identity.json'), path.join(b.stateDir, 'identity.json.gone'));
    // One void sighting is not a loss (`instar identity adopt` leaves the slot empty for a
    // few seconds between move-aside and install): nothing is counted, audited or reloaded.
    await loop.runOnce();
    expect(lost).toBe(0);
    expect(loop.status().adoptLoseCycles24h).toBe(0);
    expect(fleet.audits.get('m_b')!.read({}).some((r) => r.event === 'identity-lost')).toBe(false);
    await loop.runOnce(); // still void → confirmed
    expect(lost).toBe(1);
    expect(loop.status().adoptLoseCycles24h).toBe(1);
    expect(readAgentIdentityOnDisk(b.stateDir)?.fingerprint).toBe(id.fingerprint); // adopted back
    const events = fleet.audits.get('m_b')!.read({}).map((r) => r.event);
    expect(events).toEqual(expect.arrayContaining(['identity-lost', 'posture-not-provisioned', 'adoption-installed']));
    rm(a.stateDir); rm(b.stateDir);
  });

  it('a void that the CLI fills before the next round is never a loss; a file restored by hand after a confirmed loss reloads the process', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    writeAgentIdentity(a.stateDir);
    fs.copyFileSync(path.join(a.stateDir, 'identity.json'), path.join(b.stateDir, 'identity.json'));
    let lost = 0;
    const reloaded: string[] = [];
    const base = fleet.loop(b, { onInstalled: (fp) => { reloaded.push(fp); } });
    const d = (base as unknown as { d: ConstructorParameters<typeof AgentIdentityAdoptionLoop>[0] }).d;
    // Siblings unreachable, so the loop itself can never re-install: any reload below is the
    // externally-restored path.
    const loop = new AgentIdentityAdoptionLoop({ ...d, listActiveSiblings: () => [], onIdentityLost: () => { lost += 1; } });
    const file = path.join(b.stateDir, 'identity.json');
    await loop.runOnce();
    // (1) the CLI window: gone for one round, back before the next.
    fs.renameSync(file, `${file}.aside`);
    await loop.runOnce();
    fs.renameSync(`${file}.aside`, file);
    await loop.runOnce();
    expect(lost).toBe(0);
    expect(reloaded).toEqual([]);
    // (2) a real loss, then the operator restores the backup by hand.
    fs.renameSync(file, `${file}.aside`);
    await loop.runOnce(); await loop.runOnce();
    expect(lost).toBe(1);
    fs.renameSync(`${file}.aside`, file);
    await loop.runOnce();
    expect(reloaded).toHaveLength(1); // the process picks the identity back up without a restart
    await loop.runOnce();
    expect(reloaded).toHaveLength(1); // once
    rm(a.stateDir); rm(b.stateDir);
  });

  it('a machine that BOOTED unprovisioned reloads when the file is placed by hand (no sibling could serve it)', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    writeAgentIdentity(a.stateDir);
    const reloaded: string[] = [];
    const base = fleet.loop(b, { onInstalled: (fp) => { reloaded.push(fp); } });
    const d = (base as unknown as { d: ConstructorParameters<typeof AgentIdentityAdoptionLoop>[0] }).d;
    const loop = new AgentIdentityAdoptionLoop({ ...d, listActiveSiblings: () => [] });
    await loop.runOnce(); // unprovisioned, nobody reachable
    expect(reloaded).toEqual([]);
    fs.copyFileSync(path.join(a.stateDir, 'identity.json'), path.join(b.stateDir, 'identity.json'));
    await loop.runOnce();
    expect(reloaded).toHaveLength(1);
    rm(a.stateDir); rm(b.stateDir);
  });

  it('an unusable identity file still OBSERVES, so the machine yields the lease to a live provisioned sibling', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    const id = writeAgentIdentity(a.stateDir);
    fs.writeFileSync(path.join(b.stateDir, 'identity.json'), '{ not json');
    const loop = fleet.loop(b);
    await loop.runOnce();
    expect(loop.status().lastRefusal).toBe('identity-file-invalid');
    expect(loop.lastObservations).toMatchObject([{ machineId: 'm_a', state: 'provisioned', fingerprint: id.fingerprint }]);
    expect(identityLeaseEligible({ notProvisioned: true, observations: loop.lastObservations, isOnline: () => true })).toBe(false);
    expect(fs.readFileSync(path.join(b.stateDir, 'identity.json'), 'utf-8')).toBe('{ not json'); // never written over
    rm(a.stateDir); rm(b.stateDir);
  });

  it('a rate-limited answer is pacing, not a refusal: audited, honoured, never an operator item', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    const id = writeAgentIdentity(a.stateDir);
    writeLastKnown(b.stateDir, id.fingerprint);
    // First loop adopts (consuming the responder's one share per 10 min) …
    await fleet.loop(b).runOnce();
    fs.renameSync(path.join(b.stateDir, 'identity.json'), path.join(b.stateDir, 'identity.json.gone'));
    // … a restarted requester asks again at once and is told to wait.
    const items: AdoptionAttentionItem[] = [];
    const loop = fleet.loop(b, { items });
    await loop.runOnce();
    expect(loop.status().lastRefusal).toBe('refused:rate-limited');
    expect(items).toEqual([]);
    expect(loop.status().consecutiveFleetRefusals).toBe(0);
    rm(a.stateDir); rm(b.stateDir);
  });

  it('audit rows never contain key bytes (byte-scan of both sides)', async () => {
    const fleet = new Fleet();
    const a = fleet.add(machine('m_a'));
    const b = fleet.add(machine('m_b'));
    const id = writeAgentIdentity(a.stateDir);
    writeLastKnown(b.stateDir, id.fingerprint);
    await fleet.loop(b).runOnce();
    for (const m of [a, b]) {
      const audit = fs.readFileSync(path.join(m.stateDir, 'logs', 'agent-identity.jsonl'), 'utf-8');
      expect(audit.length).toBeGreaterThan(0);
      expect(audit).not.toContain(id.privateKey.toString('base64'));
      expect(audit).not.toContain(id.publicKey.toString('base64'));
      expect(audit).not.toContain(id.privateKey.toString('hex'));
      for (const line of audit.trim().split('\n')) expect(findKeyMaterial(JSON.parse(line))).toBeNull();
      expect(audit).toContain(id.fingerprint); // fingerprints are fine
    }
    expect(fingerprintOf(id.publicKey.toString('base64'))).toBe(id.fingerprint);
    rm(a.stateDir); rm(b.stateDir);
  });
});
