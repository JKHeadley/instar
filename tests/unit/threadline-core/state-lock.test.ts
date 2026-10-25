/**
 * One threadline-mcp per state directory owns pairing (Echo's review of #2192, SEC-5).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireStateLock, parseLock, friendlyAppName, PairingOwnership, PID_REUSE_AGE_MS, EMPTY_LOCK_GRACE_MS } from '../../../packages/threadline-mcp/src/stateLock.js';
import { notOwnerRefusal } from '../../../packages/threadline-mcp/src/pairTools.js';
import { StandalonePairing } from '../../../packages/threadline-mcp/src/pairing.js';
import { generateIdentityKeyPair } from '@sagemindai/threadline-core';

describe('state lock', () => {
  it('the first instance owns it; a second live one does not; a dead holder is taken over; release only removes our own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lock-'));
    const a = acquireStateLock(dir, process.pid);
    expect(a.held).toBe(true);
    const b = acquireStateLock(dir, process.ppid); // a different, live process
    expect(b).toMatchObject({ held: false, holderPid: process.pid });
    b.release();
    expect(fs.readFileSync(path.join(dir, 'threadline', 'owner.lock'), 'utf8')).toBe(String(process.pid));
    a.release();
    expect(fs.existsSync(path.join(dir, 'threadline', 'owner.lock'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'threadline', 'owner.lock'), '2147483646'); // no such process
    expect(acquireStateLock(dir, process.pid).held).toBe(true);
    expect(fs.statSync(path.join(dir, 'threadline', 'owner.lock')).mode & 0o077).toBe(0);
  });

  it('the owner records its app name; a non-owner reads it fresh; a pid-only lock (0.5.x) is still read (R2-2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lock-app-'));
    const file = path.join(dir, 'threadline', 'owner.lock');
    const a = acquireStateLock(dir, process.pid);
    const b = acquireStateLock(dir, process.ppid);
    expect(b.held).toBe(false);
    expect(b.holderApp()).toBeNull(); // nothing recorded yet
    a.setApp('Claude\nDesktop\u0007');
    expect(b.holderApp()).toBe('Claude Desktop');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${process.pid}\nClaude Desktop`);
    expect(Number.parseInt(fs.readFileSync(file, 'utf8'), 10)).toBe(process.pid); // what a 0.5.x reader does
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    b.setApp('impostor'); // a non-owner cannot rename the owner
    expect(b.holderApp()).toBe('Claude Desktop');
    // A third instance still sees the live owner through the two-line format.
    expect(acquireStateLock(dir, process.ppid)).toMatchObject({ held: false, holderPid: process.pid });
    a.release();
    expect(fs.existsSync(file)).toBe(false);
    // An old pid-only lock held by a live process is respected, with no app name.
    fs.writeFileSync(file, String(process.ppid));
    const c = acquireStateLock(dir, process.pid);
    expect(c).toMatchObject({ held: false, holderPid: process.ppid });
    expect(c.holderApp()).toBeNull();
    expect(parseLock('123')).toEqual({ pid: 123, app: null });
    expect(parseLock('123\nCursor')).toEqual({ pid: 123, app: 'Cursor' });
    expect(parseLock('garbage')).toEqual({ pid: null, app: null });
  });

  it('takeover race: a second instance taking over between our read and our retire is never deleted; exactly one owner (SHOULD-FIX 1)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lock-race-'));
    const file = path.join(dir, 'threadline', 'owner.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '2147483646'); // the owner exited
    let b: ReturnType<typeof acquireStateLock> | null = null;
    // A reads the dead holder; before A retires it, B (another live instance) takes over.
    const a = acquireStateLock(dir, process.pid, { beforeRetire: () => { b = acquireStateLock(dir, process.ppid); } });
    expect(b!.held).toBe(true);
    expect(a.held).toBe(false);
    expect(a.holderPid).toBe(process.ppid);
    expect(parseLock(fs.readFileSync(file, 'utf8')).pid).toBe(process.ppid);
    expect(b!.stillHeld()).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('owner.lock.'))).toEqual([]); // nothing left behind
  });

  it('an empty lock is respected while young (a 0.5.x owner mid-write) and retired once older than the grace (Echo #2215 note 2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lock-empty-'));
    const file = path.join(dir, 'threadline', 'owner.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    const young = acquireStateLock(dir, process.pid);
    expect(young.held).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(''); // not retired
    const mtime = fs.statSync(file).mtimeMs;
    const old = acquireStateLock(dir, process.pid, { now: () => mtime + EMPTY_LOCK_GRACE_MS + 1 });
    expect(old.held).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(String(process.pid));
  });

  it('a lock whose pid was reused (older than a day, process started after it) is stale; a fresh one is respected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lock-reuse-'));
    const file = path.join(dir, 'threadline', 'owner.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(process.ppid)); // a live process, but it started minutes ago
    expect(acquireStateLock(dir, process.pid).held).toBe(false); // fresh lock: respected
    const old = (Date.now() - PID_REUSE_AGE_MS - 60 * 60_000) / 1000;
    fs.utimesSync(file, old, old);
    expect(acquireStateLock(dir, process.pid).held).toBe(true); // written two days before that process started: reused pid
  });

  it('an owner whose lock was replaced stops acting as owner: credentials refused, no takeover of a live lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lock-lost-'));
    const own = new PairingOwnership(dir, process.pid);
    expect(own.owns()).toBe(true);
    const k = generateIdentityKeyPair();
    const fp = k.publicKey.subarray(0, 16).toString('hex');
    const p = new StandalonePairing({ stateDir: dir, identity: { fp, publicKey: k.publicKey, privateKey: k.privateKey }, ownName: () => ({ owner: 'o', agent: 'x' }), sendEnvelope: () => {}, relayHttpBase: null, ownsPairing: () => own.owns(), claimOwnership: () => own.ensure() });
    fs.writeFileSync(path.join(dir, 'threadline', 'owner.lock'), `${process.ppid}\nCursor`); // another live instance replaced it
    expect(own.owns()).toBe(false);
    expect(p.send('c'.repeat(32), 'secret', { credential: true })).toEqual({ sent: false, reason: 'not-pairing-owner' });
    expect(own.ensure()).toBe(false); // the new holder is alive
    expect(own.holderApp()).toBe('Cursor');
  });

  it('maps MCP client names to what a person calls the app (case-insensitive substring), else the raw name, else "another app"', () => {
    expect(friendlyAppName('claude-ai')).toBe('Claude Desktop');
    expect(friendlyAppName('Claude-AI-desktop')).toBe('Claude Desktop');
    expect(friendlyAppName('claude-code')).toBe('Claude Code');
    expect(friendlyAppName('cursor-vscode')).toBe('Cursor'); // cursor wins: it is checked before vscode
    expect(friendlyAppName('Visual Studio Code')).toBe('VS Code');
    expect(friendlyAppName('vscode-insiders')).toBe('VS Code');
    expect(friendlyAppName('codex-mcp-client')).toBe('the ChatGPT app');
    expect(friendlyAppName('ChatGPT')).toBe('the ChatGPT app');
    expect(friendlyAppName('goose')).toBe('Goose');
    expect(friendlyAppName('my-host')).toBe('my-host');
    expect(friendlyAppName('  ')).toBe('another app');
    expect(friendlyAppName(undefined)).toBe('another app');
    expect(friendlyAppName('bad\nname')).toBe('bad name');
  });

  it('the non-owner refusal names the app in plain words, never a pid or a setting', () => {
    expect(notOwnerRefusal('Claude Desktop')).toBe('Tell your person this, in these words: "Pairing is open in Claude Desktop. Finish it there, or close that app and try again."');
    expect(notOwnerRefusal(null)).toContain('Pairing is open in another app.');
    for (const t of [notOwnerRefusal('x'), notOwnerRefusal(null)]) for (const banned of ['pid', 'terminal', 'npx', 'THREADLINE_', 'command']) expect(t).not.toContain(banned);
  });
});

type Env = Record<string, unknown> & { to: string };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('a threadline-mcp that does not own pairing', () => {
  function mk(name: string, wire: { out: Env[] }, opts: { dir?: string; kp?: { publicKey: Buffer; privateKey: Buffer }; owns?: boolean } = {}) {
    const k = opts.kp ?? generateIdentityKeyPair();
    const fp = k.publicKey.subarray(0, 16).toString('hex');
    const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `tl-own-${name}-`));
    const p = new StandalonePairing({ stateDir: dir, identity: { fp, publicKey: k.publicKey, privateKey: k.privateKey }, ownName: () => ({ owner: 'o', agent: name }), sendEnvelope: (e) => wire.out.push(e as Env), relayHttpBase: null, ownsPairing: opts.owns });
    return { fp, p, dir, k };
  }
  async function pump(wire: { out: Env[] }, agents: Array<ReturnType<typeof mk>>) {
    while (wire.out.length) { const e = wire.out.shift()!; const to = agents.find((a) => a.fp === e.to); if (to) await to.p.receive(e as never); }
  }

  it('an inbound accept reaching a non-owner after the owner exited, before any tool call, takes ownership and is handled (SHOULD-FIX 2)', async () => {
    const wire = { out: [] as Env[] };
    const A = mk('a', wire), B = mk('b', wire);
    const file = path.join(B.dir, 'threadline', 'owner.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${process.ppid}\nClaude Desktop`); // B's process (simulated by ppid) owns pairing
    const own = new PairingOwnership(B.dir, process.pid);
    expect(own.owns()).toBe(false);
    const B2 = { fp: B.fp, p: new StandalonePairing({ stateDir: B.dir, identity: { fp: B.fp, publicKey: B.k.publicKey, privateKey: B.k.privateKey }, ownName: () => ({ owner: 'o', agent: 'b' }), sendEnvelope: (e) => wire.out.push(e as Env), relayHttpBase: null, ownsPairing: () => own.owns(), claimOwnership: () => own.ensure() }) };
    own.onAcquired = () => B2.p.becomeOwner();
    // The owner made an invite, then exited.
    const inv = B.p.flow.createInvite() as { ok: true; iid: string; message: string };
    fs.writeFileSync(file, '2147483646');
    // A's person opens and approves it; the plaintext accept reaches B2. No tool call on B2 first.
    const r = await A.p.flow.receiveInvite(inv.message) as { iid: string };
    expect(A.p.flow.approveAccept(r.iid)).toMatchObject({ ok: true });
    await pump(wire, [A, B2 as never]);
    expect(own.owns()).toBe(true);
    expect(parseLock(fs.readFileSync(file, 'utf8')).pid).toBe(process.pid);
    expect(B2.p.waitingToFinish().map((i) => i.iid)).toEqual([inv.iid]);
    // And the pairing completes from there.
    expect(B2.p.flow.approveFinish(inv.iid)).toMatchObject({ ok: true });
    await tick(); await pump(wire, [A, B2 as never]);
    expect(B2.p.keys.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    expect(A.p.keys.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
  });

  it('ownership is live: an instance that takes over re-reads the stores and then handles pairing ops (becomeOwner)', async () => {
    const wire = { out: [] as Env[] };
    const A = mk('a', wire), B = mk('b', wire);
    let owns = false;
    const k = B.k;
    const B2 = { fp: B.fp, p: new StandalonePairing({ stateDir: B.dir, identity: { fp: B.fp, publicKey: k.publicKey, privateKey: k.privateKey }, ownName: () => ({ owner: 'o', agent: 'b' }), sendEnvelope: (e) => wire.out.push(e as Env), relayHttpBase: null, ownsPairing: () => owns }) };
    // The owner B accepts A's invite AFTER B2 started; then B exits and B2 takes over.
    const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    await pump(wire, [A, B]);
    expect(B2.p.send(A.fp, 'x', { credential: true })).toEqual({ sent: false, reason: 'not-pairing-owner' });
    owns = true;
    expect(B2.p.keys.getProfileByFingerprint(A.fp)).toBeFalsy(); // stale in-memory stores until re-read
    B2.p.becomeOwner();
    expect(B2.p.keys.getProfileByFingerprint(A.fp)).toBeTruthy();
    // A's Finish now reaches B2 (B is gone) and is handled as owner: mutual-verified.
    A.p.flow.approveFinish(inv.iid);
    await tick();
    await pump(wire, [A, B2 as never]);
    expect(B2.p.keys.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    expect(B2.p.send(A.fp, 'secret', { credential: true })).toMatchObject({ sent: true, encrypted: true });
  });

  it('refuses credentials and pairing messages, and sees pins the owner made after it started', async () => {
    const wire = { out: [] as Env[] };
    const A = mk('a', wire), B = mk('b', wire);
    const Bsecond = mk('b', wire, { dir: B.dir, kp: B.k, owns: false }); // a second process on B's state dir
    const inv = A.p.flow.createInvite() as { ok: true; iid: string; message: string };
    const r = await B.p.flow.receiveInvite(inv.message) as { iid: string };
    B.p.flow.approveAccept(r.iid);
    await pump(wire, [A, B]);
    A.p.flow.approveFinish(inv.iid);
    await tick();
    await pump(wire, [A, B]);
    // the pin was written by the owner after Bsecond started; Bsecond still encrypts to A
    expect(Bsecond.p.send(A.fp, 'hello')).toMatchObject({ sent: true, encrypted: true });
    expect(Bsecond.p.send(A.fp, 'secret', { credential: true })).toEqual({ sent: false, reason: 'not-pairing-owner' });
    // a pairing op that reaches the non-owner is refused, not applied
    wire.out.length = 0;
    A.p.send(B.fp, 'ordinary');
    expect(await Bsecond.p.receive(wire.out.shift()! as never)).toMatchObject({ kind: 'message', encrypted: true });
    expect(Bsecond.p.encryptedChatSeen(A.fp)).toBe(false); // only the owner writes the mark
  });
});
