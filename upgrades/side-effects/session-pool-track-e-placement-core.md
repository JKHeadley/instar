# Side effects — Track E part 1: Placement core + nickname recognizer (§L4)

## What this adds
Two PURE, side-effect-free decision components for the Session Router (Multi-Machine Session Pool §L4). Both ship DARK (no wiring into the live router yet — that lands in Track E part 2 with the dispatch path + integration test). No runtime behavior changes for any deployed agent.

- `src/core/PlacementExecutor.ts` — the single canonical placement component. `decide(PlacementRequest): PlacementDecision` is pure and deterministic; the caller performs the CAS + side effects. Placement policy is structured DATA (`PlacementPolicy`), schema-validated at construction via `validatePlacementPolicy()` (a malformed policy throws — the router refuses to act rather than silently defaulting). Ordering is `hard-constraint → pin → sticky → least-loaded`. Hard pin / unmet capability with no capable machine returns `outcome: 'queued'` + an `escalationReason` — it NEVER silently mis-places. `validateTopicPlacement()` validates per-topic metadata on read; corrupt metadata returns `outcome: 'placement-blocked'`.
- `src/core/NicknameCommand.ts` — `recognizeNicknameCommand(text, knownNicknames)`: a conservative, deterministic recognizer for the user's "move/run this on <nickname>" requests (the headline test-as-self swap). It only matches when an explicit relocation verb AND a known nickname are both present, so a bare machine mention ("the mini is fast") never triggers a transfer. Resolves the longest matching nickname; classifies `pin` vs `transfer` intent.

## Risk / blast radius
None at runtime — neither module is imported by any boot path yet. Pure functions + new test files only. No config, no migration, no API surface in this commit.

## Tests
- `tests/unit/PlacementExecutor.test.ts` — 15 tests: least-loaded, offline/clock-quarantine exclusion, hard-pin placed/queued, soft-preference degrade, capability filter + escalation, sticky + hysteresis + rebalance-bypass, corrupt-metadata block, no-online-machine queue, decide() purity, and policy-validation rejection on every malformed field.
- `tests/unit/NicknameCommand.test.ts` — 11 tests: verb coverage, run-on/pin intents, longest-nickname resolution, case-insensitivity, and the critical negatives (bare mention, no preposition, unknown target, empty input).

## Follow-ups (tracked in this same Track E)
Part 2 wires PlacementExecutor + NicknameCommand into the router dispatch path (owned→forward over MeshRpc, unowned→decide→CAS-claim→spawn) with the deliverMessage contract and a Tier-2 integration test.
