---
title: "Remote Desktop speed reading in the viewer"
slug: "desktop-speed-reading"
author: "echo"
created: "2026-11-27"
eli16-overview: "desktop-speed-reading.eli16.md"
parent-principle: "Live-User-Channel Proof Before Done"
approved: true
approved-by: "echo (agent approval under Rule 82: dashboard viewer only, no constitution or CODEOWNERS path)"
---

# Remote Desktop speed reading in the viewer

## Why

`docs/specs/native-remote-desktop-quality.md` names "measured input and glass-to-glass latency" and "measured p95 visual latency" as acceptance items, and every later stage notes them as still open. The target already logs per-stream picture counts (`desktopStreamFrameSummary`, #2574), which show where pictures are lost but not what the person feels. Commitment CMT-033 (topic 131439) promises a live session with measured delay and smoothness.

## What changes

Only `dashboard/desktop.js`, `desktop.html` and `desktop.css`.

- `feelInput(kind, now)` runs in `send()` for every input that passes the existing guards (a screen switch or the lock refusal returns first, so a refused input is never timed). `move`, `buttonUp`, `keyUp` and a `keyDown` of a modifier key (Shift, Control, Alt, Meta) are not timed: the host does not draw its own pointer (`showsCursor = false` in `InstarDesktopHost.swift`), so a plain move rarely changes the picture, a release follows its press within moments, and a modifier changes nothing until the key it modifies.
- A clock already running for under 300 ms keeps its start, so a burst of key presses is timed from its first press. A clock older than 300 ms that nothing answered is counted as unanswered and the new action starts a fresh clock, so a click after a click that changed nothing is timed from the second click.
- `feelPainted(now)` runs after a picture is on screen: after `drawImage` for H.264, and after `HTMLImageElement.decode()` resolves for JPEG (`feelOnDecoded`, skipped when the stream epoch changed or decode rejects or is missing). It closes the running clock and records the delay, or counts the action as unanswered when the delay exceeds 1,500 ms. It records the gap since the previous picture when that gap is at most 500 ms, so a still screen with a ticking clock gives no smoothness figure.
- `feelSummary()` returns counts, median and 95th-percentile delay, and, once at least 10 gaps exist, pictures a second (from the median gap) and the 95th-percentile gap. At most 240 samples of each are kept.
- `requestDesktop()` resets the reading for a new session. `openStream()` forgets a waiting clock and the last picture time, so a resume or takeover keeps the samples but never pairs a picture with an action sent on the previous connection.
- A Speed button in the controls menu toggles `#speedReadout`. It updates once a second only while shown and the stream is live; `leave()` stops the timer. The readout has `pointer-events: none` and sits below the top bar; the locked-screen password box covers it while the remote screen is locked.

## Limits, said plainly

- The delay ends when the picture is ready to show, not when the display refreshes, so a screen adds up to one refresh (about 8 to 17 ms) the reading does not see.
- An unrelated screen change (a clock, a video) that lands after an action that changed nothing is counted as that action's answer. It can make a reading either faster or slower than the truth. The median is robust to a few of these, and the live proof uses a still screen.
- A burst inside 300 ms is timed from its first action, so a later action in the burst whose own picture comes later reads a little long.
- An action that changes nothing is counted as unanswered, not as a delay, unless an unrelated picture arrives within 1.5 seconds (see above).
- Plain pointer moves and drags in progress are not timed. The press that starts a drag is.

## What does not change

No protocol, server, target or native helper change. No new data leaves the page, and nothing is stored. The stream, its permission and its revocation are untouched. Elements are looked up with optional chaining, so a page without them runs as before.

## Decision points

None. The behaviour is read-only and on the viewer only, and it is off until the person taps Speed.

## Tests

`tests/unit/desktop-feel-meter.test.ts` covers delay percentiles; a burst timed from its first press; a click after an unanswered click timed from itself; moves and releases never timed, including a move then a click; late pictures; pictures with no waiting action; a ticking still screen and too few gaps giving no smoothness figure; the reading text with and without smoothness and singular "picture"; a new connection forgetting a waiting clock; refused inputs (screen switch, lock) not timed; JPEG decode counted, skipped after an epoch change, and nothing on reject or without decode; the Speed toggle; and a page without the readout. The other unit files that evaluate `desktop.js` are run with it.

## Rollback

Revert the commit. Nothing is stored, so no clean-up is needed.

## Live proof

Open a live session on a reachable machine from a phone-sized and a laptop-sized viewer, turn on Speed, do the click, scroll, typing and modifier tasks from the quality spec on a still screen, and record the readings per machine and connection in topic 131439.
