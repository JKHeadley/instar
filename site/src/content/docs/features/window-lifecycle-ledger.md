---
title: Window Lifecycle Obligation Ledger
description: An Echo-local enforcement plane that compiles governance-window duties from their source documents into a machine-checkable obligation ledger — a window cannot claim "open" or "closed" while any duty lacks real evidence, and a registered duty with no live executor is a loud finding, not silence.
---

Governance windows (bounded work periods with ritual duties — full history reads, verbatim
recitations, plan updates, cadenced operator reports) used to be held by memory and good
intentions, and the record shows memory is not enough: duties were registered in multiple
"protection" layers that all turned out decorative, and the operator — not the system —
noticed the silence. The window lifecycle obligation ledger (`core/WindowLifecycleObligationLedger`,
implemented in `src/core/WindowLifecycleObligationLedger.ts`) turns those duties into code
that refuses.

## What it does

- **Content-dependent compilation.** The ledger compiles every operative duty from the actual
  bytes of the governing documents (source-spanned AST over the tenets and the window charter,
  with SHA-256 recording and derived challenge facts). A recite-from-memory shortcut fails the
  moment the source changes; an operative clause with no compiled obligation fails compilation.
- **Honest evidence authority.** Evidence classes range from `native-local-store-presence`
  (a row exists — exactly what the shipped between-window gate can prove) up through
  content-bound rows, live re-queried messages, verified operator approvals, and runtime
  registry proofs. A weaker class is never promoted by labeling; unverifiable claims are
  `unknown`, and `unknown` never counts as success.
- **Executor liveness per duty.** Every obligation binds an executor class —
  `pending-executable` (needs a live, non-suppressed, non-dry-run execution path scheduled
  before its deadline), `completed-one-shot` (needs durable completion evidence), or
  `future-phase` (needs an enabled owner/trigger and an eligible-time schedule). A registered
  duty with nothing demonstrably running it becomes `open-unexecuted` immediately — the exact
  failure mode of the 2026-08-28 overnight incident, which ships as a mandatory E2E test.
- **Closure census.** No closed state is reachable until every compiled obligation instance
  has a terminal, permitted disposition. Waivers are exact-digest, single-use, and only the
  locally auth-bound operator can grant them; core duties are non-waivable.
- **Maturation-gated enforcement.** The plane starts in `dry-run` (would-block decisions are
  recorded to a shadow audit with independent per-row adjudication under a signed hash-chain
  census), and can only graduate to `enforced` on server-derived evidence of zero false
  passes/blocks across two complete lifecycles. Tampering with the evidence demotes
  enforcement back to dry-run.

## Scope

Echo-local by design: agentId `echo`, scope `echo-window-lifecycle`. State lives only under
Echo's agent home; every route refuses a foreign agent or scope before touching state. No
templates, migrations, hooks, or fleet defaults change.

## API

All routes require Bearer auth and are registered in the machine-local write domain.

- `GET /window-lifecycle` — ledger status: compiled obligations, statuses, lifecycle state.
- `POST /window-lifecycle/compile` — compile the ledger from the current source documents.
- `POST /window-lifecycle/evidence` — submit instance-bound evidence for a duty.
- `POST /window-lifecycle/evaluate` — evaluate predicates/executors without mutating state.
- `POST /window-lifecycle/tick` — run one lifecycle tick (evidence + executor re-query).
- `POST /window-lifecycle/transition` — request a lifecycle state transition (gated).
- `POST /window-lifecycle/native-admission` — run the shipped between-window gate through the
  versioned adapter and persist its exact input/output.
- `POST /window-lifecycle/waiver` — apply an operator waiver (exact payload digest, post-creation
  approval, non-waivable core duties refused).
- `POST /window-lifecycle/rollback` — audited Echo-local rollback to the manual ritual.
- `POST /window-lifecycle/reenable` — re-enable after rollback (requires repair evidence and a
  green dry-run).
- `GET /window-lifecycle/enforcement` — enforcement mode (`off | dry-run | enforced`) and
  maturation state.
- `POST /window-lifecycle/enforcement/record-shadow` — server-derived graduation report from the
  stored ledger + shadow audit (dry-run only; refuses unadjudicated or chain-broken rows).
- `POST /window-lifecycle/enforcement/graduate` — graduate to enforcement on valid dual-lifecycle
  evidence (forged or reused provenance refused).
- `POST /window-lifecycle/enforcement/off` — turn the plane off (neither ticks nor blocks).
