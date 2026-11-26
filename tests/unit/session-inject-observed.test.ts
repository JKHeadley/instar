/**
 * ACT-091 — the observed paste confirmation (SessionManager.injectPasteNotificationObserved).
 *
 * The delivery verdict is load-bearing: it decides the promising auto-ack, the
 * topic surface and the commitment. Before this, `injectPasteNotificationConfirmed`
 * returned false whenever the injected marker was still at the prompt after
 * 7.5 s — which is exactly what a BUSY (mid-turn) Claude Code session shows while
 * it holds the text as queued input. A live session that received the reply
 * nine seconds later was logged "no live session received it" (2026-10-12 22:21Z).
 *
 * Now, with the pane stubbed and timers faked:
 *  - marker gone inside the window            → `submitted`
 *  - idle prompt, marker still there at 7.5 s → `stuck`
 *  - busy footer, marker still there at 7.5 s → `queued-busy` (provisional, NOT delivered)
 *      · later capture: marker gone           → settle() = `submitted`
 *      · later: idle prompt + marker, twice   → `stuck`
 *      · footer never clears (stale footer)   → `ceiling` at 10 min, never `submitted`
 *      · session disappears                   → `session-gone`
 *  - the boolean wrapper is true ONLY for `submitted`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';

const REF = '[paste] Content notification saved to /tmp/x/notif.md — read it to see the details.';
const MARKER = REF.slice(0, 40); // what extractInjectionMarker yields
const IDLE_WITH_MARKER = `⏺ Done.\n❯ ${REF}\n  ⏵⏵ bypass permissions on`;
const BUSY_WITH_MARKER = `⏺ Running tests…\n❯ ${REF}\n  esc to interrupt · 12s`;
const IDLE_CLEAR = `⏺ User: ${REF}\n⏺ Reading it now.\n❯ \n  ⏵⏵ bypass permissions on`;
const BUSY_CLEAR = `⏺ User: ${REF}\n⏺ Reading it now.\n❯ \n  esc to interrupt · 3s`;

function build(panes: () => string, alive: () => boolean = () => true) {
  const mgr: any = Object.create(SessionManager.prototype);
  mgr.config = { tmuxPath: '/usr/bin/tmux' };
  mgr.injectPasteNotification = vi.fn(() => REF);
  mgr.captureOutput = vi.fn(panes);
  mgr.tmuxSessionExists = vi.fn(alive);
  return mgr as SessionManager & { captureOutput: ReturnType<typeof vi.fn> };
}

/** A pane that changes with the fake clock: the LAST entry whose `atMs` <= now. */
function timeline(entries: Array<{ atMs: number; pane: string }>): () => string {
  const t0 = Date.now();
  return () => {
    const now = Date.now() - t0;
    let pane = entries[0].pane;
    for (const e of entries) if (e.atMs <= now) pane = e.pane;
    return pane;
  };
}

describe('injectPasteNotificationObserved — the three verdicts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marker gone at the first check → submitted (the ordinary idle case)', async () => {
    const mgr = build(() => IDLE_CLEAR);
    const p = mgr.injectPasteNotificationObserved('echo-topic-1', 'reply');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ state: 'submitted' });
    expect(mgr.captureOutput).toHaveBeenCalledTimes(1);
  });

  it('idle prompt with the marker still there after the full window → stuck', async () => {
    const mgr = build(() => IDLE_WITH_MARKER);
    const p = mgr.injectPasteNotificationObserved('echo-topic-1', 'reply');
    await vi.advanceTimersByTimeAsync(7500);
    expect(await p).toEqual({ state: 'stuck' });
    expect(mgr.captureOutput).toHaveBeenCalledTimes(4); // 1000, 3000, 5000, 7500
  });

  it('busy footer with the marker at the prompt after the window → queued-busy, which is NOT submitted', async () => {
    const mgr = build(() => BUSY_WITH_MARKER);
    const p = mgr.injectPasteNotificationObserved('echo-topic-1', 'reply');
    await vi.advanceTimersByTimeAsync(7500);
    const r = await p;
    expect(r.state).toBe('queued-busy');
    // The boolean wrapper reads it as not confirmed.
    const p2 = mgr.injectPasteNotificationConfirmed('echo-topic-1', 'reply');
    await vi.advanceTimersByTimeAsync(7500);
    expect(await p2).toBe(false);
  });

  it('the inject throwing, or the session disappearing inside the window → stuck', async () => {
    const throwing = build(() => IDLE_CLEAR);
    (throwing.injectPasteNotification as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('no such session'); });
    expect(await throwing.injectPasteNotificationObserved('gone', 'reply')).toEqual({ state: 'stuck' });
    const dying = build(() => IDLE_WITH_MARKER, () => false);
    const p = dying.injectPasteNotificationObserved('gone', 'reply');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual({ state: 'stuck' });
  });
});

describe('queued-busy → settle(): the bounded follow-up watch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function queuedBusy(panes: () => string, alive: () => boolean = () => true) {
    const mgr = build(panes, alive);
    const p = mgr.injectPasteNotificationObserved('echo-topic-1', 'reply');
    await vi.advanceTimersByTimeAsync(7500);
    const r = await p;
    expect(r.state).toBe('queued-busy');
    return { mgr, r: r as Extract<typeof r, { state: 'queued-busy' }> };
  }

  it('the watch is lazy: nothing is captured until settle() is called, and settle() is memoized', async () => {
    const { mgr, r } = await queuedBusy(() => BUSY_WITH_MARKER);
    const before = mgr.captureOutput.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mgr.captureOutput).toHaveBeenCalledTimes(before);
    const a = r.settle();
    const b = r.settle();
    expect(a).toBe(b);
  });

  it('the queued text leaves the prompt when the turn reaches its next round → submitted (the live false negative, fixed)', async () => {
    // Busy with the marker for 9 s after the window, then the transcript shows it consumed.
    const { r } = await queuedBusy(timeline([{ atMs: 0, pane: BUSY_WITH_MARKER }, { atMs: 16_500, pane: BUSY_CLEAR }]));
    const settled = r.settle();
    await vi.advanceTimersByTimeAsync(5_000);  // 12.5 s: still queued
    await vi.advanceTimersByTimeAsync(5_000);  // 17.5 s: gone
    expect(await settled).toBe('submitted');
  });

  it('the turn ends and the text is still at an IDLE prompt on two consecutive polls → stuck (no ack, surfaced)', async () => {
    // Polls land at 12.5 s, 17.5 s, 22.5 s from the inject: busy, idle+marker, idle+marker.
    const { r } = await queuedBusy(timeline([{ atMs: 0, pane: BUSY_WITH_MARKER }, { atMs: 15_000, pane: IDLE_WITH_MARKER }]));
    const settled = r.settle();
    await vi.advanceTimersByTimeAsync(5_000);  // busy
    await vi.advanceTimersByTimeAsync(5_000);  // idle+marker, streak 1 — not yet
    let done = false; void settled.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);  // idle+marker, streak 2
    expect(await settled).toBe('stuck');
  });

  it('a single idle frame between the turn ending and the queued text submitting does NOT count as stuck', async () => {
    const { r } = await queuedBusy(timeline([
      { atMs: 0, pane: BUSY_WITH_MARKER },
      { atMs: 10_000, pane: IDLE_WITH_MARKER }, // one frame
      { atMs: 14_000, pane: BUSY_CLEAR },        // submitted, next turn running
    ]));
    const settled = r.settle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settled).toBe('submitted');
  });

  it('a STALE footer over an idle prompt with the marker present: never submitted — ceiling at 10 minutes', async () => {
    const { mgr, r } = await queuedBusy(() => BUSY_WITH_MARKER);
    const settled = r.settle();
    let value: string | null = null; void settled.then((v) => { value = v; });
    await vi.advanceTimersByTimeAsync(SessionManager.QUEUED_INJECTION_WATCH_CEILING_MS - 15_000);
    await Promise.resolve();
    expect(value).toBeNull(); // still watching, nothing claimed
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settled).toBe('ceiling');
    // 5 s cadence for the first minute (12 polls), then 15 s (36 polls) = 48, plus the 4 window checks.
    expect(mgr.captureOutput.mock.calls.length).toBe(4 + 12 + 36);
  });

  it('the session disappears during the watch → session-gone', async () => {
    let alive = true;
    const { r } = await queuedBusy(() => BUSY_WITH_MARKER, () => alive);
    const settled = r.settle();
    await vi.advanceTimersByTimeAsync(5_000);
    alive = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled).toBe('session-gone');
  });

  it('a capture error during the watch resolves stuck, never submitted', async () => {
    let calls = 0;
    const { r } = await queuedBusy(() => { if (++calls > 4) throw new Error('tmux gone'); return BUSY_WITH_MARKER; });
    const settled = r.settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled).toBe('stuck');
  });

  it('the ceiling is the Bash tool\'s maximum foreground timeout (10 min)', () => {
    expect(SessionManager.QUEUED_INJECTION_WATCH_CEILING_MS).toBe(600_000);
  });
});
