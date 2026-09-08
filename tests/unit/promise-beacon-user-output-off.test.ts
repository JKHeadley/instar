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
import {
  PromiseBeacon,
  type BeaconSendResult,
  type EscalationConfig,
  type ReviveResult,
} from '../../src/monitoring/PromiseBeacon.js';
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
    quietHours?: { start: string; end: string };
    maxDailyLlmSpendCents?: number;
    currentMachineId?: string;
    getSessionForTopic?: (topicId: number) => string | null;
    getSessionEpoch?: (sessionName: string) => string | null;
    escalation?: EscalationConfig;
    requestRevive?: () => Promise<ReviveResult>;
  }): PromiseBeacon {
    return new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: tracker,
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'new terminal output',
      getSessionForTopic: opts.getSessionForTopic ?? (() => 'sess-1'),
      isSessionAlive: () => true,
      getSessionEpoch: opts.getSessionEpoch,
      sendMessage: async (_topicId, text) => { opts.sent.push(text); },
      raiseAttention: (_id, detail) => { opts.attention.push(detail); },
      generateStatusLine: async () => {
        if (opts.generated) opts.generated.count += 1;
        return 'generated summary';
      },
      agentOwnedFollowthrough: opts.agentOwnedFollowthrough,
      now: opts.now,
      quietHours: opts.quietHours,
      maxDailyLlmSpendCents: opts.maxDailyLlmSpendCents,
      currentMachineId: opts.currentMachineId,
      escalation: opts.escalation,
      requestRevive: opts.requestRevive,
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

  it('keeps internal cadence bookkeeping alive through output-only quiet-hours and spend gates', async () => {
    const sent: string[] = [];
    const attention: string[] = [];
    const generated = { count: 0 };
    const now = Date.parse('2026-09-06T05:51:00.000Z');
    const beacon = makeBeacon({
      sent,
      attention,
      generated,
      now: () => now,
      quietHours: { start: '22:00', end: '08:00' },
      maxDailyLlmSpendCents: 0,
    });
    beacon.start();
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'finish the quiet-hours work',
      agentResponse: 'I will report back',
      topicId: 42,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2026-09-06T05:50:00.000Z',
    });

    await beacon.fire(c.id);

    expect(sent).toEqual([]);
    expect(attention).toEqual([]);
    expect(generated.count).toBe(0);
    expect(tracker.get(c.id)).toMatchObject({
      status: 'pending',
      lastHeartbeatAt: '2026-09-06T05:51:00.000Z',
    });
    expect(tracker.get(c.id)?.beaconSuppressed).not.toBe(true);
    beacon.stop();
  });

  it('remains cadence-bounded across repeated output-off fires under quiet hours and exhausted spend', async () => {
    const sent: string[] = [];
    const attention: string[] = [];
    const generated = { count: 0 };
    let now = Date.parse('2026-09-06T05:51:00.000Z');
    const beacon = makeBeacon({
      sent,
      attention,
      generated,
      now: () => now,
      quietHours: { start: '22:00', end: '08:00' },
      maxDailyLlmSpendCents: 0,
    });
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'finish the quiet-hours work',
      agentResponse: 'I will report back',
      topicId: 42,
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2026-09-06T05:50:00.000Z',
    });

    await beacon.fire(c.id);
    const firstHeartbeatAt = tracker.get(c.id)?.lastHeartbeatAt;
    now += 60_000;
    await beacon.fire(c.id);

    expect(firstHeartbeatAt).toBe('2026-09-06T05:51:00.000Z');
    expect(tracker.get(c.id)?.lastHeartbeatAt).toBe('2026-09-06T05:52:00.000Z');
    expect(sent).toEqual([]);
    expect(attention).toEqual([]);
    expect(generated.count).toBe(0);
  });

  it('updates only the owning machine while output is off', async () => {
    const sent: string[] = [];
    const attention: string[] = [];
    const ownerBeacon = makeBeacon({
      sent,
      attention,
      currentMachineId: 'machine-a',
      now: () => Date.parse('2026-09-06T05:51:00.000Z'),
    });
    const nonOwnerBeacon = makeBeacon({
      sent,
      attention,
      currentMachineId: 'machine-b',
      now: () => Date.parse('2026-09-06T05:52:00.000Z'),
    });
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'finish owner-scoped work',
      agentResponse: 'I will report back',
      topicId: 42,
      ownerMachineId: 'machine-a',
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2026-09-06T05:50:00.000Z',
    });

    await nonOwnerBeacon.fire(c.id);
    expect(tracker.get(c.id)?.lastHeartbeatAt).toBeUndefined();

    await ownerBeacon.fire(c.id);
    expect(tracker.get(c.id)?.lastHeartbeatAt).toBe('2026-09-06T05:51:00.000Z');
    expect(sent).toEqual([]);
    expect(attention).toEqual([]);
  });

  it('keeps session-loss revival internal through quiet hours and exhausted spend', async () => {
    const sent: string[] = [];
    const attention: string[] = [];
    const generated = { count: 0 };
    let reviveCalls = 0;
    const beacon = makeBeacon({
      sent,
      attention,
      generated,
      now: () => Date.parse('2026-09-06T05:51:00.000Z'),
      quietHours: { start: '22:00', end: '08:00' },
      maxDailyLlmSpendCents: 0,
      getSessionEpoch: () => 'NEW-EPOCH',
      escalation: { enabled: true, dryRun: false },
      requestRevive: async () => {
        reviveCalls += 1;
        return { sessionName: 'revived-session' };
      },
    });
    const c = tracker.record({
      type: 'one-time-action',
      userRequest: 'recover the overnight executor',
      agentResponse: 'I will keep the work alive',
      topicId: 42,
      sessionEpoch: 'OLD-EPOCH',
      beaconEnabled: true,
      cadenceMs: 60_000,
      nextUpdateDueAt: '2026-09-06T05:50:00.000Z',
    });

    await beacon.fire(c.id);

    expect(reviveCalls).toBe(1);
    expect(tracker.get(c.id)).toMatchObject({
      status: 'pending',
      escalationAttempts: 1,
      escalationInFlight: true,
    });
    expect(sent).toEqual([]);
    expect(attention).toEqual([]);
    expect(generated.count).toBe(0);
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
