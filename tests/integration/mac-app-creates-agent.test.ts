/**
 * The installer and the server together (docs/specs/mac-app-creates-agent.md §A, §B): a finished
 * app install's ledger, `instar install --app-ticket --key`, and POST /mobile/local-owner-device on
 * the real AgentServer HTTP pipeline, including the lost-success recovery the app relies on.
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
import type { InstarConfig } from '../../src/core/types.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { readLocalOwnerTicket, writeLocalOwnerTicket } from '../../src/core/localOwnerTicket.js';
import { localOwnerProofMessage } from '../../src/server/mobileLocalOwnerDevice.js';
import { appTicketCommand } from '../../src/commands/install.js';

const PORT = 4798;
const HOST = `127.0.0.1:${PORT}`;
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mac-app-creates-agent.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mac-create-int-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'int machine' });
  const config = {
    projectName: 'scout', projectDir: dir, stateDir, port: PORT, authToken: 'int-token',
    mobilePairing: { enabled: true, multiRoute: { enabled: true }, native: { enabled: true } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
  servers.push(server);
  const ledger = { version: 1, installId: 'i', startedAt: '', updatedAt: '', status: 'complete', cursor: 'done', answers: { forApp: true }, completed: {}, appEnroll: { agentDir: dir, port: PORT } } as never;
  return { app: server.getApp(), stateDir, ledger };
}

function enroll(app: ReturnType<AgentServer['getApp']>, dev: ReturnType<typeof makeDevice>, ticket: string) {
  const timeMs = String(Date.now());
  return request(app).post('/mobile/local-owner-device').set('Host', HOST)
    .send({ ticket, publicKey: dev.publicKey, timeMs, proof: dev.sign(localOwnerProofMessage(HOST, dev.publicKey, ticket, timeMs)), label: 'Studio' });
}

describe('installer ticket → server route', () => {
  it('--app-ticket feeds the route; a lost success is recovered with a second ticket for the same key', async () => {
    const { app, stateDir, ledger } = await boot();
    const dev = makeDevice();
    expect(appTicketCommand(ledger, dev.publicKey)).toBe('complete');
    const first = await enroll(app, dev, readLocalOwnerTicket(stateDir)!.ticket);
    expect(first.status).toBe(200);
    expect(readLocalOwnerTicket(stateDir)).toBeNull();
    // The app never saw that answer: it asks for a fresh ticket with the same key and tries again.
    expect(appTicketCommand(ledger, dev.publicKey)).toBe('complete');
    const again = await enroll(app, dev, readLocalOwnerTicket(stateDir)!.ticket);
    expect(again.status).toBe(200);
    expect(again.body.deviceId).toBe(first.body.deviceId);
    // Another app's key gets no ticket at all.
    expect(appTicketCommand(ledger, makeDevice().publicKey)).toBe('failed');
  });

  it('a body over 4 KB is refused before the handler runs (the ticket is untouched)', async () => {
    const { app, stateDir } = await boot();
    writeLocalOwnerTicket(stateDir);
    const before = readLocalOwnerTicket(stateDir);
    const r = await request(app).post('/mobile/local-owner-device').set('Host', HOST).set('Content-Type', 'application/json').send(JSON.stringify({ ticket: 'x', pad: 'x'.repeat(8000) }));
    // The 4 KB parser refuses it (the server's shared error handler answers 500 for a too-large body).
    expect([413, 500]).toContain(r.status);
    expect(readLocalOwnerTicket(stateDir)).toEqual(before);
  });
});
