/**
 * ASP public-key directory.
 *
 * The properties that matter: peers become verifiable, self is never displaced
 * by a peer file, and everything unknown or malformed fails CLOSED (null →
 * `unknown-agent` → rejection).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AspKeyDirectory } from '../../src/core/AspKeyDirectory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { signMessage, verifyMessage } from '../../src/core/agentSignatureProvenance.js';

let dir: string;

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32),
  };
}

function writeSelf(pub: Buffer) {
  fs.writeFileSync(
    path.join(dir, 'identity.json'),
    JSON.stringify({ version: 1, publicKey: pub.toString('base64'), privateKeyEncryption: 'none' })
  );
}

function writePeers(peers: Array<{ name: string; publicKey?: string }>) {
  fs.mkdirSync(path.join(dir, 'threadline'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'threadline', 'known-agents.json'),
    JSON.stringify({ agents: peers, updatedAt: new Date().toISOString() })
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-keys-'));
});
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/asp-key-directory.test.ts' }));

describe('AspKeyDirectory — resolution', () => {
  it('resolves self from identity.json with trust "self"', () => {
    const me = keypair();
    writeSelf(me.publicKey);
    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });
    const r = d.resolve('echo');
    expect(r?.trust).toBe('self');
    expect(r?.publicKey.equals(me.publicKey)).toBe(true);
  });

  it('resolves a peer from known-agents.json (hex form) with trust "discovery"', () => {
    const me = keypair(); const codey = keypair();
    writeSelf(me.publicKey);
    writePeers([{ name: 'codey', publicKey: codey.publicKey.toString('hex') }]);

    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });
    const r = d.resolve('codey');
    expect(r?.trust).toBe('discovery');
    expect(r?.publicKey.equals(codey.publicKey)).toBe(true);
  });

  it('a peer file claiming OUR name cannot displace our own identity', () => {
    // Otherwise anyone who can write the discovery cache could impersonate us
    // to our own verifier.
    const me = keypair(); const impostor = keypair();
    writeSelf(me.publicKey);
    writePeers([{ name: 'echo', publicKey: impostor.publicKey.toString('hex') }]);

    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });
    const r = d.resolve('echo');
    expect(r?.trust).toBe('self');
    expect(r?.publicKey.equals(me.publicKey)).toBe(true);
    expect(r?.publicKey.equals(impostor.publicKey)).toBe(false);
  });
});

describe('AspKeyDirectory — fails closed', () => {
  it('unknown agent resolves to null', () => {
    writeSelf(keypair().publicKey);
    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });
    expect(d.resolve('nobody')).toBeNull();
    expect(d.resolver()('nobody')).toBeNull();
  });

  it('malformed or wrong-length keys are dropped, not coerced', () => {
    writeSelf(keypair().publicKey);
    writePeers([
      { name: 'short', publicKey: 'abcd' },
      { name: 'notkey', publicKey: 'zzzz' },
      { name: 'missing' },
    ]);
    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });
    for (const n of ['short', 'notkey', 'missing']) expect(d.resolve(n)).toBeNull();
    // CONTROL: a well-formed peer in the same file still resolves, so the nulls
    // above are per-entry rejections rather than a dead loader.
    const ok = keypair();
    writePeers([
      { name: 'short', publicKey: 'abcd' },
      { name: 'good', publicKey: ok.publicKey.toString('hex') },
    ]);
    d.invalidate();
    expect(d.resolve('good')?.publicKey.equals(ok.publicKey)).toBe(true);
    expect(d.resolve('short')).toBeNull();
  });

  it('a missing or corrupt peer file degrades to fewer agents, never to trust', () => {
    writeSelf(keypair().publicKey);
    fs.mkdirSync(path.join(dir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'threadline', 'known-agents.json'), '{broken');
    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });
    expect(d.resolve('codey')).toBeNull();
    expect(d.resolve('echo')?.trust).toBe('self'); // self still works
  });

  it('empty agent id resolves to null', () => {
    writeSelf(keypair().publicKey);
    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });
    expect(d.resolve('')).toBeNull();
  });
});

describe('AspKeyDirectory — end to end with the verifier', () => {
  it('a peer-signed message now verifies as that PEER, not as us', () => {
    const me = keypair(); const codey = keypair();
    writeSelf(me.publicKey);
    writePeers([{ name: 'codey', publicKey: codey.publicKey.toString('hex') }]);
    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });

    const { text } = signMessage({
      agentId: 'codey', topicId: 29723, body: 'from codey', privateKey: codey.privateKey,
    });
    const v = verifyMessage({ raw: text, expectedTopicId: 29723, resolvePublicKey: d.resolver() });

    expect(v.classification).toBe('agent-verified');
    if (v.classification !== 'agent-verified') throw new Error('unreachable');
    expect(v.agentId).toBe('codey');
  });

  it('a peer signing under ANOTHER peer name is still rejected', () => {
    // The directory widens WHO can be verified; it must not weaken WHAT is checked.
    const me = keypair(); const codey = keypair(); const bob = keypair();
    writeSelf(me.publicKey);
    writePeers([
      { name: 'codey', publicKey: codey.publicKey.toString('hex') },
      { name: 'bob', publicKey: bob.publicKey.toString('hex') },
    ]);
    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });

    // bob's key, codey's name.
    const { text } = signMessage({
      agentId: 'codey', topicId: 29723, body: 'impersonation', privateKey: bob.privateKey,
    });
    const v = verifyMessage({ raw: text, expectedTopicId: 29723, resolvePublicKey: d.resolver() });
    expect(v.classification).toBe('rejected');
    expect(v.classification === 'rejected' && v.reason).toBe('bad-signature');
  });

  it('list() exposes fingerprints and trust, never key material beyond the public prefix', () => {
    const me = keypair(); const codey = keypair();
    writeSelf(me.publicKey);
    writePeers([{ name: 'codey', publicKey: codey.publicKey.toString('hex') }]);
    const d = new AspKeyDirectory({ stateDir: dir, selfAgentId: 'echo' });

    const listed = d.list();
    expect(listed.map((l) => l.agentId).sort()).toEqual(['codey', 'echo']);
    expect(listed.find((l) => l.agentId === 'echo')?.trust).toBe('self');
    expect(listed.find((l) => l.agentId === 'codey')?.trust).toBe('discovery');
    for (const l of listed) expect(l.fingerprint).toHaveLength(16);
  });
});
