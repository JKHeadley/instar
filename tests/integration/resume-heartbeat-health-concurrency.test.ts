// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration — the resume heartbeat must not block a concurrent /health.
 *
 * The 2026-10-13 freeze: the heartbeat sent a stale Claude id into a
 * synchronous stat-every-file walk of a 286,984-file Codex archive, the event
 * loop stalled ~25 s a minute, /health timed out, and the supervisor restarted
 * a healthy server three times. This drives the PRODUCTION tick
 * (`runResumeHeartbeatTick`) against a real `AgentServer` over HTTP with a
 * large synthetic archive and proves, from the lookup's own counters and the
 * measured /health latency, that:
 *   - a claude-code session never reads the Codex archive at all;
 *   - a session with no framework tag costs bounded work, never a per-file
 *     stat, and the async remainder leaves the event loop responsive;
 *   - /health answers quickly throughout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import type { InstarConfig } from '../../src/core/types.js';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { runResumeHeartbeatTick } from '../../src/core/ResumeHeartbeat.js';
import {
  SYNC_SCAN_NAME_BUDGET,
  pendingRolloutLookup,
  resetRolloutLookupState,
  rolloutLookupStats,
} from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager, createTempProject, type TempProject } from '../helpers/setup.js';
import { buildLargeArchive, makeFakeHome, startEventLoopLagProbe, uuidV4Like, writeTmuxStub } from '../helpers/codexArchiveFixture.js';

const STALE_CLAUDE_ID = 'ba7cbe23-6ce3-4eb1-a924-c6b2271bd0d4';
const STALE_UNTAGGED_ID = uuidV4Like(8080);
const PER_PARTITION = 1000;
const PARTITIONS = Math.ceil(SYNC_SCAN_NAME_BUDGET / PER_PARTITION) + 5;

function archiveReads(): number {
  const s = rolloutLookupStats();
  return s.hintedPartitionReads + s.syncDirectoryReads + s.asyncEnumerations + s.asyncDirectoryReads;
}

describe('resume heartbeat vs /health (integration)', () => {
  const token = 'resume-heartbeat-health-token';
  let home: string;
  let priorHome: string | undefined;
  let project: TempProject;
  let server: AgentServer;
  let resumeMap: TopicResumeMap;
  const sessions = createMockSessionManager();

  beforeAll(async () => {
    home = makeFakeHome('resume-hb-int-');
    priorHome = process.env.HOME;
    process.env.HOME = home;
    buildLargeArchive(home, { partitions: PARTITIONS, perPartition: PER_PARTITION });
    resetRolloutLookupState();

    project = createTempProject();
    const config: InstarConfig = {
      projectName: 'resume-hb', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: token,
      requestTimeoutMs: 5000, version: '1.3.1349',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 4, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000, projectDir: project.dir, tmuxPath: writeTmuxStub(home) },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    resumeMap = new TopicResumeMap(config.stateDir, config.sessions.projectDir, config.sessions.tmuxPath);
    server = new AgentServer({ config, sessionManager: sessions as never, state: project.state, topicResumeMap: resumeMap });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    project.cleanup();
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    resetRolloutLookupState();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/resume-heartbeat-health-concurrency.test.ts:cleanup' });
  });

  async function healthLatencyMs(): Promise<number> {
    const t0 = performance.now();
    const res = await request(server.getApp()).get('/health');
    expect(res.status).toBe(200);
    return performance.now() - t0;
  }

  function tick(topicSessions: Array<[number, string]>): void {
    runResumeHeartbeatTick({
      topicResumeMap: resumeMap,
      listRunningSessions: () => sessions.listRunningSessions(),
      telegramTopicSessions: () => topicSessions,
    });
  }

  it('a claude-code session with a stale id: three ticks, zero Codex archive reads, /health stays fast, the mapping is kept', async () => {
    sessions._sessions.length = 0;
    sessions._sessions.push({ id: 's1', name: 'echo-instar-agent-management', status: 'running', tmuxSession: 'echo-instar-agent-management', startedAt: new Date().toISOString(), claudeSessionId: STALE_CLAUDE_ID, framework: 'claude-code' } as never);
    resumeMap.save(61449, STALE_CLAUDE_ID, 'echo-instar-agent-management');
    const before = resumeMap.getEntryRaw(61449);

    const latencies: number[] = [];
    for (let i = 0; i < 3; i++) {
      tick([[61449, 'echo-instar-agent-management']]);
      latencies.push(await healthLatencyMs());
    }
    expect(archiveReads()).toBe(0);
    expect(rolloutLookupStats().statCalls).toBe(0);
    expect(Math.max(...latencies)).toBeLessThan(500);
    expect(resumeMap.getEntryRaw(61449)).toEqual(before);
    expect(fs.existsSync(path.join(project.stateDir, 'topic-resume-map.json'))).toBe(true);
  });

  it('a session with NO framework tag and a stale id: bounded sync work, no per-file stat, async remainder keeps /health responsive', async () => {
    resetRolloutLookupState();
    sessions._sessions.length = 0;
    sessions._sessions.push({ id: 's2', name: 'echo-legacy', status: 'running', tmuxSession: 'echo-legacy', startedAt: new Date().toISOString(), claudeSessionId: STALE_UNTAGGED_ID } as never);

    const probe = startEventLoopLagProbe(5);
    const t0 = performance.now();
    tick([[9210, 'echo-legacy']]);
    const tickMs = performance.now() - t0;
    const firstHealth = await healthLatencyMs();

    const s = rolloutLookupStats();
    expect(s.syncBudgetExhausted).toBe(1);
    expect(s.syncNamesScanned).toBeLessThanOrEqual(SYNC_SCAN_NAME_BUDGET + PER_PARTITION);
    expect(s.statCalls).toBeLessThanOrEqual(3);
    expect(tickMs).toBeLessThan(1000);

    // The async remainder runs while /health keeps answering.
    const pending = pendingRolloutLookup(STALE_UNTAGGED_ID);
    expect(pending).not.toBeNull();
    const concurrent: number[] = [];
    const poller = (async () => {
      for (let i = 0; i < 5; i++) concurrent.push(await healthLatencyMs());
    })();
    expect(await pending).toBeNull();
    await poller;
    const worstLag = probe.stop();
    expect(worstLag).toBeLessThan(250);
    expect(Math.max(firstHealth, ...concurrent)).toBeLessThan(500);
    expect(rolloutLookupStats().asyncDirectoryReads).toBe(PARTITIONS);

    // The next ticks answer from the remembered miss: no further archive reads.
    const settled = rolloutLookupStats();
    tick([[9210, 'echo-legacy']]);
    tick([[9210, 'echo-legacy']]);
    const after = rolloutLookupStats();
    expect(after.syncDirectoryReads).toBe(settled.syncDirectoryReads);
    expect(after.asyncEnumerations).toBe(settled.asyncEnumerations);
    expect(after.negativeHits).toBeGreaterThanOrEqual(settled.negativeHits + 2);
    expect(resumeMap.getEntryRaw(9210)).toBeNull(); // nothing substituted for a missing transcript
  });
});
