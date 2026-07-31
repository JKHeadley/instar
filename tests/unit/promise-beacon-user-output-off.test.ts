/**
 * PromiseBeacon is internal infrastructure by default. Human-facing summaries,
 * close-outs, escalation statuses, and Attention dead-letters require an
 * explicit opt-in; tracking and internal state transitions continue while off.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMigrationDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CommitmentTracker, type Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { PromiseBeacon, type BeaconSendResult } from '../../src/monitoring/PromiseBeacon.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';

describe('PromiseBeacon user output authority', () => {
  let dir: string;
  let tracker: CommitmentTracker;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-beacon-output-off-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/promise-beacon-user-output-off.test.ts',
    });
  });

  function commitment(over: Partial<Commitment> = {}): Commitment {
    return {
      id: 'CMT-OFF-1',
      userRequest: 'finish the work',
      agentResponse: 'I will report back',
      type: 'one-time-action',
      status: 'pending',
      createdAt: new Date().toISOString(),
      verificationCount: 0,
      violationCount: 0,
      topicId: 42,
      owner: 'agent',
      blockedOn: 'none',
      ...over,
    } as Commitment;
  }

  function makeBeacon(opts: {
    userOutputEnabled?: boolean;
    sent: string[];
    attention: string[];
    generated?: { count: number };
    agentOwnedFollowthrough?: () => { enabled: boolean; dryRun: boolean };
    now?: () => number;
  }): PromiseBeacon {
    return new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'new terminal output',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (_topicId, text) => { opts.sent.push(text); },
      raiseAttention: (_id, detail) => { opts.attention.push(detail); },
      generateStatusLine: async () => {
        if (opts.generated) opts.generated.count += 1;
        return 'generated summary';
      },
      agentOwnedFollowthrough: opts.agentOwnedFollowthrough,
      now: opts.now,
      ...(opts.userOutputEnabled === undefined
        ? {}
        : { userOutputEnabled: opts.userOutputEnabled }),
    });
  }

  const emit = (beacon: PromiseBeacon, c: Commitment, kind: 'heartbeat' | 'terminal') =>
    (beacon as unknown as {
      emitUserSend: (commitment: Commitment, text: string, messageKind: string) => Promise<BeaconSendResult>;
    }).emitUserSend(c, 'summary text', kind);

  it('missing output config suppresses both conversation sends and terminal Attention', async () => {
    const sent: string[] = [];
    const attention: string[] = [];
    const beacon = makeBeacon({ sent, attention });
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'finish the work',
      agentResponse: 'I will report back',
      topicId: 42,
      owner: 'agent',
      blockedOn: 'none',
    });

    expect(await emit(beacon, c, 'heartbeat')).toBe('suppressed-user-output-disabled');
    expect(await emit(beacon, c, 'terminal')).toBe('suppressed-user-output-disabled');
    await (beacon as unknown as { rung3: (row: Commitment) => Promise<void> }).rung3(c);

    expect(sent).toEqual([]);
    expect(attention).toEqual([]);
    expect(tracker.get(c.id)?.status).toBe('violated');
  });

  it('keeps cadence bookkeeping internal and spends no summary LLM work while output is off', async () => {
    const sent: string[] = [];
    const attention: string[] = [];
    const generated = { count: 0 };
    const beacon = makeBeacon({ sent, attention, generated });
    beacon.start();
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'finish the work',
      agentResponse: 'I will report back',
      topicId: 42,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2099-01-01T00:00:00Z',
    });

    await beacon.fire(c.id);

    expect(sent).toEqual([]);
    expect(attention).toEqual([]);
    expect(generated.count).toBe(0);
    expect(tracker.get(c.id)?.status).toBe('pending');
    expect(tracker.get(c.id)?.lastHeartbeatAt).toBeTruthy();
    beacon.stop();
  });

  it('allows the old delivery path only after explicit opt-in', async () => {
    const sent: string[] = [];
    const attention: string[] = [];
    const beacon = makeBeacon({ userOutputEnabled: true, sent, attention });

    expect(await emit(beacon, commitment(), 'heartbeat')).toBe('sent');
    expect(sent).toEqual(['summary text']);
  });

  it('does not stamp a user-facing external dead-letter when Attention is suppressed', async () => {
    const sent: string[] = [];
    const attention: string[] = [];
    const now = Date.parse('2026-07-31T20:00:00.000Z');
    const beacon = makeBeacon({
      sent,
      attention,
      now: () => now,
      agentOwnedFollowthrough: () => ({ enabled: true, dryRun: false }),
    });
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'wait for the dependency',
      agentResponse: 'I will finish after it arrives',
      topicId: 42,
      owner: 'agent',
      blockedOn: 'external',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    await beacon.sweepExternalBlocks();

    expect(attention).toEqual([]);
    expect(tracker.get(c.id)?.externalBlockDeadLetteredAt).toBeUndefined();
  });

  it('backfills existing configs to output-off without overwriting an explicit opt-in', () => {
    const defaults = getMigrationDefaults('managed-project');
    const existing = { promiseBeacon: { aggregateByTopic: true } } as Record<string, unknown>;
    applyDefaults(existing, defaults);
    expect(existing).toMatchObject({ promiseBeacon: { userOutputEnabled: false } });

    const optedIn = { promiseBeacon: { userOutputEnabled: true } } as Record<string, unknown>;
    applyDefaults(optedIn, defaults);
    expect(optedIn).toMatchObject({ promiseBeacon: { userOutputEnabled: true } });
  });

  it('wires missing config as off at the production constructor boundary', () => {
    const serverSource = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(serverSource).toContain(
      'userOutputEnabled: promiseBeaconCfg.userOutputEnabled === true',
    );
  });
});
