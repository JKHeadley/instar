# Upgrade Guide — Dashboard "Resume live output" reliability + always-visible control

## What Changed

Fixed two long-standing rough edges in the dashboard's terminal view for the
"▼ Resume live output" control.

### Scroll-to-bottom now actually lands at the bottom

Clicking "▼ Resume live output" after scrolling up in a session view used to
sometimes leave the viewport mid-history instead of snapping to the tail of
live output — defeating the purpose of the button. The same stale-scroll
happened on the two sibling auto-resume paths that fire when the user
scrolls back to the bottom or wheels down into it.

Root cause: `term.write(data)` in xterm is asynchronous. The old code called
`term.scrollToBottom()` immediately after the write, or inside a
`requestAnimationFrame` — neither guarantees the buffer has been populated,
so the scroll operated on stale viewport state and landed above the new
output.

Fix: all three resume paths now use xterm's write-completion callback —
`term.write(data, () => term.scrollToBottom())`. The scroll runs after the
buffer is populated, so the viewport lands at the new bottom.

### The button is always visible when paused

Previously the "▼ Resume live output" button only appeared when new output
happened to arrive while the user was scrolled up. In idle sessions —
nothing streaming, user just scrolled up to read history — the button never
surfaced, and there was no UI control to jump back to live.

Fix: button visibility now mirrors `!userIsFollowing` from every code path
that flips the flag. Scroll up in a session view (idle or streaming) and the
button appears. Scroll back to the bottom, click the button, wheel down into
the tail, or switch sessions, and the button hides.

## What to Tell Your User

The "Resume live output" button in your dashboard's session view now works
the way you'd expect: it shows up any time you've scrolled up (even in an
idle session where nothing is streaming), and clicking it reliably drops
you at the bottom of the live output instead of leaving you mid-history.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Reliable auto-follow resume in the dashboard terminal | Click "▼ Resume live output" after scrolling up in any session view; viewport snaps to the bottom |
| Button always available while paused | Scroll up in any session — the button surfaces automatically; scroll back down or click it to resume |

## Evidence

The fix was reproduced from Justin's report (topic 6309 on echo agent): the
button left him mid-history, and in idle sessions there was no button at
all.

Regression test (`tests/unit/dashboard-resumeLive.test.ts`, 10 tests) locks
in both invariants at the HTML-inspection layer:

- Scroll-after-write: all three resume paths use the xterm write callback;
  the old `term.write(data); requestAnimationFrame(() => term.scrollToBottom())`
  shape is explicitly banned.
- Button visibility: `term.onScroll` shows the button on scroll-up and
  hides it on scroll-to-bottom; the wheel-down resume path hides the
  button; session-switch reset hides any carry-over button.

Full dashboard test suite green across `dashboard-*.test.ts`.

Side-effects review:
`upgrades/side-effects/dashboard-resume-live-scroll.md` — concludes no
decision-point touched (pure UI timing + visibility fix), no over/under-block
risk, trivial rollback (git revert).

## Deployment Notes

No operator action required on update. The dashboard is static HTML served
from the installed instar package — clients pick up the fix on their next
page load after `instar` updates to 0.28.59.

## Rollback

Downgrade reverts the three resume paths to the prior (racy) code and
returns the button to its contingent-on-new-output visibility. No schema
changes, no state-file changes, no API changes.
