# Convergence Report: One wrong-PIN budget for the whole agent (SEC-170)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external review ran on every round (12 of 12), through the agent's codex CLI. The Anthropic clean-door reviewer was not run (token pause).

## Status: converged at round 12, past the Tier 2 cap of 6, with a design change at round 8

Rounds 1 to 6 refined a design in which the lease-holding machine kept one count. Round 6 ended at the cap with two security findings, and the operator's Chief of Staff said to go on. Rounds 7 and 8 showed that design could not keep its bound without its own leadership protocol (votes, nonces, restart-durable locks, agreed membership), and each round found another gap. The Standards-Conformance Gate then pointed out that the spec's own argument (any share of at least one admits the owner) made a much simpler design possible. From round 9 the spec divides the agent's 20 into fixed per-machine shares, counted locally, with only membership needing agreement. Rounds 9 to 12 hardened the agreement protocol: an ordered allocation table, giver-signed hand-downs, acknowledgments bound to the exact table and the registry, and recovery only through a new table. In round 12 the internal reviewer returned CONVERGED (design 0, precision 2) and codex returned MINOR ISSUES (design 0, precision 4). All six precision items are applied in the final text. The final Standards-Conformance Gate run (2026-11-22 22:16 UTC, 102 standards) raised one flag. It names three values as unclassified, but all three are classified as judgment-candidates in Decision points touched, so it is recorded as a false positive.

## ELI10 Overview

The agent's dashboard PIN is the same on every one of its computers, but each computer counted wrong guesses on its own, so more computers meant more guesses for a stranger. This spec splits the agent's 20 guesses between its computers. With five computers each allows 4, so even a stranger who knows every address gets 20 in total. Each computer counts its own part, so nothing travels between computers when someone types a PIN, and a computer cut off from the others keeps working. When a computer is added, the computer that added it hands over part of its own share at once, and the shares even out once every computer agrees. The owner's normal ways in never change: a browser they used before, their phone, and the computer itself.

## Original vs Converged

- **Originally,** one machine (the lease holder) kept the count, and every other machine reserved each attempt with it. A cut-off machine refused every new browser, and an unplanned handover paused new browsers for over five minutes. **Now** each machine owns a fixed share of the 20 and counts locally. There is no lead, no network call on the PIN path, and no pause.
- **Originally,** a split lease could let two leads each spend. **Now** shares cannot overlap by construction. The only cross-machine agreement is about membership: lowering your own share is always allowed, and raising one needs every machine's acknowledgment of that exact table plus one window.
- **Added:** count-and-flush before comparing; an ordered allocation table valid only if canonical (or owner-signed) and matching the receiver's registry; giver-signed hand-downs that end only on a completed retirement; recovery from lost state only through a new table; owner "gone for good" for a machine that never answers; an agent-raised proposal to retire a silent machine; an alert rule fit for small shares; waits on a monotonic clock.

## Iteration Summary

| Round | Constitution gate | Internal (combined lenses) | External (GPT) | Spec changes |
|---|---|---|---|---|
| 1 | ran (1 flag: maturation path) | design 7, precision 8 | 3 design, 1 precision | dev-gated rollout; no fallback share; reserve-before-compare; signed routes; lead resolution |
| 2 | ran (0 flags after edits; 2 intermediate flags fixed: weighed alternatives, restart proof) | design 3, precision 5 | 3 design, 1 precision | count handover; escrow trigger; restart by lease record |
| 3 | ran (0) | design 3, precision 4 | 3 design | seal design; deadline from send time; durable row |
| 4 | ran (0) | design 0, precision 4 | 2 design, 1 precision | seal check named, own-view gate; durations; alone = never paired |
| 5 | ran (0) | design 1, precision 1 | 1 design, 2 precision | pin-lead.json; fail-strict writes; full pause in tests |
| 6 | ran (0) | design 0, precision 2 | 2 design, 1 precision | split-lease conserved share; honored-marker predicate; fsync; recovery wording (not re-reviewed) |
| 7 | ran (1 flag: escrow deferred, operator judgment) | design 1 (split bound for 3+ machines), precision 1 | 1 design, 1 precision | conserved per-lead share replaced by confirmed sets |
| 8 | ran (several, fixed in text) | design 2 (restart lock, agreed N), precision 2 | 2 design | vote locks persisted; membership agreement |
| 9 | ran (flags led to the fixed-share design) | design 0, precision 6; CONVERGED | 2 design, 1 precision | design change to fixed per-machine shares |
| 10 | ran (0 after edits) | design 2 (table authority, first table), precision 3 | 2 design, 1 precision | ordered allocation table; durable hand-down; acknowledgment safety rule; recovery by new table |
| 11 | ran (1, already-classified values) | design 2 (signed transfers, transfer end), precision 1 | 3 design | members must equal registry; no seq jump limit; graduation per admission |
| 12 | ran (1, false positive) | design 0, precision 2; CONVERGED | MINOR: design 0, precision 4 | replay and seq rules; recovery wording; write cost; monotonic waits (applied after review) |

Internal reviewers ran as one combined-lens Claude Sonnet subagent per round (security, scalability, adversarial, integration and multi-machine, decision-point classification, verify-state, decision-completeness, lessons-aware and experience fit), re-asked each round. That is a deliberate cost reduction under the standing token pause.

## Proportion

Tier 2 security spec, about 170 lines. 12 rounds, twice the cap, continued at the Chief of Staff's direction. The first eight rounds show the cost of a leader-based design; the switch to fixed shares cut the protocol to membership agreement, and the last four rounds converged on that.

## Left behind

- Each machine's new-browser budget is its share (4 tries per window with five machines). An attack at one address can spend that share and make a new browser wait there until the window resets; the other machines are unaffected. Borrowing from idle machines was weighed and left out. This is the operator judgment the conformance gate raised in round 12.
- Fixed per-machine windows still allow up to twice the shares across a window edge in a short span. That property already exists on a single machine today.
- During enabling, until registries agree, a machine that has not yet heard of a new machine can hold one share too many per unknown machine (§6).
- A wrong "gone for good" confirmation by the owner can add at most that machine's old share.

## Full Findings Catalog

Each round's findings and resolutions are summarized in the table above and in "Original vs Converged". The raw reviewer outputs are in the security session's scratchpad for this run (codex170-r1 to r12, plus the internal reviewer transcript). The previous lead-based design is kept there too, as pool-wide-pin-budget.leader-design.md.

## Standards-Conformance Gate: dispositions after round 12

The gate is LLM-judged and its findings vary from run to run on the same text. The Chief of Staff's run at e8a8f16a6 (22:39 UTC) returned 8 possible violations, where my last run before it had returned 1. Each of the 8 is fixed or disposed below.

1. **Verify the State (an owner's "gone for good" could hand out a share a still-running machine uses).** Fixed. The confirmation counts only when the pool's own contact records show no signed contact from the machine for 7 days. That is the same silence that lists it for the owner, so the owner's tap takes effect at once in the ordinary case. Unreadable records keep the raise waiting.
2. **Cross-Machine Coherence (a hand-down doesn't fence a cut-off peer's pending raise).** Fixed. A raise never exceeds the table entry minus the machine's own outstanding transfers. A worked example and a test were added.
3. **Judgment Within Floors (equal shares let a busy machine refuse while others idle).** Disposed. The division is already a judgment-candidate with a floor (shares sum to 20, agreed), an arbiter and an owner-signed path to a weighted division. A new trigger was added: any new-browser refusal outside a counted attack during dev-agent-live means borrowing or a weighted division is built before the fleet packet.
4. **Security Fixes Keep the Experience Whole (a zero-share machine could refuse indefinitely; borrowing dismissed without evidence).** Fixed. Any machine at share 0 that is not retired gets a giver-signed hand-down from any reachable peer and admits after one window. That covers lost state and a newcomer whose giver had nothing to spare. Borrowing is now rejected on evidence: it puts a network call back on the PIN path, which the lead design proved costly. It has a measured trigger and a tracked commitment.
5. **Judgment Within Floors (fixed alert thresholds).** Disposed. They are classified as a judgment-candidate with a floor (alerts never change what is admitted), an arbiter and a fallback.
6. **The Agent Carries the Loop (the retirement proposal resurfaced after 30 days with nothing new).** Fixed. It re-raises only when something new happens: another machine goes silent, or a change is held back by a silent machine.
7. **Bounded Notification Surface (one proposal per silent machine).** Fixed. One agent-wide item lists every silent machine and is updated in place.
8. **Maturation Path (no test-agent rung, no graduation condition).** Fixed in form. Both existed, and each rung now states its exit condition explicitly.

Two further gate items from my re-runs were also fixed: the lost-allocation recovery retry got the same brakes as acknowledgments, and the 30-day wait was replaced by the 7-day corroboration.

**Final gate runs on the committed text (three runs, 22:42 UTC, 102 standards each):** 1, 1 and 2 possible violations. All of them are Judgment Within Floors items, asking for evidence for the exact 7-day corroboration and for the equal split. Both are already declared judgment-candidates with floor, arbiter and fallback, to be tuned from dev-agent-live evidence. They are disposed, not hidden. They are the two places where Justin may prefer a different call: an owner's tap taking effect at once, and a weighted rather than equal split.

## Convergence verdict

Converged at round 12: the internal reviewer returned CONVERGED and the external reviewer returned minor issues only, with no design findings. Every precision item is applied. This is past the Tier 2 cap, by the Chief of Staff's direction to go on, and the design changed at round 8, so the operator should read §3 (the fixed-share design and its weighed alternatives) and §5 (what changes for the owner) before approving. No code is to be written until the spec is approved.
