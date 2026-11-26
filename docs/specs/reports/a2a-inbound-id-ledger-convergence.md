# Convergence Report — A2A inbound message-id ledger

## Cross-model review: codex-cli:gpt-6-astra (RAN — every round) + clean-door-anthropic-review: claude-code:claude-fable-5

The work ran 23 rounds across three phases:
- **R1–R9:** the parent backup-routes spec.
- **L1–L11:** the first ledger designs.
- **C1–C6:** the cut design, then narrow verification passes.

What ran in each round:
- **External GPT pass:** a real GPT-tier review through the agent's codex CLI (`gpt-6-astra`), status `ok`, every round.
- **Clean-door Anthropic read:** a second read on `claude-fable-5`, also every round. It is disclosed separately and never counts as cross-model.
- **Internal reviewers:**
  - The full set of six (security, scalability/performance, adversarial, integration/deployment, decision-completeness, lessons-aware) ran through C3.
  - C4–C6 were narrow verification passes: one adversarial internal reviewer on the changed rules, alongside both externals.
- **Standards-Conformance Gate:** ran every round, in its `markdown` form. Final result at v18: verdict `fit`, 0 flags, 92 standards checked.

The internal reviewers were subagents of the authoring session, running `claude-opus-5-5`.

## ELI10 Overview

A message from another agent can reach me more than once. Reasons include:
- the relay re-delivers a held copy after I restart;
- a sender retries after a timeout;
- soon, a sender will try a backup route when the relay fails.

Today four delivery paths each half-remember what they have seen, and none of them share notes. This spec gives me one list, kept for 14 days, of every message id I accept. All paths write to it at the same moment: after I decide to accept a message, and before I act on it.

The list never decides that a message "already arrived" on guesswork. A resend is dropped only if I already judged the first copy to need no reply. Every other resend is delivered again, with a note at the top saying it is a resent copy. The trade is deliberate. Duplicates are fine as long as they are labelled; losing a message is not.

## Original vs Converged

- **Delivery proof.**
  - Originally: the ledger also tried to prove each message reached a model, using markers, reply signals, drain reconciliation and record hygiene.
  - Converged: it records receipt and the synchronous hand-off only. Rounds L7–L11 found new races inside that proof machinery every time (trend 9→9→9→4→12). The standing "cut to five floors" rule removed it in v12.
- **Replication.**
  - Originally: the ledger replicated across machines.
  - Converged: each machine keeps its own list. A merged `?scope=pool` read and a peer annotation exist, but neither can stop a message. Real replication is its own tracked item (ACT-054, due 2026-11-03).
- **Trusting peer machines.**
  - Originally: a peer machine's answer could suppress a resend, which raised questions about which network routes to trust.
  - Converged (v14): a peer's answer only changes the wording of the resent-copy notice. That removes the trust question entirely.
- **Recognising a hand-off.**
  - Originally: outcomes were inferred from return shapes.
  - Converged: a closed allowlist. Anything not on it, including shapes nobody foresaw, is `handoff-failed`, and a resend of that message is delivered.
- **Which hand-offs stop a resend.**
  - Originally: any hand-off stopped a resend.
  - v16: only "durable" ones (warm, approval, store) did.
  - v17: only the message store.
  - v18: none. The C6 reviews showed `store` rows are written only in local namespaces, which never suppress, and that production always wires a router, so the path never runs. Today only a verified `no-reply` suppresses. Making some paths durable is ACT-055 (due 2026-11-10).
- **Where the gate checks the ledger.**
  - Originally: replays were checked before trust.
  - Converged: the ledger lookup sits after the operation-permission check and before rate counting. A sender whose trust was revoked is refused, never answered as a duplicate.
- **Health advertisement.**
  - Originally: the capability was advertised while the table was open.
  - Converged: it is advertised only while the lookup is actually working, so not during a database-error cooldown or breaker.

## Iteration Summary

| Round | Distinct design findings | Change | Standards-Conformance Gate |
|---|---|---|---|
| R1–R9 (parent spec) | ~9 per round, not falling | restructured: ledger first (ACT-053), backup routes v2 after | ran each round (2–6 flags) |
| L1–L6 | falling, then flat | ledger designs v1–v7 | ran (fit) |
| L7 | 9 | v8: pipe, marker and replication added | ran (fit, 0 flags) |
| L8 | ~9 | v9: Codex-only funnel removed | ran (1 flag: Know Your Principal → namespaced keys) |
| L9 | ~9 | v10: reply signal and queue branch removed | ran (1 flag: P20 wording) |
| L10 | 4 | v11: one shared relay-loop predicate | ran (1 flag: Remove-What-Demands-Attention) |
| L11 | ~12 | **v12 structural cut**: receipt and hand-off only | ran (0 flags) |
| C1 | ~9 | v13: peer check on marked resends only; closed outcome table | ran (0 flags) |
| C2 | ~10 | v14: peer answers annotate only; allowlist; in-flight cleared in `finally` | ran (0 flags) |
| C3 | 6, all local | v15: named-rule edits, no new machinery | ran (0 flags) |
| C4 (narrow) | 1 | v16: only durable hand-offs suppress | ran (0 flags) |
| C5 (narrow) | 2 | v17: durable means `store` only; guarantee wording narrowed | ran (0 flags) |
| C6 (narrow) | 0 design-class; 3 text corrections | v18: no path counts as durable; gate ordering; advert tied to lookup health | ran (fit, 0 flags) |

The skill's soft cap of 10 rounds was exceeded. The operator's standing rules on recurring findings applied:
- "counts are signals, not gates";
- 80/20: stop when findings stop changing the build;
- cut to five floors after about three failed rounds.

Under those rules the design was cut twice: v12 removed the delivery proof, and v14 made peer answers annotate-only. It then ran to a point where the findings no longer changed the build. The lessons-aware reviewer judged the spec at the 80/20 point in both C2 and C3. C4–C6 found only over-claims of durability. Each was fixed by suppressing less, which moves failures toward labelled duplicates.

## Accepted, not changed (build-time notes)

From the C6 clean-door read:
- **Replays skip the rate budget.**
  - What: a terminal-row replay is dropped before rate counting, so it costs the sender no budget.
  - Why accepted: there is only one terminal kind today (`no-reply`), and the cost per replay is one indexed SQLite read. The `replayDropped` counter is the signal.
  - When it would change: a separate replay budget is added if the counter shows abuse.
- **Dense test section.**
  - What: the unit-test section is hard to follow as prose.
  - Response: the build will ship the transition table and outcome allowlist as data that both the code and the tests consume.
- **Counters freeze when the prune breaker trips.**
  - What: persisted counters stop flushing if the prune breaker trips. `/health` reads memory, so it stays current.
  - Response: the build flushes on a separate timer.
- **Sequencing against ACT-055.**
  - Why not wait: v2 backup routes need a receiver-side id now, and the ledger is the smallest thing that gives one.

## Evolution items opened

- **ACT-053:** this ledger.
- **ACT-054:** cross-machine replication (due 2026-11-03).
- **ACT-055:** per-path delivery durability (due 2026-11-10).
