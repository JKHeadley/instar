## What Changed

- Honest lock reading: `GET /machine-maintenance/lock-state` reports whether a Mac is really locked. It says `locked` only when the session flag, the lock screen actually drawn and an immediate password requirement all agree. A screensaver a keypress dismisses reads `screensaver-or-display-sleep`; conflicting or unreadable evidence reads `unknown` with the reason. Every input is reported beside the verdict.
- Browser care, watch-only: `chrome-launch.sh` now records each normal Chrome an agent opens (which session, what for, how long it should live). A sweep every 15 minutes writes down which of this agent's own browsers it WOULD close and why it keeps the rest (unsaved form input, a download still running, someone at the keyboard, the opening session still alive, a sign-in repair). It never touches the operator's own Chrome and closes nothing in this release. New helpers: `chrome-close.sh` (dry-run: records that the task is done and reports what a close would do), `chrome-renew.sh`, `chrome-unsaved.sh`. Results ride `GET /machine-maintenance` as `browserCare`. Dev-gated, dark on the fleet.

## What to Tell Your User

If you ask whether one of your Macs is locked, I can now check properly instead of trusting one flag that also says "locked" during a plain screensaver. I also keep a list of the browser windows I open, so I can tell you which ones I left open; for now I only note which I would close, and close none of them.

## Evidence

- Unit tests cover every row of the lock decision table on both sides, the browser sweep's ownership rule, each close reason and each keep reason, and the helper scripts with stubbed system tools; the page check runs in a real DOM. A source test proves the new code has no way to end a process.
- Integration and end-to-end tests serve both routes through the real server, including the 2026-11-01 case (flag set, no password, screensaver running), which now reads as a screensaver, not locked.

## Summary of New Capabilities

- `GET /machine-maintenance/lock-state`: honest lock verdict with its inputs.
- `browserCare` on `GET /machine-maintenance`: the agent's open browsers and the sweep's would-close / keep verdicts.
- `chrome-close.sh`, `chrome-renew.sh`, `chrome-unsaved.sh` and `chrome-launch.sh --purpose/--ttl-minutes`.
