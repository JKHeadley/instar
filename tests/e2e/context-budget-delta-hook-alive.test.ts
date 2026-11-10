// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the per-prompt delta hook is ALIVE on the production path
 * (context-budget-layered-summaries §7.7; Phase 1 S15): the real AgentServer,
 * given the layer store exactly as server.ts builds it (dev-gated), serves
 * GET /topic/:id/prompt-context (200, not 404/503) and
 * GET /context-budget/delta-shadow; the hook PostUpdateMigrator installs calls
 * that route against the listening server; and the shadow half of the plan
 * line "after a real compaction the first prompt does not receive the packet
 * and the briefing both": with the seed's own briefing fetch served by the
 * same server, the first prompt's delta omits the briefing while the session
 * (in shadow) still receives it. With the layers off, the route still serves
 * the full output and the summary is 503.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentServer } from '../../src/server/AgentServer.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { buildContextLayers, contextLayersEnabled } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { DeltaShadowLog, type ShadowPromptRow } from '../../src/monitoring/contextLayers/promptContext.js';
import { createTempProject, createMockSessionManager, type TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 515151;
const TOKEN = 'e2e-delta-token';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

describe('per-prompt delta hook — alive on the production path', () => {
  let project: TempProject | null = null;
  let server: AgentServer | null = null;
  afterEach(async () => { await server?.stop(); server = null; project?.cleanup(); project = null; });

  async function boot(developmentAgent: boolean) {
    project = createTempProject();
    const port = await freePort();
    const config = {
      projectName: 'e2e-delta', projectDir: project.dir, stateDir: project.stateDir, port, authToken: TOKEN, requestTimeoutMs: 5000, version: '0.0.0-e2e',
      developmentAgent,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, users: [],
    } as unknown as InstarConfig;
    fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify({ projectName: 'e2e-delta', port }));
    const topicIntentStore = new TopicIntentStore(project.stateDir);
    topicIntentStore.updateAwareness(T, {
      topic: { goal: 'prove S15', trend: 'on track', themes: ['e2e'] },
      recentArc: { goal: 'shadow', trend: 'on track', themes: ['e2e'] },
      currentWork: { goal: 'measure the delta', trend: 'on track', themes: ['e2e'] },
    }, { messageId: 1, messageText: 'go', fromUser: true, at: Date.now(), turn: 1 });
    // server.ts: the layer store, gated exactly as at boot.
    const contextLayers = contextLayersEnabled(config as never, undefined) ? buildContextLayers({ stateDir: project.stateDir }) : undefined;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: project.state, topicIntentStore, contextLayers } as never);
    await server.start();
    return { app: server.getApp(), port, stateDir: project.stateDir, home: project.dir };
  }

  it('dev agent: both routes answer 200, the installed hook calls the route, and the seed briefing is not sent twice (shadow)', async () => {
    const b = await boot(true);
    const r = await request(b.app).get(`/topic/${T}/prompt-context?session=sess-e2e-0`).set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.schema).toBe('prompt-context/1');
    expect(r.body.mode).toBe('full');
    expect(r.body.briefing).toContain('measure the delta');
    expect(r.body.shadow.basis).toBe('unseeded-full');
    expect((await request(b.app).get(`/topic/${T}/prompt-context`)).status).toBe(401);
    const s = await request(b.app).get('/context-budget/delta-shadow').set('Authorization', `Bearer ${TOKEN}`);
    expect(s.status).toBe(200);
    expect(s.body.prompts).toBe(1);
    expect(s.body.reduction).toEqual({ switchOn: false, allowed: false, reason: 'switch-off' });

    // A compaction: the recovery seed fetches the briefing from THIS server, then writes the marker.
    expect((await request(b.app).get(`/topic-intent/${T}/briefing`).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(200);
    await request(b.app).get(`/topic/context/${T}?recent=20`).set('Authorization', `Bearer ${TOKEN}`); // the seed's history fetch (503 here: no TopicMemory; still observed)
    const seededDir = path.join(b.stateDir, 'state', 'context-layers', '_seeded');
    fs.mkdirSync(seededDir, { recursive: true });
    fs.writeFileSync(path.join(seededDir, 'sess-e2e-1.json'), JSON.stringify({ sessionId: 'sess-e2e-1', epoch: '', source: 'compact', seededAt: Date.now() }));

    // The hook the update path installs, run against the listening server.
    const m = new PostUpdateMigrator({ projectDir: b.home, stateDir: b.stateDir, port: b.port, hasTelegram: true, projectName: 'e2e-delta' });
    m.migrate();
    const hook = path.join(b.stateDir, 'hooks', 'instar', 'telegram-topic-context.sh');
    expect(fs.readFileSync(hook, 'utf-8')).toContain('/prompt-context?session=');
    // Async: the server runs in THIS process, so a synchronous spawn would block it from answering.
    const run = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn('bash', [hook], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CLAUDE_PROJECT_DIR: b.home, INSTAR_AUTH_TOKEN: TOKEN } });
      let stdout = '';
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (c: string) => { stdout += c; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout }); });
      child.stdin.end(JSON.stringify({ prompt: `[telegram:${T}] next`, session_id: 'sess-e2e-1' }));
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('measure the delta'); // shadow: the session still receives the full output
    const rows = new DeltaShadowLog(b.stateDir).rows().filter((x): x is ShadowPromptRow => x.t === 'prompt' && x.session === 'sess-e2e-1');
    expect(rows).toHaveLength(1); // the hook's ONE request reached the route
    expect(rows[0].basis).toBe('seed');
    expect(rows[0].briefingIncluded).toBe(false); // the delta would not repeat the briefing the seed delivered
    expect(rows[0].omitted.some((o) => o.k === 'b')).toBe(true);
    expect(rows[0].returned).toBe('full');
  }, 60_000);

  it('fleet agent: the route still serves the full output (no shadow), the summary is 503', async () => {
    const b = await boot(false);
    const r = await request(b.app).get(`/topic/${T}/prompt-context?session=sess-f`).set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('full');
    expect(r.body.shadow).toBeNull();
    expect((await request(b.app).get('/context-budget/delta-shadow').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(503);
    expect(fs.existsSync(path.join(b.stateDir, 'state', 'context-layers', '_delta-shadow'))).toBe(false);
  });

  it('WIRED: AgentServer mounts the routes before the main routes and shares the briefing log with the briefing route', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/server/AgentServer.ts'), 'utf-8');
    const mount = src.indexOf('this.app.use(createPromptContextRoutes({');
    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(src.indexOf('    this.app.use(routes);'));
    expect(src).toContain('onBriefingServed: (topicId: number, text: string) => promptSeedFetches.noteBriefing(topicId, text),');
    expect(src).toContain("options.liveConfig?.get?.<boolean>('contextBudget.deltaHook.enabled', false) === true");
    expect(src).toContain('options.contextBudgetSentinel.status().canary');
  });
});
