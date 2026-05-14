/**
 * TrustElevationSource tests — F-5 Tier-2 trust-elevation policy for the
 * Self-Healing Remediator. Covers the trust-elevation table from
 * `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (Trust elevation policy
 * section + A11, A22, A25, A41, A53, A57, A59).
 *
 * Spec anchors verified here: asymmetric trust path (pessimistic
 * quarantine always-allowed), collaborative-trust minimum for upward
 * transitions, 48h fresh dry-run trace + 1-week history requirement,
 * essential-runbook two-distinct-channel rule (A53), source-only
 * lifecycle transitions (proposal→registered, live→deprecated,
 * deprecated→removed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TrustElevationSource,
  FRESH_TRACE_MAX_AGE_MS,
  MIN_DRY_RUN_HISTORY_DAYS,
  type AutonomyProfileLevel,
  type TrustedApprovalChannel,
} from '../../src/remediation/TrustElevationSource.js';
import { TelegramApprovalChannel } from '../../src/remediation/channels/TelegramApprovalChannel.js';
import { CliApprovalChannel } from '../../src/remediation/channels/CliApprovalChannel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-trust-elevation-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, {
    recursive: true,
    force: true,
    operation: 'tests/unit/TrustElevationSource.test.ts:afterEach',
  });
});

// ── helpers ─────────────────────────────────────────────────────────

function makeTelegram(approvals: Array<{ runbookId: string; action: string; messageId?: string; approved: boolean }>): TelegramApprovalChannel {
  const map = new Map<string, { approved: boolean; principalUserId?: string }>();
  for (const a of approvals) {
    const key = `${a.runbookId}::${a.action}::${a.messageId ?? ''}`;
    map.set(key, { approved: a.approved, principalUserId: 'principal-1' });
  }
  return new TelegramApprovalChannel({ seededApprovals: map, principalUserId: 'principal-1' });
}

function makeCli(approvals: Array<{ runbookId: string; action: string; messageId?: string; approved: boolean }>): CliApprovalChannel {
  const map = new Map<string, { approved: boolean; principalUserId?: string }>();
  for (const a of approvals) {
    const key = `${a.runbookId}::${a.action}::${a.messageId ?? ''}`;
    map.set(key, { approved: a.approved, principalUserId: 'operator-1' });
  }
  return new CliApprovalChannel({ seededConfirmations: map, principalUserId: 'operator-1' });
}

const FRESH_TRACE_MS = 1 * 60 * 60 * 1000; // 1 hour
const STALE_TRACE_MS = FRESH_TRACE_MAX_AGE_MS + 60 * 1000;
const SUFFICIENT_HISTORY = MIN_DRY_RUN_HISTORY_DAYS + 1;

// ── 1. registered→live requires collaborative + fresh trace + history ──

describe('registered→live promotion gate', () => {
  it('1a. allows when collaborative + fresh trace + sufficient history', async () => {
    const src = new TrustElevationSource({
      profile: 'collaborative',
      channels: [makeTelegram([])],
    });
    const result = await src.canTransition('rb-1', 'registered-to-live', {
      dryRunTraceAge: FRESH_TRACE_MS,
      dryRunHistoryDays: SUFFICIENT_HISTORY,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('registered-to-live-approved');
  });

  it('1b. refuses when trace is stale (>48h)', async () => {
    const src = new TrustElevationSource({
      profile: 'collaborative',
      channels: [makeTelegram([])],
    });
    const result = await src.canTransition('rb-1', 'registered-to-live', {
      dryRunTraceAge: STALE_TRACE_MS,
      dryRunHistoryDays: SUFFICIENT_HISTORY,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('stale-dry-run-trace');
  });

  it('1c. refuses when history is under 1 week', async () => {
    const src = new TrustElevationSource({
      profile: 'collaborative',
      channels: [makeTelegram([])],
    });
    const result = await src.canTransition('rb-1', 'registered-to-live', {
      dryRunTraceAge: FRESH_TRACE_MS,
      dryRunHistoryDays: 3,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('insufficient-dry-run-history');
  });

  it('1d. refuses when trace-age missing', async () => {
    const src = new TrustElevationSource({
      profile: 'collaborative',
      channels: [makeTelegram([])],
    });
    const result = await src.canTransition('rb-1', 'registered-to-live', {
      dryRunHistoryDays: SUFFICIENT_HISTORY,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('missing-dry-run-trace-age');
  });
});

// ── 2. quarantined→live (non-essential): one channel approval ──

describe('quarantined→live (non-essential)', () => {
  it('2a. allows when collaborative + one approving channel', async () => {
    const tg = makeTelegram([{ runbookId: 'rb-2', action: 'unquarantine', messageId: 'm1', approved: true }]);
    const src = new TrustElevationSource({ profile: 'collaborative', channels: [tg] });
    const result = await src.canTransition('rb-2', 'quarantined-to-live', {
      essential: false,
      approval: { action: 'unquarantine', messageId: 'm1' },
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('unquarantine-approved');
  });

  it('2b. refuses when no channel approves', async () => {
    const tg = makeTelegram([{ runbookId: 'rb-2', action: 'unquarantine', messageId: 'm1', approved: false }]);
    const src = new TrustElevationSource({ profile: 'collaborative', channels: [tg] });
    const result = await src.canTransition('rb-2', 'quarantined-to-live', {
      essential: false,
      approval: { action: 'unquarantine', messageId: 'm1' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unquarantine-no-channel-approved');
  });

  it('2c. refuses when no channels are configured at all', async () => {
    const src = new TrustElevationSource({ profile: 'collaborative', channels: [] });
    const result = await src.canTransition('rb-2', 'quarantined-to-live', {
      essential: false,
      approval: { action: 'unquarantine' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unquarantine-no-channel-configured');
  });
});

// ── 3. quarantined→live (essential): TWO distinct-kind channels (A53) ──

describe('quarantined→live (essential, A53)', () => {
  it('3a. allows when two distinct-kind channels both approve', async () => {
    const tg = makeTelegram([{ runbookId: 'rb-3', action: 'unquarantine', messageId: 'm1', approved: true }]);
    const cli = makeCli([{ runbookId: 'rb-3', action: 'unquarantine', messageId: 'm1', approved: true }]);
    const src = new TrustElevationSource({ profile: 'collaborative', channels: [tg, cli] });
    const result = await src.canTransition('rb-3', 'quarantined-to-live', {
      essential: true,
      approval: { action: 'unquarantine', messageId: 'm1' },
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('essential-unquarantine-approved-two-channels');
  });

  it('3b. refuses when only one channel approves (essential needs two)', async () => {
    const tg = makeTelegram([{ runbookId: 'rb-3', action: 'unquarantine', messageId: 'm1', approved: true }]);
    const cli = makeCli([{ runbookId: 'rb-3', action: 'unquarantine', messageId: 'm1', approved: false }]);
    const src = new TrustElevationSource({ profile: 'collaborative', channels: [tg, cli] });
    const result = await src.canTransition('rb-3', 'quarantined-to-live', {
      essential: true,
      approval: { action: 'unquarantine', messageId: 'm1' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('essential-unquarantine-requires-two-distinct-channel-approvals');
  });

  it('3c. refuses essential when only one channel kind is configured (no real second factor)', async () => {
    const tg1 = makeTelegram([{ runbookId: 'rb-3', action: 'unquarantine', messageId: 'm1', approved: true }]);
    // Second Telegram channel — same `kind`, doesn't count as a real second factor per A53.
    const tg2 = makeTelegram([{ runbookId: 'rb-3', action: 'unquarantine', messageId: 'm1', approved: true }]);
    const src = new TrustElevationSource({ profile: 'collaborative', channels: [tg1, tg2] });
    const result = await src.canTransition('rb-3', 'quarantined-to-live', {
      essential: true,
      approval: { action: 'unquarantine', messageId: 'm1' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('essential-unquarantine-no-second-channel');
  });

  it('3d. requireSecondChannel(essential=true) needs ≥2 distinct kinds', async () => {
    const tg = makeTelegram([]);
    const cli = makeCli([]);
    const srcSingleKind = new TrustElevationSource({ profile: 'collaborative', channels: [tg, makeTelegram([])] });
    const srcMixed = new TrustElevationSource({ profile: 'collaborative', channels: [tg, cli] });
    expect(await srcSingleKind.requireSecondChannel({ runbookId: 'rb-3', essential: true })).toBe(false);
    expect(await srcMixed.requireSecondChannel({ runbookId: 'rb-3', essential: true })).toBe(true);
    expect(await srcSingleKind.requireSecondChannel({ runbookId: 'rb-3', essential: false })).toBe(true);
  });
});

// ── 4. live→quarantined always allowed (pessimistic / asymmetric rule) ──

describe('live→quarantined (pessimistic, always allowed)', () => {
  it('4a. allowed at any trust profile', async () => {
    for (const profile of ['cautious', 'supervised', 'collaborative', 'autonomous'] as AutonomyProfileLevel[]) {
      const src = new TrustElevationSource({ profile, channels: [] });
      const result = await src.canTransition('rb-4', 'live-to-quarantined', {});
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('pessimistic-quarantine-always-allowed');
    }
  });
});

// ── 5. proposal→registered always refused programmatically ──

describe('proposal→registered (source change only)', () => {
  it('5a. refused regardless of trust profile or channel approval', async () => {
    const tg = makeTelegram([{ runbookId: 'rb-5', action: 'register', messageId: 'm1', approved: true }]);
    const cli = makeCli([{ runbookId: 'rb-5', action: 'register', messageId: 'm1', approved: true }]);
    const src = new TrustElevationSource({ profile: 'autonomous', channels: [tg, cli] });
    const result = await src.canTransition('rb-5', 'proposal-to-registered', {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('proposal-to-registered-requires-instar-dev-commit');
  });

  it('5b. live→deprecated and deprecated→removed also refused programmatically', async () => {
    const src = new TrustElevationSource({ profile: 'autonomous', channels: [makeTelegram([]), makeCli([])] });
    const dep = await src.canTransition('rb-5', 'live-to-deprecated', {});
    const rem = await src.canTransition('rb-5', 'deprecated-to-removed', {});
    expect(dep.allowed).toBe(false);
    expect(dep.reason).toBe('live-to-deprecated-requires-instar-dev-source-change');
    expect(rem.allowed).toBe(false);
    expect(rem.reason).toBe('deprecated-to-removed-requires-instar-dev-source-change-and-migration-note');
  });
});

// ── 6. Below-collaborative trust refuses all upward transitions ──

describe('trust-level guards', () => {
  it('6a. supervised profile refuses registered→live even with fresh trace + history', async () => {
    const src = new TrustElevationSource({
      profile: 'supervised',
      channels: [makeTelegram([])],
    });
    const result = await src.canTransition('rb-6', 'registered-to-live', {
      dryRunTraceAge: FRESH_TRACE_MS,
      dryRunHistoryDays: SUFFICIENT_HISTORY,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('trust-level-below-collaborative:supervised');
  });

  it('6b. cautious profile refuses upward transitions even with valid channels', async () => {
    const tg = makeTelegram([{ runbookId: 'rb-6', action: 'unquarantine', messageId: 'm1', approved: true }]);
    const cli = makeCli([{ runbookId: 'rb-6', action: 'unquarantine', messageId: 'm1', approved: true }]);
    const src = new TrustElevationSource({ profile: 'cautious', channels: [tg, cli] });
    const result = await src.canTransition('rb-6', 'quarantined-to-live', {
      essential: true,
      approval: { action: 'unquarantine', messageId: 'm1' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('trust-level-below-collaborative:cautious');
  });

  it('6c. but downward (live→quarantined) is always allowed even at cautious', async () => {
    const src = new TrustElevationSource({ profile: 'cautious', channels: [] });
    const result = await src.canTransition('rb-6', 'live-to-quarantined', {});
    expect(result.allowed).toBe(true);
  });

  it('6d. autonomous profile is fine — it is above the collaborative threshold', async () => {
    const src = new TrustElevationSource({
      profile: 'autonomous',
      channels: [makeTelegram([])],
    });
    const result = await src.canTransition('rb-6', 'registered-to-live', {
      dryRunTraceAge: FRESH_TRACE_MS,
      dryRunHistoryDays: SUFFICIENT_HISTORY,
    });
    expect(result.allowed).toBe(true);
  });
});

// ── 7. Stub channels verify properly in test fixtures ──

describe('TrustedApprovalChannel stubs', () => {
  it('7a. TelegramApprovalChannel returns approval for seeded entries', async () => {
    const ch = new TelegramApprovalChannel({
      seededApprovals: new Map([
        ['rb-7::unquarantine::msg-1', { approved: true, principalUserId: 'user-7' }],
      ]),
    });
    const ok = await ch.verifyApproval({ runbookId: 'rb-7', action: 'unquarantine', messageId: 'msg-1' });
    expect(ok.approved).toBe(true);
    expect(ok.principalUserId).toBe('user-7');

    const miss = await ch.verifyApproval({ runbookId: 'rb-7', action: 'unquarantine', messageId: 'msg-DIFFERENT' });
    expect(miss.approved).toBe(false);
    expect(miss.reason).toBe('no-matching-telegram-countersignature');
  });

  it('7b. CliApprovalChannel returns approval for seeded entries', async () => {
    const ch = new CliApprovalChannel({
      seededConfirmations: new Map([
        ['rb-7::unquarantine::challenge-XYZ', { approved: true, principalUserId: 'op-7' }],
      ]),
    });
    const ok = await ch.verifyApproval({ runbookId: 'rb-7', action: 'unquarantine', messageId: 'challenge-XYZ' });
    expect(ok.approved).toBe(true);
    expect(ok.principalUserId).toBe('op-7');

    const miss = await ch.verifyApproval({ runbookId: 'rb-7', action: 'unquarantine', messageId: 'wrong' });
    expect(miss.approved).toBe(false);
    expect(miss.reason).toBe('no-matching-cli-confirmation');
  });

  it('7c. channels expose stable `name` + `kind` discriminators', () => {
    const tg = new TelegramApprovalChannel();
    const cli = new CliApprovalChannel();
    expect(tg.kind).toBe('telegram');
    expect(cli.kind).toBe('cli');
    expect(tg.kind).not.toBe(cli.kind);
    // `name` exists and is a string
    expect(typeof tg.name).toBe('string');
    expect(typeof cli.name).toBe('string');
  });

  it('7d. custom TrustedApprovalChannel implementations compose via the interface', async () => {
    class StubChannel implements TrustedApprovalChannel {
      public readonly name = 'stub';
      public readonly kind = 'stub-kind';
      async verifyApproval() {
        return { approved: true, principalUserId: 'stub-user' };
      }
    }
    const src = new TrustElevationSource({
      profile: 'collaborative',
      channels: [new StubChannel(), new TelegramApprovalChannel({
        seededApprovals: new Map([['rb-7d::unquarantine::msg-1', { approved: true }]]),
      })],
    });
    const result = await src.canTransition('rb-7d', 'quarantined-to-live', {
      essential: true,
      approval: { action: 'unquarantine', messageId: 'msg-1' },
    });
    expect(result.allowed).toBe(true);
  });
});

// ── 8. Misc edge cases ──

describe('misc', () => {
  it('8a. refuses with empty runbookId', async () => {
    const src = new TrustElevationSource({ profile: 'collaborative', channels: [makeTelegram([])] });
    const result = await src.canTransition('', 'live-to-quarantined', {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('runbook-id-required');
  });

  it('8b. constructor refuses missing profile / channels', () => {
    // @ts-expect-error — exercising runtime guard
    expect(() => new TrustElevationSource({})).toThrow();
    // @ts-expect-error — exercising runtime guard
    expect(() => new TrustElevationSource({ profile: 'collaborative' })).toThrow();
  });

  it('8c. requireSecondChannel returns false on empty runbookId', async () => {
    const src = new TrustElevationSource({ profile: 'collaborative', channels: [makeTelegram([]), makeCli([])] });
    expect(await src.requireSecondChannel({ runbookId: '', essential: true })).toBe(false);
  });
});
