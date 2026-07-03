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
import {
  createConversationDelivery,
  classifySlackSendError,
  CONVERSATION_UNREACHABLE_ERRORS,
} from '../../src/core/deliverToConversation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** A SlackApiError-shaped throw (the funnel reads `.slackError`). */
function slackApiError(code: string): Error & { slackError: string } {
  const e = new Error(`slack api error: ${code}`) as Error & { slackError: string };
  e.slackError = code;
  return e;
}

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

  // ── §5.1 permanent-vs-transient classification (increment 2) ──
  describe('classifySlackSendError (§5.1 / §5.0(a) R2-security-NEW-3)', () => {
    it('the pinned permanent set is exactly {is_archived, channel_not_found, not_in_channel}', () => {
      expect([...CONVERSATION_UNREACHABLE_ERRORS].sort()).toEqual(
        ['channel_not_found', 'is_archived', 'not_in_channel'].sort(),
      );
    });
    it('a pinned code classifies PERMANENT (the code is is_archived, NOT channel_archived)', () => {
      for (const code of ['is_archived', 'channel_not_found', 'not_in_channel']) {
        expect(classifySlackSendError(slackApiError(code))).toEqual({ kind: 'permanent', code });
      }
      // The wrong code name is NOT permanent — it is permanent-SHAPED (canary).
      expect(classifySlackSendError(slackApiError('channel_archived')).kind).toBe('permanent-shaped-unknown');
    });
    it('an unrecognized permanent-shaped channel-state code is the L5 drift canary', () => {
      expect(classifySlackSendError(slackApiError('is_restricted')).kind).toBe('permanent-shaped-unknown');
    });
    it('a Slack-answered non-channel-state code is CLEAN (positive not-posted evidence)', () => {
      expect(classifySlackSendError(slackApiError('ratelimited')).kind).toBe('clean-transient');
    });
    it('a pre-accept network refusal is CLEAN; a timeout/reset is AMBIGUOUS', () => {
      expect(classifySlackSendError(new Error('connect ECONNREFUSED 127.0.0.1')).kind).toBe('clean-transient');
      expect(classifySlackSendError(new Error('socket hang up')).kind).toBe('ambiguous');
    });
  });

  it('a permanent Slack error → typed conversation-unreachable (permanent flag) + reachability flip', async () => {
    const id = registry.mintForInbound('C0BA4F4E0FP').id!;
    const deliver = makeFunnel({ sendSlack: async () => { throw slackApiError('is_archived'); } });
    const outcome = await deliver(id, 'x');
    expect(outcome.delivered).toBe(false);
    expect(outcome.delivered === false && outcome.reason).toBe('conversation-unreachable');
    expect(outcome.delivered === false && outcome.permanent).toBe(true);
    expect(registry.resolve(id)!.platform === 'slack' && registry.resolve(id)!.reachability).toBe('unreachable');
  });

  it('an unrecognized permanent-shaped error is treated TRANSIENT + raises ONE drift-canary attention', async () => {
    const id = registry.mintForInbound('C0BA4F4E0FP').id!;
    const attentions: string[] = [];
    const deliver = makeFunnel({
      sendSlack: async () => { throw slackApiError('is_restricted'); },
      onAttention: (key) => attentions.push(key),
    });
    const outcome = await deliver(id, 'x');
    expect(outcome.delivered === false && outcome.reason).toBe('send-failed');
    expect(outcome.delivered === false && (outcome as { permanent?: boolean }).permanent).toBeFalsy();
    expect(attentions.some((k) => k.startsWith('slack-permanent-drift'))).toBe(true);
    // Transient → reachability NOT flipped (self-heals via the beacon N-fail path).
    expect(registry.resolve(id)!.platform === 'slack' && registry.resolve(id)!.reachability).toBe('ok');
  });

  it('reachability auto-clears to ok on the next successful delivery', async () => {
    const id = registry.mintForInbound('C0BA4F4E0FP').id!;
    let fail = true;
    const deliver = makeFunnel({
      sendSlack: async () => { if (fail) throw slackApiError('is_archived'); },
    });
    await deliver(id, 'x'); // flip to unreachable
    expect(registry.resolve(id)!.platform === 'slack' && registry.resolve(id)!.reachability).toBe('unreachable');
    fail = false;
    await deliver(id, 'y'); // success → auto-clear
    expect(registry.resolve(id)!.platform === 'slack' && registry.resolve(id)!.reachability).toBe('ok');
  });

  // ── §5.0(a) E1 ambiguous-outcome idempotency guard (increment 2) ──
  describe('E1 ambiguous-outcome idempotency (§5.0(a))', () => {
    it('an ambiguous outcome that actually posted does NOT double-post the re-fire (logical lane)', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP:1751412345.123456').id!;
      const deliver = makeFunnel({ sendSlack: async () => { throw new Error('socket hang up'); } });
      // First fire: ambiguous → the funnel records the suppressor.
      const first = await deliver(id, 'heartbeat 23m', { logicalSendId: 'CMT-001:7' });
      expect(first.delivered).toBe(false);
      // The re-fire of the SAME logical send (interpolated text differs) is suppressed.
      const second = await deliver(id, 'heartbeat 6h', { logicalSendId: 'CMT-001:7' });
      expect(second.outcome).toBe('already-delivered-recently');
    });
    it('the NEXT logical send (new seq) is NOT suppressed', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP').id!;
      const deliver = makeFunnel({ sendSlack: async () => { throw new Error('socket hang up'); } });
      await deliver(id, 'a', { logicalSendId: 'CMT-001:7' });
      // A genuinely NEW heartbeat (seq 8) never matches the retired entry.
      const next = await deliver(id, 'b', { logicalSendId: 'CMT-001:8' });
      expect(next.outcome).not.toBe('already-delivered-recently');
    });
    it('a CLEAN transient failure is NOT recorded — its retry is NOT suppressed (R2-security-NEW-3)', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP').id!;
      const deliver = makeFunnel({ sendSlack: async () => { throw slackApiError('ratelimited'); } });
      await deliver(id, 'a', { logicalSendId: 'CMT-001:7' });
      const retry = await deliver(id, 'a', { logicalSendId: 'CMT-001:7' });
      expect(retry.outcome).not.toBe('already-delivered-recently');
      expect(registry.isSendSuppressed(id, 'CMT-001:7', 'logical')).toBe(false);
    });
    it('the content-hash lane suppresses an identical repeat within the window but not a different text', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP').id!;
      const deliver = makeFunnel({ sendSlack: async () => { throw new Error('socket hang up'); } });
      const longText = 'This is a session-shutdown notice long enough to clear the content-hash length gate.';
      await deliver(id, longText); // no logicalSendId → content-hash lane
      const repeat = await deliver(id, longText);
      expect(repeat.outcome).toBe('already-delivered-recently');
      const different = await deliver(id, `${longText} (a genuinely different notice body here)`);
      expect(different.outcome).not.toBe('already-delivered-recently');
    });
    it('allowDuplicate bypasses the guard for a deliberate resend', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP').id!;
      const deliver = makeFunnel({ sendSlack: async () => { throw new Error('socket hang up'); } });
      await deliver(id, 'a', { logicalSendId: 'CMT-001:7' });
      const bypass = await deliver(id, 'a', { logicalSendId: 'CMT-001:7', allowDuplicate: true });
      expect(bypass.outcome).not.toBe('already-delivered-recently');
    });
    it('a delivered outcome retires the entry (retireSend) so the seq can advance cleanly', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP').id!;
      const deliver = makeFunnel(); // success
      const outcome = await deliver(id, 'a', { logicalSendId: 'CMT-001:7' });
      expect(outcome.delivered).toBe(true);
      // A successful send records the likely-posted suppressor; the caller
      // retires it after advancing the seq (the beacon does this).
      registry.retireSend(id, 'CMT-001:7');
      expect(registry.isSendSuppressed(id, 'CMT-001:7', 'logical')).toBe(false);
    });
  });

  // ── §3.5.2 bind-pin / boundTuple overlay (increment 2) ──
  describe('boundTuple delivery overlay (§3.5.2)', () => {
    it('a coherent boundTuple delivers into the bound tuple’s thread', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP:1751412345.123456').id!;
      const deliver = makeFunnel();
      const outcome = await deliver(id, 'x', {
        boundTuple: { platform: 'slack', channelId: 'C0BA4F4E0FP', threadTs: '1751412345.123456' },
      });
      expect(outcome.delivered).toBe(true);
      expect(slackSends).toEqual([{ channelId: 'C0BA4F4E0FP', text: 'x', threadTs: '1751412345.123456' }]);
    });
    it('an INCOHERENT boundTuple (id not within the tuple’s coherence bound) refuses on BOTH fields (R6-M4)', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP').id!;
      const attentions: string[] = [];
      const deliver = makeFunnel({ onAttention: (k) => attentions.push(k) });
      // A boundTuple naming a DIFFERENT channel — id is not its candidate/offset.
      const outcome = await deliver(id, 'x', {
        boundTuple: { platform: 'slack', channelId: 'C0OTHER99999', threadTs: null },
      });
      expect(outcome.delivered).toBe(false);
      expect(outcome.delivered === false && outcome.reason).toBe('conversation-binding-incoherent');
      expect(slackSends).toHaveLength(0);
      expect(attentions.some((k) => k.startsWith('conversation-binding-incoherent'))).toBe(true);
    });
    it('a malformed boundTuple is ignored (falls back to resolve(id), never a crash)', async () => {
      const id = registry.mintForInbound('C0BA4F4E0FP').id!;
      const deliver = makeFunnel();
      const outcome = await deliver(id, 'x', {
        boundTuple: { platform: 'slack', channelId: 'not-a-valid-channel!', threadTs: null },
      });
      expect(outcome.delivered).toBe(true); // clamped away → plain resolve(id)
    });
  });
});
