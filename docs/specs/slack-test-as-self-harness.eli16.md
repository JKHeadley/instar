# test-as-self for Slack — the permission demonstration (ELI16 overview)

## What this change is, in plain English

The Slack org permission system already decides — for any (person, request) pair —
whether to **allow**, **refuse**, **ask to clarify**, or **step up** (demand a second
factor). A permission system is only believable if you can *watch it refuse*. This
change builds the demonstration that proves it: a fixed cast of test users, a list of
scripted requests, and a runner that drives each one through the **real** permission
gate and checks two things at once — the right decision came out, **and** the matching
audit entry actually landed in the decision ledger. The spec calls this property
"verified, not narrated": instead of a human asserting "yes it refuses members," the
harness *shows* the refusal happening and shows the receipt.

## What already exists (this change does not invent the gate)

- `SlackPermissionGate` — the real verdict engine (allow / refuse / clarify / step-up).
- `SlackPermissionObserver` — the object the live Slack adapter calls per message; it
  resolves the sender → runs the gate → records the verdict in the decision ledger.
- `PermissionDecisionLedger` — the append-only audit trail (`/permissions/decisions`).
- A first-draft Layer-A harness (`SlackScenarioHarness`) with six rows that drove the
  gate **directly** and checked only the decision — not the audit entry.

## What is new

- **Two more scenario rows** so the deterministic, credential-free subset is complete:
  a *granted member* who reaches a protected action because someone gave them a
  time-boxed grant (→ allow), and an *unregistered outsider* whose request is refused.
- **A static grant store and a registry-backed resolver** — plain test fixtures that
  feed the existing gate so the granted-member and identity-resolution paths run for
  real without any signed mandate or live Slack workspace.
- **An audit-asserting runner** that drives every row through the *same* observer the
  live adapter uses, then reads the ledger back and asserts the matching entry exists.
- **An executable surface:** a `POST /permissions/scenario-suite/run` route and an
  `instar test-as-self --slack` CLI subcommand, so the demonstration is something you
  run and watch go green — not just a test file.

## The safeguards, in plain terms

- **Credential-free.** No real Slack tokens, ever. Senders are synthetic-but-distinct
  verified ids. The whole thing runs in CI on every build, so it can't rot.
- **It changes no decision logic.** The gate is untouched. The harness only *invokes*
  it and *reads* its ledger. The one wiring tweak (the test gate gains a grant store)
  is deny-by-default for everyone except the single Grace fixture, so no other row's
  verdict moves.
- **It mutates nothing real.** The audit-asserting run writes its ledger into a
  throwaway temp directory — never the running agent's state.

## What you (the reviewer) actually need to decide

Whether the cast + the scenario rows are the right ones to prove the system governs
(they mirror the spec's worked examples A–F plus the two deterministic runbook rows),
and whether "assert the verdict AND the audit entry per row" is the right bar for
calling the demonstration trustworthy. The live-Slack-workspace layer (real users in a
real workspace) is explicitly out of this change and remains a later, operator-driven
step.
