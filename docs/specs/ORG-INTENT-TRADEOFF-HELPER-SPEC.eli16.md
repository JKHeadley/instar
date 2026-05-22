# ORG-INTENT Tradeoff Helper — ELI16

> Plain-English companion to `ORG-INTENT-TRADEOFF-HELPER-SPEC.md`. Read this first.

## What's the problem

In Phases 1 and 2 we wired `ORG-INTENT.md` into two places: the gate that reviews outbound messages, and the agent's session-start context. Both use the tradeoff hierarchy from the file — the ordered list that says which value wins when two pull in opposite directions.

But until now, only the message-review reviewer could use the hierarchy mechanically. Anyone else who wanted to ask "given these two values, which wins?" would have to fetch the file, parse it themselves, and reinvent the resolution logic. That's the kind of duplication that drifts apart over time.

## What this change does

We added one small new file (`src/core/TradeoffResolver.ts`) with a pure function: give it two value strings and the org's tradeoff hierarchy, and it tells you which one wins, why, and a human-readable explanation. No LLM call. Just deterministic string matching.

We also added one HTTP route, `POST /intent/tradeoff-resolve`, so any code or any agent can ask the question via curl.

The resolver tries three strategies in order:

1. **Pair-pattern**: if the hierarchy has an entry like `"customer trust over speed"` and you ask about trust vs. speed, the explicit "X over Y" wins.
2. **List-order**: otherwise, whichever value appears earlier in the ranked list wins.
3. **No match**: if neither value is in the hierarchy, the resolver says so. The caller decides what to do — usually: ask the value-alignment reviewer (LLM) to make the call.

## How it relates to the earlier phases

- **Phase 1 (gate)**: still the authority. Constraint violations get blocked there. The tradeoff helper is signal, not authority — it never blocks anything.
- **Phase 2 (session-start)**: still injects the whole hierarchy at session boot. The agent reasons with the contract from message one.
- **Phase 3 (this one)**: lets code paths outside the reviewer ask the hierarchy a direct yes/no question. Research agents, planning passes, future jobs.

The reviewer doesn't change. It already gets the structured hierarchy in its prompt (from Phase 1) and uses LLM reasoning to resolve ties. The new helper is a parallel option for code that wants deterministic resolution without the LLM cost.

## What's deferred

Phase 4 is still queued: a periodic background job that samples the agent's recent outbound actions and flags accumulated drift even when no single message violates anything.

## What you'll notice

- If you author your `ORG-INTENT.md` with explicit "customer trust over speed" patterns in the tradeoff hierarchy, you can now ask the agent (or any internal code) to resolve a tradeoff and get a clean deterministic answer.
- If your hierarchy is a plain ranked list (`["customer trust", "compliance", "speed"]`), the resolver respects list order — earlier wins.
- If you don't have a tradeoff hierarchy yet, the route returns `{ basis: 'no-match' }` and callers fall back to whatever they were doing before.
- CLAUDE.md gets one new bullet under the ORG-INTENT subsection telling the agent how to call the new route.

## How to roll back

The change is purely additive. Three rollback options documented in the side-effects review: code revert, ignore the route, or simply don't call it.

## Tests

Three tiers, all passing:

- 16 unit tests pin every branch of the resolver.
- 5 new integration tests pin the HTTP route end-to-end.
- 5 E2E lifecycle tests pin the wiring through AgentServer.

## Where to look next

- Spec: `docs/specs/ORG-INTENT-TRADEOFF-HELPER-SPEC.md`
- Side-effects review: `upgrades/side-effects/org-intent-tradeoff-helper.md`
- Phase 1 (gate): `docs/specs/ORG-INTENT-RUNTIME-GATE-SPEC.md`
- Phase 2 (session-start): `docs/specs/ORG-INTENT-SESSION-START-INJECTION-SPEC.md`
