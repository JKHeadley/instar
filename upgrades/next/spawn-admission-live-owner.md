# Spawn admission binds for live remote owners

## What Changed

Session spawn admission now enforces its ownership verdict when a conversation's live owner is another machine, instead of logging a would-refuse in dry-run and spawning a duplicate anyway. The graduation is the narrowest possible row: only a verified-live remote owner with durable inbound custody live is enforced; owner-dark, error, and unowned rows keep their existing dry-run posture, and single-machine installs are unaffected. A refusal forwards the message to the owning machine — it is never dropped.

## What to Tell Your User

On a multi-machine setup, a conversation that lives on one machine can no longer quietly spawn a second session on another machine — the bug where a topic pinned to one computer suddenly answered from the other one, on the wrong model. Messages now always land on the machine that owns the conversation.

## Summary of New Capabilities

- Enforce the spawn-admission refusal for provably-live remote owners (forward, never loss).
- Report live-owner enforcement state (configured, armed, and any blocking gate) on the admission status surface.

## Evidence

- A 1,000-message burst end-to-end test with a live remote owner produces zero local spawns.
- Full CI green on PR #1467; owner-dark/error/unowned rows verified unchanged at line level.
