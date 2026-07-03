/**
 * deliverToConversation — the outbound funnel skeleton (spec
 * durable-conversation-identity §5/§5.1, §6.1 increment 1).
 *
 * The load-bearing §5.1 assertions: dryRun and fleet-dark return the SAME
 * typed `not-delivered` result the unresolvable path uses — NEVER
 * success-shaped (A Refusal Stays a Refusal / P18) — plus a would-deliver
 * audit line; a replicated-only entry carries NO delivery authority (KYP);
 * thread-level conversations deliver IN-THREAD.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationDelivery } from '../../src/core/deliverToConversation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('deliverToConversation (funnel skeleton)', () => {
  let dir: string;
  let registry: ConversationRegistry;
  let telegramSends: Array<{ topicId: number; text: string }>;
  let slackSends: Array<{ channelId: string; text: string; threadTs?: string }>;
  let audits: string[];
  let gate: { enabled: boolean; dryRun: boolean };

  const makeFunnel = (over?: Partial<Parameters<typeof createConversationDelivery>[0]>) =>
    createConversationDelivery({
      registry,
      followThrough: () => gate,
      sendTelegram: async (topicId, text) => {
        telegramSends.push({ topicId, text });
        return true;
      },
      sendSlack: async (channelId, text, threadTs) => {
        slackSends.push({ channelId, text, threadTs });
      },
      auditWouldDeliver: (line) => audits.push(line),
      ...over,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-funnel-'));
    registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm-test' });
    telegramSends = [];
    slackSends = [];
    audits = [];
    gate = { enabled: true, dryRun: false };
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/deliver-to-conversation.test.ts' });
    } catch {
      /* cleanup */
    }
  });

  it('id > 0 → today’s Telegram path, delivered', async () => {
    const deliver = makeFunnel();
    const outcome = await deliver(12476, 'hello');
    expect(outcome).toEqual({ delivered: true, outcome: 'delivered' });
    expect(telegramSends).toEqual([{ topicId: 12476, text: 'hello' }]);
    expect(slackSends).toHaveLength(0);
  });

  it('id < 0 resolved local-origin, gate LIVE → Slack send with channel + thread_ts (in-thread delivery)', async () => {
    const id = registry.mintForInbound('C0BA4F4E0FP:1751412345.123456').id!;
    const deliver = makeFunnel();
    const outcome = await deliver(id, 'heartbeat');
    expect(outcome).toEqual({ delivered: true, outcome: 'delivered' });
    expect(slackSends).toEqual([{ channelId: 'C0BA4F4E0FP', text: 'heartbeat', threadTs: '1751412345.123456' }]);
  });

  it('channel-level conversation delivers with NO thread_ts', async () => {
    const id = registry.mintForInbound('C0BA4F4E0FP').id!;
    const deliver = makeFunnel();
    await deliver(id, 'hi');
    expect(slackSends).toEqual([{ channelId: 'C0BA4F4E0FP', text: 'hi', threadTs: undefined }]);
  });

  it('fleet-dark → typed non-delivery (NOT success-shaped), nothing sent', async () => {
    gate = { enabled: false, dryRun: true };
    const id = registry.mintForInbound('C0BA4F4E0FP').id!;
    const deliver = makeFunnel();
    const outcome = await deliver(id, 'x');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('follow-through-dark');
    expect(slackSends).toHaveLength(0);
  });

  it('dryRun → the SAME typed not-delivered result + a would-deliver audit line (§5.1)', async () => {
    gate = { enabled: true, dryRun: true };
    const id = registry.mintForInbound('C0BA4F4E0FP:1751412345.123456').id!;
    const deliver = makeFunnel();
    const outcome = await deliver(id, 'x');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('follow-through-dry-run');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain('would-deliver');
    expect(audits[0]).toContain('C0BA4F4E0FP:1751412345.123456');
    expect(slackSends).toHaveLength(0);
  });

  it('unresolvable id → typed failure, never a throw, never a silent drop', async () => {
    const deliver = makeFunnel();
    const outcome = await deliver(-987654321, 'x');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('unresolvable');
  });

  it('a replicated-only-origin entry is NOT deliverable (KYP — §3.5/§7)', async () => {
    // Seed a replicated-origin entry through journal replay (the ingest writers
    // land with the §6.1 step-9 replicated-store increment).
    fs.writeFileSync(
      path.join(dir, 'conversation-registry.jsonl'),
      `${JSON.stringify({ seq: 1, op: 'mint', key: 'slack:_:C0PEER11111', tuple: ['slack', 'C0PEER11111', null], id: -555, origin: 'replicated', ts: '2026-07-01T00:00:00.000Z' })}\n`,
    );
    const deliver = makeFunnel();
    const outcome = await deliver(-555, 'x');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('replicated-only-origin');
    expect(slackSends).toHaveLength(0);
  });

  it('system-channel suppression is preserved INSIDE the funnel (§4, security-m4)', async () => {
    const id = registry.mintForInbound('C0DASHBOARD1').id!;
    const deliver = makeFunnel({ isSystemChannel: (ch) => ch === 'C0DASHBOARD1' });
    const outcome = await deliver(id, 'standby noise');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('system-channel-suppressed');
    expect(slackSends).toHaveLength(0);
  });

  it('no local Slack adapter → typed failure naming the owning-machine heal (§5.0)', async () => {
    const id = registry.mintForInbound('C0BA4F4E0FP').id!;
    const deliver = makeFunnel({ sendSlack: undefined });
    const outcome = await deliver(id, 'x');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('no-slack-adapter');
  });

  it('a Slack transport error returns a typed send-failed — non-exceptional (§5.1)', async () => {
    const id = registry.mintForInbound('C0BA4F4E0FP').id!;
    const deliver = makeFunnel({
      sendSlack: async () => {
        throw new Error('socket hang up');
      },
    });
    const outcome = await deliver(id, 'x');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('send-failed');
    expect(outcome.delivered === false && outcome.detail).toContain('socket hang up');
  });

  it('a Telegram transport error returns a typed telegram-send-failed — non-exceptional', async () => {
    const deliver = makeFunnel({
      sendTelegram: async () => {
        throw new Error('relay down');
      },
    });
    const outcome = await deliver(12476, 'x');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('telegram-send-failed');
  });
});
