/**
 * threadline-mcp's StandalonePairing (packages/threadline-mcp/src/pairing.ts): the rules that make a
 * channel safe for secrets without Instar (spec threadline-standalone-pairing D6, D7).
 * Two standalone agents joined by an in-memory wire.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StandalonePairing } from '../../../packages/threadline-mcp/src/pairing.js';
import { PairTools } from '../../../packages/threadline-mcp/src/pairTools.js';
import { generateIdentityKeyPair, sign, canonicalizeEnvelope } from '@sagemindai/threadline-core';

type Env = Record<string, unknown> & { from: string; to: string };

function agent(name: string, wire: { out: Env[] }, opts: { fetchImpl?: typeof fetch; relayHttpBase?: string | null; dir?: string; kp?: { publicKey: Buffer; privateKey: Buffer }; now?: () => Date } = {}) {
  const k = opts.kp ?? generateIdentityKeyPair();
  const fp = k.publicKey.subarray(0, 16).toString('hex');
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `sa-${name}-`));
  const p = new StandalonePairing({
    stateDir: dir,
    identity: { fp, publicKey: k.publicKey, privateKey: k.privateKey },
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    sendEnvelope: (e) => wire.out.push(e as Env),
    relayHttpBase: opts.relayHttpBase ?? null,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
  });
  return { name, fp, p, key: k.publicKey, priv: k.privateKey, dir, kp: k };
}

/** The engine sends Finish on a timer (delay 0, then bounded retries): let it fire. */
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Deliver everything queued to whichever agent it is addressed to. */
async function pump(wire: { out: Env[] }, agents: Array<ReturnType<typeof agent>>, results: unknown[] = []) {
  while (wire.out.length) {
    const e = wire.out.shift()!;
    const to = agents.find((a) => a.fp === e.to);
    if (to) results.push(await to.p.receive(e as never));
  }
  return results;
}

async function pair(wire: { out: Env[] }, A: ReturnType<typeof agent>, B: ReturnType<typeof agent>) {
  const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
  const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
  B.p.flow.approveAccept(r.iid);
  await pump(wire, [A, B]);
  expect(A.p.waitingToFinish().map((i) => i.iid)).toEqual([inv.iid]);
  A.p.flow.approveFinish(inv.iid);
  await tick();
  await pump(wire, [A, B]);
}

describe('StandalonePairing', () => {
  it('two agents without Instar pair by invite; pairing ops are never surfaced as messages', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    const seen = await pump(wire, [A, B]);
    A.p.flow.approveFinish(inv.iid);
    await tick();
    seen.push(...await pump(wire, [A, B]));
    expect(seen.every((x) => (x as { kind: string }).kind === 'control')).toBe(true);
    expect(A.p.keys.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
    expect(B.p.keys.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    expect(A.p.recentEvents().some((e) => e.event.kind === 'paired' && e.event.role === 'inviter')).toBe(true);
    expect(B.p.recentEvents().some((e) => e.event.kind === 'paired' && e.event.role === 'recipient')).toBe(true);
  });

  it('a pinned peer is ALWAYS sent encrypted; an unknown one gets plaintext', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire), C = agent('c', wire);
    await pair(wire, A, B);
    expect(A.p.send(B.fp, 'hi')).toMatchObject({ sent: true, encrypted: true });
    expect(wire.out.at(-1)).toHaveProperty('signature');
    const got = await pump(wire, [A, B]);
    expect(got[0]).toMatchObject({ kind: 'message', text: 'hi', encrypted: true, credential: false });
    expect(A.p.send(C.fp, 'hello stranger')).toMatchObject({ sent: true, encrypted: false });
    expect(wire.out.at(-1)).not.toHaveProperty('signature');
  });

  it('credentials: refused to an unpaired or paused peer; delivered and marked when paired', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    expect(A.p.send(B.fp, 'secret', { credential: true })).toEqual({ sent: false, reason: 'peer-not-mutually-verified' });
    expect(wire.out).toHaveLength(0);
    await pair(wire, A, B);
    expect(A.p.send(B.fp, 'secret', { credential: true })).toMatchObject({ sent: true, encrypted: true });
    expect(await pump(wire, [A, B])).toEqual([expect.objectContaining({ kind: 'message', text: 'secret', credential: true })]);
    A.p.keys.demoteInvitePairing(B.fp, 'leak');
    expect(A.p.send(B.fp, 'secret', { credential: true })).toEqual({ sent: false, reason: 'peer-not-mutually-verified' });
  });

  it('an inbound credential from a peer that is only invite-accepted is refused', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    // B accepted A's invite (A pinned on B as invite-accepted), but A never finished.
    const inv = A.p.flow.createInvite() as { ok: true; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    await pump(wire, [A, B]);
    // A (not finished) pins B only when it finishes, so make A's side verified by hand to send:
    A.p.keys.markInviteVerified(B.fp, { peerIdentityPub: B.key.toString('hex'), via: 'test', ownIdentityPub: A.key.toString('hex') });
    A.p.send(B.fp, 'sneaky', { credential: true });
    expect(await pump(wire, [A, B])).toEqual([{ kind: 'refused', reason: 'credential from a peer that is not mutual-verified' }]);
  });

  it('encrypted messages decrypt ONLY with a pinned key; a stranger or a tampered envelope is refused', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire), M = agent('m', wire);
    await pair(wire, A, B);
    // M pins B by hand (B never pinned M) and sends it an encrypted message.
    M.p.keys.markInviteVerified(B.fp, { peerIdentityPub: B.key.toString('hex'), via: 'test' });
    M.p.send(B.fp, 'trust me');
    expect(await pump(wire, [A, B, M])).toEqual([{ kind: 'refused', reason: 'encrypted message from a sender with no pinned key' }]);
    A.p.send(B.fp, 'real');
    const e = wire.out.shift()!;
    const tampered = { ...e, payload: Buffer.from('x').toString('base64') };
    expect(await B.p.receive(tampered as never)).toEqual({ kind: 'refused', reason: 'could not verify or decrypt with the pinned key' });
  });

  it('while waiting for the inviter to finish, the acceptor sends as before pairing, so nothing is lost; a paused pin stays encrypted', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    await pump(wire, [A, B]); // A now waits for its person; it holds no pin for B
    expect(B.p.send(A.fp, 'are you there?')).toMatchObject({ sent: true, encrypted: false });
    expect(await pump(wire, [A, B])).toEqual([expect.objectContaining({ kind: 'message', text: 'are you there?' })]);
    A.p.flow.approveFinish(inv.iid);
    await tick();
    await pump(wire, [A, B]);
    expect(B.p.send(A.fp, 'now paired')).toMatchObject({ encrypted: true });
    expect(await pump(wire, [A, B])).toEqual([expect.objectContaining({ kind: 'message', encrypted: true })]);
    B.p.keys.demoteInvitePairing(A.fp, 'second accept');
    expect(B.p.send(A.fp, 'still private')).toMatchObject({ encrypted: true });
    expect(await pump(wire, [A, B])).toEqual([expect.objectContaining({ kind: 'message', text: 'still private', encrypted: true })]);
  });

  it('a captured encrypted envelope is accepted once; a replay of it is refused, and a forgery cannot burn its id', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    A.p.send(B.fp, 'pay invoice 7');
    const e = wire.out.shift()!;
    // a forgery reusing the real messageId arrives FIRST; it fails verification and must not mark the id as seen
    expect(await B.p.receive({ ...e, payload: Buffer.from('x').toString('base64') } as never)).toMatchObject({ kind: 'refused' });
    expect(await B.p.receive(e as never)).toMatchObject({ kind: 'message', text: 'pay invoice 7', encrypted: true });
    expect(await B.p.receive(e as never)).toEqual({ kind: 'refused', reason: 'replayed message (already received)' });
    // a new message from the same sender still goes through
    A.p.send(B.fp, 'second');
    expect(await B.p.receive(wire.out.shift()! as never)).toMatchObject({ kind: 'message', text: 'second' });
  });

  it('pairing ops other than the accept are ignored in plaintext; an invite sent as a message is refused', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const fakeFinish = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'pair-invite-finish', text: '{}' })).toString('base64') };
    expect(await B.p.receive(fakeFinish as never)).toEqual({ kind: 'control' });
    expect(B.p.keys.list()).toEqual([]);
    const inv = A.p.flow.createInvite() as { message: string };
    const relayed = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'chat', text: inv.message })).toString('base64') };
    expect(await B.p.receive(relayed as never)).toMatchObject({ kind: 'refused' });
  });

  it('plaintext naming a PAIRED peer: from that peer only if signed by its pinned key; otherwise an unverified claim; never a credential', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire), M = agent('m', wire);
    await pair(wire, A, B);
    const pt = (text: string) => ({ from: A.fp, to: B.fp, messageId: `m-${text}`, payload: Buffer.from(JSON.stringify({ type: 'chat', text })).toString('base64') });
    // Unsigned (how Instar before step 9 sends ordinary chat): the relay could have written it.
    expect(await B.p.receive(pt('old instar sends this way') as never)).toEqual({ kind: 'message', text: 'old instar sends this way', type: 'chat', encrypted: false, credential: false, unverifiedPairedClaim: true });
    // Signed by the pinned key: really from A.
    const signedEnv = pt('signed by a');
    const good = { ...signedEnv, signature: sign(A.priv, Buffer.from(canonicalizeEnvelope(signedEnv), 'utf-8')).toString('base64') };
    expect(await B.p.receive(good as never)).toMatchObject({ kind: 'message', fromPairedPeer: true, encrypted: false, credential: false });
    // Signed by someone else (a relay forging A's name): still only an unverified claim.
    const forged = { ...signedEnv, signature: sign(M.priv, Buffer.from(canonicalizeEnvelope(signedEnv), 'utf-8')).toString('base64') };
    expect(await B.p.receive(forged as never)).toMatchObject({ kind: 'message', unverifiedPairedClaim: true });
    expect(await B.p.receive(forged as never)).not.toHaveProperty('fromPairedPeer');
    // A tampered signed envelope is no longer A's.
    expect(await B.p.receive({ ...good, payload: Buffer.from(JSON.stringify({ text: 'changed' })).toString('base64') } as never)).toMatchObject({ unverifiedPairedClaim: true });
  });

  it('once a paired peer has sent encrypted chat, plaintext in its name is refused (downgrade); pairing ops and credentials do not set that mark', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B); // finish/ack travelled encrypted
    A.p.send(B.fp, 'a credential', { credential: true });
    await pump(wire, [A, B]);
    expect(B.p.encryptedChatSeen(A.fp)).toBe(false);
    const pt = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'chat', text: 'plain' })).toString('base64') };
    expect(await B.p.receive(pt as never)).toMatchObject({ kind: 'message', unverifiedPairedClaim: true });
    A.p.send(B.fp, 'ordinary encrypted chat');
    await pump(wire, [A, B]);
    expect(B.p.encryptedChatSeen(A.fp)).toBe(true);
    expect(await B.p.receive(pt as never)).toEqual({ kind: 'refused', reason: 'plaintext from a paired agent that has sent encrypted messages before (possible downgrade)' });
    // persisted in the pin record (spec r3 D6): a restarted B still refuses
    const file = path.join(B.dir, 'threadline', 'pinned-keys.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).peers.find((x: { fingerprint: string }) => x.fingerprint === A.fp).encryptedSeenAt).toBeTruthy();
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    const B2 = agent('b', wire, { dir: B.dir, kp: B.kp });
    expect(await B2.p.receive(pt as never)).toMatchObject({ kind: 'refused' });
    expect(B2.p.refusedPlaintext.get(A.fp)).toBe(1);
  });

  it('forgetting a pin removes its encryptedSeen mark with it (spec r3 D6, D8)', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    A.p.send(B.fp, 'ordinary encrypted chat');
    await pump(wire, [A, B]);
    expect(B.p.encryptedChatSeen(A.fp)).toBe(true);
    B.p.keys.forget(A.fp);
    expect(B.p.encryptedChatSeen(A.fp)).toBe(false);
  });

  it('a pre-r3 encrypted-chat-peers.json is folded into the pins once, then renamed', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    const legacy = path.join(B.dir, 'threadline', 'encrypted-chat-peers.json');
    fs.writeFileSync(legacy, JSON.stringify({ [A.fp]: '2026-10-15T00:00:00.000Z' }), { mode: 0o600 });
    const B2 = agent('b', wire, { dir: B.dir, kp: B.kp });
    expect(B2.p.encryptedChatSeen(A.fp)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(legacy + '.migrated')).toBe(true);
  });

  it('the audit log records pairing, credential sends and refusals, privately, with no message content', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire), C = agent('c', wire);
    expect(A.p.send(C.fp, 'secret-to-stranger', { credential: true })).toMatchObject({ sent: false });
    await pair(wire, A, B);
    A.p.send(B.fp, 'the vault password', { credential: true });
    await pump(wire, [A, B]);
    A.p.send(B.fp, 'hello');
    const env = wire.out.shift()!;
    await B.p.receive(env as never); await B.p.receive(env as never); // the second is a replay
    const read = (x: ReturnType<typeof agent>) => fs.readFileSync(x.p.auditPath, 'utf8');
    const a = read(A).trim().split('\n').map((l) => JSON.parse(l)), b = read(B).trim().split('\n').map((l) => JSON.parse(l));
    expect(a.map((x) => x.kind)).toEqual(expect.arrayContaining(['credential-refused', 'finish-prompt', 'paired', 'credential-sent']));
    expect(a.find((x) => x.kind === 'credential-refused')).toMatchObject({ to: C.fp, reason: 'peer-not-mutually-verified' });
    expect(b.map((x) => x.kind)).toEqual(expect.arrayContaining(['accept-prompt', 'paired', 'credential-received', 'refused']));
    expect(b.find((x) => x.kind === 'refused')).toMatchObject({ from: A.fp, reason: 'replayed message (already received)' });
    expect(read(A) + read(B)).not.toMatch(/vault password|secret-to-stranger|hello|tlinv1:/);
    expect(fs.statSync(A.p.auditPath).mode & 0o077).toBe(0);
  });

  it('the audit log rotates past its size limit, and an unwritable state dir never breaks messaging', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    fs.mkdirSync(path.dirname(A.p.auditPath), { recursive: true });
    fs.writeFileSync(A.p.auditPath, 'x'.repeat(StandalonePairing.AUDIT_MAX_BYTES + 1));
    A.p.send(B.fp, 'x', { credential: true });
    expect(fs.existsSync(A.p.auditPath + '.1')).toBe(true);
    expect(fs.readFileSync(A.p.auditPath, 'utf8').trim().split('\n')).toHaveLength(1);
    fs.renameSync(path.dirname(A.p.auditPath), path.dirname(A.p.auditPath) + '.moved');
    fs.writeFileSync(path.dirname(A.p.auditPath), 'not a directory');
    expect(A.p.send(B.fp, 'x', { credential: true })).toMatchObject({ sent: false }); // no throw
  });

  it('an invite is never sent as a message, to anyone, paired or not', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const inv = A.p.flow.createInvite() as { message: string };
    expect(B.p.send(A.fp, `here you go: ${inv.message}`)).toEqual({ sent: false, reason: 'invite-in-message' });
    await pair(wire, A, B);
    expect(A.p.send(B.fp, inv.message)).toEqual({ sent: false, reason: 'invite-in-message' });
    expect(wire.out).toHaveLength(0);
  });

  it('pairing events become plain system lines for the inbox, newest first, never secrets', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    expect(A.p.systemLines()).toEqual([]);
    await pair(wire, A, B);
    const lines = A.p.systemLines();
    expect(lines[0]).toMatch(/now paired with "b"/);
    expect(lines.some((l) => /"b" accepted your invite\. Run threadline_pair_finish/.test(l))).toBe(true);
    expect(B.p.systemLines()[0]).toMatch(/now paired with "a"/);
    expect(JSON.stringify([...A.p.systemLines(), ...B.p.systemLines()])).not.toMatch(/tlinv1:|secret/);
    expect(A.p.systemLines(1)).toHaveLength(1);
  });

  it('a corrupt pairing file is an attention item in status and the inbox lines, and the file is kept aside', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-corrupt-'));
    fs.mkdirSync(path.join(dir, 'threadline'));
    fs.writeFileSync(path.join(dir, 'threadline', 'pinned-keys.json'), 'not json');
    const k = generateIdentityKeyPair();
    const p = new StandalonePairing({ stateDir: dir, identity: { fp: k.publicKey.subarray(0, 16).toString('hex'), publicKey: k.publicKey, privateKey: k.privateKey }, ownName: () => ({ owner: 'o', agent: 'a' }), sendEnvelope: () => {}, relayHttpBase: null });
    expect(p.storeProblems).toHaveLength(1);
    expect(p.systemLines()[0]).toMatch(/Pairing ATTENTION: .*pinned-keys\.json was not valid JSON/);
    const st = new PairTools({ pairing: p, elicit: null, resolvePeer: () => null }).status() as { attention: Array<{ problem: string }> };
    expect(st.attention[0].problem).toMatch(/moved to .*unreadable-/);
    expect(fs.readFileSync(p.auditPath, 'utf8')).toMatch(/"kind":"store-problem"/);
    expect(fs.readdirSync(path.join(dir, 'threadline')).some((f) => f.startsWith('pinned-keys.json.unreadable-'))).toBe(true);
  });

  it('a relay cannot redirect: an encrypted envelope addressed to another agent is refused', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    A.p.send(B.fp, 'for b only');
    const e = wire.out.shift()!;
    // the signed `to` cannot be changed, so re-addressing breaks the signature; and a validly signed envelope
    // for someone else that reaches B is refused by the to-check
    expect(await B.p.receive({ ...e, to: 'f'.repeat(32) } as never)).toMatchObject({ kind: 'refused' });
    const C = agent('c', wire);
    expect(await C.p.receive(e as never)).toMatchObject({ kind: 'refused' });
    expect(await B.p.receive(e as never)).toMatchObject({ kind: 'message', text: 'for b only' });
  });

  it('the replay ledger survives a restart', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    A.p.send(B.fp, 'once');
    const e = wire.out.shift()!;
    expect(await B.p.receive(e as never)).toMatchObject({ kind: 'message' });
    const B2 = agent('b', wire, { dir: B.dir, kp: B.kp }); // restart
    expect(await B2.p.receive(e as never)).toEqual({ kind: 'refused', reason: 'replayed message (already received)' });
    expect(fs.statSync(path.join(B.dir, 'threadline', 'seen-messages.jsonl')).mode & 0o077).toBe(0);
  });

  it('a credential outside its freshness window is refused; ordinary chat has no window', async () => {
    const wire = { out: [] as Env[] };
    // The envelope's timestamp is the real clock, so the receiver's clock is moved relative to it.
    let skew = 0;
    const now = () => new Date(Date.now() + skew);
    const A = agent('a', wire), B = agent('b', wire, { now });
    await pair(wire, A, B);
    A.p.send(B.fp, 'old secret', { credential: true });
    A.p.send(B.fp, 'old chat');
    const [cred, chat] = [wire.out.shift()!, wire.out.shift()!];
    skew = 2 * 60 * 60_000; // delivered two hours later
    expect(await B.p.receive(cred as never)).toEqual({ kind: 'refused', reason: 'credential outside its freshness window (possible replay)' });
    expect(await B.p.receive(chat as never)).toMatchObject({ kind: 'message', text: 'old chat' });
    skew = 0;
    A.p.send(B.fp, 'fresh secret', { credential: true });
    expect(await B.p.receive(wire.out.shift()! as never)).toMatchObject({ kind: 'message', credential: true });
    skew = -30 * 60_000; // dated 30 minutes in the receiver's future
    A.p.send(B.fp, 'future secret', { credential: true });
    expect(await B.p.receive(wire.out.shift()! as never)).toMatchObject({ kind: 'refused' });
  });

  it('an unreadable encryptedSeen record fails safe: plaintext from a paired agent is refused, it is reported, and the file is not overwritten', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    const file = path.join(B.dir, 'threadline', 'encrypted-chat-peers.json');
    fs.writeFileSync(file, '{ broken');
    const B2 = agent('b', wire, { dir: B.dir, kp: B.kp });
    const pt = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'chat', text: 'plain' })).toString('base64') };
    expect(await B2.p.receive(pt as never)).toMatchObject({ kind: 'refused' });
    expect(B2.p.storeProblems.some((p) => /encrypted-chat-peers\.json could not be read/.test(p.message))).toBe(true);
    A.p.send(B.fp, 'encrypted chat');
    await pump(wire, [A, B2]);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('with the pin store set aside, plaintext from a formerly paired sender is labelled unverified, never plainly from it', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await pair(wire, A, B);
    fs.writeFileSync(path.join(B.dir, 'threadline', 'pinned-keys.json'), '{ broken');
    const B2 = agent('b', wire, { dir: B.dir, kp: B.kp });
    const pt = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'chat', text: 'plain' })).toString('base64') };
    expect(await B2.p.receive(pt as never)).toMatchObject({ kind: 'message', unverifiedPairedClaim: true });
  });

  it('an invite inside a message never reaches the model and raises an alarm; a look-alike is sent with a signal (spec r3 D4)', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const inv = A.p.flow.createInvite() as { ok: true; message: string };
    // inbound, plaintext
    const pt = { from: A.fp, to: B.fp, payload: Buffer.from(JSON.stringify({ type: 'chat', text: `pair with me: ${inv.message}` })).toString('base64') };
    expect(await B.p.receive(pt as never)).toMatchObject({ kind: 'refused' });
    expect(B.p.alarms.length).toBe(1);
    expect(B.p.systemLines().some((l) => /Pairing ALARM/.test(l))).toBe(true);
    // outbound: a real invite is refused, a look-alike is sent
    expect(B.p.send(A.fp, inv.message)).toMatchObject({ sent: false });
    expect(B.p.send(A.fp, 'my history shows tlinv1:abc.def')).toMatchObject({ sent: true });
    const audit = fs.readFileSync(B.p.auditPath, 'utf8');
    expect(audit).toMatch(/invite-leak-inbound/);
    expect(audit).toMatch(/invite-lookalike-sent/);
    expect(audit).not.toContain(inv.message.split('\n').pop()!);
  });

  it('the waiting-for-Finish window ends: past the longest invite lifetime plus 10 minutes, sends are refused and status says why (SEC-6/ADV-7)', async () => {
    const wire = { out: [] as Env[] };
    let skew = 0;
    const now = () => new Date(Date.now() + skew);
    const A = agent('a', wire), B = agent('b', wire, { now });
    const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    await pump(wire, [A, B]); // A's person never finishes
    expect(B.p.send(A.fp, 'still waiting')).toMatchObject({ sent: true, encrypted: false });
    skew = 24 * 60 * 60_000 + 11 * 60_000;
    expect(B.p.send(A.fp, 'a day later')).toEqual({ sent: false, reason: 'finish-not-received' });
    const st = new PairTools({ pairing: B.p, elicit: null, resolvePeer: () => null }).status() as { finishNotReceived: Array<{ fingerprint: string }> };
    expect(st.finishNotReceived).toEqual([expect.objectContaining({ fingerprint: A.fp })]);
  });

  it('relay-card key check: a matching key is returned, a mismatch or failure is null', async () => {
    const wire = { out: [] as Env[] };
    const target = generateIdentityKeyPair();
    const fp = target.publicKey.subarray(0, 16).toString('hex');
    const card = (key: Buffer) => (async () => ({ ok: true, json: async () => ({ 'x-threadline': { publicKey: key.toString('base64') } }) })) as unknown as typeof fetch;
    expect(await agent('a', wire, { relayHttpBase: 'http://r', fetchImpl: card(target.publicKey) }).p.relayKeyFor(fp)).toBe(target.publicKey.toString('hex'));
    expect(await agent('b', wire, { relayHttpBase: 'http://r', fetchImpl: card(generateIdentityKeyPair().publicKey) }).p.relayKeyFor(fp)).toBeNull();
    const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await agent('c', wire, { relayHttpBase: 'http://r', fetchImpl: failing }).p.relayKeyFor(fp)).toBeNull();
    expect(await agent('d', wire, { relayHttpBase: null }).p.relayKeyFor(fp)).toBeNull();
  });
});

/**
 * The wire type of ordinary chat (interop with Instar, 0.6.1). Instar's inbound gate reads
 * `content.type` as the operation and allows `'message'`; 0.6.0 sent `'chat'`, which a strict
 * Instar agent refused. Outbound now says `'message'` on every path; inbound accepts both.
 */
describe('StandalonePairing: ordinary chat travels as type "message"', () => {
  const plaintextType = (e: Env) => JSON.parse(Buffer.from(String(e.payload), 'base64').toString('utf-8')).type;

  it('all three send paths put type "message" on the wire: credential, pinned encrypted, and plaintext', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire), C = agent('c', wire);
    await pair(wire, A, B);
    // credential (encrypted to the pin): B decrypts it and reports the type it carried
    expect(A.p.send(B.fp, 'a secret', { credential: true })).toMatchObject({ sent: true, encrypted: true });
    expect(await pump(wire, [A, B])).toEqual([{ kind: 'message', text: 'a secret', type: 'message', encrypted: true, credential: true }]);
    // ordinary chat to a pinned peer (encrypted)
    expect(A.p.send(B.fp, 'hello paired')).toMatchObject({ sent: true, encrypted: true });
    expect(await pump(wire, [A, B])).toEqual([{ kind: 'message', text: 'hello paired', type: 'message', encrypted: true, credential: false }]);
    // ordinary chat to an unpaired agent (plaintext): read the payload itself
    expect(A.p.send(C.fp, 'hello stranger')).toMatchObject({ sent: true, encrypted: false });
    const pt = wire.out.pop()!;
    expect(pt).not.toHaveProperty('signature');
    expect(plaintextType(pt)).toBe('message');
    expect(await C.p.receive(pt as never)).toEqual({ kind: 'message', text: 'hello stranger', type: 'message', encrypted: false, credential: false });
  });

  it('inbound "chat" (older threadline-mcp) and "message" are both ordinary chat, encrypted and plaintext, and both set the encryptedSeen mark', async () => {
    for (const type of ['chat', 'message']) {
      const wire = { out: [] as Env[] };
      const A = agent('a', wire), B = agent('b', wire), C = agent('c', wire);
      await pair(wire, A, B);
      // Encrypted, as an older peer would send it: built through the same encrypt path with the old type.
      (A.p as unknown as { sendEncrypted(to: string, k: Buffer, m: Record<string, unknown>): string }).sendEncrypted(B.fp, B.key, { content: `enc ${type}`, type });
      expect(await pump(wire, [A, B])).toEqual([{ kind: 'message', text: `enc ${type}`, type, encrypted: true, credential: false }]);
      expect(B.p.encryptedChatSeen(A.fp)).toBe(true);
      // An old-style credential (type 'chat' + metadata.credential) is still a credential.
      (A.p as unknown as { sendEncrypted(to: string, k: Buffer, m: Record<string, unknown>): string }).sendEncrypted(B.fp, B.key, { content: 'old secret', type, metadata: { credential: true } });
      expect(await pump(wire, [A, B])).toEqual([{ kind: 'message', text: 'old secret', type, encrypted: true, credential: true }]);
      // Plaintext from an unpaired sender.
      const pt = { from: C.fp, to: B.fp, messageId: `pt-${type}`, payload: Buffer.from(JSON.stringify({ type, text: `plain ${type}` })).toString('base64') };
      expect(await B.p.receive(pt as never)).toEqual({ kind: 'message', text: `plain ${type}`, type, encrypted: false, credential: false });
    }
  });
});
