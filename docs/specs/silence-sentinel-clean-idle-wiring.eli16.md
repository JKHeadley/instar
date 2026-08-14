# The "it's just finished, leave it alone" check was never plugged in

> The one-line version: before telling you a session is stuck, the watchdog is supposed to check three things — one of them was never connected, so a session sitting quietly at a finished prompt was reported as frozen.

## The problem in one breath

When a session goes quiet, a watchdog re-reads its live screen before saying anything, and stays silent if any of three things is true: the screen shows work in progress, a helper task is still running, or **the screen is just a finished prompt waiting for input**.

That third check asks a question the watchdog was never given a way to answer. The answer defaults to "no, it isn't a finished prompt", and nothing anywhere supplied a real one — the setting appears exactly twice in the entire codebase: where it is declared, and where it is read.

So a session that had simply finished its turn and was waiting was treated as a corroborated freeze, and escalated to the operator as one.

## What already exists

- **The watchdog**, which was deliberately reworked so it would stop making confident claims about sessions it could not see into.
- **Two of the three checks, properly connected** — "is it visibly working" and "does it have a live helper task".
- **A shared list of what a finished prompt looks like**, already used by two other parts of the system, and carrying a note saying to use it rather than keep a private copy that can drift apart.

## What this adds

**The third check is connected**, using that shared list rather than a new private copy. A session at a finished prompt is now recognised as finished and quietly left alone, which is what the design always said should happen.

The plumbing had a hole in it: the helper that assembles the watchdog's dependencies did not accept this one, so even a caller wanting to supply it had nowhere to put it. It accepts and forwards it now.

## Why it went unnoticed

The default answer — "no, not a finished prompt" — is a perfectly plausible real answer. There is no error and no warning; a missing connection and a genuinely-not-idle session produce the same value. The tests for this area supply their own stand-ins for these checks, so they never noticed the real one was absent.

It was found by a second agent auditing for exactly this pattern: settings that are optional, default to something believable, and are never supplied.

## The safeguards

**A test that fails without the fix.** It asks the assembler for the dependency and checks a real function comes back. Removing the forwarding makes it fail; a second test asserts that when nothing is supplied the value stays absent, so the documented default still governs rather than being faked.

**Nothing is suppressed that shouldn't be.** The check only recognises the specific appearance of a finished prompt. A session showing anything else still escalates exactly as before — this narrows a false alarm, it does not quieten the watchdog.
