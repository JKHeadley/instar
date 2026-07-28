// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — the Increment-C alert pipeline assembled the way AgentServer
 * wires it: gate events → SpendAlertEmitters → SpendAlertDispatcher →
 * TelegramSpendTopicChannel → (resolver ladder | durable relay | lifeline),
 * with the scrubbed jsonl audit. Wiring-integrity per TESTING-INTEGRITY-SPEC:
 * deps are real implementations (no no-ops), and the decision boundary is
 * exercised on both sides (dryRun soak vs live delivery; dedicated vs
 * lifeline; durable-relay vs direct).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SpendAlertDispatcher } from '../../src/core/SpendAlertDispatcher.js';
import { TelegramSpendTopicChannel } from '../../src/core/TelegramSpendTopicChannel.js';
import { SpendAlertResolver } from '../../src/core/SpendAlertResolver.js';
import { SpendAlertEmitters } from '../../src/core/SpendAlertEmitters.js';

let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-'));
  clock = Date.parse('2026-07-08T12:00:00Z');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/spend-alert-pipeline.test.ts' });
});

function assemble(opts: { dryRun: boolean; relayWorks?: boolean }) {
  const sent: Array<{ topicId: number; text: string }> = [];
  const enqueued: Array<{ topicId: number; text: string }> = [];
  const persistPath = path.join(dir, 'alert-topic.json');
  const auditPath = path.join(dir, 'logs', 'routing-spend-alerts.jsonl');
  const resolver = new SpendAlertResolver({
    configuredTopicId: () => undefined,
    readPersistedTopicId: () => {
      try {
        return (JSON.parse(fs.readFileSync(persistPath, 'utf-8')) as { topicId?: number }).topicId;
      } catch {
        return undefined;
      }
    },
    persistTopicId: (topicId) => fs.writeFileSync(persistPath, JSON.stringify({ topicId })),
    servingLeaseConfirmedAgoMs: () => 0, // single-machine: trivially the holder
    createTopic: async () => 4242,
    sendToTopic: async () => true,
    lifelineTopicId: () => 999,
    now,
  });
  const channel = new TelegramSpendTopicChannel({
    resolver,
    sendToTopic: async (topicId, text) => {
      sent.push({ topicId, text });
      return true;
    },
    lifelineTopicId: () => 999,
    enqueueDurable: opts.relayWorks
      ? (topicId, text) => {
          enqueued.push({ topicId, text });
          return true;
        }
      : undefined,
  });
  const dispatcher = new SpendAlertDispatcher({ channels: [channel], dryRun: opts.dryRun, auditPath, digestWindowMs: 20, now });
  const emitters = new SpendAlertEmitters({ dispatcher, machineId: 'm-int', now });
  return { emitters, dispatcher, sent, enqueued, auditPath, persistPath };
}

describe('spend-alert pipeline (integration)', () => {
  it('dryRun soak (FD-16 default): gate events produce audited would-sends, ZERO deliveries', async () => {
    const { emitters, sent, auditPath } = assemble({ dryRun: true });
    emitters.onGateEvent({ type: 'refusal', reason: 'cap-exceeded', keyRef: 'k1', door: 'openrouter-api', detail: 'daily: 24 + 8 > 25' });
    emitters.onGateEvent({ type: 'admit', keyRef: 'k1', door: 'openrouter-api', committedDayUsd: 20, committedLifetimeUsd: 20, dailyCapUsd: 25, lifetimeCapUsd: 60 });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(0);
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.decision === 'dry-run' && l.kind === 'cap-hit')).toBe(true);
    expect(lines.some((l) => l.decision === 'dry-run' && l.kind === 'cap-approach')).toBe(true);
  });

  it('live: a cap-hit rides the DURABLE relay into the resolver-created topic; the topic id persists (rung 2)', async () => {
    const { emitters, enqueued, sent, persistPath } = assemble({ dryRun: false, relayWorks: true });
    emitters.onGateEvent({ type: 'refusal', reason: 'cap-exceeded', keyRef: 'k1', door: 'openrouter-api', detail: 'x > cap' });
    await new Promise((r) => setTimeout(r, 30));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].topicId).toBe(4242); // resolver created ONCE...
    expect(JSON.parse(fs.readFileSync(persistPath, 'utf-8')).topicId).toBe(4242); // ...and persisted
    expect(sent).toHaveLength(0); // durable path handled it — no double-send
  });

  it('live: informational door-dark digests into ONE direct send; the audit trail is metadata-only', async () => {
    const { emitters, dispatcher, sent, auditPath } = assemble({ dryRun: false });
    emitters.onNatureRoutePlan({ dryRun: false, failClosed: true, resolution: { resolvedChain: 'JUDGE', swapTail: [{}] } });
    await new Promise((r) => setTimeout(r, 5));
    await dispatcher.flushDigest();
    expect(sent).toHaveLength(1);
    expect(sent[0].topicId).toBe(4242);
    expect(sent[0].text).toContain('JUDGE');
    const raw = fs.readFileSync(auditPath, 'utf-8');
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('sk-'); // no key-shaped substrings in the scrubbed audit
  });

  it('a dead relay + dead dedicated topic degrades to the LIFELINE — never a silent drop', async () => {
    const sentTopics: number[] = [];
    const resolver = new SpendAlertResolver({
      configuredTopicId: () => 42,
      readPersistedTopicId: () => undefined,
      persistTopicId: () => {},
      servingLeaseConfirmedAgoMs: () => 0,
      createTopic: async () => 42,
      sendToTopic: async () => true,
      lifelineTopicId: () => 999,
      now,
    });
    const channel = new TelegramSpendTopicChannel({
      resolver,
      sendToTopic: async (topicId) => {
        sentTopics.push(topicId);
        if (topicId === 42) throw new Error('dedicated topic deleted');
        return true;
      },
      lifelineTopicId: () => 999,
      enqueueDurable: () => false, // relay store unavailable
    });
    const dispatcher = new SpendAlertDispatcher({ channels: [channel], dryRun: false, now });
    const r = await dispatcher.dispatch({ kind: 'cap-hit', dedupeKey: 'k', text: 'critical' });
    expect(r.decision).toBe('sent-lifeline');
    expect(sentTopics).toEqual([42, 999]);
  });
});
