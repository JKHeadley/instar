// safe-git-allow: initialize only a throwaway source fixture; no network git operations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import type { InstarConfig } from '../../src/core/types.js';

export const FEEDBACK_RUNTIME_AUTH = 'fixture-feedback-runtime-auth';

export async function settledFeedbackRuntimeTick(server: AgentServer, headers: Record<string, string>) {
  const tick = await request(server.getApp()).post('/feedback-factory/execute/tick').set(headers);
  let status = await request(server.getApp()).get('/feedback-factory/execute/status').set(headers);
  for (let tries = 0; tries < 100 && status.body.lastTick?.runId !== tick.body.runId; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await request(server.getApp()).get('/feedback-factory/execute/status').set(headers);
  }
  return { tick, status };
}

/** Only the GitHub executable and sandbox availability are external test edges. */
export function feedbackGitHubRuntimeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-runtime-server-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'feedback-factory', 'store'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'runtime-fixture', authToken: FEEDBACK_RUNTIME_AUTH }));
  const source = path.join(root, 'source');
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture-owner/repo.git'], { cwd: source });
  const ghPath = path.join(root, 'gh');
  const marker = path.join(root, 'github-reads');
  fs.writeFileSync(ghPath, `#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, 'called\\n');
if(process.env.GH_TOKEN!=='fixture-vault-identity'||process.env.GITHUB_TOKEN!=='fixture-vault-identity') process.exit(1);
const a=process.argv.slice(2);
if(a[0]==='auth') console.log(JSON.stringify({hosts:{'github.com':[{login:'fixture-agent'}]}}));
else if(a[0]==='pr' && a[1]==='list') console.log(JSON.stringify([{number:17,title:'Fixture fix',body:'feedback-fixture',commits:[]}]));
else if(a[1]==='user') console.log(JSON.stringify({login:'fixture-agent'}));
else console.log(JSON.stringify({owner:{login:'fixture-owner',type:'User'},allow_auto_merge:true}));
`, { mode: 0o700 });
  const vault = new SecretStore({ stateDir, forceFileKey: true });
  const config = {
    projectName: 'runtime-fixture', projectDir: root, stateDir, port: 0, authToken: FEEDBACK_RUNTIME_AUTH,
    dashboardPin: '314159', developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    feedbackFactory: { processing: {}, drain: {}, consumer: { dryRun: true }, triage: {}, execute: { sourceRepoPath: source, dryRun: true, publishRepo: 'fixture-agent/repo' } },
  } as unknown as InstarConfig;
  function createServer(extra: Record<string, unknown> = {}) {
    return new AgentServer({
      ...extra,
      config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir),
      intelligence: { evaluate: async () => '{}' },
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
      feedbackTriageDeps: { quotaUsedPercent: async () => 5, secondOpinion: () => null },
      feedbackExecuteDeps: {
        runner: { available: () => ({ ok: true, version: 'fixture' }), run: async () => { throw new Error('No builds in availability proof'); } },
      } as never,
    });
  }
  return { root, stateDir, vault, ghPath, marker, createServer };
}
