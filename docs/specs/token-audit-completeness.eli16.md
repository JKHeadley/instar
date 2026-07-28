# Token-Audit Completeness — plain-English overview

## What this is

Justin set a rule: **any feature that spends AI tokens must be fully auditable — how many tokens, by which feature, on which model.** And specifically: the cartographer's background doc-sweep (which pays a third-party model, codex, to rewrite stale code summaries) must never be switched on until its spending is provably visible.

Most of the plumbing already existed. Every internal AI call the agent makes — its gates, sentinels, background judges — already flows through one funnel that writes a row to a ledger: which feature called, how many tokens in/out, how long it took, which model, which framework. You can read it at `/metrics/features`. So this isn't a new metering system; it's closing the holes in the one we have.

## The four holes

1. **Codex calls report zero tokens.** The codex CLI's plain output carries no usage numbers, so every codex-routed call records "tokens: unknown." That's exactly the route the doc-sweep uses — the one feature Justin asked to audit would have been the blind one. Fix: run codex in its JSON-event mode and read the usage events it streams, carefully (the final answer comes from a separate file codex writes, so a weird model output can never corrupt the result; the events are only ever used for counting).

2. **Failed calls lose their cost.** If a call times out or errors after the model already did the work, the tokens were burned but the ledger row says null. Flaky features looked cheap — the opposite of auditing. Fix: record whatever usage was seen even when the call fails.

3. **No per-model split.** A feature that uses both a cheap and an expensive model showed one combined number. Fix: the ledger now breaks tokens down per feature AND per model (including cached-token counts, since cached input costs ~10× less than fresh).

4. **Tagging was optional.** Features identify themselves with an "attribution" tag; untagged calls lump into an "unlabeled" bucket and nothing stopped new code from shipping untagged. Fix: all 8 currently-untagged callsites get tagged in this same PR (zero leftovers — no grandfathered list), and a new build check fails CI if any future LLM call ships without a tag. The rule also goes into the constitution as a written standard.

## The part that makes it durable

The scary failure mode isn't today — it's the silent slide back. If a future codex version changes its output format, parsing would quietly find nothing and tokens would go null again with no alarm. So the spec adds tripwires: a per-framework "usage coverage" number you can read at a glance (should sit at ~100% for frameworks that can report), a one-time alert if a codex call ever completes with no countable usage, and a live test that runs one real codex call and fails if counting broke (it skips politely when the machine has no codex or the account is rate-limited, so it never cries wolf).

## Tradeoffs accepted

- The codex change swaps a simple "run and read output" call for a streaming parser with strict memory caps and a temp-file handoff — more moving parts, but each piece is pinned in the spec with tests, and a kill-switch (`intelligence.codexExecJson: false`, or an env var) restores the old behavior instantly if a codex version misbehaves.
- Routine temp-file cleanup now flows through the audited deletion funnel, which would have bloated the audit log — so the audit log gains size-capped rotation (with a marker entry so a shrunk log is explainably rotated, never mysteriously truncated).
- The sweep stays OFF until this lands and is verified. That was the point.

## What you'll see when it ships

`curl /metrics/features` will show, per feature: tokens by model, cache vs fresh, coverage of usage reporting, and how much (if any) spend is unattributed — which should read zero.
