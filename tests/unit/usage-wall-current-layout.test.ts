/**
 * Usage-wall detection on the CURRENT Claude Code layout (fb-f8b946ae-597).
 *
 * The fixture is a real pane captured from session echo-instar-app on
 * 2026-11-10, stuck at "You've hit your weekly limit" while the default-on
 * wall rescue never fired: rows the chrome list did not know followed the
 * banner, background-agent timers ticked so the pane never settled, and a
 * right-hand diff panel put text on every row. The operator's name and
 * Telegram id are redacted; nothing else is changed.
 *
 * Every boundary is tested from both sides: the walled pane is detected, the
 * same pane with real session output after the banner is not, and ticking
 * timer rows do not restart the settle clock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectUsageWall,
  evaluateUsageWallSettle,
  isPaneChromeLine,
  paneShowsUsageWallBanner,
  currentUsageLimitBanner,
  stripSidePanel,
  BACKGROUND_AGENT_ROW,
} from '../../src/monitoring/rateLimitDetection.js';
import { sessionUsageWallFromTranscript, confirmSessionUsageLimit } from '../../src/monitoring/sessionUsageLimitEvidence.js';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'usage-wall', 'claude-weekly-wall-side-panel-2026-11-10.txt');
const REAL_PANE = fs.readFileSync(FIXTURE, 'utf-8');
const NOW = Date.parse('2026-11-10T15:57:00Z');

/** Insert `row` right after the LAST banner block of the real pane. */
function withRowAfterLastBanner(pane: string, row: string): string {
  const lines = pane.split('\n');
  let idx = -1;
  lines.forEach((l, i) => { if (l.includes('/usage-credits to finish')) idx = i; });
  lines.splice(idx + 1, 0, row);
  return lines.join('\n');
}

/** The real pane one second later: timers, token counts and shell counts moved. */
function ticked(pane: string): string {
  return pane
    .replace('1h 8m 2s · ↓ 312.5k tokens', '1h 8m 3s · ↓ 312.9k tokens')
    .replace('1h 8m 33s · ↓ 363.2k tokens', '1h 8m 34s · ↓ 363.4k tokens')
    .replace('7 shells · ↓ to manage', '8 shells · ↓ to manage');
}

describe('usage wall on the 2026-11-10 Claude Code layout (real pane)', () => {
  it('detects the walled real pane', () => {
    expect(detectUsageWall(REAL_PANE)).toBe(true);
  });

  it('does NOT detect the same pane when real session output follows the banner', () => {
    const resumed = withRowAfterLastBanner(REAL_PANE, '⏺ I pushed the fix and opened the pull request.');
    expect(detectUsageWall(resumed)).toBe(false);
  });

  it('the courtesy-notice banner keeps the reset time and the new companion hint', () => {
    const banner = currentUsageLimitBanner(REAL_PANE);
    expect(banner).toContain("You've hit your weekly limit · resets Nov 14 at 1pm");
    expect(banner).toContain('/usage-credits to finish');
    expect(currentUsageLimitBanner(withRowAfterLastBanner(REAL_PANE, '⏺ Done — the fix is in.'))).toBeNull();
  });

  it('settles although background-agent timers tick on every poll', () => {
    const a = evaluateUsageWallSettle(REAL_PANE, undefined, NOW, { settleMs: 20_000 });
    expect(a.decision).toBe('waiting');
    const b = evaluateUsageWallSettle(ticked(REAL_PANE), a.next, NOW + 10_000, { settleMs: 20_000 });
    expect(b.decision).toBe('waiting');
    expect(b.next!.since).toBe(NOW); // the tick did not restart the clock
    const c = evaluateUsageWallSettle(ticked(ticked(REAL_PANE)), b.next, NOW + 20_000, { settleMs: 20_000 });
    expect(c.decision).toBe('settled');
  });

  it('a change at or above the banner still restarts the settle clock', () => {
    const a = evaluateUsageWallSettle(REAL_PANE, undefined, NOW, { settleMs: 20_000 });
    const moved = REAL_PANE.replace('Checking in', 'Checking in again');
    const b = evaluateUsageWallSettle(moved, a.next, NOW + 20_000, { settleMs: 20_000 });
    expect(b.decision).toBe('waiting');
    expect(b.next!.since).toBe(NOW + 20_000);
  });

  it('a retry spinner after the banner vetoes the wall', () => {
    expect(detectUsageWall(withRowAfterLastBanner(REAL_PANE, '  Retrying in 10s · attempt 2/10'))).toBe(false);
    expect(paneShowsUsageWallBanner(withRowAfterLastBanner(REAL_PANE, '  Retrying in 10s · attempt 2/10'))).toBe(false);
  });
});

describe('side panel removal', () => {
  it('cuts every row of the real pane at the panel rule', () => {
    const lines = stripSidePanel(REAL_PANE.split('\n'));
    expect(lines.some((l) => l.includes('│'))).toBe(false);
    expect(lines.some((l) => l.includes('.claude/settings.json'))).toBe(false);
    expect(lines.find((l) => l.includes('Update installed'))!.trim()).toBe('✔ Update installed · Restart to update');
  });

  it('leaves a pane with no side panel untouched (boxed prompt, a single prose rule)', () => {
    const pane = [
      '⏺ The table below compares the two options │ cost │ speed',
      '╭──────────────────────────────╮',
      '│ >                            │',
      '╰──────────────────────────────╯',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ];
    expect(stripSidePanel(pane)).toEqual(pane);
  });
});

describe('chrome rows are anchored (both sides of each boundary)', () => {
  const cases: Array<[string, string, string]> = [
    // [chrome row, look-alike prose that must stay session output, label]
    ['✻ Baked for 3s · done 7:56 AM · 7 shells still running', '✻ Baked for 3s and then I rewrote the parser', 'finished-turn row'],
    ['✻ Cooked for 9h 55m 7s · done 6:23 AM · 7 shells still running', 'Cooked for 2 hours, then served.', 'finished-turn row (long)'],
    ['     Usage credits are at least 30% off for one purchase · 14 days left · /usage-credits', 'Usage credits are cheaper this month, see the pricing page.', 'usage-credits promo'],
    ['✔ Update installed · Restart to update', '✔ Update installed for the API client in src/api', 'update notice'],
    ['  ⏵⏵ bypass permissions on · 7 shells · ↓ to manage', 'bypass permissions on the staging host were removed', 'permission status row'],
  ];
  for (const [chrome, prose, label] of cases) {
    it(label, () => {
      expect(isPaneChromeLine(chrome)).toBe(true);
      expect(isPaneChromeLine(prose)).toBe(false);
    });
  }

  it('background-agent rows', () => {
    expect(BACKGROUND_AGENT_ROW.test('◯ general-purpose  Pushing side-effects artifact commit upstream   1h 8m 2s · ↓ 312.5k tokens')).toBe(true);
    expect(BACKGROUND_AGENT_ROW.test('◯ general-purpose  Deleting a config   45s')).toBe(true);
    expect(BACKGROUND_AGENT_ROW.test('◯ general-purpose finished the review in 1h 8m 2s')).toBe(false);
    expect(BACKGROUND_AGENT_ROW.test('⏺ I spent 1h 8m 2s on this')).toBe(false);
  });

  it('"⏺ main" is chrome only above a background-agent row', () => {
    const banner = '  ⎿  You\'ve hit your weekly limit · resets Nov 14 at 1pm\n';
    expect(detectUsageWall(banner + '⏺ main\n❯ ')).toBe(false); // a one-word reply
    expect(detectUsageWall(banner + '  ⏺ main\n  ◯ general-purpose  Running tests   2m 3s · ↓ 1.2k tokens\n')).toBe(true);
  });

  it('the new companion wording is a banner row', () => {
    expect(detectUsageWall('     /usage-credits to finish what you’re working on.\n❯ ')).toBe(true);
    expect(detectUsageWall('⏺ Run /usage-credits to finish what you are working on, I said.\n❯ ')).toBe(false);
  });
});

// ── Transcript evidence ──────────────────────────────────────────────────────

describe('sessionUsageWallFromTranscript (the exact session\'s own record)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/usage-wall-current-layout.test.ts:cleanup' });
    dir = undefined;
  });
  const SID = '7f9694e9-83ff-403e-a47d-6f987af8b140';
  const wallRow = (over: Record<string, unknown> = {}) => ({
    type: 'assistant', sessionId: SID, isApiErrorMessage: true, error: 'rate_limit', isSidechain: false,
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 14 at 1pm (America/Los_Angeles)" }] },
    ...over,
  });
  function transcript(rows: unknown[]): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-transcript-'));
    const p = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return p;
  }
  const userRow = { type: 'user', sessionId: SID, message: { content: 'Checking in' } };

  it('returns the banner when the latest main-turn row is the wall error', () => {
    const p = transcript([userRow, wallRow()]);
    expect(sessionUsageWallFromTranscript(p, SID)).toContain('weekly limit');
    expect(confirmSessionUsageLimit(p, SID)).toBe(true);
  });

  it('a server throttle (same error code) is not a usage wall', () => {
    const p = transcript([userRow, wallRow({ message: { content: [{ type: 'text', text: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited' }] } })]);
    expect(sessionUsageWallFromTranscript(p, SID)).toBeNull();
    expect(confirmSessionUsageLimit(p, SID)).toBe(true); // the legacy predicate is unchanged
  });

  it('a later user row refutes the wall; sidechain and other-session rows are ignored', () => {
    expect(sessionUsageWallFromTranscript(transcript([wallRow(), userRow]), SID)).toBeNull();
    expect(sessionUsageWallFromTranscript(transcript([userRow, wallRow({ isSidechain: true })]), SID)).toBeNull();
    expect(sessionUsageWallFromTranscript(transcript([userRow, wallRow({ sessionId: 'other' })]), SID)).toBeNull();
  });

  it('a normal assistant reply is not a wall', () => {
    const p = transcript([userRow, { type: 'assistant', sessionId: SID, message: { content: [{ type: 'text', text: "You've hit your weekly limit, so I paused." }] } }]);
    expect(sessionUsageWallFromTranscript(p, SID)).toBeNull();
  });
});

// ── Watchdog: transcript as the primary signal, pane as corroboration ───────

describe('SessionWatchdog.checkUsageWall with transcript evidence', () => {
  let watchdog: SessionWatchdog | undefined;
  afterEach(() => watchdog?.stop());

  // A future layout: a row the chrome list does not know follows the banner.
  const UNKNOWN_LAYOUT = withRowAfterLastBanner(REAL_PANE, '  ▣ 3 checks queued · ctrl+q to view');

  function setup(pane: string, transcriptWall: string | null) {
    const sm = {
      listRunningSessions: vi.fn().mockReturnValue([]),
      captureOutput: vi.fn().mockReturnValue(pane),
      sendKey: vi.fn(),
      isSessionAlive: vi.fn().mockReturnValue(true),
      usageWallFromTranscript: vi.fn().mockReturnValue(transcriptWall),
    } as any;
    const cfg = {
      stateDir: '/tmp/test-watchdog-usage-wall-layout',
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 180, pollIntervalMs: 30_000, rateLimitSettleMs: 0 } },
    } as any;
    watchdog = new SessionWatchdog(cfg, sm, {} as any);
    const walls: string[] = [];
    watchdog.on('usage-wall', (s: string) => walls.push(s));
    return { walls, sm };
  }

  it('the real pane emits from the pane alone; the transcript is not read', () => {
    const { walls, sm } = setup(REAL_PANE, null);
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1');
    expect(walls).toEqual(['s1']);
    expect(sm.usageWallFromTranscript).not.toHaveBeenCalled();
  });

  it('an unknown layout row after the banner: no wall without the transcript', () => {
    const { walls } = setup(UNKNOWN_LAYOUT, null);
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1');
    expect(walls).toEqual([]);
  });

  it('an unknown layout row after the banner: the transcript confirms the wall', () => {
    const { walls, sm } = setup(UNKNOWN_LAYOUT, "You've hit your weekly limit · resets Nov 14 at 1pm");
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1');
    expect(walls).toEqual(['s1']);
    expect(sm.usageWallFromTranscript).toHaveBeenCalledWith('s1');
  });

  it('model output below the banner vetoes the transcript path (stale transcript id after a resume)', () => {
    const resumed = withRowAfterLastBanner(UNKNOWN_LAYOUT, '⏺ Bash(git status)');
    const { walls } = setup(resumed, "You've hit your weekly limit · resets Nov 14 at 1pm");
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1');
    expect(walls).toEqual([]);
    expect(paneShowsUsageWallBanner(resumed)).toBe(false);
    expect(paneShowsUsageWallBanner(UNKNOWN_LAYOUT)).toBe(true); // the task-list "⏺ main" header is not model output
    expect(paneShowsUsageWallBanner(withRowAfterLastBanner(UNKNOWN_LAYOUT, '● Bash(git status)'))).toBe(false); // the Linux output marker
  });

  it('a transcript wall with no banner on the pane does not emit (pane corroboration required)', () => {
    const { walls, sm } = setup('⏺ Working on it.\n❯ ', "You've hit your weekly limit · resets Nov 14 at 1pm");
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1');
    expect(walls).toEqual([]);
    expect(sm.usageWallFromTranscript).not.toHaveBeenCalled();
  });

  it('a throwing transcript reader is not evidence', () => {
    const { walls, sm } = setup(UNKNOWN_LAYOUT, null);
    sm.usageWallFromTranscript.mockImplementation(() => { throw new Error('EACCES'); });
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1');
    expect(walls).toEqual([]);
  });
});
