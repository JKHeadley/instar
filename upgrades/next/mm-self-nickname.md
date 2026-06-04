# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Completes the multi-machine relocation fix: a machine now resolves its OWN nickname.

- **Root cause (live-caught on real hardware):** `updateNickname` is local-only, so a
  machine rename applied on a peer's registry never reached the owning machine — its own
  capacity entry was `nickname=None` while peers saw the name. The relocation check runs on
  the holder, so it couldn't resolve its own nickname and "move it back to <this machine>"
  silently failed.
- **`SelfNicknameResolver`** (pure) — resolves self-nickname: local view → peer view → derive.
- **Convergence task** — at boot and on a timer, if the local self-nickname is missing, it
  adopts the name a peer authoritatively reports and persists it, making `getCapacities()`
  symmetric so the recognizer, transfer route, and `/pool` all resolve self.
- **Transfer route** resolves the self-nickname via the resolver (was capacity-only).

## What to Tell Your User

- **"Move it back here" works now.** When a conversation is on one of your machines and you
  ask to move it back to the machine you're on, that used to silently do nothing in some
  setups — your agent didn't know its own name. It learns its own name from its other
  machines now, so moving things back and forth just works.

## Summary of New Capabilities

- A machine resolves its own user-facing nickname (from peers when its local copy is missing).
- Reliable "move this to the machine it's already on" — the last gap in nickname transfers.

## Evidence

Live-caught on the real laptop+mini pair (laptop returned 404 "unknown machine: Laptop" for
its own name). 7 unit tests incl. the asymmetry regression + an e2e proving self-nickname
transfer resolves through the real AgentServer. Spec: MULTI-MACHINE-SESSION-POOL-SPEC §L4.
