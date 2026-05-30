# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Two fixes that make running one agent across multiple machines actually work
end-to-end.**

First, a real bug: the private channel machines use to send each other commands
was being blocked by the normal login check before it could even verify the
message's own signature. Because each machine has its own login token, one
machine could never present a token the other would accept — so every
cross-machine action (checking if a peer is alive, handing a conversation to
another machine, moving one) was silently refused. That channel is already
protected by a strong per-machine cryptographic signature, so it now correctly
skips the token check and relies on the signature. This is the missing piece
that made a second machine show as offline even when both machines could reach
each other perfectly.

Second, the headline "move this to the mini" feature is now wired all the way
through. Saying "move this to <machine nickname>" (or "run this on <nickname>")
in a conversation now pins that conversation to the named machine and hands it
over, so it continues there. Before, the phrase was understood but nothing acted
on it.

## What to Tell Your User

If you run on one machine, nothing changes. If you run across two machines: a
second machine will now correctly show as online and become eligible to receive
conversations, and you can say "move this to the mini" (using whatever nickname
shows on your Machines list) to hand the current conversation to that machine —
it picks up there. Both machines need to update for this to work.

## Summary of New Capabilities

- The machine-to-machine command channel is exempt from the API token check and
  authed solely by its per-machine cryptographic signature — so cross-machine
  presence, delivery, and transfer work over the network, not just in tests.
- New `TopicPlacementPinStore`: durably pins a conversation to a chosen machine.
- "move this to <nickname>" / "run this on <nickname>" is wired on inbound:
  recognize the command, pin the conversation, release local ownership, and let
  it re-place onto the named machine via the existing place-and-resume path.

## Evidence

- `tests/unit/mesh-rpc-auth-exemption.test.ts` — the machine command route
  reaches its handler with no token (and ignores a wrong one — the signature is
  the auth); a normal protected route still requires the token.
- `tests/unit/topic-placement-pin-store.test.ts` — pin set/get/clear, durable
  across restarts, tolerant of a corrupt file.
- `tests/unit/transfer-activation-wiring.test.ts` — the recognizer/planner are
  wired on inbound before routing, a transfer sets the pin + releases ownership,
  the pin is passed into placement, and the whole path is dark-gated.
- Found on real hardware (laptop + Mac mini): the mini stayed offline because its
  `/mesh/rpc` returned 401 before the signed envelope was checked; with the
  exemption the cross-machine calls authenticate off the envelope as designed.
- Side-effects: `upgrades/side-effects/mesh-rpc-auth-and-transfer-activation.md`.
