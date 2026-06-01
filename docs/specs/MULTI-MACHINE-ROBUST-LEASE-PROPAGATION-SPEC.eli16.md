# ELI16 — Multi-Machine Robust Lease Propagation

## The one-sentence version

Make "which machine is in charge" reliable even over the open internet and on
loaded/flaky machines — by letting a backup machine *ask* the in-charge machine
"are you still in charge?" instead of only waiting to be told, turning on the
rollout driver that's currently switched off, and finally writing the test that
proves two machines can't both think they're in charge.

## What's broken

We've been unable to demonstrate "move a conversation to the other machine and have
it reply." Digging in, the cause wasn't load or tunnels — it was four structural
gaps:

1. **The backup machine can only listen, never ask.** The fast channel that shares
   "who's in charge" (the lease) only *pushes*: the in-charge machine tells the
   others. If it goes quiet, or the network is one-way, a backup has no way to *ask*
   "what's the current state?" — it just waits. Over the open internet that's
   fragile.
2. **The rollout driver is switched off.** There's a component (`StageAdvancer`)
   that's the only thing allowed to move the feature from "off" → "shadow" → "live."
   It's created and then literally thrown away (`void new …`), so the feature is
   stuck "off" no matter what.
3. **The version stamp is "unknown."** That driver only turns the feature on once a
   test passes *for the current code version* — but outside the CI server the
   version reads "unknown," so the test result never matches and it can never turn on.
4. **No test for the nightmare case.** We never wrote a test for "the network splits,
   both machines think they're in charge, then the network heals — does it correctly
   settle on exactly one?" That's the whole point of the lease, and it's untested.

## The fixes

- **Let backups ask (active pull).** Add a simple read-only "what's your current
  lease?" endpoint, and have backups periodically *ask* the in-charge machine over
  the internet (using the same tunnel address the rest of the system already uses).
  It feeds into the exact same logic as before — it just adds a second way for the
  info to arrive, so a quiet or one-way network no longer blinds a backup.
- **LAN-optional, never LAN-required.** Justin's rule: this MUST work for machines
  that are *not* on the same local network. So everything uses the internet address
  by default; being on the same LAN is just a faster shortcut to the same place,
  never a requirement.
- **Turn the rollout driver on (carefully).** Keep the retained driver and run it on
  a timer — but it ships **dark**: the feature stays "off" until a real test passes,
  and going past "shadow" still needs Justin to say so.
- **Fix the version stamp** so it reads the real commit (falls back to "unknown" only
  when there's genuinely no repo).
- **Write the split-brain test.** Two machines, cut the connection so both grab the
  lease, then reconnect — and prove the tie-breaker (higher "epoch" number wins)
  settles on exactly one. Also run the heal over a fake internet connection, not just
  a shared folder, to prove it works off-LAN.

## Why it's safe

Build-and-test only — nothing goes live. The pool stays "off," no live conversation
is moved, no production setting is flipped. The new endpoint is read-only and returns
a signed value (no secrets). Everything is reversible: set the pull interval to 0 and
it's back to today's behavior; leave the stage "dark" and the driver does nothing.

## How it fits the constitution (the new traceability rule)

This is the first spec written under the new "every spec must name the constitutional
rule it serves" gate. It serves **Framework-Agnostic — works everywhere**: Justin's
"must work for machines NOT on a LAN, LAN is just an optimization" is exactly that
rule's "every path falls back gracefully; the optional fast path degrades cleanly to
the universal one." The split-brain half serves the founding goal of **coherence** —
one agent across machines, never two in charge at once.
