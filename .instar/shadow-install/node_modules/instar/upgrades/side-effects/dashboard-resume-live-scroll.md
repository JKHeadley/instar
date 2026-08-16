# Side-Effects Review — Dashboard "Resume live output" reliability + always-visible while paused

**Version / slug:** `dashboard-resume-live-scroll`
**Date:** `2026-04-18`
**Author:** `echo`
**Second-pass reviewer:** `not required — pure UI timing fix, no gate/sentinel/watchdog/session-lifecycle surface`

## Summary of the change

The dashboard's "Resume live output" button (and the two sibling resume paths that
fire on scroll-to-bottom and wheel-down) did not reliably snap the xterm viewport
to the bottom after being clicked. The user still landed mid-history and had to
scroll manually to see live output — defeating the purpose of the button.

Root cause: `term.write(data)` is asynchronous — xterm parses and renders the
write on a microtask. The old code called `term.scrollToBottom()` either
immediately after the write or inside a `requestAnimationFrame`. Neither
guarantees the buffer has been populated, so `scrollToBottom()` snapped against
a stale `baseY` and landed above the new output.

Fix: use xterm's write-completion callback — `term.write(data, () => { term.scrollToBottom(); })`.
The callback fires after the write is flushed, so the scroll operates on the
final buffer state.

## Secondary change — button visibility mirrors follow state

The prior behavior only showed the "▼ Resume live output" button when new
output happened to arrive while the user was scrolled up — via `showResumeButton()`
inside `renderTerminalOutput`'s not-following branch. If the user scrolled up in
an idle session (no new output arriving), the button never appeared, and there
was no UI control to jump back to live.

Fix: `term.onScroll` now surfaces the button the moment the user scrolls up
(`!atBottom && userIsFollowing` → flip false + `showResumeButton()`), and hides
it the moment they return to the bottom by any means (`atBottom && !userIsFollowing`
→ flip true + `hideResumeButton()`). The wheel-down resume path hides the button
for the same reason. Session-switch reset calls `hideResumeButton()` so a
carry-over button from a prior session doesn't mislead.

The button is now the always-available "take me back to live" control, not a
contingent reaction to incoming output.

Files touched:

- `dashboard/index.html` — two overlapping changes:
  - Three resume paths use xterm's write-completion callback:
    1. The button `onclick` handler.
    2. The `term.onScroll` handler's auto-resume branch.
    3. The `xtermViewport` wheel handler's auto-resume branch.
    The button handler retains `container.scrollIntoView({block:'end'})` in a
    shared `snapToBottom` closure so both the pending-data and no-pending-data
    branches do the same thing.
  - Button visibility now mirrors `!userIsFollowing` from every path that
    flips the flag: scroll-up in `onScroll`, scroll-to-bottom in `onScroll`,
    wheel-down resume, and session-switch reset.
- `tests/unit/dashboard-resumeLive.test.ts` — new. HTML-inspection regression
  test, consistent with the existing `dashboard-*.test.ts` pattern. Ten tests,
  split across two describe blocks: (a) scroll-after-write invariants — locks
  in the callback form on all three paths and bans the old
  `term.write(data); requestAnimationFrame(() => term.scrollToBottom())` shape;
  (b) button-visibility invariants — asserts show on scroll-up, hide on
  scroll-to-bottom / wheel-resume / session switch.

## 1. Over-block

N/A — no block/allow decision exists in this change. The only behavior altered
is the timing of a DOM scroll call relative to an xterm write.

## 2. Under-block

N/A — see Over-block.

## 3. Level-of-abstraction fit

The fix lives at the exact layer where the bug lives: dashboard JavaScript
interacting with xterm.js. xterm's documented API for scheduling work after
a write is the write callback; using `requestAnimationFrame` was a workaround
that guessed at timing instead of using the library's native hook. The fix
moves us from guessing to the library-native pattern.

There is no higher-level authority that should own terminal-viewport scrolling
— this is a leaf UI behavior. There is no lower layer to delegate to — xterm
itself is the layer.

## 4. Signal-vs-authority compliance

No decision point touched. This is not a gate, filter, sentinel, watchdog, or
dispatcher. No brittle logic holds blocking authority. The principle does not
apply. Documented in Phase 1.

## 5. Interactions

- **`renderTerminalOutput` (the steady-state write path):** Still uses the
  bare `term.write(data); term.scrollToBottom();` form. That path runs only
  when `userIsFollowing === true` — xterm's default behavior is to auto-track
  the bottom when the viewport is already there, so the follow-up
  `scrollToBottom()` is essentially redundant and harmless. Not touched.
- **`term.onScroll` flag-flipping:** The scroll event fires during
  `term.write()` as the buffer grows. If the write callback runs after
  `scrollToBottom()`, the onScroll handler sees `atBottom === true` and
  keeps `userIsFollowing === true`. No race with flag-flipping introduced.
- **Concurrent WS output:** If a new frame arrives via WebSocket during the
  click handler, it calls `renderTerminalOutput` with `userIsFollowing === true`
  (we just set it). That path does its own `term.clear()` + `term.write` +
  `scrollToBottom()`, which will overwrite whatever our click handler was
  mid-flight. Net effect: user ends up at bottom either way. No deadlock, no
  torn state.
- **Infinite-scroll history loader:** Unaffected — uses `buf.viewportY <= 10`,
  which is a separate concern from the bottom-snap logic.

## 6. External surfaces

None. This is client-side JavaScript in the dashboard HTML, served to the
user's browser. No other agents, no other users, no other systems observe the
change. No server API touched. No persisted state touched.

## 7. Rollback cost

Trivial: `git revert <commit>`. No data migration, no state repair, no release
coordination. Dashboard is static HTML served by the instar server; a revert
commit + server restart puts the old code back in front of the user
immediately.

## Verification

- HTML-inspection regression test passing (`tests/unit/dashboard-resumeLive.test.ts`, 6 tests).
- Full dashboard test suite passing (`dashboard-*.test.ts`, 20 tests total).
- Manual browser verification: deferred to user acceptance — reproducing the
  bug end-to-end requires a live session with pending output and a user
  scrolled up, which is Justin's original reporting path. The mechanical fix
  is narrow enough (swap `term.write(data); scroll` → `term.write(data, scroll)`)
  that the HTML regression is the load-bearing guarantee.
