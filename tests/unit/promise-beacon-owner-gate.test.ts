/**
 * Unit tests for the C1+C2 owner-gated outbound chokepoint
 * (PromiseBeacon.emitUserSend — spec agent-owned-followthrough §4.2/§4.8).
 *
 * Both sides of every boundary (Testing Integrity — semantic correctness):
 *   - feature OFF  → sends normally regardless of owner (current behavior).
 *   - on + dryRun  → logs the intended action but STILL sends (observe-first).
 *   - on + live + owner:'agent' + status kind → suppressed (no send).
 *   - on + live + owner:'agent' + terminal     → rerouted to the Attention
 *     dead-letter (raiseAttention), NEVER suppressed, NEVER a topic status send.
 *   - on + live + owner:'user'  → always sends (the user gets their messages).
 *   - terminal with NO topicId  → still surfaces via raiseAttention.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker, type Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { PromiseBeacon } from '../../src/monitoring/PromiseBeacon.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-owner-gate-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}, null, 2));
  return {
    dir,
    cleanup: () =>
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/promise-beacon-owner-gate.test.ts' }),
  };
}

function commitment(over: Partial<Commitment>): Commitment {
  return {
    id: 'CMT-001',
    userRequest: 'do x',
    agentResponse: 'on it',
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

describe('PromiseBeacon owner-gated chokepoint (emitUserSend)', () => {
  let dir: string;
  let cleanup: () => void;
  let sent: Array<{ topicId: number; text: string }>;
  let attention: Array<{ id: string; detail: string }>;
  let featureState: { enabled: boolean; dryRun: boolean };
  let beacon: PromiseBeacon;
  let events: string[];

  beforeEach(() => {
    ({ dir, cleanup } = tmpState());
    sent = [];
    attention = [];
    featureState = { enabled: false, dryRun: true };
    beacon = new PromiseBeacon({
      stateDir: dir,
      commitmentTracker: new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) }),
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => '',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (topicId, text) => { sent.push({ topicId, text }); },
      raiseAttention: (id, detail) => { attention.push({ id, detail }); },
      agentOwnedFollowthrough: () => featureState,
    });
    events = [];
    for (const e of ['aoft.suppressed', 'aoft.would-suppress', 'aoft.terminal-rerouted', 'aoft.would-reroute-terminal']) {
      beacon.on(e, () => events.push(e));
    }
  });
  afterEach(() => cleanup());

  const emit = (c: Commitment, kind: 'heartbeat' | 'closeOut' | 'rung2' | 'terminal') =>
    (beacon as unknown as { emitUserSend: (c: Commitment, t: string, k: string) => Promise<void> })
      .emitUserSend(c, 'msg', kind);

  it('feature OFF → sends normally even for an agent-owned status kind', async () => {
    featureState = { enabled: false, dryRun: false };
    await emit(commitment({ owner: 'agent' }), 'heartbeat');
    expect(sent).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('on + dryRun + owner:agent status → logs would-suppress but STILL sends', async () => {
    featureState = { enabled: true, dryRun: true };
    await emit(commitment({ owner: 'agent' }), 'heartbeat');
    expect(sent).toHaveLength(1);
    expect(events).toContain('aoft.would-suppress');
  });

  it('on + live + owner:agent status → SUPPRESSED (no send)', async () => {
    featureState = { enabled: true, dryRun: false };
    await emit(commitment({ owner: 'agent' }), 'heartbeat');
    expect(sent).toHaveLength(0);
    expect(events).toContain('aoft.suppressed');
  });

  it('on + live + owner:agent rung2 → SUPPRESSED', async () => {
    featureState = { enabled: true, dryRun: false };
    await emit(commitment({ owner: 'agent' }), 'rung2');
    expect(sent).toHaveLength(0);
    expect(events).toContain('aoft.suppressed');
  });

  it('on + live + owner:agent terminal → reroutes to Attention, never a topic send', async () => {
    featureState = { enabled: true, dryRun: false };
    await emit(commitment({ owner: 'agent' }), 'terminal');
    expect(sent).toHaveLength(0);
    expect(attention).toHaveLength(1);
    expect(events).toContain('aoft.terminal-rerouted');
  });

  it('on + live + owner:user status → always sends (the user gets their messages)', async () => {
    featureState = { enabled: true, dryRun: false };
    await emit(commitment({ owner: 'user' }), 'heartbeat');
    expect(sent).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('terminal with NO topicId still surfaces via Attention (never swallowed)', async () => {
    featureState = { enabled: true, dryRun: false };
    await emit(commitment({ owner: 'agent', topicId: undefined }), 'terminal');
    expect(sent).toHaveLength(0);
    expect(attention).toHaveLength(1);
  });
});
