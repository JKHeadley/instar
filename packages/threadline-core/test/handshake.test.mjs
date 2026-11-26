// The pairing handshake (docs/specs/a2a-pairing-invite-link.md §11), against the BUILT package:
// two agents on an in-memory relay reach `paired` on both sides only after the hello, and a
// refusal reaches the acceptor. The full suite (both implementations, every branch) is
// tests/unit/threadline/pairing-handshake.test.ts in the Instar repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PairingHandshake, PairingInviteFlow, PairingInviteStore, PinnedKeyStore, generateIdentityKeyPair, sign, verify,
  pairingNoticeText, ALL_PAIRING_OPS,
} from '../dist/index.js';

function makeNet() {
  const net = { queue: [], agents: new Map(), drop: () => false };
  net.pump = async () => {
    while (net.queue.length) {
      const m = net.queue.shift();
      if (net.drop(m)) continue;
      const to = net.agents.get(m.to);
      if (to) await to.hs.handleControl(m.op, m.from, m.payload);
    }
  };
  return net;
}

function makeAgent(net, name) {
  const kp = generateIdentityKeyPair();
  const pub = kp.publicKey.toString('hex');
  const fp = pub.slice(0, 32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tlc-hs-${name}-`));
  const trust = new PinnedKeyStore(dir, undefined, () => {});
  const store = new PairingInviteStore(dir);
  const notices = [];
  const send = (to, op, payload) => { net.queue.push({ from: fp, to, op, payload: JSON.parse(JSON.stringify(payload)) }); };
  const hs = new PairingHandshake({
    store, trust,
    identity: () => ({ fp, publicKeyHex: pub }),
    signHex: (m) => sign(kp.privateKey, Buffer.from(m)).toString('hex'),
    verifyHex: (k, m, s) => verify(Buffer.from(k, 'hex'), Buffer.from(m), Buffer.from(s, 'hex')),
    randomHex: (n) => crypto.randomBytes(n).toString('hex'),
    sendPlaintext: send,
    sendToKey: (to, _k, op, payload) => send(to, op, payload),
    notice: (n) => notices.push(n),
    forward: () => {},
    log: () => {},
    setTimer: () => () => {}, // no timers in this smoke test
  });
  const flow = new PairingInviteFlow({
    store, trust, identity: () => ({ fp, publicKeyHex: pub, privateKey: kp.privateKey }),
    relayKeyFor: async () => null,
    sendPlaintext: hs.flowSendPlaintext, sendToKey: hs.flowSendToKey, notify: hs.flowNotify,
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    schedule: (fn) => fn(),
  });
  hs.attach(flow);
  const a = { fp, hs, store, trust, notices };
  net.agents.set(fp, a);
  return a;
}

test('both sides report "paired" only after the hello; the texts are plain', async () => {
  assert.equal(ALL_PAIRING_OPS.size, 7);
  const net = makeNet();
  const A = makeAgent(net, 'pp');
  const B = makeAgent(net, 'echo');
  const inv = A.hs.createInvite();
  assert.equal((await B.hs.receiveInvite(inv.message)).ok, true);
  assert.equal(B.hs.approveAccept(inv.iid).ok, true);
  await net.pump();
  assert.deepEqual(B.notices.map((n) => n.kind), ['approved', 'accept-received']);
  net.drop = (m) => m.op === 'pair-invite-hello';
  assert.equal(A.hs.approveFinish(inv.iid).ok, true);
  await net.pump();
  assert.equal(A.notices.some((n) => n.kind === 'paired'), false);
  assert.equal(B.notices.some((n) => n.kind === 'paired'), false);
  // The pins are recorded on both sides; only the hello is missing, so neither says "paired".
  assert.equal(A.trust.getProfileByFingerprint(B.fp).pairingState, 'mutual-verified');
  assert.equal(B.trust.getProfileByFingerprint(A.fp).pairingState, 'mutual-verified');
  assert.match(pairingNoticeText({ kind: 'paired', iid: inv.iid, peerFp: B.fp, peerName: 'echo', role: 'inviter', checked: true }), /^Connected ✓ "echo"/);
});

test('the full exchange: "paired" on both sides', async () => {
  const net = makeNet();
  const A = makeAgent(net, 'pp');
  const B = makeAgent(net, 'echo');
  const inv = A.hs.createInvite();
  await B.hs.receiveInvite(inv.message);
  B.hs.approveAccept(inv.iid);
  await net.pump();
  A.hs.approveFinish(inv.iid);
  await net.pump();
  assert.equal(A.notices.filter((n) => n.kind === 'paired').length, 1);
  assert.equal(B.notices.filter((n) => n.kind === 'paired').length, 1);
});

test('a revoked invite: the acceptor gets a signed refusal and is told why', async () => {
  const net = makeNet();
  const A = makeAgent(net, 'pp');
  const B = makeAgent(net, 'echo');
  const inv = A.hs.createInvite();
  await B.hs.receiveInvite(inv.message);
  assert.equal(A.store.revoke(inv.iid), true);
  B.hs.approveAccept(inv.iid);
  await net.pump();
  const refused = B.notices.find((n) => n.kind === 'accept-refused');
  assert.equal(refused.reason, 'revoked');
  assert.match(pairingNoticeText(refused), /cancelled that invite/);
});
