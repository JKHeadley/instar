# Side-Effects Review: P0 hook-arming orchestration (codexHookArm)

## Change
New `src/core/codexHookArm.ts` + unit tests — the P0 arming orchestration (the half that decides
whether/what to arm and verifies the outcome), per the approved+converged spec (P0 / G2 verdict +
§7 gates F1-F3):

- `armCodexHooks({projectDir, codexHome?, trustDriver?})` — idempotent: returns `already-armed`
  (no spawn) when all of the agent's project hook slots are already trusted+enabled (F2); `skipped`
  when the project hooks.json is NOT instar-owned (F1 manifest verify — never blind-trust); else
  drives Codex's trust flow then READS BACK config.toml to confirm (`armed` / `partial` with the
  still-untrusted + the user-disabled slots surfaced, F3 — never silently re-enables).
- `projectHooksAreInstarOwned(projectDir)` — F1: the project `.codex/hooks.json` must match
  buildInstarCodexHookGroups (expected instar hooks present) AND carry no instar-marker command
  pointing outside THIS project's hooks dir (anti-injection).
- `makeTmuxTrustDriver({tmuxPath, codexBinary, model})` — the default driver: spawns interactive
  Codex in tmux (CODEX_HOME scoped, **NO `--dangerously-bypass-*` flags** — F1), polls capture-pane
  (bounded ~40s) for the trust prompt, sends Down+Enter to pick "Trust all and continue", then
  exits + kills the pane. The fragile keystroke step is INJECTED so the orchestration is unit-tested
  without a real codex; the driver itself is validated by test-as-self on a live agent.

## Why
G2 verdict: arming the agent's own project hooks via Codex's trust state is inherently per-agent
(path-keyed) and avoids the rejected machine-wide managed-config. This module makes that arming
idempotent, safe (manifest-verified, no bypass flags), and verifiable (readback) — the F1-F3 gates
the convergence review demanded.

## Scope / blast radius
- New code; the orchestration is pure-ish (fs reads + an injected driver). `armCodexHooks` is NOT
  yet wired into install/migrate (next increment) — no runtime behavior change until then.
- When wired, it only ever arms the agent's OWN project hooks (path-scoped); the operator's
  personal Codex (other cwd) is untouched. The tmux driver runs without sandbox/approval bypass.
- No migration impact yet (new code, ships with dist). The B2 atomic-with-migration wiring is the
  next step. <!-- tracked: codex-full-parity -->

## Signal vs Authority / Over-block
- N/A — this arms safety hooks (makes them run); it adds no new gate authority. The hooks
  themselves keep their existing signal/authority split.

## Rollback
- Delete the module + test. Not yet referenced by any call path.

## Tests
- `tests/unit/codexHookArm.test.ts`: 7 — manifest-owned true/false; already-armed skips the driver
  (idempotent); manifest-mismatch refuses to drive; arms+readback; partial when readback incomplete;
  user-disabled surfaced not re-enabled. Green. tsc clean.
- Live test-as-self of the tmux keystroke driver: batched with the P0 joint live-proof on codey.

## Publish
- Feature branch `echo/codex-parity-audit`. Ships atomic with P1 (spec §7 B2).
