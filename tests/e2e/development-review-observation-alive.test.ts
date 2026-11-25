import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createMockSessionManager, createTempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

describe('development review observation lifecycle', () => {
  it('launches the review and exposes observed roster and late exact-session usage', async () => {
    const project = createTempProject();
    cleanup.push(project.cleanup);
    const slug = 'overseer-development';
    const jobsFile = path.join(project.stateDir, 'jobs.json');
    const manifests = path.join(project.stateDir, 'jobs', 'schedule');
    const bodies = path.join(project.stateDir, 'jobs', 'instar');
    fs.mkdirSync(manifests, { recursive: true });
    fs.mkdirSync(bodies, { recursive: true });
    fs.writeFileSync(jobsFile, '[]');
    fs.copyFileSync(new URL('../../src/scaffold/templates/jobs/instar/overseer-development.md', import.meta.url),
      path.join(bodies, slug + '.md'));
    fs.writeFileSync(path.join(manifests, slug + '.json'), JSON.stringify({
      slug, origin: 'instar', schedule: '0 0 1 1 *', priority: 'low', model: 'haiku',
      expectedDurationMinutes: 1, enabled: true, execute: { type: 'agentmd' },
    }));
    const sessions = createMockSessionManager();
    const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1,
      allowOnThrowawayAgent: true, startupGraceMs: 120_000,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, sessions as never, project.state, project.stateDir);
    let observe = true;
    scheduler.setConfigReader(() => ({ jobs: { observeEmptyDevelopmentReview: observe } }));
    scheduler.start();
    cleanup.push(() => scheduler.stop());
    const config = { projectName: 'development-review-test', projectDir: project.dir,
      stateDir: project.stateDir, port: 0, authToken: 'development-review-test',
      scheduler: { enabled: false }, monitoring: {}, messaging: [] } as InstarConfig;
    const server = new AgentServer({ config, state: project.state, scheduler, sessionManager: sessions as never });
    cleanup.push(() => server.stop());
    await server.start();
    const ledger = server.getTokenLedger();
    expect(ledger).not.toBeNull();
    scheduler.setTokenLedger(ledger);
    const history = (endpoint = `/jobs/${slug}/history`) =>
      request(server.getApp()).get(endpoint).set('Authorization', 'Bearer development-review-test');
    expect((await request(server.getApp()).get(`/jobs/${slug}/history`)).status).toBe(401);
    expect(await scheduler.triggerJob(slug, 'scheduled')).toBe('triggered');
    expect(sessions._spawnCount).toBe(1);
    const first = (await history()).body.runs[0];
    expect(first.developmentReviewObservation).toEqual({ wouldSkip: true, actualUsage: null });

    const firstSession = sessions._sessions[0];
    firstSession.status = 'completed';
    ledger!.bindJobSessionTranscript(firstSession.id, 'fixture-transcript');
    ledger!.recordEvent({ requestId: 'fixture-call', sessionId: 'fixture-transcript', ts: Date.now(),
      inputTokens: 11, outputTokens: 7, cacheReadTokens: 100, cacheCreationTokens: 5, model: 'haiku' });
    const withUsage = await history(`/jobs/history?slug=${slug}`);
    expect(withUsage.status).toBe(200);
    expect(withUsage.body.runs[0]).toMatchObject({ runId: first.runId, developmentReviewObservation: {
      wouldSkip: true, actualUsage: { modelCalls: 1, tokensIn: 11, tokensOut: 7, cacheRead: 100, cacheWrite: 5 },
    } });

    fs.writeFileSync(jobsFile, JSON.stringify([{
      slug: 'category-member', name: 'Category member', description: 'Fixture member',
      schedule: '0 0 1 1 *', priority: 'low', expectedDurationMinutes: 1, model: 'haiku',
      enabled: false, tags: ['cat:development'], execute: { type: 'prompt', value: 'Fixture' },
    }]));
    expect(await scheduler.triggerJob(slug, 'scheduled')).toBe('triggered');
    expect(sessions._spawnCount).toBe(2);
    expect((await history()).body.runs[0].developmentReviewObservation).toEqual({ wouldSkip: false, actualUsage: null });
    sessions._sessions[1].status = 'completed';
    fs.writeFileSync(path.join(manifests, 'another-job.json'), '{');
    expect(await scheduler.triggerJob(slug, 'scheduled')).toBe('triggered');
    expect(sessions._spawnCount).toBe(3);
    expect((await history()).body.runs[0].developmentReviewObservation).toEqual({ wouldSkip: null, actualUsage: null });
    sessions._sessions[2].status = 'completed';
    observe = false;
    expect(await scheduler.triggerJob(slug, 'scheduled')).toBe('triggered');
    expect(sessions._spawnCount).toBe(4);
    expect((await history()).body.runs[0]).not.toHaveProperty('developmentReviewObservation');
  });
});
