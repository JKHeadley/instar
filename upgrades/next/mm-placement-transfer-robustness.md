# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Multi-machine topic placement got two robustness surfaces, plus a fix for a real
move-back bug (shipped in #750; this fragment cuts the release that carries it).

- **Recognizer fix (`RelocationNicknameSet`, `commands/server.ts`)** — "move this to
  `<machine>`" worked toward a peer but silently fell through when moving *back* to the
  machine currently handling the topic. Root cause: the recognizer's known-nickname set
  came from `MachinePoolRegistry.getCapacities()`, which can omit a machine's **own**
  nickname; since the lifeline forwards inbound to the holder, the relocation check runs
  on the very machine being moved back to. The fix unions the local machine's own
  nickname (capacities → identity entry → deterministic derive) into the recognizer set.
- **`GET /pool/placement?topic=N` (`TopicPlacementDescription`)** — returns the owning
  machine + nickname, the **reason** (`pinned` = a deliberate move vs `placed` =
  load-balanced vs `unowned`), and the lease-holder. Answerable from any machine: a
  standby proxies to the holder, whose pin store is authoritative.
- **`POST /pool/transfer {topic, to}`** — a deterministic move that runs the same
  validated `planTransferByNickname` planner (rate-limit, online, already-there,
  offline-confirm) without depending on natural-language recognition; a non-holder
  proxies to the holder.
- **Awareness/migration** — the CLAUDE.md scaffold documents both endpoints for new
  agents; an idempotent `PostUpdateMigrator` block adds them to existing agents. Both
  routes 503 while the pool is dark (default), so production agents are unaffected.

## What to Tell Your User

- **You can now ask where a conversation is running, and move it reliably.** Ask "where
  is this running, and why?" and I'll tell you which machine has it and whether it was
  deliberately moved there or just load-balanced. And "move this to the mini" (or any
  machine) now always works — including moving it back to the machine you're already on,
  which used to silently do nothing.

## Summary of New Capabilities

- Ask which machine a topic runs on and why (pinned vs load-placed), from any machine.
- Reliable "move this to <machine>" — including the move-back that previously failed.
- A deterministic transfer option that doesn't depend on phrasing.

## Evidence

PR #750 (merged, squash `1afa089`). 26 new tests across all three tiers (12 unit /
11 integration / 3 e2e), full `tsc --noEmit` clean, CI 17/17 green. Spec:
`docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md` §L4/L5 (approved).
