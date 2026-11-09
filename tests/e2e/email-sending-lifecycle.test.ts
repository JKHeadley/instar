/**
 * Production-path proof (docs/specs/backup-email-sending.md, Testing — E2E): AgentServer builds the email sender
 * from its real wiring, its routes answer 200 (503 with no sender), the recipe is available only through the
 * proving list, and a scheduled job with `deliver: ['email']` goes through the real JobScheduler → outbox → transport
 * path with its run marked. Then the drill this row's `exercised` status names: email switched off on purpose and
 * the report arrives in the job's topic with its line. Also: a crash before admission is reconciled once, a restart
 * with Telegram down drains on the next start, and `deliver` is accepted by jobs.json and the AGENT.md manifest path.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import { loadJobs } from '../../src/scheduler/JobLoader.js';
import { validateManifest } from '../../src/scheduler/AgentMdJobLoader.js';
import { registerEmailRoutes } from '../../src/server/emailRoutes.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const servers: AgentServer[] = [];
const schedulers: JobScheduler[] = [];
const dirs: string[] = [];
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_e2e', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_e2e', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const AUTH = 'e2e-token';
const PIN = '123456';
const OWNER = 'owner@example.com';

// Resend, stood in at the network edge: the real transport, the real fetch call shape.
const resend = { sends: [] as Array<{ body: Record<string, unknown>; headers: Record<string, string> }>, lastEvent: 'delivered' };
const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.stubGlobal('fetch', (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) {
      if (u.endsWith('/domains')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (u.endsWith('/emails') && init.method === 'POST') {
        resend.sends.push({ body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify({ id: `msg_${resend.sends.length}` }), { status: 200 });
      }
      if (u.includes('/emails/msg_')) return new Response(JSON.stringify({ last_event: resend.lastEvent }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const s of schedulers) s.stop();
  for (const s of servers) { s.emailService?.stop(); await s.stop(); }
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/email-sending-lifecycle.test.ts' });
});

const JOB = { slug: 'daily-report', name: 'Daily Report', description: 'd', schedule: '0 9 * * *', priority: 'medium', expectedDurationMinutes: 5, model: 'sonnet', enabled: true, execute: { type: 'prompt', value: 'report' }, deliver: ['email'], telegramNotify: true, topicId: 501 };

function boot(extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'email-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const jobsFile = path.join(stateDir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify([JOB]));
  const config = {
    projectName: 'Echo', projectDir: dir, stateDir, port: 0, host: '127.0.0.1', version: '0.0.0', authToken: AUTH, dashboardPin: PIN,
    developmentAgent: true, recommendedServices: { provingRecipes: ['email-v1'] }, secrets: { forceFileKey: true },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile, maxParallelJobs: 1 }, messaging: [], updates: {}, ...extra,
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const state = new StateManager(stateDir);
  const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } } as never, sessionManager, state, stateDir);
  schedulers.push(scheduler);
  const topic = { sends: [] as Array<{ topicId: number; text: string }>, up: true };
  scheduler.setTelegram({
    sendToTopic: async (topicId: number, text: string) => { if (!topic.up) throw new Error('telegram down'); topic.sends.push({ topicId, text }); return { messageId: topic.sends.length }; },
    findOrCreateForumTopic: async () => ({ topicId: 501 }), closeForumTopic: async () => undefined,
  } as never);
  const ledger = new RecommendedServicesLedger({ stateDir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
  const server = new AgentServer({ config, sessionManager, state, scheduler, initiativeTracker: new InitiativeTracker(stateDir), recommendedServicesLedger: ledger } as any);
  servers.push(server);
  const secrets = new SecretStore({ stateDir, forceFileKey: true });
  return { server, scheduler, sessionManager, state, ledger, secrets, topic, config, stateDir };
}

async function ready(server: AgentServer) {
  await vi.waitFor(() => expect(server.emailService).not.toBeNull(), { timeout: 10_000 });
  return server.emailService!;
}

/** Runs the job once through the real scheduler, completing its session. */
async function runJob(b: ReturnType<typeof boot>) {
  await b.scheduler.triggerJob('daily-report', 'test');
  await new Promise((r) => setTimeout(r, 50));
  const session = b.sessionManager._sessions[b.sessionManager._sessions.length - 1];
  session.status = 'completed';
  b.state.saveSession(session);
  await b.scheduler.notifyJobComplete(session.id, session.tmuxSession);
  return new JobRunHistory(b.stateDir).query({ slug: 'daily-report' }).runs[0];
}

describe('email: production wiring', () => {
  it('is alive: the routes answer 200 from the real wiring, and the recipe is available only through the proving list', async () => {
    const b = boot();
    await ready(b.server);
    const app = b.server.getApp();
    const status = await request(app).get('/recommended-services/email/status').set('Authorization', `Bearer ${AUTH}`);
    expect(status.status).toBe(200);
    expect(status.body.state).toBe('not-set-up');
    expect((await request(app).get('/email/outbox').set('Authorization', `Bearer ${AUTH}`)).status).toBe(200);
    const list = await request(app).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(list.body.services.find((r: { service: string }) => r.service === 'email')).toMatchObject({ available: true, backupStatus: 'exercised' });
    const fleet = boot({ developmentAgent: false, recommendedServices: {} });
    const fleetList = await request(fleet.server.getApp()).get('/recommended-services').set('Authorization', `Bearer ${AUTH}`);
    expect(fleetList.body.services.find((r: { service: string }) => r.service === 'email').available).toBe(false);
  });

  it('answers 503 when no sender is built', async () => {
    const a = express();
    a.use(express.json());
    const router = express.Router();
    registerEmailRoutes(router, { service: () => null, originTopics: () => null, topicHasOtherReaders: () => false, hasGrant: () => false, checkConfirmPin: () => true, holdsLease: () => true });
    a.use(router);
    expect((await request(a).get('/email/outbox')).status).toBe(503);
    expect((await request(a).post('/email/send-to-owner').set('X-Instar-Request', '1').send({})).status).toBe(503);
  });

  it('a scheduled report goes through the scheduler, outbox and transport, marked on its run; then the drill: switched off, it arrives in the topic with its line', async () => {
    const b = boot();
    const svc = await ready(b.server);
    b.scheduler.start();
    // The owner's yes, as the confirm page writes it, and setup's stored credential.
    b.ledger.recordYes({ service: 'email', origin: 'person-asked', offerTextHash: 'x', grantMachine: 'm_e2e', principal: '42', recipientHash: svc.recipientHashOf(OWNER), timezone: 'UTC' });
    b.secrets.set('email_recipient', OWNER);
    b.secrets.set('email_sending', JSON.stringify({ shape: 'A', transport: 'resend', secret: 're_e2e' }));
    const app = b.server.getApp();
    // The proof through the real route, then the code through the real PIN check.
    const proof = await request(app).post('/recommended-services/email/prove').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(proof.body.result).toBe('waiting');
    const code = String(resend.sends[resend.sends.length - 1].body.text).match(/(\d{6})/)![1];
    expect((await request(app).post('/recommended-services/email/prove').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({})).body.result).toBe('waiting');
    // The confirm page holds no bearer token: the code route takes the PIN alone, through the real middleware.
    expect((await request(app).post('/recommended-services/email/code').set('X-Instar-Request', '1').send({ code, pin: 'wrong-pin' })).status).toBe(403);
    const entered = await request(app).post('/recommended-services/email/code').set('X-Instar-Request', '1').send({ code, pin: PIN });
    expect(entered.body).toEqual({ confirmed: true });
    expect((await request(app).post('/recommended-services/email/verify').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({})).body.result).toBe('pass');

    const before = resend.sends.length;
    const run = await runJob(b);
    expect(run.emailOutboxId).toMatch(/^em-run-[0-9a-f]{32}$/);
    await svc.idle();
    expect(resend.sends.length).toBe(before + 1);
    const sent = resend.sends[resend.sends.length - 1];
    expect(sent.body).toMatchObject({ to: [OWNER], subject: 'Echo: Daily Report: Done' });
    expect(sent.headers['Idempotency-Key']).toBe(run.emailOutboxId);
    await svc.poll(run.emailOutboxId!);
    expect(b.server.emailOutbox!.get(run.emailOutboxId!)?.status).toBe('delivered');
    expect(b.topic.sends).toHaveLength(0);

    // The drill: email switched off on purpose. The next report arrives in the job's topic with its line.
    (b.config as { email?: { enabled?: boolean } }).email = { enabled: false };
    const run2 = await runJob(b);
    await vi.waitFor(() => expect(b.server.emailOutbox!.get(run2.emailOutboxId!)?.status).toBe('fallen-back'), { timeout: 5000 });
    expect(resend.sends.length).toBe(before + 1);
    expect(b.topic.sends).toHaveLength(1);
    expect(b.topic.sends[0].topicId).toBe(501);
    expect(b.topic.sends[0].text).toContain('Daily Report');
    expect(b.topic.sends[0].text).toMatch(/I was asked to email you this/);
  });

  it('a crash before admission is reconciled exactly once; Telegram down at shutdown drains on the next start', async () => {
    const b = boot();
    await ready(b.server);
    b.scheduler.start();
    // A completed run of an emailing job with no marker: the bookkeeping crashed before the row.
    const history = new JobRunHistory(b.stateDir);
    const runId = history.recordStart({ slug: 'daily-report', sessionId: 's-crash', trigger: 'scheduled' } as never);
    history.recordCompletion({ runId, result: 'success' });
    b.topic.up = false;
    expect(b.scheduler.reconcileEmailReports(0)).toBe(1);
    expect(b.scheduler.reconcileEmailReports(0)).toBe(0);
    const id = new JobRunHistory(b.stateDir).query({ slug: 'daily-report' }).runs[0].emailOutboxId!;
    await vi.waitFor(() => expect(b.server.emailOutbox!.get(id)?.status).toBe('falling-back'));
    b.server.emailService!.stop();
    // The next start, Telegram back: recovery drains it.
    b.topic.up = true;
    const { buildEmailService } = await import('../../src/email/wireEmail.js');
    const next = buildEmailService({
      stateDir: b.stateDir, agentName: 'Echo', machineId: 'm_e2e', recipientKey: 'k', ledger: () => b.ledger,
      readSecret: () => null, holdsLease: () => true, detectCredential: () => false, config: () => ({}),
      jobs: () => b.scheduler.getJobs(), deliverJobReport: (job, text) => b.scheduler.deliverJobReport(job, text),
    });
    next.service.recover();
    await vi.waitFor(() => expect(next.outbox.get(id)?.status).toBe('fallen-back'));
    expect(b.topic.sends.some((s) => s.topicId === 501)).toBe(true);
    next.service.stop();
  });

  it('deliver is accepted by jobs.json and by the AGENT.md manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-e2e-jobs-'));
    dirs.push(dir);
    const file = path.join(dir, 'jobs.json');
    fs.writeFileSync(file, JSON.stringify([JOB]));
    expect(loadJobs(file)[0].deliver).toEqual(['email']);
    expect(validateManifest({ ...JOB, origin: 'user' }).deliver).toEqual(['email']);
  });
});
