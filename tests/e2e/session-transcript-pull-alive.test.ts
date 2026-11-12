// @ts-nocheck — production boot path exercised over real HTTP.
/**
 * native-conversation-any-machine-access §3d — Tier-3 "feature is alive".
 *
 * Two AgentServers on the production init path with DIFFERENT API tokens. The serving machine
 * registers `session-transcript-pull` on a real MeshRpcDispatcher behind its real /mesh/rpc route;
 * the asking machine is given the signed sender (`meshSignedRead`) the way server.ts gives it.
 * GET /sessions/NAME/transcript?machineId=SERVER on the asking machine answers 200 with
 * `via: 'signed'` for a session that exists only on the serving machine. The source checks prove
 * server.ts registers the verb on the production dispatcher and hands the sender to AgentServer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MeshRpcDispatcher } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { createSessionTranscriptPullHandler } from '../../src/core/sessionTranscriptPull.js';
import { redactForDevice } from '../../src/server/mobileSessionTerminalRoutes.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); }, 30_000);

const tmpBase = () => (process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir());
function agentDir(label) {
  const root = fs.mkdtempSync(path.join(tmpBase(), `stp-alive-${label}-`)), stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  cleanup.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'session-transcript-pull-alive' }));
  return { root, stateDir };
}
async function listen(server) {
  const http = server.getApp().listen(0, '127.0.0.1');
  cleanup.push(() => new Promise((resolve) => http.close(resolve)));
  await new Promise((resolve) => (http.listening ? resolve() : http.once('listening', resolve)));
  return `http://127.0.0.1:${http.address().port}`;
}

describe('session-transcript-pull lifecycle', () => {
  it('server.ts registers the verb on the production dispatcher and hands the signed sender to AgentServer', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(src).toContain("'session-transcript-pull': (cmd) => _servePoolReads().transcript(");
    expect(src).toContain('transcript: createSessionTranscriptPullHandler({');
    expect(src).toContain('history: createTopicHistoryPoolHandler({');
    expect(src).toMatch(/_meshSignedRead = \(machineId, command, timeoutMs\) => \{[\s\S]{0,300}meshClient\.send\(/);
    expect(src).toContain('meshSignedRead: _meshSignedRead ?? undefined');
    const agent = fs.readFileSync(path.join(process.cwd(), 'src/server/AgentServer.ts'), 'utf8');
    expect(agent).toContain('meshSignedRead: options.meshSignedRead ?? null');
  });

  it('is alive: a remote session\'s transcript is read over the signed mesh with no shared token', async () => {
    const keys = { m_ask: generateSigningKeyPair(), m_serve: generateSigningKeyPair() };

    // ── The serving machine ──
    const s = agentDir('serve');
    const transcript = path.join(s.root, 'session.jsonl');
    fs.writeFileSync(transcript, [
      { type: 'user', timestamp: '2026-11-11T10:00:00Z', message: { content: 'what is on the Mini?' } },
      { type: 'assistant', timestamp: '2026-11-11T10:00:02Z', message: { content: [{ type: 'text', text: 'Its transcript, read from the Mama PC.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const serveConfig = { projectName: 'stp-serve', projectDir: s.root, stateDir: s.stateDir, port: 0, authToken: 'serve-token-differs', dashboardPin: '111222' };
    const seen = new Set();
    const dispatcher = new MeshRpcDispatcher({
      verify: { selfMachineId: 'm_serve', verify: (c, sig, sender) => !!keys[sender] && verify(c, sig, keys[sender].publicKey), isRegisteredPeer: (id) => id === 'm_ask', seenNonce: (a, n) => seen.has(`${a}:${n}`), now: () => Date.now() },
      rbac: { routerHolder: () => 'm_serve', ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (a, n) => seen.add(`${a}:${n}`),
      handlers: {
        'session-transcript-pull': createSessionTranscriptPullHandler({
          clean: (t) => redactForDevice(t, [serveConfig.authToken, serveConfig.dashboardPin]),
          findSession: (name) => (name === 'echo-on-mini' ? { filePath: transcript, conversations: [] } : null),
        }),
      },
    });
    const serving = new AgentServer({ config: serveConfig, state: new StateManager(s.stateDir), sessionManager: createMockSessionManager(), meshRpcDispatcher: dispatcher, meshSelfId: 'm_serve' });
    cleanup.push(() => serving.stop());
    const serveUrl = await listen(serving);

    // ── The asking machine: a different token, the signed sender ──
    const a = agentDir('ask');
    let n = 0;
    const client = new MeshRpcClient({ selfMachineId: 'm_ask', sign: (c) => sign(c, keys.m_ask.privateKey), nonce: () => `ask-${++n}`, now: () => Date.now() });
    const asking = new AgentServer({
      config: { projectName: 'stp-ask', projectDir: a.root, stateDir: a.stateDir, port: 0, authToken: 'ask-token-differs', dashboardPin: '333444' },
      state: new StateManager(a.stateDir), sessionManager: createMockSessionManager(), meshSelfId: 'm_ask',
      resolvePeerUrls: () => [{ machineId: 'm_serve', url: serveUrl, kind: 'lan' }],
      meshSignedRead: (machineId, command, timeoutMs) => client.send({ machineId, url: serveUrl }, command, 0, { timeoutMs }),
    });
    cleanup.push(() => asking.stop());
    const askUrl = await listen(asking);
    const auth = { Authorization: 'Bearer ask-token-differs', 'X-Instar-AgentId': 'stp-ask' };

    // The bearer hop would be refused: the serving machine does not know the asking machine's token.
    const bearer = await fetch(`${serveUrl}/sessions/echo-on-mini/transcript`, { headers: { Authorization: 'Bearer ask-token-differs' } });
    expect(bearer.status).toBe(401);

    const res = await fetch(`${askUrl}/sessions/echo-on-mini/transcript?machineId=m_serve`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, via: 'signed', machineId: 'm_serve', conversations: [] });
    expect(body.entries.map((e) => e.text)).toEqual(['what is on the Mini?', 'Its transcript, read from the Mama PC.']);

    const status = await (await fetch(`${askUrl}/pool/signed-reads`, { headers: auth })).json();
    expect(status.signedCapable.m_serve.transcript).toBe(true);
    expect(status.counts.bearerReads).toBe(0);
  }, 60_000);
});
