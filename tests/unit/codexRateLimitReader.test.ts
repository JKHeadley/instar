// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readLatestCodexUsage,
  parseUsageFromTail,
} from '../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Unit coverage for the codex `/status`-equivalent rate-limit reader. The
 * authoritative account windows (primary 5h, secondary weekly) are persisted
 * by the codex CLI into each rollout's `token_count` events; this reader
 * surfaces the freshest one. Both sides of every boundary: data present →
 * structured snapshot; no data / no codex home → null.
 */

const NOW_MS = 1_780_171_000_000; // 2026-05-30T19:23:20Z, just before the resets below.

function tokenCountLine(opts: {
  ts: string;
  primaryUsed: number;
  secondaryUsed: number;
  reached?: string | null;
  plan?: string;
}): string {
  return JSON.stringify({
    timestamp: opts.ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: opts.primaryUsed, window_minutes: 300, resets_at: 1780171524 },
        secondary: { used_percent: opts.secondaryUsed, window_minutes: 10080, resets_at: 1780174809 },
        credits: null,
        plan_type: opts.plan ?? 'plus',
        rate_limit_reached_type: opts.reached ?? null,
      },
    },
  });
}

/**
 * The session-close record codex appends after the last real quota event: a
 * DIFFERENT limit family (`premium`) carrying credits/entitlement state and no
 * usage windows at all. Taking the newest rate_limits record blindly let this
 * one line erase a whole session of real quota, which is what blanked the
 * Subscriptions cards the moment a session ended.
 */
function entitlementCloseLine(ts: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'premium',
        limit_name: null,
        primary: null,
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        plan_type: null,
        rate_limit_reached_type: null,
      },
    },
  });
}

function turnContextLine(model: string): string {
  return JSON.stringify({
    timestamp: '2026-05-30T19:20:00.000Z',
    type: 'turn_context',
    payload: { turn_id: 'x', model, approval_policy: 'never' },
  });
}

describe('parseUsageFromTail', () => {
  it('extracts the latest token_count rate_limits with derived fields', () => {
    const tail = [
      turnContextLine('gpt-5.5'),
      tokenCountLine({ ts: '2026-05-30T19:00:00.000Z', primaryUsed: 5, secondaryUsed: 50 }),
      tokenCountLine({ ts: '2026-05-30T19:22:00.000Z', primaryUsed: 13, secondaryUsed: 93 }),
    ].join('\n');

    const snap = parseUsageFromTail(tail, '/x/rollout-2026-05-30T12-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl', NOW_MS);
    expect(snap).not.toBeNull();
    // Latest event wins (93%, not the earlier 50%).
    expect(snap!.secondary!.usedPercent).toBe(93);
    expect(snap!.secondary!.remainingPercent).toBe(7);
    expect(snap!.secondary!.windowMinutes).toBe(10080);
    expect(snap!.primary!.usedPercent).toBe(13);
    expect(snap!.primary!.remainingPercent).toBe(87);
    expect(snap!.model).toBe('gpt-5.5');
    expect(snap!.planType).toBe('plus');
    expect(snap!.threadId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(snap!.capturedAt).toBe('2026-05-30T19:22:00.000Z');
    // Derived reset fields.
    expect(snap!.secondary!.resetsAtIso).toBe(new Date(1780174809 * 1000).toISOString());
    expect(snap!.secondary!.resetsInSeconds).toBe(Math.round((1780174809 * 1000 - NOW_MS) / 1000));
  });

  it('surfaces rate_limit_reached_type when a window is exhausted', () => {
    const tail = tokenCountLine({ ts: '2026-05-30T19:22:00.000Z', primaryUsed: 100, secondaryUsed: 100, reached: 'secondary' });
    const snap = parseUsageFromTail(tail, '/x/rollout-2026-05-30T12-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl', NOW_MS);
    expect(snap!.rateLimitReachedType).toBe('secondary');
    expect(snap!.secondary!.remainingPercent).toBe(0);
  });

  it('returns null when the tail has no token_count event', () => {
    const tail = [turnContextLine('gpt-5.2'), '{"type":"agent_message","payload":{}}'].join('\n');
    expect(parseUsageFromTail(tail, '/x/rollout-x.jsonl', NOW_MS)).toBeNull();
  });

  it('ignores malformed JSON lines and still finds a valid token_count', () => {
    const tail = ['{not json', tokenCountLine({ ts: '2026-05-30T19:22:00.000Z', primaryUsed: 1, secondaryUsed: 2 }), 'garbage'].join('\n');
    const snap = parseUsageFromTail(tail, '/x/rollout-x.jsonl', NOW_MS);
    expect(snap!.primary!.usedPercent).toBe(1);
  });

  it('keeps the codex quota when a window-less entitlement record closes the session', () => {
    const tail = [
      turnContextLine('gpt-5.5'),
      tokenCountLine({ ts: '2026-05-30T19:22:00.000Z', primaryUsed: 13, secondaryUsed: 93 }),
      entitlementCloseLine('2026-05-30T19:22:00.500Z'),
    ].join('\n');

    const snap = parseUsageFromTail(tail, '/x/rollout-x.jsonl', NOW_MS);
    expect(snap).not.toBeNull();
    // The newest record is the entitlement one, but the codex windows survive.
    expect(snap!.secondary!.usedPercent).toBe(93);
    expect(snap!.primary!.usedPercent).toBe(13);
    expect(snap!.planType).toBe('plus');
    expect(snap!.capturedAt).toBe('2026-05-30T19:22:00.000Z');
    expect(snap!.windowsUnavailable).toBeUndefined();
  });

  it('still takes the NEWEST codex record when several are present', () => {
    const tail = [
      tokenCountLine({ ts: '2026-05-30T19:00:00.000Z', primaryUsed: 5, secondaryUsed: 50 }),
      entitlementCloseLine('2026-05-30T19:10:00.000Z'),
      tokenCountLine({ ts: '2026-05-30T19:22:00.000Z', primaryUsed: 13, secondaryUsed: 93 }),
    ].join('\n');
    const snap = parseUsageFromTail(tail, '/x/rollout-x.jsonl', NOW_MS);
    expect(snap!.secondary!.usedPercent).toBe(93);
    expect(snap!.capturedAt).toBe('2026-05-30T19:22:00.000Z');
  });

  it('reports windowsUnavailable when the only records carry no window', () => {
    const tail = [
      turnContextLine('gpt-5.5'),
      entitlementCloseLine('2026-05-30T19:22:00.500Z'),
    ].join('\n');
    const snap = parseUsageFromTail(tail, '/x/rollout-x.jsonl', NOW_MS);
    expect(snap).not.toBeNull();
    expect(snap!.windowsUnavailable).toBe(true);
    expect(snap!.primary).toBeNull();
    expect(snap!.secondary).toBeNull();
    expect(snap!.capturedAt).toBe('2026-05-30T19:22:00.500Z');
  });

  it('ignores a NON-codex limit family even when it does carry windows', () => {
    const foreign = JSON.stringify({
      timestamp: '2026-05-30T19:30:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'some-other-product',
          primary: { used_percent: 99, window_minutes: 300, resets_at: 1780171524 },
          plan_type: 'other',
          rate_limit_reached_type: null,
        },
      },
    });
    const tail = [
      tokenCountLine({ ts: '2026-05-30T19:22:00.000Z', primaryUsed: 13, secondaryUsed: 93 }),
      foreign,
    ].join('\n');
    const snap = parseUsageFromTail(tail, '/x/rollout-x.jsonl', NOW_MS);
    // Another product's window must never be presented as this account's quota.
    expect(snap!.primary!.usedPercent).toBe(13);
    expect(snap!.planType).toBe('plus');
  });

  it('tolerates a missing window (only primary present)', () => {
    const line = JSON.stringify({
      timestamp: '2026-05-30T19:22:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 40, window_minutes: 300, resets_at: 1780171524 },
          plan_type: 'plus',
          rate_limit_reached_type: null,
        },
      },
    });
    const snap = parseUsageFromTail(line, '/x/rollout-x.jsonl', NOW_MS);
    expect(snap!.primary!.usedPercent).toBe(40);
    expect(snap!.secondary).toBeNull();
  });
});

describe('readLatestCodexUsage', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/codexRateLimitReader.test.ts:cleanup' });
  });

  function writeRollout(uuid: string, ts: string, lines: string[], ymd = ['2026', '05', '30']): string {
    const dir = path.join(home, 'sessions', ...ymd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${ts}-${uuid}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  it('reads the freshest snapshot from the newest rollout on disk', async () => {
    writeRollout('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '2026-05-30T12-00-00', [
      turnContextLine('gpt-5.5'),
      tokenCountLine({ ts: '2026-05-30T19:22:00.000Z', primaryUsed: 13, secondaryUsed: 93 }),
    ]);
    const snap = await readLatestCodexUsage({ codexHome: home, nowMs: NOW_MS });
    expect(snap).not.toBeNull();
    expect(snap!.secondary!.usedPercent).toBe(93);
    expect(snap!.source).toBe('codex-rollout');
    expect(snap!.threadId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('falls back to an older rollout when the newest has no token_count yet', async () => {
    // Older file HAS rate-limit data.
    writeRollout('11111111-1111-1111-1111-111111111111', '2026-05-30T10-00-00', [
      tokenCountLine({ ts: '2026-05-30T17:00:00.000Z', primaryUsed: 20, secondaryUsed: 60 }),
    ]);
    // Newest file (later mtime via later write) has NO token_count.
    const newer = writeRollout('22222222-2222-2222-2222-222222222222', '2026-05-30T20-00-00', [
      '{"type":"session_meta","payload":{}}',
    ]);
    // Make the no-data file unambiguously newer by mtime.
    const future = new Date(NOW_MS + 60_000);
    fs.utimesSync(newer, future, future);

    const snap = await readLatestCodexUsage({ codexHome: home, nowMs: NOW_MS });
    expect(snap).not.toBeNull();
    expect(snap!.primary!.usedPercent).toBe(20);
  });

  it('returns null when no sessions dir exists (pure Claude agent)', async () => {
    expect(await readLatestCodexUsage({ codexHome: home, nowMs: NOW_MS })).toBeNull();
  });

  it('falls through an entitlement-only rollout to an older one that has real windows', async () => {
    const older = writeRollout('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '2026-05-30T12-00-00', [
      tokenCountLine({ ts: '2026-05-30T19:22:00.000Z', primaryUsed: 13, secondaryUsed: 93 }),
    ]);
    const newer = writeRollout('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', '2026-05-30T13-00-00', [
      entitlementCloseLine('2026-05-30T19:40:00.000Z'),
    ]);
    // Stamp BOTH files relative to real wall-clock: the reader ranks by mtime,
    // so pinning only one to a 2026-05-30 timestamp would leave the other on
    // today's mtime and the ordering under test would never actually apply.
    const realNow = Date.now();
    const stamp = (file: string, msAgo: number) => {
      const t = new Date(realNow - msAgo);
      fs.utimesSync(file, t, t);
    };
    stamp(older, 120_000);
    stamp(newer, 60_000);

    const snap = await readLatestCodexUsage({ codexHome: home, nowMs: NOW_MS });
    expect(snap).not.toBeNull();
    expect(snap!.secondary!.usedPercent).toBe(93);
    expect(snap!.windowsUnavailable).toBeUndefined();
  });

  it('returns the entitlement-only snapshot when NO rollout reports a window', async () => {
    writeRollout('cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee', '2026-05-30T12-00-00', [
      entitlementCloseLine('2026-05-30T19:40:00.000Z'),
    ]);
    const snap = await readLatestCodexUsage({ codexHome: home, nowMs: NOW_MS });
    expect(snap).not.toBeNull();
    expect(snap!.windowsUnavailable).toBe(true);
    expect(snap!.primary).toBeNull();
    expect(snap!.secondary).toBeNull();
  });

  it('returns null when rollouts exist but none carry rate-limit data', async () => {
    writeRollout('33333333-3333-3333-3333-333333333333', '2026-05-30T12-00-00', [
      '{"type":"agent_message","payload":{"type":"agent_message"}}',
    ]);
    expect(await readLatestCodexUsage({ codexHome: home, nowMs: NOW_MS })).toBeNull();
  });
});
