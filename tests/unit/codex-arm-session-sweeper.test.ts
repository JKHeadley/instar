/**
 * CodexArmSessionSweeper — the safety invariants from
 * docs/specs/codex-arm-session-leak-and-sweeper.md §3, each as a named test.
 *
 * Every test injects its own lister/killer, so none of this touches a real tmux.
 * (The REAL tmux reproduction — parent dies, session still dies — is the integration
 * test `codex-arm-self-destruct-real-tmux.test.ts`.)
 */
import { describe, it, expect } from 'vitest';
import {
  CodexArmSessionSweeper,
  isArmSessionName,
  armSessionCorroboration,
  makeTmuxSessionLister,
  parseTmuxSessionRows,
  ARM_SESSION_PREFIX,
  MIN_MAX_AGE_MS,
  NAME_TIME_TOLERANCE_MS,
  type TmuxSessionRow,
  type SweepKill,
} from '../../src/monitoring/CodexArmSessionSweeper.js';

const NOW = 1_800_000_000_000; // fixed clock
const secsAgo = (s: number) => Math.floor((NOW - s * 1000) / 1000);

/** A name exactly as `makeTmuxTrustDriver` mints it, for a session born `s` seconds ago. */
function armName(secondsAgo: number): string {
  return `${ARM_SESSION_PREFIX}${(NOW - secondsAgo * 1000).toString(36)}`;
}
function armRow(secondsAgo: number): TmuxSessionRow {
  return { name: armName(secondsAgo), createdEpochSec: secsAgo(secondsAgo) };
}

function build(rows: TmuxSessionRow[], cfg: Partial<ConstructorParameters<typeof CodexArmSessionSweeper>[0]> = {}) {
  const killed: string[] = [];
  const audited: SweepKill[] = [];
  const sweeper = new CodexArmSessionSweeper(
    { enabled: true, dryRun: false, initialPassDelayMs: 0, ...cfg },
    {
      listSessions: () => rows,
      killSession: (n) => { killed.push(n); },
      now: () => NOW,
      audit: (e) => { audited.push(e); },
    },
  );
  return { sweeper, killed, audited };
}

describe('armSessionCorroboration — verify the state, not its symbol', () => {
  it('corroborates a name whose embedded birth time matches what tmux recorded', () => {
    expect(armSessionCorroboration(armName(3600), secsAgo(3600))).toBe('corroborated');
  });

  it('rejects a hand-made name with the right prefix but the wrong shape', () => {
    // The prefix is a symbol anyone can type. The suffix is the evidence.
    expect(armSessionCorroboration('instar-codex-arm-scratch-pad', secsAgo(3600))).toBe('name-shape-mismatch'); // hyphen
    expect(armSessionCorroboration('instar-codex-arm-MYWORK', secsAgo(3600))).toBe('name-shape-mismatch');
    expect(armSessionCorroboration('instar-codex-arm-', secsAgo(3600))).toBe('name-shape-mismatch');
  });

  it('rejects a well-shaped name whose embedded time disagrees with tmux', () => {
    // `zzzzzzz` is valid base36 — and encodes a moment nowhere near this session's birth.
    expect(armSessionCorroboration('instar-codex-arm-zzzzzzz', secsAgo(3600))).toBe('timestamp-mismatch');
    // A real arm name, but reused for a session created much later.
    expect(armSessionCorroboration(armName(86_400), secsAgo(60))).toBe('timestamp-mismatch');
  });

  it('allows a tolerance for clock adjustment, not for coincidence', () => {
    const created = secsAgo(3600);
    const minted = (created * 1000) + NAME_TIME_TOLERANCE_MS - 1000;
    expect(armSessionCorroboration(`${ARM_SESSION_PREFIX}${minted.toString(36)}`, created)).toBe('corroborated');
    const tooFar = (created * 1000) + NAME_TIME_TOLERANCE_MS + 1000;
    expect(armSessionCorroboration(`${ARM_SESSION_PREFIX}${tooFar.toString(36)}`, created)).toBe('timestamp-mismatch');
  });

  it('is not even consulted for a non-arm name', () => {
    expect(armSessionCorroboration('sagemind-server', secsAgo(3600))).toBe('not-an-arm-name');
  });
});

describe('CodexArmSessionSweeper', () => {
  it('kills a corroborated orphan older than maxAgeMs', () => {
    const row = armRow(3600);
    const { sweeper, killed } = build([row]);
    const r = sweeper.sweep();
    expect(killed).toEqual([row.name]);
    expect(r.killed).toBe(1);
    expect(r.errors).toBe(0);
  });

  // Invariant 1 — prefix is exact, anchored, and includes the trailing hyphen.
  it('never touches a session that is not prefixed instar-codex-arm-', () => {
    const { sweeper, killed } = build([
      { name: 'sagemind-server', createdEpochSec: secsAgo(86_400) },
      { name: 'ai-guy-topic-25777', createdEpochSec: secsAgo(86_400) },
      { name: 'dawn-evolve-prop-1339', createdEpochSec: secsAgo(86_400) },
      { name: 'my-instar-codex-arm-x', createdEpochSec: secsAgo(86_400) }, // prefix not at 0
      { name: 'instar-codex-armadillo', createdEpochSec: secsAgo(86_400) }, // no trailing hyphen match
    ]);
    const r = sweeper.sweep();
    expect(killed).toEqual([]);
    expect(r.killed).toBe(0);
    expect(r.kept).toBe(0); // not candidates at all — never even counted as kept
  });

  it('keeps an uncorroborated look-alike and says why', () => {
    const { sweeper, killed } = build([
      { name: 'instar-codex-arm-SCRATCH', createdEpochSec: secsAgo(86_400) }, // uppercase: wrong shape
      { name: 'instar-codex-arm-zzzzzzz', createdEpochSec: secsAgo(86_400) }, // right shape, wrong time
    ]);
    const r = sweeper.sweep();
    expect(killed).toEqual([]);
    expect(r.keptReasons).toEqual({ 'name-shape-mismatch': 1, 'timestamp-mismatch': 1 });
  });

  it('isArmSessionName anchors the prefix at position 0', () => {
    expect(isArmSessionName('instar-codex-arm-abc')).toBe(true);
    expect(isArmSessionName('my-instar-codex-arm-abc')).toBe(false);
    expect(isArmSessionName('instar-codex-armadillo')).toBe(false);
    expect(ARM_SESSION_PREFIX).toBe('instar-codex-arm-');
  });

  // Invariant 2 — the age floor beats codexHookArm's own 50s arming window.
  it('keeps an arm session that is still inside the arming window', () => {
    const { sweeper, killed } = build([armRow(20)]);
    const r = sweeper.sweep();
    expect(r.kept).toBe(1);
    expect(r.keptReasons['within-age-threshold']).toBe(1);
    expect(killed).toEqual([]);
  });

  it('clamps a carelessly low maxAgeMs up to the floor', () => {
    const { sweeper, killed } = build([armRow(30)], { maxAgeMs: 1_000 });
    expect(sweeper.getStatus().maxAgeMs).toBe(MIN_MAX_AGE_MS);
    sweeper.sweep();
    expect(killed).toEqual([]); // 30s old is still inside the clamped floor
  });

  // Invariant 3 — a future-dated session (clock skew) is kept, not treated as ancient.
  it('keeps a session whose creation time is in the future', () => {
    const { sweeper, killed } = build([armRow(-7200)]);
    expect(sweeper.sweep().kept).toBe(1);
    expect(killed).toEqual([]);
  });

  // Invariant 4 — an unreadable session list ends the pass with ZERO kills.
  it('fails closed when the session list cannot be read', () => {
    const killed: string[] = [];
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => { throw new Error('tmux: connection refused'); },
        killSession: (n) => { killed.push(n); },
        now: () => NOW,
      },
    );
    const r = sweeper.sweep();
    expect(r.failedClosed).toBe(true);
    expect(r.killed).toBe(0);
    expect(r.errors).toBe(1);
    expect(killed).toEqual([]);
  });

  // P19 — No Unbounded Loops: a permanently broken tmux is not re-probed forever.
  it('opens a breaker after maxConsecutiveListFailures unreadable passes', () => {
    let attempts = 0;
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0, maxConsecutiveListFailures: 3 },
      {
        listSessions: () => { attempts += 1; throw new Error('tmux gone'); },
        killSession: () => {},
        now: () => NOW,
      },
    );
    sweeper.sweep(); sweeper.sweep();
    expect(sweeper.getStatus().breakerOpen).toBe(false);
    const third = sweeper.sweep();
    expect(third.breakerOpen).toBe(true);
    expect(sweeper.getStatus().breakerOpen).toBe(true);
    // Fourth pass does not even call the lister.
    const fourth = sweeper.sweep();
    expect(fourth.breakerOpen).toBe(true);
    expect(attempts).toBe(3);
  });

  it('an open breaker lets a probe through and CLOSES when the list becomes readable', () => {
    // The normal boot order on a host: the sweeper starts before the tmux server exists.
    let present = false;
    const row = armRow(3600);
    let attempts = 0;
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0, maxConsecutiveListFailures: 2, breakerProbeEveryPasses: 3 },
      {
        listSessions: () => { attempts += 1; if (!present) throw new Error('no server running'); return [row]; },
        killSession: () => {},
        now: () => NOW,
      },
    );
    sweeper.sweep(); sweeper.sweep();                 // 2 failures → open
    expect(sweeper.getStatus().breakerOpen).toBe(true);
    sweeper.sweep(); sweeper.sweep();                 // passes 1,2 since open: skipped
    expect(attempts).toBe(2);
    present = true;
    const probe = sweeper.sweep();                    // pass 3 since open: PROBE
    expect(attempts).toBe(3);
    expect(probe.breakerOpen).toBe(false);
    expect(probe.killed).toBe(1);                     // and it swept on the same pass
    expect(sweeper.getStatus().breakerOpen).toBe(false);
    expect(sweeper.getStatus().breakerProbes).toBe(1);
  });

  it('a pass stops issuing kills once its wall-clock budget is spent', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      name: `${ARM_SESSION_PREFIX}${(NOW - 3_600_000 - i).toString(36)}`,
      createdEpochSec: Math.floor((NOW - 3_600_000 - i) / 1000),
    }));
    const killed: string[] = [];
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0, maxPassMs: 500 },
      {
        listSessions: () => rows,
        // each kill "takes" 400 ms of wall clock
        killSession: (n) => { const t = Date.now(); while (Date.now() - t < 400) { /* spin */ } killed.push(n); },
        now: () => NOW,
      },
    );
    const r = sweeper.sweep();
    expect(killed.length).toBeGreaterThanOrEqual(1);
    expect(killed.length).toBeLessThan(6);
    expect(r.keptReasons['pass-time-budget']).toBe(6 - killed.length);
  });

  it('fails CLOSED when the protected-name lookup itself fails', () => {
    const killed: string[] = [];
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [armRow(3600)],
        killSession: (n) => { killed.push(n); },
        protectedNames: () => { throw new Error('config unreadable'); },
        now: () => NOW,
      },
    );
    const r = sweeper.sweep();
    expect(killed).toEqual([]);
    expect(r.failedClosed).toBe(true);
    expect(r.errors).toBe(1);
  });

  it('dry-run reports DISTINCT would-kill names of the LATEST pass, not the cumulative count', () => {
    const rows = [armRow(3600), armRow(3601)];
    let present = rows;
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: true, initialPassDelayMs: 0 },
      { listSessions: () => present, killSession: () => {}, now: () => NOW },
    );
    sweeper.sweep(); sweeper.sweep(); sweeper.sweep();
    expect(sweeper.getStatus().wouldKill).toBe(6);         // cumulative, re-counted each pass
    expect(sweeper.getStatus().wouldKillDistinct).toBe(2); // the honest backlog
    present = [rows[0]];                                   // a sibling cleared one
    sweeper.sweep();
    expect(sweeper.getStatus().wouldKillDistinct).toBe(1); // reflected next pass
  });

  it('dry-run observation is NOT capped — a standing backlog beyond 50 is fully reported', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      name: `${ARM_SESSION_PREFIX}${(NOW - 3_600_000 - i).toString(36)}`,
      createdEpochSec: Math.floor((NOW - 3_600_000 - i) / 1000),
    }));
    const { sweeper, killed } = build(rows, { dryRun: true, maxKillsPerPass: 50 });
    const r = sweeper.sweep();
    expect(killed).toEqual([]);
    expect(r.wouldKill).toBe(120);
    expect(sweeper.getStatus().wouldKillDistinct).toBe(120);
    expect(r.keptReasons['per-pass-cap']).toBeUndefined();
  });

  // Invariant 9 — an attached session is never an orphan, whatever its age. (The activity keep
  // was withdrawn: tmux's session_activity does not move for a detached send-keys-driven arm.)
  it('keeps an attached session whatever its age; activity alone does not save a detached one', () => {
    const attached = { ...armRow(3600), attached: true };
    const detachedButActive = { ...armRow(3601), activityEpochSec: secsAgo(60), attached: false };
    const { sweeper, killed } = build([attached, detachedButActive]);
    const r = sweeper.sweep();
    expect(killed).toEqual([detachedButActive.name]);
    expect(r.keptReasons).toEqual({ attached: 1 });
  });

  it('a kill that finds the session already gone is alreadyGone, not an error', () => {
    const row = armRow(3600);
    let probes = 0;
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [row],
        killSession: () => { throw new Error("can't find session"); },
        hasSession: () => { probes += 1; return 'absent' as const; },
        now: () => NOW,
      },
    );
    const r = sweeper.sweep();
    expect(probes).toBe(1);
    expect(r.alreadyGone).toBe(1);
    expect(r.errors).toBe(0);
    expect(sweeper.getStatus().alreadyGone).toBe(1);
    // and it is NOT booked as a kill failure for the retry brake
    const again = sweeper.sweep();
    expect(again.keptReasons['kill-failures-exhausted']).toBeUndefined();
  });

  it('an UNKNOWN probe after a failed kill is an error, never a successful cleanup', () => {
    const row = armRow(3600);
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [row],
        killSession: () => { throw new Error('timeout'); },
        hasSession: () => 'unknown' as const,
        now: () => NOW,
      },
    );
    const r = sweeper.sweep();
    expect(r.errors).toBe(1);
    expect(r.alreadyGone).toBe(0);
  });

  it('a kill failure on a session that still exists IS an error', () => {
    const row = armRow(3600);
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [row],
        killSession: () => { throw new Error('permission denied'); },
        hasSession: () => 'present' as const,
        now: () => NOW,
      },
    );
    const r = sweeper.sweep();
    expect(r.errors).toBe(1);
    expect(r.alreadyGone).toBe(0);
  });

  it('dryRun is read LIVE at each pass — the arming flip needs no restart', () => {
    const row = armRow(3600);
    let live: boolean | undefined = true;
    const killed: string[] = [];
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: true, initialPassDelayMs: 0 },
      { listSessions: () => [row], killSession: (n) => { killed.push(n); }, liveDryRun: () => live, now: () => NOW },
    );
    sweeper.sweep();
    expect(killed).toEqual([]);
    live = false;
    sweeper.sweep();
    expect(killed).toEqual([row.name]);
    expect(sweeper.getStatus().dryRun).toBe(false);
    live = undefined; // unreadable → keep current posture
    sweeper.sweep();
    expect(sweeper.getStatus().dryRun).toBe(false);
  });

  it('dry-run audits a name ONCE per process lifetime, not once per pass', () => {
    const row = armRow(3600);
    const { sweeper, audited } = build([row], { dryRun: true });
    sweeper.sweep(); sweeper.sweep(); sweeper.sweep();
    expect(audited).toHaveLength(1);
  });

  it('a readable pass resets the consecutive-failure count', () => {
    let fail = true;
    const row = armRow(3600);
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0, maxConsecutiveListFailures: 3 },
      {
        listSessions: () => { if (fail) throw new Error('blip'); return [row]; },
        killSession: () => {},
        now: () => NOW,
      },
    );
    sweeper.sweep(); sweeper.sweep();
    expect(sweeper.getStatus().consecutiveListFailures).toBe(2);
    fail = false;
    sweeper.sweep();
    expect(sweeper.getStatus().consecutiveListFailures).toBe(0);
    expect(sweeper.getStatus().breakerOpen).toBe(false);
  });

  // P19 — a permanently unkillable session is not retried forever.
  it('stops attempting a session after maxKillFailuresPerSession', () => {
    const row = armRow(3600);
    let attempts = 0;
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0, maxKillFailuresPerSession: 2 },
      {
        listSessions: () => [row],
        killSession: () => { attempts += 1; throw new Error('permission denied'); },
        now: () => NOW,
      },
    );
    sweeper.sweep(); sweeper.sweep();
    expect(attempts).toBe(2);
    const third = sweeper.sweep();
    expect(attempts).toBe(2); // not retried
    expect(third.keptReasons['kill-failures-exhausted']).toBe(1);
  });

  // Invariant 6 — bounded blast radius.
  it('kills at most maxKillsPerPass in one pass', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      name: `${ARM_SESSION_PREFIX}${(NOW - 3_600_000 - i).toString(36)}`,
      createdEpochSec: Math.floor((NOW - 3_600_000 - i) / 1000),
    }));
    const { sweeper, killed } = build(rows, { maxKillsPerPass: 5 });
    const r = sweeper.sweep();
    expect(r.killed).toBe(5);
    expect(killed).toHaveLength(5);
    expect(r.keptReasons['per-pass-cap']).toBe(35);
  });

  it('a kill failure is counted and does not stop the pass', () => {
    const a = armRow(3600);
    const b = armRow(3601);
    const killed: string[] = [];
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [a, b],
        killSession: (n) => { if (n === a.name) throw new Error('session not found'); killed.push(n); },
        now: () => NOW,
      },
    );
    const r = sweeper.sweep();
    expect(r.errors).toBe(1);
    expect(r.killed).toBe(1);
    expect(killed).toEqual([b.name]);
  });

  it('dryRun books wouldKill, never killed, and kills nothing', () => {
    const row = armRow(3600);
    const { sweeper, killed, audited } = build([row], { dryRun: true });
    const r = sweeper.sweep();
    expect(killed).toEqual([]);
    expect(r.killed).toBe(0);     // a status must never say sessions died when none did
    expect(r.wouldKill).toBe(1);
    expect(r.kills[0]?.dryRun).toBe(true);
    expect(audited).toHaveLength(1);
    expect(sweeper.getStatus().killed).toBe(0);
    expect(sweeper.getStatus().wouldKill).toBe(1);
  });

  it('the per-pass cap bounds ATTEMPTS, so a pass of failing kills is still bounded', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      name: `${ARM_SESSION_PREFIX}${(NOW - 3_600_000 - i).toString(36)}`,
      createdEpochSec: Math.floor((NOW - 3_600_000 - i) / 1000),
    }));
    let attempts = 0;
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0, maxKillsPerPass: 3 },
      { listSessions: () => rows, killSession: () => { attempts += 1; throw new Error('nope'); }, now: () => NOW },
    );
    const r = sweeper.sweep();
    expect(attempts).toBe(3);
    expect(r.errors).toBe(3);
    expect(r.keptReasons['per-pass-cap']).toBe(7);
  });

  // Invariant 5 — protected / standing names are never touched, asserted as code.
  it('never touches a protected or standing session name, even one that corroborates', () => {
    const row = armRow(3600);
    const killed: string[] = [];
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [row],
        killSession: (n) => { killed.push(n); },
        protectedNames: () => [row.name],
        now: () => NOW,
      },
    );
    const r = sweeper.sweep();
    expect(killed).toEqual([]);
    expect(r.keptReasons['protected-or-standing']).toBe(1);
  });

  it('ships enabled + dryRun with NO config at all — the posture claim, proven', () => {
    const sweeper = new CodexArmSessionSweeper({}, { listSessions: () => [], killSession: () => {} });
    const st = sweeper.getStatus();
    expect(st.enabled).toBe(true);
    expect(st.dryRun).toBe(true);
    expect(st.maxAgeMs).toBe(900_000);
    expect(st.sweepIntervalMs).toBe(600_000);
  });

  it('a malformed timer period from config is resolved, never allowed to spin', () => {
    const sweeper = new CodexArmSessionSweeper(
      { sweepIntervalMs: null as unknown as number, initialPassDelayMs: '10m' as unknown as number },
      { listSessions: () => [], killSession: () => {} },
    );
    expect(sweeper.getStatus().sweepIntervalMs).toBe(600_000);
    const tiny = new CodexArmSessionSweeper({ sweepIntervalMs: 5 }, { listSessions: () => [], killSession: () => {} });
    expect(tiny.getStatus().sweepIntervalMs).toBe(60_000); // floored, not honoured
  });

  it('a pass that throws inside the interval callback never escapes to the event loop', () => {
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      { listSessions: () => [armRow(3600)], killSession: () => {}, now: () => NaN },
    );
    // A non-finite clock would have thrown from toISOString; it is guarded instead.
    expect(() => sweeper.sweep()).not.toThrow();
  });

  it('a disabled sweeper does nothing at all', () => {
    const { sweeper, killed } = build([armRow(3600)], { enabled: false });
    expect(sweeper.sweep().killed).toBe(0);
    expect(killed).toEqual([]);
  });

  it('an audit sink that throws never fails the sweep', () => {
    const row = armRow(3600);
    const killed: string[] = [];
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [row],
        killSession: (n) => { killed.push(n); },
        now: () => NOW,
        audit: () => { throw new Error('disk full'); },
      },
    );
    expect(() => sweeper.sweep()).not.toThrow();
    expect(killed).toEqual([row.name]);
  });

  it('a config key present-but-undefined does not erase its default', () => {
    const sweeper = new CodexArmSessionSweeper(
      { enabled: true, maxKillsPerPass: undefined, maxAgeMs: undefined },
      { listSessions: () => [], killSession: () => {}, now: () => NOW },
    );
    expect(sweeper.getStatus().maxKillsPerPass).toBe(50);
    expect(sweeper.getStatus().maxAgeMs).toBe(900_000);
  });

  it('getStatus reports cumulative counters', () => {
    const old = armRow(3600);
    const { sweeper } = build([old, armRow(10)]);
    sweeper.sweep();
    const s = sweeper.getStatus();
    expect(s.killed).toBe(1);
    expect(s.kept).toBe(1);
    expect(s.passes).toBe(1);
    expect(s.lastPassAt).toBe(new Date(NOW).toISOString());
    expect(s.lastKills[0]?.session).toBe(old.name);
  });
});

describe('parseTmuxSessionRows', () => {
  it('parses real `tmux ls -F` output', () => {
    const rows = parseTmuxSessionRows([
      'instar-codex-arm-mvm43in2 1792900000',
      'sagemind-server 1792800000',
      '',
    ].join('\n'));
    expect(rows).toEqual([
      { name: 'instar-codex-arm-mvm43in2', createdEpochSec: 1792900000 },
      { name: 'sagemind-server', createdEpochSec: 1792800000 },
    ]);
  });

  it('parses the four-field form with activity and attached', () => {
    const rows = parseTmuxSessionRows('instar-codex-arm-mvm43in2 1792900000 1792900100 1');
    expect(rows).toEqual([{ name: 'instar-codex-arm-mvm43in2', createdEpochSec: 1792900000, activityEpochSec: 1792900100, attached: true }]);
    const rows0 = parseTmuxSessionRows('my build session 1792900000 1792900000 0');
    expect(rows0).toEqual([{ name: 'my build session', createdEpochSec: 1792900000, activityEpochSec: 1792900000, attached: false }]);
  });

  it('splits on the LAST space, so a session name containing spaces survives intact', () => {
    // Splitting on the FIRST space would yield the session `my`, which then fails the
    // arm-prefix test and is silently ignored — a session quietly invisible to the sweep.
    const rows = parseTmuxSessionRows('my build session 1792900000');
    expect(rows).toEqual([{ name: 'my build session', createdEpochSec: 1792900000 }]);
  });

  it('drops a row whose timestamp is not a number rather than guessing at it', () => {
    // A row we cannot date is a row we must not age out.
    expect(parseTmuxSessionRows('instar-codex-arm-x notanumber')).toEqual([]);
    expect(parseTmuxSessionRows('instar-codex-arm-x')).toEqual([]);
  });

  it('makeTmuxSessionLister returns a callable bound to the given tmux path', () => {
    expect(typeof makeTmuxSessionLister('/opt/homebrew/bin/tmux')).toBe('function');
  });
});
