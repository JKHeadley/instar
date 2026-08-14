## What Changed

Before telling you a session may be stuck, the watchdog checks three things and stays quiet if any is true. One of the three was never connected.

- **"Is it just sitting at a finished prompt?" could never be answered.** The setting that answers it appears exactly twice in the whole codebase — where it is declared and where it is read — and nothing supplied it. The answer defaulted to "no".
- **So a session that had simply finished its turn was reported as a corroborated freeze**, and escalated to the operator as one.
- **The plumbing had a hole**: the helper that assembles the watchdog's dependencies did not accept this one, so even a caller wanting to supply it had nowhere to put it. It accepts and forwards it now.
- **It uses the shared description of a finished prompt**, already relied on by two other parts of the system, rather than a private copy — that shared list carries a note asking callers to do exactly this.
- **Nothing else is quietened.** A session showing anything other than a finished prompt escalates exactly as before.

## What to Tell Your User

When a session goes quiet, I re-read its screen before saying anything, and I am supposed to stay silent if it is simply finished and waiting for you. That particular check was never wired up, so "finished and waiting" looked identical to "frozen", and you would have been told a session might be stuck when it had merely completed its turn.

That check now works. You should see fewer false alarms of that specific kind, and no change to genuine ones.

## Summary of New Capabilities

None. This reconnects an existing check. No new command, route, setting, or behaviour, and the watchdog's thresholds and cadence are untouched.

## Evidence

Confirmed by counting rather than inferring: the setting occurs twice in the source — its declaration and its single use — against a comparison check that occurs twenty-two times. The escalation path it was meant to prevent was read directly in the code, sitting immediately above the branch that reports a genuine freeze. Proven in both directions: removing the forwarding makes the new test fail, while a second control test asserts that when nothing is supplied the value stays absent, so the documented default still governs rather than being faked. Source restored byte-identical after the check, typecheck clean, forty-two of forty-two tests passing, up from forty.

Found by a second agent auditing for settings that are optional, default to something believable, and are never supplied.
