/**
 * The terminal fallback (packages/threadline-mcp/src/pairSocket.ts; spec threadline-standalone-pairing
 * D5). A host without elicitation cannot ask the person, so the person runs
 * `threadline-mcp pair open|finish` in a terminal. The CLI talks to the RUNNING server over a Unix
 * socket and the server runs the same PairTools, asking each question on the terminal.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { StandalonePairing } from '../../../packages/threadline-mcp/src/pairing.js';
import { PairTools } from '../../../packages/threadline-mcp/src/pairTools.js';
import { servePairSocket, runPairCli, PAIR_SOCKET_PROTOCOL, pairSocketPathProblem } from '../../../packages/threadline-mcp/src/pairSocket.js';
import { generateIdentityKeyPair, findInviteToken } from '@sagemindai/threadline-core';

type Env = Record<string, unknown> & { to: string };
const tick = () => new Promise((r) => setTimeout(r, 5));
const servers: net.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

function agent(name: string, wire: { out: Env[] }) {
  const k = generateIdentityKeyPair();
  const fp = k.publicKey.subarray(0, 16).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ps-${name}-`));
  const pairing = new StandalonePairing({
    stateDir: dir,
    identity: { fp, publicKey: k.publicKey, privateKey: k.privateKey },
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    sendEnvelope: (e) => wire.out.push(e as Env),
    relayHttpBase: null,
  });
  const base = { pairing, resolvePeer: (n: string) => (/^[0-9a-f]{32}$/.test(n) ? n : null) };
  const sock = path.join(dir, 'pair.sock');
  return { name, fp, pairing, sock, base, serve: async () => { servers.push(await servePairSocket(sock, (e) => new PairTools({ ...base, elicit: e }))); } };
}
async function pump(wire: { out: Env[] }, agents: Array<ReturnType<typeof agent>>) {
  while (wire.out.length) {
    const e = wire.out.shift()!;
    const to = agents.find((a) => a.fp === e.to);
    if (to) await to.pairing.receive(e as never);
  }
}
/** A person at a terminal: answers each prompt from a script once it is shown. */
function terminal(answers: string[], isTTY = true) {
  const input = new PassThrough();
  let shown = '';
  const output = new Writable({
    write(chunk, _enc, cb) {
      const t = String(chunk); shown += t;
      if (/: $/.test(t)) setImmediate(() => input.write((answers.shift() ?? '') + '\n'));
      cb();
    },
  });
  return { io: { input, output, isTTY }, text: () => shown };
}

describe('terminal pairing (D5)', () => {
  it('the person pastes and approves in a terminal; the inviter finishes in a terminal; both are paired', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('scout', wire), B = agent('carl', wire);
    await A.serve(); await B.serve();
    const made = A.pairing.flow.createInvite({}) as { ok: true; message: string };

    const bob = terminal([made.message, '2']); // a multi-line paste (blank lines inside), then "2) approve" (the safe choice is listed first)
    expect(await runPairCli(['open'], B.sock, bob.io)).toBe(0);
    expect(bob.text()).toContain('calls itself "scout"');
    const result = bob.text().slice(bob.text().lastIndexOf('{'));
    expect(result).toContain('"approved"');
    expect(result).not.toContain(findInviteToken(made.message)!); // the server's answer never carries the invite
    await pump(wire, [A, B]);

    const alice = terminal(['finish']); // a choice may also be typed by name
    expect(await runPairCli(['finish'], A.sock, alice.io)).toBe(0);
    expect(alice.text()).toContain('calls itself "carl"');
    await tick();
    await pump(wire, [A, B]);
    expect(A.pairing.keys.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
    expect(B.pairing.keys.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
  });

  it('refuses to decide without an interactive terminal, and sends nothing', async () => {
    const wire = { out: [] as Env[] };
    const B = agent('b', wire);
    await B.serve();
    const t = terminal(['tlinv1:x', '1'], false);
    expect(await runPairCli(['open'], B.sock, t.io)).toBe(2);
    expect(t.text()).toMatch(/needs an interactive terminal/);
    expect(wire.out).toHaveLength(0);
  });

  it('an empty answer or a choice that is not offered decides nothing', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    await B.serve();
    const made = A.pairing.flow.createInvite({}) as { message: string };
    const t7 = terminal([made.message, '7']);
    expect(await runPairCli(['open'], B.sock, t7.io)).toBe(0); // declined
    expect(t7.text()).toContain('Not one of the choices');
    expect(wire.out).toHaveLength(0);
    expect(await runPairCli(['open'], B.sock, terminal(['']).io)).toBe(1);
    expect(B.pairing.keys.list()).toEqual([]);
  });

  it('closing the terminal mid-question decides nothing, and the server is free for the next attempt', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire), B = agent('b', wire);
    const ended: unknown[] = [];
    servers.push(await servePairSocket(B.sock, (e) => {
      const t = new PairTools({ ...B.base, elicit: e });
      const open = t.open.bind(t);
      t.open = async () => { const r = await open(); ended.push(r); return r; };
      return t;
    }));
    const made = A.pairing.flow.createInvite({}) as { message: string };
    const raw = net.connect(B.sock);
    await new Promise<void>((resolve) => {
      raw.on('data', (d) => { const m = JSON.parse(String(d).split('\n')[0]); if (m.ask?.startsWith('Paste')) raw.write(JSON.stringify({ answer: { invite: made.message } }) + '\n'); else if (m.ask) { raw.destroy(); resolve(); } });
      raw.write(JSON.stringify({ cmd: 'open', v: PAIR_SOCKET_PROTOCOL }) + '\n');
    });
    await vi.waitFor(() => expect(ended).toEqual([expect.objectContaining({ result: 'declined' })])); // not left hanging
    expect(wire.out).toHaveLength(0);
    // the same invite can still be accepted properly afterwards
    expect(await runPairCli(['open'], B.sock, terminal([made.message, '2']).io)).toBe(0);
    expect(wire.out).toHaveLength(1);
  });

  it('a client speaking another protocol version is refused, naming both (spec r3 D5)', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    await A.serve();
    const raw = net.connect(A.sock);
    const reply = await new Promise<string>((resolve) => {
      let got = '';
      raw.on('data', (d) => { got += String(d); });
      raw.on('close', () => resolve(got));
      raw.write(JSON.stringify({ cmd: 'status' }) + '\n');
    });
    expect(JSON.parse(reply.split('\n')[0]).result).toMatchObject({ ok: false, error: expect.stringContaining(`protocol ${PAIR_SOCKET_PROTOCOL}`) });
  });

  it('refuses a socket path that is a symlink, a plain file, or too long (spec r3 D5)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
    const target = path.join(dir, 'elsewhere.sock');
    const link = path.join(dir, 'pair.sock');
    fs.symlinkSync(target, link);
    expect(pairSocketPathProblem(link)).toMatch(/symlink/);
    await expect(servePairSocket(link, () => { throw new Error('unused'); })).rejects.toThrow(/symlink/);
    const plain = path.join(dir, 'plain.sock');
    fs.writeFileSync(plain, 'x');
    expect(pairSocketPathProblem(plain)).toMatch(/not a socket/);
    expect(fs.readFileSync(plain, 'utf8')).toBe('x');
    expect(pairSocketPathProblem(path.join(dir, 'x'.repeat(120)))).toMatch(/longer than/);
    expect(pairSocketPathProblem(path.join(dir, 'fresh.sock'))).toBeNull();
    const t = terminal(['']);
    expect(await runPairCli(['status'], link, t.io)).toBe(1);
    expect(t.text()).toMatch(/symlink/);
  });

  it('runs one command per connection; a second command on it is ignored', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    await A.serve();
    const raw = net.connect(A.sock);
    let got = '';
    raw.on('data', (d) => { got += String(d); });
    // open waits on the person; a status smuggled in behind it must not run alongside it
    raw.write(JSON.stringify({ cmd: 'open', v: PAIR_SOCKET_PROTOCOL }) + '\n' + JSON.stringify({ cmd: 'status', v: PAIR_SOCKET_PROTOCOL }) + '\n');
    await vi.waitFor(() => expect(got).toContain('"ask"'));
    await tick(); await tick();
    raw.destroy();
    expect(got).not.toContain('"result"');
  });

  it('a terminal that sits on a question past the idle limit is closed, and the question is answered with nothing', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    const ended: unknown[] = [];
    servers.push(await servePairSocket(A.sock, (e) => {
      const t = new PairTools({ ...A.base, elicit: e });
      const open = t.open.bind(t);
      t.open = async () => { const r = await open(); ended.push(r); return r; };
      return t;
    }, { idleMs: 50 }));
    const raw = net.connect(A.sock);
    raw.on('data', () => { /* sees the question, never answers */ });
    raw.write(JSON.stringify({ cmd: 'open', v: PAIR_SOCKET_PROTOCOL }) + '\n');
    await new Promise((r) => raw.on('close', r));
    await vi.waitFor(() => expect(ended).toEqual([expect.objectContaining({ ok: false })]));
  });

  it('says plainly when threadline-mcp is not running', async () => {
    const t = terminal([]);
    expect(await runPairCli(['open'], path.join(os.tmpdir(), `none-${process.pid}.sock`), t.io)).toBe(1);
    expect(t.text()).toMatch(/Nothing is listening for terminal pairing\. Terminal pairing is off unless THREADLINE_PAIR_TERMINAL=1/);
  });

  it('a second server on the same state dir does not take the socket from a live one', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    await A.serve();
    await expect(servePairSocket(A.sock, (e) => new PairTools({ ...A.base, elicit: e }))).rejects.toThrow(/already serving/);
    expect(await runPairCli(['status'], A.sock, terminal([], false).io)).toBe(0); // the first still answers
  });

  it('a stale socket file from a dead server is replaced; the socket is private to the user', async () => {
    const wire = { out: [] as Env[] };
    const A = agent('a', wire);
    // A server killed hard leaves its socket file behind (close() would have removed it).
    const dead = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(A.sock)})`]);
    await vi.waitFor(() => expect(fs.existsSync(A.sock)).toBe(true), { timeout: 5000 });
    dead.kill('SIGKILL');
    await new Promise((r) => dead.once('exit', r));
    expect(fs.existsSync(A.sock)).toBe(true);
    fs.writeFileSync(A.sock + '.x', ''); // an unrelated file is untouched
    await A.serve();
    expect(await runPairCli(['status'], A.sock, terminal([], false).io)).toBe(0);
    expect(fs.statSync(A.sock).mode & 0o077).toBe(0);
    expect(fs.existsSync(A.sock + '.x')).toBe(true);
  });
});
