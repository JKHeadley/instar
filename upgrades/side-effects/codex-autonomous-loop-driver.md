# Side-Effects Review — Codex autonomous-loop driver

**Version / slug:** `codex-autonomous-loop-driver`
**Date:** `2026-05-30`
**Author:** `echo`
**Second-pass reviewer:** see below (required — lifecycle machinery)

## Summary of the change

Adds a codex registration of the shared autonomous-stop-hook so a `codex exec` session
sustains a multi-turn autonomous run (the codex analog of Claude's Stop-hook loop). A
SEPARATE codex Stop group (`autonomous-stop-hook.sh --codex`) is added in
`installCodexHooks`; the hook self-gates on `autonomousSessions.codexLoopDriver.enabled`
(default false → DARK). Claude's path is byte-for-byte unchanged.

## Decision-point inventory

1. `IS_CODEX` gate in the hook (— is this a codex-registered invocation?).
2. `codexLoopDriver.enabled` flag check (— should the codex loop actually run?).
3. `groupIsInstarOwned` (— is this Stop group instar-owned, to replace not duplicate?).

## 1. Over-block
Could it block a stop that SHOULD proceed? Only when the flag is ON, an autonomous job is
active for this session, AND tasks remain — which is exactly the intended block (continue
the run). With the flag OFF (default) it never blocks. The existing ownership/duration/
emergency/completion terminal checks (unchanged) still release the session.

## 2. Under-block
Could it fail to block when it SHOULD continue? When the flag is OFF, yes — by design
(dark). When ON, the only residual is the open binary question of whether codex runs the
second Stop group (Phase-5 / live verification gates this before enabling; fallback =
move into group 0). No silent data loss either way — at worst the codex run stops early,
same as today.

## 3. Level-of-abstraction fit
The driver lives where Claude's does (the autonomous skill hook) and is registered where
codex's other standing hooks are (`installCodexHooks`). The flag sits with the other
autonomous-mode settings (`autonomousSessions`). No new subsystem.

## 4. Signal vs authority compliance
**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)
The hook is an AUTHORITY surface by nature (a Stop hook returns block/approve — same as
Claude's existing loop hook and codex's existing stop-gate-router). It does not newly
elevate authority: it reuses the established Stop-hook contract. The dark flag means the
authority is dormant until explicitly enabled. No monitoring/signal component is converted
into a blocker.

## 5. Interactions
- **Review trio (stop-gate-router / response-review / claim-intercept / scope-coherence):**
  the driver is the LAST hook in the SAME Stop group (slot stop:0:N). Within-group block
  precedence vs the router is verified live before enabling; worst case the session still
  continues via the router (never strands).
- **Claude autonomous mode:** independent registration (settings.json vs .codex/hooks.json);
  `IS_CODEX=0` for Claude → unchanged.
- **armCodexHooks:** the new hook changes the hooks.json hash → re-arm on update (handled
  by the existing migration). Because it rides group 0 (a group codex already trusts/arms),
  it adds NO new arm slot — avoiding the recurring-arm-spawn side-effect a separate group
  (stop:1:0) would have caused (caught by the second-pass review, then designed out).

## 6. External surfaces
None new. No HTTP route, no Telegram message, no external API. The hook talks only to the
local server's existing `/autonomous/evaluate-completion` (unchanged) when a completion
condition is set.

## 7. Rollback cost
Lowest tier. Set `autonomousSessions.codexLoopDriver.enabled: false` → the standing hook
exits immediately (instant, no redeploy, no session kill). Full PR revert is clean
(additive change; removing the Stop group + the `IS_CODEX` block restores prior behavior).

## Conclusion
Safe to ship DARK. The only non-trivial residual (does codex run a second Stop group) is
gated behind the default-off flag and resolved by live verification before enabling — per
Justin's "careful + clear plan to regress" condition.

## Second-pass review (if required)

**Reviewer:** independent second-pass agent (lifecycle machinery — required)
**Status:** DONE 2026-05-30 — **CONCUR on shipping DARK.** Verified PASS on: Claude path
unchanged, dark gate cannot leak (all config-read failure paths → disabled), `$0` anchor,
groupIsInstarOwned idempotency, migration parity (both halves land). The reviewer caught a
fleet-wide arm side-effect from the original separate-group design (a `stop:1:0` slot codex
may never trust → recurring codex-TUI arm spawns on every update, even dark). **Resolved**
by moving the driver into the existing Stop group (slot stop:0:N) — no new arm slot. The
remaining open item (within-group block precedence + that the loop actually re-prompts a
real codex run) is gated to live verification BEFORE the flag is enabled, per the spec's
Phase 5 — it is not a merge/dark-ship blocker.

## Evidence pointers
- Unit: `tests/unit/installCodexHooks.test.ts` (separate Stop group, idempotent, user-group preserved).
- Unit: `tests/unit/autonomous-stop-hook-codex-gate.test.ts` (dark default / disabled / enabled / Claude-unaffected — both sides of the gate).
- Spec: `docs/specs/codex-autonomous-loop-driver.md` (+ `.eli16.md`).
