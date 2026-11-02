# Side-Effects Review — remote desktop multiple screens and three-finger gestures

**Version / slug:** `desktop-multi-display-gestures`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 1: a revert fully undoes it, with no stored state. Adds a read route (`GET /desktop/requests/:id/displays`, relayed as a mesh `displays` operation), a `selectDisplay` input action handled by `DirectDesktopAccess`, `listDisplays`/`selectDisplay` on the Mac and Windows hosts, a `displays` command in both native helpers, viewer picker and three-finger gestures, Fn flags on Mac arrow keys, and a smaller, movable Windows banner. Size: about 20 source files and 400 lines of source, plus tests. One review round; four commit attempts, each stopped by a section this review had missed, which is above the signal for a Tier-1 change.

## Decision-point inventory

- `DirectDesktopAccess.displays` — add — read gated exactly like `cursor`: viewer session plus valid grant.
- `DirectDesktopAccess` input path, `selectDisplay` — add — a malformed id closes the stream; a well-formed unknown id changes nothing.
- `DesktopHost` display id validation — add — bounds host text and ids.
- Grant, PIN, controller lock, indicator, idle and ten-minute limits — pass-through.

---

## 1. Over-block

A well-formed id for a display that exists is never refused. A viewer on a machine reporting `supported: false` gets no picker even if the machine has several screens; it says so and asks for an update.

## 2. Under-block

Nothing here widens what a granted operator can do: they already control the whole desktop. The display list shows screen names and resolutions only after a valid grant. A display id is opaque and is resolved against the host's own list before use, and on macOS parsed to an integer.

## 3. Level-of-abstraction fit

Host specifics stay in hosts. The authority owns the session's choice, so it survives a resume and resets for a new grant. The shortcut tables live in the viewers because they are the viewers' choice of keys, and the host path stays key-only as asked.

## 4. Signal vs authority compliance

No brittle check gains blocking authority. Refusing a malformed id on an authenticated stream matches how every other malformed command is treated. See docs/signal-vs-authority.md.

## 5. Interactions

- Version skew is the main risk: an older host treats an unknown command as a protocol violation and ends the session. The viewer sends `selectDisplay` only after `supported: true`, and treats any failure of the read as unsupported.
- Switching kills the capture helper while a frame may be pending. That counts as one capture failure, below the limit of three; the next tick starts fresh with a keyframe.
- If an H.264 helper fails because a screen vanished, the existing fallback moves the session to JPEG for the rest of the session. The picture survives; it is lower quality.
- PR 2531 (merged while this was in review) adds a three-finger tap. A swipe is not a tap: its multi-tap marks movement, so a swipe does not also middle-click. Its double-tap-and-hold drag sent a click and then a press, which the host read as a double-click and maximized a window being dragged; fixed here. A lone touch tap now clicks about 300 ms later, the cost of telling a tap from the start of a double tap.
- Adding Fn and NumericPad to posted arrow keys changes all remote arrow keys on a Mac to match a physical keyboard.

## 6. External surfaces

One new authenticated read route. No new ports, credentials, prompts or permissions. A rebuilt helper keeps its grant only when signed with the release identity; that is existing behaviour. The Windows companion gains a `displays` request and an optional `displayId`; without it, it behaves as before. The Windows banner moves and shrinks but stays on top, and closing it still ends control.

## 6b. Operator-surface quality

(1) The Screens button sits in the viewer's dock beside the existing controls, and its menu leads with the choice itself. (2) It shows screen names, resolution and "Main"; display ids are never shown. (3) No destructive action is added; Stop is unchanged. (4) Rows are full-width plain text at phone width, and the note for an older machine reads "This machine needs an update before you can switch screens." The switch is reachable from a phone. On one screen the button stays hidden.

## 7. Multi-machine posture

Proxied-on-read: the list is relayed through the existing mesh broker to the target that holds the screens, and `selectDisplay` travels on the end-to-end encrypted stream, so the front sees neither. Each target keeps its own choice for the life of a grant; nothing replicates. An older front or target answers 404 or 403, which the viewer treats as unsupported.

## 8. Rollback cost

Revert and release. No state or migration. Viewers fall back to the older-host behaviour. The CLAUDE.md bullet updates itself through the existing `remoteDesktopBullet` migration.

## Second-pass review

An independent reviewer read the diff and raised six concerns, all resolved before commit: a capture helper could start after Stop during the display re-read (fixed with a capture generation, tested); an empty list was read as a missing screen, which would drop the selection at a UAC prompt (fixed, tested); a tap during a switch could land off target (pointer presses are held until a new frame, tested); a mouse press did not clear the open-overview memory, so a button could send a stray Escape (fixed, tested); one failed read removed working controls (the last good list is kept, with a 30-second re-read, tested); and the spec disagreed with the code on a second swipe up (spec corrected). It found no defect in version skew, coordinate maths for negative origins, or the C#, by reading only.

Concur with the review, after the fixes above.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: n/a`, `reason: one-shot user-driven action, not a self-triggered loop: the capture helper restarts only when the operator picks a screen`.
