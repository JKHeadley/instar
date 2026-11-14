// safe-git-allow: test-tmpdir-cleanup — isolated E2E state only.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TopicIntentStore, buildEvent } from '../../src/core/TopicIntent.js';
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';
import type { InstarConfig } from '../../src/core/types.js';

// This tests production wiring + verdict lifecycle, not model accuracy. The
// actual incident's semantic replay is recorded separately in the case study.
describe('topic-goal completion on the production AgentServer path', () => {
  it('keeps the run active for a rejected milestone, then terminalizes only the independent MET verdict', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-goal-e2e-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    const store = new TopicIntentStore(stateDir);
    const file = store.read(135786);
    file.refs.goal = { refId: 'goal', arcId: 'services', topicId: 135786, kind: 'goal',
      text: 'Offer all nine services, including Bitwarden. Jev is optional.', confidence: 0.4, status: 'live',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastReinforcedAt: new Date().toISOString(),
      evidence: [buildEvent('goal', 'extract-user', '137154')] };
    store.save(file);
    const prompts: string[] = []; let reply = 'NOT_MET\nDisclose missing proactive offers and other services.';
    const config = { projectName: 'e2e', projectDir: dir, stateDir, port: 0, authToken: 'test-goal',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {} } as InstarConfig;
    const server = new AgentServer({ config, state: new StateManager(stateDir), topicIntentStore: store,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] } as never,
      completionEvaluator: new CompletionEvaluator({ intelligence: { async evaluate(p) { prompts.push(p); return reply; } } }) });
    try {
      const app = server.getApp();
      const post = (route: string, body: unknown) => request(app).post(route).set('Authorization', 'Bearer test-goal').send(body);
      const registered = await post('/autonomous/register', { topicId: '135786', condition: 'Prove Jev and Tailscale',
        workDir: dir, endAt: new Date(Date.now() + 60_000).toISOString() });
      expect(registered.status).toBe(200);
      expect(registered.body.topicGoalContext).toContain('Bitwarden');
      const body = { topicId: '135786', runId: registered.body.runId, condition: 'Prove Jev and Tailscale' };
      const rejected = await post('/autonomous/evaluate-completion', { ...body, transcriptTail: 'Both services proven. All work finished.' });
      expect(rejected.status).toBe(200); expect(rejected.body.met).toBe(false);
      expect(prompts[0]).toContain('Offer all nine services, including Bitwarden');
      expect(prompts[0]).toContain('optional');
      reply = 'MET\nOnly the declared proof milestone is complete; the final report leads with the remaining program gaps.';
      const accepted = await post('/autonomous/evaluate-completion', { ...body,
        transcriptTail: 'PARTIAL: proactive offers and seven recipes remain. This run only proves Jev and Tailscale; both live proofs passed.' });
      expect(accepted.body.met).toBe(true);
      const nextRun = await post('/autonomous/register', { topicId: '135786', condition: 'Build remaining services', workDir: dir });
      expect(nextRun.status).toBe(200); // previous run was terminalized by MET
    } finally { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
