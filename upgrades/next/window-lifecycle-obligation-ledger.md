# Window lifecycle obligation ledger — governance duties become code that refuses

## Summary of New Capabilities

- A new Echo-only enforcement plane compiles governance duties (history reads, verbatim recitations, plan updates, cadenced reports) from their source documents into a machine-checkable obligation ledger, and refuses window "open"/"closed" claims while any duty lacks real evidence.
- Every duty carries an executor-liveness predicate: a duty that is registered but has nothing demonstrably running it becomes a loud `open-unexecuted` finding instead of silent non-execution.
- The whole plane ships maturation-gated: `off | dry-run (default) | enforced`. In dry-run it records what it would have blocked; it can only graduate to real enforcement on server-derived evidence of zero false calls, and tampering with that evidence demotes it back to dry-run.

## What Changed

- New `src/core/WindowLifecycleObligationLedger.ts`: a content-dependent compiler (source-derived AST over the governing documents; a recite-from-memory shortcut fails when the source changes), per-duty evidence policies with honest authority levels (local-store presence is never promoted to authenticated), per-class executor-liveness predicates (`pending-executable` / `completed-one-shot` / `future-phase`), a signed per-run audit census with hash chain, exact-digest operator-only waivers with non-waivable core duties, and an audited Echo-local rollback.
- `AgentServer`/`routes`: new authenticated `/window-lifecycle/*` routes (compile, evidence, evaluate, tick, transition, native admission, waiver, rollback, status), enforcement middleware over the session-creation, message-send, and completion-claim doors (typed 409 refusals when enforced), all registered in the `WriteDomainRegistry` and `CapabilityIndex`.
- `SessionWatchdog`: real all-session inspection authority with durable machine-local HMAC (epoch + monotonic revision, restart-safe) so stall-cadence evidence cannot be forged or replayed.
- `BetweenWindowAdmissionGate`: consumed unchanged behind a versioned adapter that persists exact inputs/outputs; its structural verdict is never dressed up as semantic proof.
- Shared test infrastructure: `session-management-e2e` fixtures now use process-unique tmux/temp prefixes so concurrent checkouts' suites cannot delete each other's live fixtures.

## What to Tell Your User

This feature is scoped to the Echo development agent and ships dark: nothing changes on your install unless the ledger is explicitly compiled and graduated on that machine. For the operator it serves, the practical change is that governance-window claims ("opened", "closed", "report sent") stop being assertions and become checked states — a skipped duty now blocks or surfaces loudly instead of passing silently, and enforcement only turns on after a watch-only period proves it makes zero false calls.

## Evidence

- 27 independent review-fix cycles to concurrence (cycle 22; re-confirmed at cycles 24 and 27 after integration corrections), recorded in the Window-28 build ledger with every rejection and disposition.
- Complete `npm run test:all` exited 0 with zero failures (final E2E phase: 341 files passed / 1 skipped, 3,107 tests passed), including the two-lifecycle production AgentServer E2E (real admission → cadence → mid → close → post-live → closure census, plus graduation, forgery-rejection, and demotion paths) and a mandatory incident test reproducing the 2026-08-28 registered-duty-with-no-executor silence, asserting admission refuses with both predicate and executor reasons.
- Spec `docs/specs/window-lifecycle-obligation-ledger.md` converged (3 iterations) and operator-approved 2026-08-28 09:32 PDT, with the approval quote recorded in the spec header; side-effects review with second-pass reviewer concurrence at `upgrades/side-effects/window-lifecycle-obligation-ledger.md`.
