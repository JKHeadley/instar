/**
 * native-conversation-any-machine-access §3d — signed transcript, list and pool-history reads
 * between two real HTTP servers whose API tokens differ, through createRoutes and a real
 * MeshRpcDispatcher / MeshRpcClient pair.
 *
 * The serving machine's HTTP routes demand its own token, so any read that sent the asking
 * machine's token by bearer is refused: a passing signed read proves no shared token was needed.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { createSessionTranscriptPullHandler } from '../../src/core/sessionTranscriptPull.js';
import { createTopicHistoryPoolHandler } from '../../src/core/topicHistoryPull.js';
import { redactForDevice } from '../../src/server/mobileSessionTerminalRoutes.js';

const ASKER = 'm_asker';
const SERVER = 'm_server';
const STRANGER = 'm_stranger';
const keys = Object.fromEntries([ASKER, SERVER, STRANGER].map((id) => {
  const kp = generateSigningKeyPair();
  return [id, { priv: kp.privateKey, pub: kp.publicKey }];
}));
const TOPIC = 141868;
const base = () => (process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir());

type Srv = { url: string; close: () => Promise<void>; dir: string };
const open: Srv[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

function listen(app: express.Express, dir: string): Promise<Srv> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const s: Srv = {
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, dir,
        close: () => new Promise<void>((r) => srv.close(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/pool-reads-signed.test.ts:close' }); r(); })),
      };
      open.push(s);
      resolve(s);
    });
  });
}

/** Only this machine's own token opens its HTTP routes; /mesh/rpc is signed instead. */
const requireToken = (token: string): express.RequestHandler => (req, res, next) => {
  if (req.path === '/mesh/rpc') { next(); return; }
  if (req.headers.authorization !== `Bearer ${token}`) { res.status(401).json({ error: 'token refused' }); return; }
  next();
};

function dispatcherFor(self: string, peers: string[], handlers: Partial<Record<MeshCommand['type'], (c: MeshCommand) => unknown>>): MeshRpcDispatcher {
  const seen = new Set<string>();
  return new MeshRpcDispatcher({
    verify: {
      selfMachineId: self,
      verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
      isRegisteredPeer: (s) => peers.includes(s),
      seenNonce: (s, n) => seen.has(`${s}:${n}`),
      now: () => Date.now(),
    },
    rbac: { routerHolder: () => self, ownerOf: () => null, placementTargetOf: () => null },
    recordNonce: (s, n) => seen.add(`${s}:${n}`),
    handlers,
  });
}

let transcriptFile = '';
let bigTranscriptDir = '';
beforeAll(() => {
  bigTranscriptDir = fs.mkdtempSync(path.join(base(), 'prs-t-'));
  transcriptFile = path.join(bigTranscriptDir, 'remote.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-11-11T10:00:00Z', message: { content: 'first question from the owner' } },
    { type: 'assistant', timestamp: '2026-11-11T10:00:01Z', message: { content: [{ type: 'text', text: 'answer with server-token-secret-value inside' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  ];
  fs.writeFileSync(transcriptFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return () => SafeFsExecutor.safeRmSync(bigTranscriptDir, { recursive: true, force: true, operation: 'tests/integration/pool-reads-signed.test.ts:beforeAll' });
});

const historyRows = [
  { messageId: 5, eventId: 'ev-5', fromUser: true, text: 'hello from the serving machine', timestamp: '2026-11-11T10:00:00.000Z', provenance: { source: 'telegram' } },
];

/** The serving machine: its own token, the verbs registered (or not, for an older machine). */
async function servingMachine(opts: { verbs: 'new' | 'history-only' | 'none'; conversations?: string[] | null; peers?: string[] }): Promise<Srv> {
  const dir = fs.mkdtempSync(path.join(base(), 'prs-s-'));
  const clean = (t: string) => redactForDevice(t, ['server-token-secret-value']);
  const handlers: Partial<Record<MeshCommand['type'], (c: MeshCommand) => unknown>> = {};
  if (opts.verbs === 'new') {
    const transcript = createSessionTranscriptPullHandler({
      clean,
      findSession: (name) => (name === 'echo-remote' ? { filePath: transcriptFile, conversations: opts.conversations ?? ['telegram:1'] } : null),
      listSessions: async () => [{ tmuxSession: 'echo-remote', status: 'running', machineId: SERVER }],
    });
    handlers['session-transcript-pull'] = (c) => transcript(c as never).then((r) => (opts.conversations === null && r.ok && r.mode === 'transcript' ? (({ conversations: _c, ...rest }) => rest)(r) : r));
    const pool = createTopicHistoryPoolHandler({ clean, readPool: async () => historyRows });
    handlers['topic-history-pull'] = (c) => pool(c as never);
  } else if (opts.verbs === 'history-only') {
    // The history verb without the pool shape: answers the default shape, no `shape` echo.
    handlers['topic-history-pull'] = () => ({ ok: true, messages: [{ fromUser: true, text: 'default shape' }] });
  }
  const dispatcher = dispatcherFor(SERVER, opts.peers ?? [ASKER], handlers);
  const ctx = { config: { authToken: 'server-token-secret-value', stateDir: dir, port: 0, projectDir: dir }, stateDir: dir, meshRpcDispatcher: dispatcher, meshSelfId: SERVER } as never;
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(requireToken('server-token-secret-value'));
  app.use(createRoutes(ctx));
  return listen(app, dir);
}

interface AskerOpts {
  server: Srv;
  peerVersion?: string | null;
  meshTimeoutMs?: number;
  signer?: string;
  /** Write team-access files so team access reads as on / confined. */
  confined?: Array<{ ref: string; personKey?: string }>;
  teamDevicesFile?: boolean;
  meshSignedRead?: ((m: string, c: MeshCommand, t: number) => Promise<unknown>) | null;
}

let nonce = 0;
async function askingMachine(o: AskerOpts): Promise<{ srv: Srv; meshCalls: MeshCommand[]; get: (p: string) => Promise<{ status: number; body: Record<string, unknown> }> }> {
  const dir = fs.mkdtempSync(path.join(base(), 'prs-a-'));
  if (o.confined) {
    fs.mkdirSync(path.join(dir, 'state', 'team-access'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'team-access', 'confined.json'), JSON.stringify({ entries: o.confined }));
  }
  if (o.teamDevicesFile) {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'mobile-devices.json'), JSON.stringify({ devices: [{ role: 'team' }] }));
  }
  const signer = o.signer ?? ASKER;
  const client = new MeshRpcClient({ selfMachineId: signer, sign: (c) => sign(c, keys[signer].priv), nonce: () => `a${++nonce}`, now: () => Date.now() });
  const meshCalls: MeshCommand[] = [];
  const meshSignedRead = o.meshSignedRead !== undefined ? o.meshSignedRead : (machineId: string, command: MeshCommand, timeoutMs: number) => {
    meshCalls.push(command);
    return client.send({ machineId, url: o.server.url }, command, 0, { timeoutMs: o.meshTimeoutMs ?? timeoutMs });
  };
  const ctx = {
    config: { authToken: 'asker-token', stateDir: dir, port: 0, projectDir: dir },
    stateDir: dir,
    meshSelfId: ASKER,
    resolvePeerUrls: () => [{ machineId: SERVER, url: o.server.url, kind: 'lan' }],
    meshSignedRead,
    machinePoolRegistry: { getCapacity: (id: string) => (id === SERVER ? { machineId: SERVER, nickname: 'Mini', online: true, selfReportedLastSeen: '2026-11-11T14:02:00Z', ...(o.peerVersion === null ? {} : { hardware: { instarVersion: o.peerVersion ?? '1.3.1740' } }) } : null) },
    state: { findSessionByTmux: () => null, listSessions: () => [] },
    telegram: { getTopicHistory: () => [], getTopicHistoryBefore: () => [] },
  } as never;
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(createRoutes(ctx));
  const srv = await listen(app, dir);
  const get = async (p: string) => {
    const r = await fetch(`${srv.url}${p}`, { headers: { Authorization: 'Bearer asker-token' } });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  return { srv, meshCalls, get };
}

describe('signed pool reads between machines with different tokens', () => {
  it('transcript, list and pool history all succeed with via: signed, and nothing goes by bearer', async () => {
    const server = await servingMachine({ verbs: 'new' });
    const a = await askingMachine({ server });
    const t = await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    expect(t.status).toBe(200);
    expect(t.body.via).toBe('signed');
    expect((t.body.entries as Array<{ text: string }>).map((e) => e.text)).toEqual(['first question from the owner', 'answer with [redacted] inside', 'Bash: ls']);
    expect(t.body.conversations).toEqual(['telegram:1']);

    const h = await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&limit=50`);
    expect(h.status).toBe(200);
    const pool = h.body.pool as { via: Record<string, string>; failed: unknown[] };
    expect(pool.via).toEqual({ [SERVER]: 'signed' });
    expect(pool.failed).toEqual([]);
    expect((h.body.messages as Array<Record<string, unknown>>).find((m) => m.machine === SERVER)).toMatchObject({ eventId: 'ev-5', messageId: 5, provenance: { source: 'telegram' } });

    const status = await a.get('/pool/signed-reads');
    expect(status.body.signedCapable).toEqual({ [SERVER]: { transcript: true, list: false, historyPool: true } });
    expect(status.body.bearerFallbackNeededBy).toEqual([{ machineId: SERVER, kinds: ['list'] }]);
    expect((status.body.counts as { bearerReads: number }).bearerReads).toBe(0);
  });

  it('an unregistered machine is refused, and that is not a reason to send the token', async () => {
    const server = await servingMachine({ verbs: 'new' });
    const a = await askingMachine({ server, signer: STRANGER });
    const t = await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    expect(t.status).toBe(502);
    expect(t.body.reason).toBe('peer-refused');
    const status = await a.get('/pool/signed-reads');
    expect((status.body.counts as { bearerReads: number }).bearerReads).toBe(0);
  });

  it('an older peer (unknown verb, older advert) is reached by bearer once and remembered', async () => {
    const server = await servingMachine({ verbs: 'none' });
    const a = await askingMachine({ server, peerVersion: '1.3.1700' });
    const first = await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    // The bearer hop reached the older machine, which refused the asking machine's token: proof it went by bearer.
    expect(first.status).toBe(401);
    expect(first.body.via).toBe('bearer');
    expect(a.meshCalls).toHaveLength(1);
    await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    expect(a.meshCalls).toHaveLength(1);
    const status = await a.get('/pool/signed-reads');
    expect((status.body.bearerFallbackNeededBy as Array<{ kinds: string[] }>)[0].kinds).toContain('transcript');
  });

  it('claim-unauthorized from a peer advertising the new version is a refusal, never a bearer hop', async () => {
    const server = await servingMachine({ verbs: 'none' });
    const a = await askingMachine({ server, peerVersion: '1.3.1800' });
    const t = await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    expect(t.status).toBe(502);
    expect(t.body.reason).toBe('peer-refused');
  });

  it('a peer with the history verb and no transcript verb is signedCapable for history only, and stays in bearerFallbackNeededBy for transcript', async () => {
    const server = await servingMachine({ verbs: 'history-only' });
    const a = await askingMachine({ server, peerVersion: '1.3.1700' });
    await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    const h = await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&limit=50`);
    // The default-shape answer did not echo `shape: 'pool'`, so the pool read went by bearer (and was refused).
    expect((h.body.pool as { failed: Array<{ error: string }> }).failed[0].error).toBe('HTTP 401');
    const status = await a.get('/pool/signed-reads');
    expect(status.body.signedCapable).toEqual({ [SERVER]: { transcript: false, list: false, historyPool: false } });
    expect(status.body.bearerFallbackNeededBy).toEqual([{ machineId: SERVER, kinds: ['transcript', 'list', 'historyPool'] }]);
  });

  it('with the pool shape served, history is signedCapable while the transcript verb is missing', async () => {
    const dir = fs.mkdtempSync(path.join(base(), 'prs-s-'));
    const pool = createTopicHistoryPoolHandler({ clean: (t) => t, readPool: async () => historyRows });
    const dispatcher = dispatcherFor(SERVER, [ASKER], { 'topic-history-pull': (c) => pool(c as never) });
    const app = express();
    app.use(express.json());
    app.use(requireToken('server-token-secret-value'));
    app.use(createRoutes({ config: { authToken: 'server-token-secret-value', stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher } as never));
    const server = await listen(app, dir);
    const a = await askingMachine({ server, peerVersion: '1.3.1700' });
    await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&limit=50`);
    await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    const status = await a.get('/pool/signed-reads');
    expect((status.body.signedCapable as Record<string, Record<string, boolean>>)[SERVER]).toEqual({ transcript: false, list: false, historyPool: true });
    expect(status.body.bearerFallbackNeededBy).toEqual([{ machineId: SERVER, kinds: ['transcript', 'list'] }]);
  });

  it('a timeout does not fall back: the machine is named asleep, and no token is sent', async () => {
    const server = await servingMachine({ verbs: 'new' });
    const a = await askingMachine({ server, meshSignedRead: () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 20)) });
    const t = await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    expect(t.status).toBe(502);
    expect(t.body.reason).toBe('peer-unreachable');
    expect(t.body.machine).toMatchObject({ machineId: SERVER, name: 'Mini', lastSeen: '2026-11-11T14:02:00Z', asleepOrUnreachable: true });
    const h = await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&limit=50`);
    expect((h.body.pool as { asleepOrUnreachable: unknown[] }).asleepOrUnreachable).toEqual([expect.objectContaining({ machineId: SERVER, asleepOrUnreachable: true })]);
    const status = await a.get('/pool/signed-reads');
    expect((status.body.counts as { bearerReads: number }).bearerReads).toBe(0);
    expect((status.body.counts as { failuresNotDowngraded: number }).failuresNotDowngraded).toBe(2);
  });

  it('the asking machine refuses the owner a transcript whose audience excludes the owner', async () => {
    const server = await servingMachine({ verbs: 'new', conversations: ['app-private'] });
    const a = await askingMachine({ server, confined: [{ ref: 'app-private', personKey: 'member-key' }] });
    const t = await a.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    expect(t.status).toBe(403);
    expect(t.body.error).toBe('This session serves a conversation that is private to someone else.');
    expect(t.body.entries).toBeUndefined();
  });

  it('an answer with no conversations field is served on a never-team agent and refused with team access on', async () => {
    const server = await servingMachine({ verbs: 'new', conversations: null });
    const solo = await askingMachine({ server });
    expect((await solo.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`)).status).toBe(200);
    const team = await askingMachine({ server, teamDevicesFile: true });
    const refused = await team.get(`/sessions/echo-remote/transcript?machineId=${SERVER}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('That machine runs an older version and cannot say whose conversation this session served.');
  });
});

describe('pool history: a row larger than the cap, through the route', () => {
  it('comes marked on the row, is read on by machine + row + byteFrom, and the next page reaches the older row', async () => {
    const dir = fs.mkdtempSync(path.join(base(), 'prs-big-'));
    const big = 'é'.repeat(9000);
    const all = [
      { messageId: 1, eventId: 'ev-1', fromUser: true, text: 'older', timestamp: '2026-11-11T10:00:01.000Z' },
      { messageId: 2, eventId: 'ev-2', fromUser: false, text: big, timestamp: '2026-11-11T10:00:02.000Z' },
      { messageId: 3, eventId: 'ev-3', fromUser: true, text: 'newer', timestamp: '2026-11-11T10:00:03.000Z' },
    ];
    const pool = createTopicHistoryPoolHandler({ clean: (t) => t, maxBytes: 8 * 1024 + 4000,
      readPool: async (q) => all.filter((m) => q.before === undefined || Date.parse(m.timestamp) < q.before).slice(-q.limit) });
    const dispatcher = dispatcherFor(SERVER, [ASKER], { 'topic-history-pull': (c) => pool(c as never) });
    const app = express();
    app.use(express.json());
    app.use(requireToken('server-token-secret-value'));
    app.use(createRoutes({ config: { authToken: 'server-token-secret-value', stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher } as never));
    const server = await listen(app, dir);
    const a = await askingMachine({ server });
    const p1 = await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&limit=50`);
    const m1 = p1.body.messages as Array<Record<string, unknown>>;
    expect(m1.map((m) => m.eventId)).toEqual(['ev-3']);
    expect((p1.body.pool as { truncated: unknown[] }).truncated).toHaveLength(1);
    const page2 = `before=${Date.parse(String(m1[0].timestamp))}&beforeMessageId=3`;
    const p2 = await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&limit=50&${page2}`);
    const m2 = p2.body.messages as Array<Record<string, unknown>>;
    expect(m2.map((m) => m.eventId)).toEqual(['ev-2']);
    const cutRow = m2[0];
    const marker = cutRow.rowTruncated as { row: string; totalBytes: number; from: number; to: number };
    expect(marker).toMatchObject({ row: 'ev-2', from: 0, totalBytes: Buffer.byteLength(big) });
    expect(marker.to).toBeLessThan(marker.totalBytes);
    const pieces = [cutRow.text as string];
    let to = marker.to;
    for (let g = 0; to < marker.totalBytes && g < 20; g++) {
      const c = await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&limit=50&${page2}&machine=${SERVER}&row=ev-2&byteFrom=${to}`);
      expect(c.status).toBe(200);
      pieces.push((c.body.messages as Array<{ text: string }>)[0].text);
      to = (c.body.rowTruncated as { to: number }).to;
    }
    expect(pieces.join('')).toBe(big);
    // The next page by the oldest row received reaches the older row without the remainder.
    const p3 = await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&limit=50&before=${Date.parse(String(cutRow.timestamp))}&beforeMessageId=2`);
    expect((p3.body.messages as Array<Record<string, unknown>>).map((m) => m.eventId)).toEqual(['ev-1']);
    // A continuation without a machine is refused plainly.
    expect((await a.get(`/telegram/topics/${TOPIC}/messages?scope=pool&row=ev-2&byteFrom=0`)).status).toBe(400);
  });
});

describe('the serving machine\'s own route applies the audience too', () => {
  it('refuses the owner a local transcript whose conversation is private to someone else, and serves an ordinary one', async () => {
    const dir = fs.mkdtempSync(path.join(base(), 'prs-l-'));
    fs.mkdirSync(path.join(dir, 'state', 'team-access'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'team-access', 'confined.json'), JSON.stringify({ entries: [{ ref: 'telegram:9', personKey: 'member-key' }] }));
    const sessions: Record<string, Record<string, unknown>> = {
      'echo-private': { tmuxSession: 'echo-private', telegramTopicId: 9, claudeSessionId: 'x' },
      'echo-plain': { tmuxSession: 'echo-plain', telegramTopicId: 8 },
    };
    const ctx = { config: { authToken: 't', stateDir: dir, port: 0, projectDir: dir }, stateDir: dir, state: { findSessionByTmux: (n: string) => sessions[n] ?? null } } as never;
    const app = express();
    app.use(createRoutes(ctx));
    const srv = await listen(app, dir);
    const priv = await fetch(`${srv.url}/sessions/echo-private/transcript`);
    expect(priv.status).toBe(403);
    expect((await priv.json() as { error: string }).error).toBe('This session serves a conversation that is private to someone else.');
    // The ordinary session passes the audience and reaches the record lookup.
    const plain = await fetch(`${srv.url}/sessions/echo-plain/transcript`);
    expect(plain.status).toBe(404);
    expect((await plain.json() as { reason: string }).reason).toBe('no-transcript');
  });
});
