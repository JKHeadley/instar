/**
 * Feature-is-alive proof for the native session screen (docs/specs/mobile-native-session-screen.md):
 * an AgentServer booted on its production path (development agent, mobile pairing on), a phone
 * paired through the real redeem/confirm path, and a running session record in the real
 * StateManager. The signed owner phone reads the session's pane (200, credentials redacted) and
 * types into it (200, once; the identical signed request is refused as a replay); a finished
 * session answers 404 with a plain reason; Bearer requests still reach the original handlers.
 * Wiring integrity: the device router is mounted before the main routes on the production server
 * and delegates to the real SessionManager surface (capture and send) and the real state.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, Session } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { NOT_RUNNING_REASON } from '../../src/server/mobileSessionTerminalRoutes.js';

const HOST = 'echo-session-screen-e2e.example.dev';
const TOKEN = 'e2e-token-session-screen';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-session-terminal-alive.test.ts' });
});

describe('native session screen — production wiring', () => {
  it('is alive: an owner phone reads and types into a running session; refusals are plain', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'session-screen-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
    const config = {
      projectName: 'session-screen-e2e', projectDir: dir, stateDir, port: 0, authToken: TOKEN, developmentAgent: true,
      mobilePairing: { multiRoute: { enabled: false } },
      tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
      threadline: { ownerName: 'Justin' },
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const captured: Array<{ tmux: string; lines: number }> = [];
    const typed: Array<{ tmux: string; text: string }> = [];
    sessionManager.captureOutputAsync = async (tmux: string, lines: number) => { captured.push({ tmux, lines }); return `working...\nBearer ${TOKEN}\n`; };
    sessionManager.sendInput = (tmux: string, text: string) => { typed.push({ tmux, text }); return true; };
    const state = new StateManager(stateDir);
    state.saveSession({ id: 'sess-1', name: 'echo-work', tmuxSession: 'echo-work', status: 'running', startedAt: '2026-11-03T20:00:00.000Z', jobSlug: undefined } as unknown as Session);
    state.saveSession({ id: 'sess-2', name: 'echo-old', tmuxSession: 'echo-old', status: 'completed', startedAt: '2026-11-03T10:00:00.000Z' } as unknown as Session);
    const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
    const server = new AgentServer({ config, sessionManager, state, initiativeTracker: new InitiativeTracker(stateDir), tunnel });
    servers.push(server);
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();

    // Pair a phone through the production redeem + confirm path.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', `Bearer ${TOKEN}`).set('X-Instar-AgentId', 'session-screen-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const sign = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      return { raw, time, sig: dev.sign(canonicalString(deviceId, HOST, method, p, time, raw)) };
    };
    const send = (method: 'GET' | 'POST', p: string, signedReq = sign(method, p, undefined)) => {
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', signedReq.time).set('X-Instar-Device-Sig', signedReq.sig);
      return signedReq.raw ? q.send(signedReq.raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', sign('POST', '/mobile/device/confirm', { code }))).body.status).toBe('active');

    // Read: 200 (alive, not 503 or 403), from the real state, via the real capture surface.
    const out = await send('GET', '/sessions/echo-work/output?lines=200');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ session: 'echo-work', sessionId: 'sess-1', tmuxSession: 'echo-work', startedAt: '2026-11-03T20:00:00.000Z' });
    expect(out.body.output).toContain('working...');
    expect(out.body.output).not.toContain(TOKEN);
    expect(captured).toEqual([{ tmux: 'echo-work', lines: 200 }]);

    // Type: 200 once; the identical signed request is a replay.
    const p = '/sessions/echo-work/input?sid=sess-1';
    const once = sign('POST', p, { text: 'continue please' });
    expect((await send('POST', p, once)).status).toBe(200);
    expect(typed).toEqual([{ tmux: 'echo-work', text: 'continue please' }]);
    const again = await send('POST', p, once);
    expect([401, 409]).toContain(again.status); // the in-memory verifier (401) or the durable record (409)
    expect(typed).toHaveLength(1);
    expect(fs.existsSync(path.join(stateDir, 'logs', 'mobile-session-input.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'mobile-session-input-replay.json'))).toBe(true);

    // A finished session: a plain reason (single machine: not running).
    const old = await send('GET', '/sessions/echo-old/output');
    expect(old.status).toBe(404);
    expect(old.body).toEqual({ error: 'session-not-running', reason: NOT_RUNNING_REASON });

    // Bearer still reaches the original handlers (they read the same state through the session manager).
    const bearer = await auth(request(app).get('/sessions/echo-work/output'));
    expect(bearer.status).not.toBe(403);
    expect(bearer.body.sessionId).toBeUndefined();
  });
});
