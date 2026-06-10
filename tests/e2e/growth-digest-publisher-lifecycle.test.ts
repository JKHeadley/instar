// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the GrowthDigestPublisher
 * (Slice 2). Boots the REAL AgentServer (the path server.ts uses) and proves the
 * publisher is constructed + started + wired to the REAL analyst on the production
 * init path — and that the construction gate (analyst present AND digestDelivery
 * !== 'off') holds on both sides.
 *
 *  - LIVE: dev-agent config + digestDelivery:'live' + Updates topic + a seeded
 *    stalling initiative → driving one cycle lands exactly one growth check-in in
 *    the Updates topic, end-to-end through the production guarded funnel.
 *  - OFF: digestDelivery:'off' → the publisher is NOT constructed (null).
 *  - NO ANALYST: no initiativeTracker → analyst null → publisher null even at
 *    digestDelivery:'live'.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const UPDATES_TOPIC_ID = 9091;

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

// A stalling-initiative tracker (only the analyst's Pick<list|digest> surface is
// used; failureLearning stays off so nothing else touches it).
function fakeTracker() {
  return {
    list: () => [],
    digest: (now: Date) => ({
      generatedAt: now.toISOString(),
      items: [{ initiativeId: 'feat-x', title: 'Feature X', reason: 'stale', detail: 'No movement in 18 days.' }],
    }),
  } as never;
}

function bootConfig(tmpDir: string, stateDir: string, digestDelivery: 'off' | 'dry-run' | 'live'): InstarConfig {
  return {
    projectName: 'e2e',
    projectDir: tmpDir,
    stateDir,
    port: 0,
    authToken: 'test-e2e-growth-digest',
    requestTimeoutMs: 10000,
    version: '0.0.0',
    developmentAgent: true, // gate the analyst LIVE (dev-agent dark-feature gate)
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: { growthAnalyst: { digestDelivery, digestTimezone: 'UTC' } },
    updates: {},
  } as unknown as InstarConfig;
}

interface Booted {
  server: AgentServer;
  stateDir: string;
  tmpDir: string;
  sends: { topicId: number; text: string }[];
}

async function boot(digestDelivery: 'off' | 'dry-run' | 'live', opts: { withTracker?: boolean; withTopic?: boolean } = {}): Promise<Booted> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-digest-e2e-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

  const state = new StateManager(stateDir);
  if (opts.withTopic !== false) state.set('agent-updates-topic', UPDATES_TOPIC_ID);

  const sends: { topicId: number; text: string }[] = [];
  const telegram = {
    sendToTopic: async (topicId: number, text: string) => { sends.push({ topicId, text }); },
    sendMessage: async () => ({}),
    getTopicHistory: () => [],
    on: () => {},
    start: async () => {},
    stop: async () => {},
  } as never;

  const config = bootConfig(tmpDir, stateDir, digestDelivery);
  const server = new AgentServer({
    config,
    sessionManager: createMockSessionManager() as never,
    state,
    telegram,
    ...(opts.withTracker === false ? {} : { initiativeTracker: fakeTracker() }),
  } as never);
  await server.start();
  return { server, stateDir, tmpDir, sends };
}

describe('GrowthDigestPublisher E2E lifecycle — feature is alive', () => {
  let booted: Booted | undefined;
  afterEach(async () => {
    if (booted) {
      await booted.server.stop();
      SafeFsExecutor.safeRmSync(booted.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/growth-digest-publisher-lifecycle.test.ts' });
      booted = undefined;
    }
  });

  it('LIVE: constructed + started on the production path, sends one check-in to the Updates topic', async () => {
    booted = await boot('live');
    const pub = (booted.server as unknown as { growthDigestPublisher: { isStarted(): boolean; publishOnce: (n: Date, t: string) => Promise<void> } | null }).growthDigestPublisher;
    expect(pub).not.toBeNull();
    expect(pub!.isStarted()).toBe(true);

    // Drive one cycle through the REAL analyst + real guarded funnel.
    await pub!.publishOnce(new Date('2026-06-10T17:30:00.000Z'), 'manual');

    expect(booted.sends).toHaveLength(1);
    expect(booted.sends[0].topicId).toBe(UPDATES_TOPIC_ID);
    expect(booted.sends[0].text).toContain('Growth check-in');
    expect(booted.sends[0].text).toContain('Feature X');

    // The real audit sink wrote the durable record.
    const auditPath = path.join(booted.stateDir, 'logs', 'growth-digest.jsonl');
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((e: { action: string }) => e.action === 'sent')).toBe(true);
  });

  it('OFF: digestDelivery:"off" → the publisher is NOT constructed (construction gate)', async () => {
    booted = await boot('off');
    const pub = (booted.server as unknown as { growthDigestPublisher: unknown }).growthDigestPublisher;
    expect(pub).toBeNull();
  });

  it('NO ANALYST: no initiativeTracker → analyst null → publisher null even at "live"', async () => {
    booted = await boot('live', { withTracker: false });
    const pub = (booted.server as unknown as { growthDigestPublisher: unknown }).growthDigestPublisher;
    expect(pub).toBeNull();
  });
});
