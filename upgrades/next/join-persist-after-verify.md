# Joining a machine saves the pairing reply's extra fields only after the identity checks out

## What Changed

When a new machine joins an agent with `instar join`, the reply carries the agent's identity in a sealed, verified envelope, plus two extra fields outside it. Everything in that reply is now saved only after the envelope verifies: the owner's phone-pairing introducers, the shared recovery key, the other machine's registration as a trusted peer, and the pairing keys and Telegram handover that turn sharing on. A join that fails the identity handover (a wrong address, or something answering in the other machine's place) saves none of it, stops, and says so, instead of reporting "Joined".

A join to another machine over plain `http://` (not this machine and not Tailscale, which encrypts the link itself) now prints a warning that the code and reply travel unencrypted. The pair command no longer tells you to "verify the visual symbols match", since that step no longer exists.

## What to Tell Your User

Nothing changes when a join works. If a join is pointed at the wrong place, it no longer leaves any settings behind.

## Summary of New Capabilities

None. Security hardening of machine pairing.

## Evidence

A unit test runs a real join against a stand-in listener that answers with both fields and no valid identity. Before this change the fields were saved and the listener was registered as a peer; now nothing names it and the join exits with an error. The test fails on the old code and passes now.
