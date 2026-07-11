/**
 * Unit tests for OwnerDarkLadder — Layer A's `other-dark` arm (ownership-
 * gated-spawn-and-judgment-within-floors spec §3.3).
 *
 * Covers: dry-run journal-only posture, the two FD9 notice wordings (queue-dark
 * vs queue-live custody), episode dedupe (ONE notice per topic-episode),
 * per-topic cooldown across episodes, the pre-send owner-liveness re-check,
 * topic-history split-brain suppression, send-failure retryability, the
 * topicId-null journal-only path, sweepRecovered, and status().
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OwnerDarkLadder,
  OWNER_DARK_NOTICE_QUEUE_DARK,
  OWNER_DARK_NOTICE_QUEUE_LIVE,
} from '../../src/core/OwnerDarkLadder.js';
import type { OwnerDarkLadderDeps, LadderMode } from '../../src/core/OwnerDarkLadder.js';
import type { BoundedJsonlAudit } from '../../src/core/BoundedJsonlAudit.js';

const T0 = Date.parse('2026-07-10T12:00:00.000Z');
let fakeNow = T0;

function makeLadder(depsOver: Partial<OwnerDarkLadderDeps> = {}, cfg?: { maxUserSilenceMs?: number; noticeCooldownMs?: number }) {
  const journal = { append: vi.fn() };
  const deps: OwnerDarkLadderDeps = {
    isMachineAlive: vi.fn(() => false),
    sendNotice: vi.fn(async () => true),
    topicHistoryHasRecentNotice: vi.fn(() => false),
    journal: journal as unknown as BoundedJsonlAudit,
    log: vi.fn(),
    now: () => fakeNow,
    ...depsOver,
  };
  const ladder = new OwnerDarkLadder(cfg, deps);
  return { ladder, deps, journal };
}

function input(over: Partial<{ sessionKey: string; topicId: number | null; ownerMachineId: string; mode: LadderMode; custodyLive: boolean }> = {}) {
  return {
    sessionKey: '555',
    topicId: 555 as number | null,
    ownerMachineId: 'machine-owner',
    mode: 'enforce' as LadderMode,
    custodyLive: false,
    ...over,
  };
}

function journalActions(journal: { append: ReturnType<typeof vi.fn> }): string[] {
  return journal.append.mock.calls.map((c) => (c[0] as Record<string, unknown>).action as string).filter(Boolean);
}

beforeEach(() => {
  fakeNow = T0;
});

describe('dry-run mode (Increment-1 posture)', () => {
  it("action 'would-notice': sendNotice NEVER called, journal row written", async () => {
    const { ladder, deps, journal } = makeLadder();
    const r = await ladder.handleOwnerDark(input({ mode: 'dry-run' }));
    expect(r.action).toBe('would-notice');
    expect(deps.sendNotice).not.toHaveBeenCalled();
    expect(journalActions(journal)).toContain('would-notice');
  });

  it("second call same topic + episode → 'suppressed-episode-dedupe'", async () => {
    const { ladder, journal } = makeLadder();
    const r1 = await ladder.handleOwnerDark(input({ mode: 'dry-run' }));
    const r2 = await ladder.handleOwnerDark(input({ mode: 'dry-run' }));
    expect(r1.action).toBe('would-notice');
    expect(r2.action).toBe('suppressed-episode-dedupe');
    expect(r2.episodeId).toBe(r1.episodeId);
    expect(journalActions(journal)).toContain('suppressed-episode-dedupe');
  });
});

describe('enforce mode — the rung-3 notice floor', () => {
  it('sends the exact QUEUE_DARK wording when custodyLive is false', async () => {
    const { ladder, deps } = makeLadder();
    const r = await ladder.handleOwnerDark(input({ custodyLive: false }));
    expect(r.action).toBe('noticed');
    expect(deps.sendNotice).toHaveBeenCalledTimes(1);
    expect((deps.sendNotice as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([555, OWNER_DARK_NOTICE_QUEUE_DARK]);
  });

  it('sends the exact QUEUE_LIVE wording when custodyLive is true', async () => {
    const { ladder, deps } = makeLadder();
    const r = await ladder.handleOwnerDark(input({ custodyLive: true }));
    expect(r.action).toBe('queue-custody-noticed');
    expect((deps.sendNotice as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([555, OWNER_DARK_NOTICE_QUEUE_LIVE]);
  });

  it('ONE notice per (topic, episode) — a repeat is suppressed-episode-dedupe', async () => {
    const { ladder, deps } = makeLadder();
    const r1 = await ladder.handleOwnerDark(input());
    const r2 = await ladder.handleOwnerDark(input());
    expect(r1.action).toBe('noticed');
    expect(r2.action).toBe('suppressed-episode-dedupe');
    expect(deps.sendNotice).toHaveBeenCalledTimes(1);
  });

  it('per-topic cooldown persists ACROSS episodes; a post-cooldown encounter notices again', async () => {
    const { ladder, deps } = makeLadder(); // default cooldown 30 min
    const r1 = await ladder.handleOwnerDark(input());
    expect(r1.action).toBe('noticed');

    // Owner recovers → episode closes; then goes dark again inside the cooldown.
    ladder.ownerRecovered('machine-owner');
    fakeNow = T0 + 10 * 60_000; // 10 min < 30 min cooldown
    const r2 = await ladder.handleOwnerDark(input());
    expect(r2.action).toBe('suppressed-cooldown');
    expect(r2.episodeId).not.toBe(r1.episodeId); // a NEW episode — the cooldown is what suppressed
    expect(deps.sendNotice).toHaveBeenCalledTimes(1);

    // Past the cooldown, the same topic can be noticed again.
    fakeNow = T0 + 31 * 60_000;
    const r3 = await ladder.handleOwnerDark(input());
    expect(r3.action).toBe('noticed');
    expect(deps.sendNotice).toHaveBeenCalledTimes(2);
  });

  it('pre-send liveness re-check: a just-recovered owner suppresses the notice AND closes the episode', async () => {
    const { ladder, deps } = makeLadder({ isMachineAlive: vi.fn(() => true) });
    const r = await ladder.handleOwnerDark(input());
    expect(r.action).toBe('suppressed-owner-recovered');
    expect(deps.sendNotice).not.toHaveBeenCalled();
    expect(ladder.status().openEpisodes).toHaveLength(0);
    expect(ladder.status().counters.episodesClosed).toBe(1);
  });

  it('topic history already shows a notice (split-brain guard) → suppressed-topic-history', async () => {
    const { ladder, deps } = makeLadder({ topicHistoryHasRecentNotice: vi.fn(() => true) });
    const r = await ladder.handleOwnerDark(input());
    expect(r.action).toBe('suppressed-topic-history');
    expect(deps.sendNotice).not.toHaveBeenCalled();
  });

  it("sendNotice returning false → 'notice-send-failed' and the topic is NOT marked noticed (a later call may retry)", async () => {
    const sendNotice = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { ladder, deps } = makeLadder({ sendNotice });
    const r1 = await ladder.handleOwnerDark(input());
    expect(r1.action).toBe('notice-send-failed');
    // NOT episode-deduped, NOT cooldown-suppressed — the retry reaches the send.
    const r2 = await ladder.handleOwnerDark(input());
    expect(r2.action).toBe('noticed');
    expect(deps.sendNotice).toHaveBeenCalledTimes(2);
    expect(ladder.status().counters.sendFailed).toBe(1);
  });

  it('topicId null → journal-only, no send', async () => {
    const { ladder, deps, journal } = makeLadder();
    await ladder.handleOwnerDark(input({ topicId: null }));
    expect(deps.sendNotice).not.toHaveBeenCalled();
    expect(journalActions(journal)).toContain('no-topic-no-notice');
  });
});

describe('sweepRecovered', () => {
  it('closes episodes whose owner machine is alive again, keeps dark ones open', async () => {
    const isMachineAlive = vi.fn((id: string) => id === 'machine-1');
    const { ladder, journal } = makeLadder({ isMachineAlive });
    // Open two episodes via dry-run encounters (dry-run never reads liveness).
    await ladder.handleOwnerDark(input({ mode: 'dry-run', ownerMachineId: 'machine-1', topicId: 1, sessionKey: '1' }));
    await ladder.handleOwnerDark(input({ mode: 'dry-run', ownerMachineId: 'machine-2', topicId: 2, sessionKey: '2' }));
    expect(ladder.status().openEpisodes).toHaveLength(2);

    ladder.sweepRecovered();
    const open = ladder.status().openEpisodes;
    expect(open).toHaveLength(1);
    expect(open[0].ownerMachineId).toBe('machine-2');
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner-dark-episode-closed', ownerMachineId: 'machine-1' }),
    );
  });
});

describe('status()', () => {
  it('reports open episodes (with refusal/notice counts) and counters', async () => {
    const { ladder } = makeLadder();
    await ladder.handleOwnerDark(input({ topicId: 7, sessionKey: '7' })); // noticed
    await ladder.handleOwnerDark(input({ topicId: 8, sessionKey: '8', custodyLive: true })); // queue-custody-noticed
    await ladder.handleOwnerDark(input({ topicId: 7, sessionKey: '7' })); // dedupe

    const s = ladder.status();
    expect(s.openEpisodes).toHaveLength(1);
    expect(s.openEpisodes[0]).toMatchObject({ ownerMachineId: 'machine-owner', topicsRefused: 2, topicsNoticed: 2 });
    expect(s.counters).toMatchObject({
      encounters: 3,
      noticed: 1,
      queueCustodyNoticed: 1,
      suppressedEpisodeDedupe: 1,
    });
    expect(s.config).toMatchObject({ maxUserSilenceMs: 600_000, noticeCooldownMs: 1_800_000 });
  });
});
