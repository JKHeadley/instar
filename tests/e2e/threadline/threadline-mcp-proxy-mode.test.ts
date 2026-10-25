/**
 * threadline-mcp in LISTENER PROXY mode (a local Threadline listener answers on
 * THREADLINE_SEND_PORT): the server has no relay connection of its own, so it cannot pair or
 * encrypt. It must say so rather than silently send a paired agent plaintext (spec
 * threadline-standalone-pairing D6), and it never relays an invite (D4).
 * The BUILT server over stdio, a fake listener, a pin written to the state dir beforehand.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PinnedKeyStore, createInvite, encodeInvite, generateIdentityKeyPair } from '@sagemindai/threadline-core';

const pkg = path.resolve(__dirname, '../../../packages/threadline-mcp');
const hasDeps = fs.existsSync(path.join(pkg, 'node_modules', '@modelcontextprotocol', 'sdk')) && fs.existsSync(path.join(pkg, 'node_modules', '@sagemindai', 'threadline-core'));

describe.skipIf(!hasDeps)('threadline-mcp through a listener proxy', () => {
  let listener: http.Server;
  const relayed: Array<{ to: string; text: string }> = [];
  let client: Client;
  let stateDir: string;
  const peer = generateIdentityKeyPair();
  const peerFp = peer.publicKey.subarray(0, 16).toString('hex');
  const stranger = 'f'.repeat(32);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    try { return { isError: !!r.isError, body: JSON.parse(text) }; } catch { return { isError: !!r.isError, body: text }; }
  };

  beforeAll(async () => {
    execFileSync('npx', ['tsc'], { cwd: pkg, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'pipe' });
    listener = http.createServer((req, res) => {
      if (req.url === '/status') { res.end(JSON.stringify({ connected: true })); return; }
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { relayed.push(JSON.parse(b)); res.end(JSON.stringify({ sent: true, threadId: 't' })); });
    });
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
    const port = (listener.address() as { port: number }).port;

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-proxy-'));
    new PinnedKeyStore(stateDir).markInviteVerified(peerFp, { peerIdentityPub: peer.publicKey.toString('hex'), via: 'test' });

    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(pkg, 'dist', 'server.js')],
      env: { ...process.env as Record<string, string>, THREADLINE_STATE_DIR: stateDir, THREADLINE_SEND_PORT: String(port), THREADLINE_USE_LISTENER: '1', THREADLINE_RELAY: 'ws://127.0.0.1:9/v1/connect' },
      stderr: 'pipe',
    });
    client = new Client({ name: 'host', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => { await client?.close(); listener?.close(); });

  it('without THREADLINE_USE_LISTENER=1 a listener on the port is ignored: no proxy mode (Echo review SEC-9)', async () => {
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-noproxy-'));
    const port = (listener.address() as { port: number }).port;
    const t2 = new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, 'dist', 'server.js')], env: { ...process.env as Record<string, string>, THREADLINE_STATE_DIR: sd, THREADLINE_SEND_PORT: String(port), THREADLINE_RELAY: 'ws://127.0.0.1:9/v1/connect' }, stderr: 'pipe' });
    const c2 = new Client({ name: 'host', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    await c2.connect(t2);
    const r = await c2.callTool({ name: 'threadline_pair_invite', arguments: {} });
    expect(JSON.stringify(r.content)).not.toMatch(/another Threadline program|Pairing is open in/);
    await c2.close();
  });

  it('refuses to pair, refuses plaintext to a paired agent, never relays an invite; other messages still go', async () => {
    // Terminal pairing is off unless the person turns it on: no socket in the state dir (D5).
    expect(fs.existsSync(path.join(stateDir, 'pair.sock'))).toBe(false);
    const inv = await call('threadline_pair_invite');
    expect(inv.isError).toBe(true);
    expect(JSON.stringify(inv.body)).toMatch(/send through another Threadline program on this computer/);
    expect(JSON.stringify(inv.body)).not.toMatch(/THREADLINE_[A-Z_]+|\d{4}/); // plain words: no setting, no port
    expect((await call('threadline_pair_open')).isError).toBe(true);

    const toPaired = await call('threadline_send', { to: peerFp, message: 'hello paired friend' });
    expect(toPaired.isError).toBe(true);
    expect(String(toPaired.body)).toMatch(/paired with this agent, so messages to it must be encrypted/);

    const realInvite = encodeInvite(createInvite({ identityPubHex: generateIdentityKeyPair().publicKey.toString('hex'), owner: 'x', agent: 'y' }));
    const leak = await call('threadline_send', { to: stranger, message: `pair with me: ${realInvite}` });
    expect(leak.isError).toBe(true);
    expect(String(leak.body)).toMatch(/contains a pairing invite/);
    // Only a checksum-valid invite is refused; text that merely looks like one is sent (spec r3 D4).
    expect((await call('threadline_send', { to: stranger, message: 'the format is tlinv1:abc.def' })).isError).toBe(false);

    expect((await call('threadline_send', { to: stranger, message: 'an ordinary hello' })).isError).toBe(false);
    await vi.waitFor(() => expect(relayed.map((r) => r.text)).toEqual(['the format is tlinv1:abc.def', 'an ordinary hello']), { timeout: 5000 });
  }, 60_000);
});
