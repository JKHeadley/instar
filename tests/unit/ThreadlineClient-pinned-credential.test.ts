/**
 * Verified pairing v2 — the pinned credential send (spec §3.5 / FD4 v2).
 *
 * A pairing start caches only the peer's Ed25519 identity key, so the real clients never
 * hold an X25519 key for each other (the production-path E2E shows this). A credential is
 * therefore encrypted to the PINNED identity key and the X25519 key derived from it, and
 * the receiver opens it with the key derived from the sender's identity key. Everything
 * else must behave exactly as before: a plaintext envelope from a peer we hold only an
 * identity key for still goes to the unknown-sender path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadlineClient } from '../../src/threadline/client/ThreadlineClient.js';
import { MessageEncryptor, computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { encodePlaintextPayload } from '../../src/threadline/autoAck.js';

function makeAgent() {
  const kp = generateIdentityKeyPair();
  return { pub: kp.publicKey, priv: kp.privateKey, fp: computeFingerprint(kp.publicKey) };
}

type Internals = Record<string, unknown> & { knownAgents: Map<string, unknown>; handleIncomingMessage(e: unknown): void };

function clientFor(self: ReturnType<typeof makeAgent>, sent: unknown[]) {
  const client = new ThreadlineClient({ name: 'T', stateDir: '/tmp/pinned-credential-test' }, () => 1_791_144_650_402);
  const internals = client as unknown as Internals;
  internals.relayClient = { sendMessage: (e: unknown) => sent.push(e), sendAck: () => {} };
  internals.identity = { fingerprint: self.fp, publicKey: self.pub };
  internals.encryptor = new MessageEncryptor(self.priv, self.pub);
  return { client, internals };
}

describe('ThreadlineClient — pinned credential send (FD4 v2)', () => {
  let a: ReturnType<typeof makeAgent>;
  let b: ReturnType<typeof makeAgent>;
  let sent: unknown[];

  beforeEach(() => {
    a = makeAgent();
    b = makeAgent();
    sent = [];
  });

  it('encrypts to the pinned key with no cached X25519 key, and the peer opens it holding only our identity key', () => {
    const { client: ca } = clientFor(a, sent);
    const { client: cb, internals: ib } = clientFor(b, []);
    ib.knownAgents.set(a.fp, { agentId: a.fp, name: 'a', publicKey: a.pub }); // what a pairing start leaves
    const got: Array<{ from: string; content: unknown }> = [];
    const unknown: unknown[] = [];
    cb.on('message', (m: { from: string; content: { content?: unknown } }) => got.push({ from: m.from, content: m.content.content }));
    cb.on('unknown-sender', (e: unknown) => unknown.push(e));

    const { threadId } = ca.sendCredentialToPinned(b.fp, b.pub.toString('hex'), 'the token is 4242');
    expect(threadId).toMatch(/^thread-/);
    ib.handleIncomingMessage(sent[0]);

    expect(got).toEqual([{ from: a.fp, content: 'the token is 4242' }]);
    expect(unknown).toHaveLength(0);
  });

  it('refuses a pinned key that does not belong to the recipient, and sends nothing', () => {
    const { client: ca } = clientFor(a, sent);
    expect(() => ca.sendCredentialToPinned(b.fp, makeAgent().pub.toString('hex'), 'x')).toThrow(/does not match/);
    expect(sent).toHaveLength(0);
  });

  it('a plaintext envelope from a peer we hold only an identity key for still takes the unknown-sender path', () => {
    const { client: cb, internals: ib } = clientFor(b, []);
    ib.knownAgents.set(a.fp, { agentId: a.fp, name: 'a', publicKey: a.pub });
    const got: unknown[] = [];
    const unknown: unknown[] = [];
    cb.on('message', (m: unknown) => got.push(m));
    cb.on('unknown-sender', (e: unknown) => unknown.push(e));
    ib.handleIncomingMessage({
      from: a.fp, to: b.fp, threadId: 'thread-1', messageId: 'm-1',
      payload: encodePlaintextPayload('hello', 'chat', false), timestamp: new Date().toISOString(),
    });
    expect(got).toHaveLength(0);
    expect(unknown).toHaveLength(1);
  });

  it('an envelope encrypted to the derived key but signed by someone else is not delivered', () => {
    const m = makeAgent(); // an impostor who knows b's public key
    const { client: cm } = clientFor(m, sent);
    const { client: cb, internals: ib } = clientFor(b, []);
    ib.knownAgents.set(a.fp, { agentId: a.fp, name: 'a', publicKey: a.pub });
    const got: unknown[] = [];
    cb.on('message', (x: unknown) => got.push(x));
    cm.sendCredentialToPinned(b.fp, b.pub.toString('hex'), 'forged');
    ib.handleIncomingMessage({ ...(sent[0] as object), from: a.fp }); // claims to be a
    expect(got).toHaveLength(0);
  });
});

describe('ThreadlineClient — the pinned key is the authority after a restart (FD4a)', () => {
  it('the receiver opens a credential with an EMPTY cache by asking the pinned-key resolver', () => {
    const a = makeAgent();
    const b = makeAgent();
    const sent: unknown[] = [];
    const { client: ca } = clientFor(a, sent);
    const { client: cb, internals: ib } = clientFor(b, []);
    cb.setPinnedKeyResolver((fp) => (fp === a.fp ? a.pub : null)); // what the trust profile holds
    const got: unknown[] = [];
    const unknown: unknown[] = [];
    cb.on('message', (m: { content: { content?: unknown } }) => got.push(m.content.content));
    cb.on('unknown-sender', (e: unknown) => unknown.push(e));
    ca.sendCredentialToPinned(b.fp, b.pub.toString('hex'), 'after a restart');
    ib.handleIncomingMessage(sent[0]);
    expect(got).toEqual(['after a restart']);
    expect(unknown).toHaveLength(0);
  });

  it('a resolver key that is not the sender\'s is ignored (unknown-sender, nothing delivered)', () => {
    const a = makeAgent();
    const b = makeAgent();
    const sent: unknown[] = [];
    const { client: ca } = clientFor(a, sent);
    const { client: cb, internals: ib } = clientFor(b, []);
    cb.setPinnedKeyResolver(() => makeAgent().pub);
    const got: unknown[] = [];
    const unknown: unknown[] = [];
    cb.on('message', (m: unknown) => got.push(m));
    cb.on('unknown-sender', (e: unknown) => unknown.push(e));
    ca.sendCredentialToPinned(b.fp, b.pub.toString('hex'), 'x');
    ib.handleIncomingMessage(sent[0]);
    expect(got).toHaveLength(0);
    expect(unknown).toHaveLength(1);
  });

  it('the binding check accepts an empty cache but refuses a DIFFERENT cached key', () => {
    const a = makeAgent();
    const b = makeAgent();
    const { client: ca, internals: ia } = clientFor(a, []);
    const pinnedHex = b.pub.toString('hex');
    expect(ca.isChannelBoundToPairing(b.fp, pinnedHex, null)).toBe(true);
    ia.knownAgents.set(b.fp, { agentId: b.fp, name: 'b', publicKey: makeAgent().pub });
    expect(ca.isChannelBoundToPairing(b.fp, pinnedHex, null)).toBe(false);
    ia.knownAgents.set(b.fp, { agentId: b.fp, name: 'b', publicKey: b.pub });
    expect(ca.isChannelBoundToPairing(b.fp, pinnedHex, null)).toBe(true);
    // A pinned key that is not this recipient's never binds.
    expect(ca.isChannelBoundToPairing(b.fp, makeAgent().pub.toString('hex'), null)).toBe(false);
  });
});
