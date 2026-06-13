# WS5.2 Step 10 — livetest battery orchestration (dry-run→live promotion gate)

<!-- bump: patch -->

<!--
  NOTE: dark/unwired tooling. One new exported class (CredentialRepointingLivetest) +
  its fake-deps unit test. NOT wired into any runtime path — it is the §5 livetest
  battery (the dry-run→live PROMOTION gate), which by the spec is NOT part of merge CI
  and runs ONLY when the operator arms it at enablement. No route, no config flag, no
  credential write path. The module performs zero IO (pure orchestration over injected
  swap + resolveIdentity deps); the unit test uses fakes only. The live battery touches
  REAL credentials and is the operator's enablement-time action, not a dark-build step.
-->

## What Changed

Delivers the §5 livetest battery as testable orchestration — the structural gate for the dry-run→live promotion decision, so "is this safe to turn on?" is a runnable, verified procedure rather than a memory.

- **`CredentialRepointingLivetest`** (src/core/CredentialRepointingLivetest.ts) — drives the automatable battery items against injected deps (wired to the real CredentialSwapExecutor + identity oracle only at enablement):
  - **(a)** enrolled-home swap round-trip and **(b)** default-home slot round-trip — each verified by the identity oracle (NOT `claude auth status`, disqualified in E4a): after the swap the two slots' identities must have EXCHANGED; after the swap-back they must be RESTORED. The harness ALWAYS attempts the restoring swap, even when the forward verify fails, and reports any residual state honestly.
  - **Manual items surfaced, never auto-passed** — (c) post-swap refresher correctness, (d) the §0.c at-expiry residual (a deliberately-minted disposable grant), and the E4 liveness observation are listed as required operator steps; `promotable` stays `false` while any remain outstanding.
- **Armed guard** — `run()` performs ZERO swaps unless explicitly armed. The arm is set only at enablement, behind an operator flag + the feature's own enable check — never in CI, never as a dark-build step. So importing or testing the module can never move a real credential.

## What to Tell Your User

Nothing changes for you yet — this is off-by-default validation tooling. What it adds: before the credential-moving feature is ever turned on, there's now a runnable, verified "is this actually safe to switch on?" check. It performs a real account-swap and swap-back and confirms — using the trustworthy identity check, not the misleading one — that the move landed on the right account and then cleanly undid itself, always leaving things exactly as they were. Two parts of that check are inherently hands-on (they involve waiting out a token refresh and deliberately stressing a throwaway login), so the tool lists those as steps you and I do together. Crucially, the whole battery refuses to run unless explicitly armed at turn-on time — it can never move a real credential just by existing or being tested. Turning the feature on, and running this gate, stays your decision.

## Summary of New Capabilities

No new runtime capability — this is the dry-run→live promotion gate for live credential re-pointing, shipped unwired (it runs only when the operator arms it at enablement). New internal class `CredentialRepointingLivetest`: drives the automatable swap round-trip battery (identity-verified exchange-then-restore, always restoring), surfaces the manual items (refresher correctness, the at-expiry residual via a disposable grant, liveness) without ever auto-passing them, and refuses every swap unless explicitly armed. Not wired into any runtime path; no route, no config flag, no credential write path.

## Evidence

- `tests/unit/credential-repointing-livetest.test.ts` (8) — armed guard (refuses + zero swaps when unarmed); armed happy path (both round-trips exchange-then-restore, world left exactly as found, 4 swaps); not-promotable while manual items remain; fail-closed when the oracle can't resolve a slot; refusal when both slots already report one account; fail-AND-still-restore when the forward swap doesn't actuate; residual-state report when the restoring swap fails; the manual items (c)/(d)/E4 are surfaced. tsc + full lint clean; feature-delivery-completeness 97/97.
