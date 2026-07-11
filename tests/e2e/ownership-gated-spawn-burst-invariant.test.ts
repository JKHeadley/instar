/**
 * Burst-invariant E2E for ownership-gated spawn (spec §5, Tier-3 discipline):
 * a sustained inbound BURST for conversations whose owner machine is DARK must
 * converge to ZERO local sessions + exactly ONE honest notice per
 * (topic, outage-episode) — never a bootleg spawn per message, never a notice
 * flood (P17), never silence.
 *
 * The composition under test is a faithful port of the production
 * `admitLocalSpawn` coupling in src/commands/server.ts (the Telegram
 * cold-spawn callsite): SpawnAdmission.admit() → refusal → OwnerDarkLadder
 * .handleOwnerDark(). The callsite-pin wiring test
 * (tests/unit/spawn-admission-callsite-pins.test.ts) holds the literals to
 * the real file; THIS test proves the composed burst behavior:
 *
 *  - ENFORCE mode (flag live + durable custody): N inbound → 0 spawns,
 *    1 notice per topic-episode, dedupe/cooldown absorbing the rest.
 *  - OBSERVE mode (Increment-1 shipping posture): N inbound → N spawns
 *    (pass-through, byte-identical legacy behavior), N wouldBlock journal
 *    rows, ZERO notices sent (would-notice journaled once per topic-episode).
 *  - Owner recovery closes the episode; a LATER outage re-arms exactly one
 *    new notice (episode-scoped dedupe, not a permanent latch).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpawnAdmission } from '../../src/core/SpawnAdmission.js';
import type { SpawnAdmissionDeps, SpawnAdmissionFlag } from '../../src/core/SpawnAdmission.js';
import { OwnerDarkLadder } from '../../src/core/OwnerDarkLadder.js';
import type { BoundedJsonlAudit } from '../../src/core/BoundedJsonlAudit.js';

const T0 = Date.parse('2026-07-10T12:00:00.000Z');
let fakeNow = T0;

type Row = Record<string, unknown>;

function fakeJournal(rows: Row[]): BoundedJsonlAudit {
  return { append: (r: Row) => rows.push(r) } as unknown as BoundedJsonlAudit;
}

/** The harness mirroring server.ts's admitLocalSpawn composition. */
function makeHarness(opts: { flag: SpawnAdmissionFlag; ownerAlive?: () => boolean }) {
  const journalRows: Row[] = [];
  const ladderRows: Row[] = [];
  const sentNotices: Array<{ topicId: number; text: string }> = [];
  let spawns = 0;
  const ownerAlive = opts.ownerAlive ?? (() => false);

  const admissionDeps: SpawnAdmissionDeps = {
    selfMachineId: () => 'laptop',
    poolStage: () => 'live',
    readOwnership: () => ({ owner: 'mini', epoch: 3, status: 'owned' }),
    isMachineAlive: (m: string) => (m === 'mini' ? ownerAlive() : true),
    durableCustodyLive: () => true,
    journal: (r: Row) => journalRows.push(r),
    raiseAttention: () => {},
    provenance: () => {},
    log: () => {},
    now: () => fakeNow,
  };
  const admission = new SpawnAdmission(opts.flag, admissionDeps);

  const ladder = new OwnerDarkLadder(undefined, {
    isMachineAlive: (m: string) => (m === 'mini' ? ownerAlive() : true),
    sendNotice: async (topicId, text) => {
      sentNotices.push({ topicId, text });
      return true;
    },
    topicHistoryHasRecentNotice: () => false,
    journal: fakeJournal(ladderRows),
    log: () => {},
    now: () => fakeNow,
  });

  /**
   * One inbound message → the production admitLocalSpawn shape
   * (src/commands/server.ts, telegram-cold-spawn callsite).
   */
  async function inbound(topicId: number): Promise<void> {
    const d = admission.admit({ sessionKey: String(topicId), callsite: 'telegram-cold-spawn' });
    if (d.allow) {
      spawns++;
      // Observe-mode parity with production (`_ladderDryRunConsult` in
      // src/commands/server.ts): the ladder journals the would-notice when
      // the seam WOULD have refused a dark-owner spawn — the soak data the
      // enforce flip requires. Same guard condition as the helper.
      if (d.wouldBlock && (d.ownership?.kind === 'other-dark')) {
        await ladder.handleOwnerDark({
          sessionKey: String(topicId),
          topicId,
          ownerMachineId: d.ownership?.owner ?? 'unknown',
          mode: 'dry-run',
          custodyLive: false,
        });
      }
      return;
    }
    if (d.refusalAction === 'owner-dark-ladder' || d.refusalAction === 'rung3-notice') {
      await ladder.handleOwnerDark({
        sessionKey: String(topicId),
        topicId,
        ownerMachineId: d.ownership?.owner ?? 'unknown',
        mode: 'enforce',
        custodyLive: false,
      });
    }
  }

  return {
    inbound,
    ladder,
    spawnCount: () => spawns,
    notices: sentNotices,
    journalRows,
    ladderRows,
  };
}

beforeEach(() => {
  fakeNow = T0;
});

describe('ownership-gated spawn — burst invariant (E2E composition)', () => {
  it('ENFORCE: 1,000 inbound messages for a dark-owner topic → ZERO local sessions + exactly ONE notice', async () => {
    const h = makeHarness({ flag: { enabled: true, dryRun: false } });
    for (let i = 0; i < 1_000; i++) {
      fakeNow = T0 + i * 250; // a sustained burst over ~4 minutes
      await h.inbound(777);
    }
    expect(h.spawnCount()).toBe(0);
    expect(h.notices.length).toBe(1);
    expect(h.notices[0].topicId).toBe(777);
    // The honest queue-dark wording (custody false in this composition).
    expect(h.notices[0].text).toContain('please resend');
    // The other 999 encounters were absorbed by episode dedupe — journaled, silent.
    const dedupe = h.ladderRows.filter((r) => r.action === 'suppressed-episode-dedupe');
    expect(dedupe.length).toBe(999);
  });

  it('ENFORCE: a burst across 3 dark-owner topics → zero spawns, exactly one notice PER topic', async () => {
    const h = makeHarness({ flag: { enabled: true, dryRun: false } });
    for (let i = 0; i < 300; i++) {
      fakeNow = T0 + i * 1_000;
      await h.inbound(701 + (i % 3));
    }
    expect(h.spawnCount()).toBe(0);
    expect(h.notices.length).toBe(3);
    expect(new Set(h.notices.map((n) => n.topicId))).toEqual(new Set([701, 702, 703]));
  });

  it('OBSERVE (Increment-1 shipping posture): the SAME burst passes through — N spawns, N wouldBlock rows, ZERO notices sent', async () => {
    const h = makeHarness({ flag: { enabled: true, dryRun: true } });
    for (let i = 0; i < 500; i++) {
      fakeNow = T0 + i * 500;
      await h.inbound(777);
    }
    // Pass-through: every message still spawns exactly as legacy behavior.
    expect(h.spawnCount()).toBe(500);
    // NOTHING was sent to the user.
    expect(h.notices.length).toBe(0);
    // Observability: the seam journaled the would-refuse verdicts...
    const wouldBlockRows = h.journalRows.filter((r) => r.wouldBlock === true);
    expect(wouldBlockRows.length).toBe(500);
    // ...and the ladder journaled exactly ONE would-notice for the episode.
    expect(h.ladderRows.filter((r) => r.action === 'would-notice').length).toBe(1);
  });

  it('flag DISABLED: byte-identical legacy behavior — all spawns, zero journal chatter from the ladder', async () => {
    const h = makeHarness({ flag: { enabled: false, dryRun: true } });
    for (let i = 0; i < 100; i++) await h.inbound(777);
    expect(h.spawnCount()).toBe(100);
    expect(h.notices.length).toBe(0);
    expect(h.ladderRows.length).toBe(0);
  });

  it('owner recovery closes the episode; a LATER outage re-arms exactly ONE new notice', async () => {
    let alive = false;
    const h = makeHarness({ flag: { enabled: true, dryRun: false }, ownerAlive: () => alive });

    // Outage #1: burst → one notice.
    for (let i = 0; i < 50; i++) {
      fakeNow = T0 + i * 1_000;
      await h.inbound(777);
    }
    expect(h.notices.length).toBe(1);

    // Owner comes back; the sweep closes the episode.
    alive = true;
    fakeNow = T0 + 10 * 60_000;
    h.ladder.sweepRecovered();
    expect(h.ladder.status().openEpisodes.length).toBe(0);

    // Outage #2, past the per-topic cooldown (30 min default): ONE new notice.
    alive = false;
    for (let i = 0; i < 50; i++) {
      fakeNow = T0 + 45 * 60_000 + i * 1_000;
      await h.inbound(777);
    }
    expect(h.notices.length).toBe(2);
  });

  it('cooldown guard: a SECOND episode inside the 30-min cooldown stays silent (suppressed-cooldown), never a re-ping', async () => {
    let alive = false;
    const h = makeHarness({ flag: { enabled: true, dryRun: false }, ownerAlive: () => alive });
    await h.inbound(777);
    expect(h.notices.length).toBe(1);

    // Flap: owner blips up (episode closes) and drops again 2 minutes later.
    alive = true;
    fakeNow = T0 + 60_000;
    h.ladder.sweepRecovered();
    alive = false;
    fakeNow = T0 + 3 * 60_000;
    await h.inbound(777);
    // New episode, but the per-topic cooldown absorbs the second notice.
    expect(h.notices.length).toBe(1);
    expect(h.ladderRows.some((r) => r.action === 'suppressed-cooldown')).toBe(true);
  });

  it('pre-send liveness re-check: an owner that recovered between the admission read and the send is suppressed', async () => {
    // The TOCTOU window the re-check exists for: the ADMISSION read saw the
    // owner dark (a stale heartbeat view), but by the time the ladder is about
    // to send, the owner is back. Model it directly: the ladder's OWN liveness
    // dep answers alive while the admission's answered dark.
    const ladderRows: Row[] = [];
    const sentNotices: Array<{ topicId: number; text: string }> = [];
    const ladder = new OwnerDarkLadder(undefined, {
      isMachineAlive: () => true, // recovered by send time
      sendNotice: async (topicId, text) => {
        sentNotices.push({ topicId, text });
        return true;
      },
      topicHistoryHasRecentNotice: () => false,
      journal: fakeJournal(ladderRows),
      log: () => {},
      now: () => fakeNow,
    });
    const res = await ladder.handleOwnerDark({
      sessionKey: '777',
      topicId: 777,
      ownerMachineId: 'mini',
      mode: 'enforce',
      custodyLive: false,
    });
    expect(res.action).toBe('suppressed-owner-recovered');
    expect(sentNotices.length).toBe(0);
    expect(ladderRows.some((r) => r.action === 'suppressed-owner-recovered')).toBe(true);
    // Recovery also closed the episode (the dedupe latch resets with the outage).
    expect(ladder.status().openEpisodes.length).toBe(0);
  });
});
