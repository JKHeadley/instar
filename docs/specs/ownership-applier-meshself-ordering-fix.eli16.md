# ELI16 — OwnershipApplier mesh-self ordering fix

**Parent principle:** Wiring Integrity — a dependency-injected component must actually run, not be a silently-skipped no-op (Testing Integrity Standard, wiring-integrity clause).

## What's the problem, in plain words?

When you move a conversation from one of my machines to another (say, Laptop → Mac Mini), the destination machine has to *learn* that it now owns that conversation, so the next message gets answered there. The piece of code that teaches it — the `OwnershipApplier` — reads a synced list of "who owns what" and writes down the ownership on the destination's own disk.

It turns out that piece of code was **never actually turned on** at runtime. Not on either machine. The reason is a subtle ordering mistake in the server's startup file: the code that switches the applier on checks a variable (`_meshSelfId`, "which machine am I?") that doesn't get filled in until about 650 lines *later* in the startup sequence. So at the moment of the check, that variable is still empty, the check fails, and the applier is quietly skipped forever.

You couldn't see this on the machine you move *from*, because that machine writes the ownership a different way. You could only see it on the machine you move *to* — and that's exactly the machine that needed the applier. So a moved conversation would say "moved!" but then go silent on the new machine, because the new machine never realized it was in charge. That's the precise bug the operator personally ran into.

## How was it found?

By the new gold-standard live test — the whole point of which is to drive a feature through the *real* path on *real* machines before a human ever has to. I moved a throwaway conversation to the Mini and then checked the Mini's *own disk and API* (not just the "ok" response from the move command). The move reported success, the "who owns what" list correctly synced to the Mini — but the Mini never wrote down the ownership. To be sure it wasn't a logic bug, I ran the applier by hand against the Mini's real data and it worked perfectly, materializing every moved conversation. That proved the code is correct and the problem is purely that the server never *runs* it.

## What's the fix?

Two small, careful changes that make the wiring impossible to break by reordering:

1. **Make "which machine am I?" late-bound.** Instead of reading that variable once at startup (when it's still empty), the applier asks for it fresh each time it runs. The machine id is only used for a log label anyway — the actual ownership-writing doesn't need it — so even an early run before the id is known still does the right thing.

2. **Turn the applier on based on the right condition.** The on-switch now checks only "is the durable ownership store active?" (which is the genuinely relevant thing) instead of also requiring the not-yet-filled machine-id variable. I pulled this on-switch out into its own tiny, testable function so a unit test can prove it switches on correctly — the inline version was untestable, which is how the bug slipped through in the first place.

## How do we know it's really fixed?

Tests prove the on-switch logic. But because the bug lived in the server's *startup ordering*, the real proof has to come from a real two-machine run — so the release gate is: deploy to both machines, move a throwaway conversation Laptop → Mini, and confirm the Mini writes the durable ownership record, its log shows its *own* applier ran, and a reply genuinely comes back *from the Mini* through Telegram and Slack. A "moved!" that isn't backed by the destination actually owning the conversation is the exact false success this whole effort exists to forbid.
