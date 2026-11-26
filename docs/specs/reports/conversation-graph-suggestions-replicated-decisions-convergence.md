# Convergence Report — Conversations suggestions: the owner's decisions reach every machine

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in all six rounds (status `ok` each round; the first round's attempt through the agent-home build failed with `error` and was re-run through the installed build, which succeeded). The Anthropic clean-door read (`claude-code`) degraded in round 1 with `override-not-frontier` and was not retried; it is disclosure only and never counts as a cross-model pass. Gemini was not authed (`gemini-not-authed`).

## ELI10 Overview

On the Conversations page the agent suggests groups of chats. You can Reject a suggestion (it should never come back) or Accept it (a group is made and the chats move in). Until now each of your agent's computers remembered your choices only for itself, so a computer that never saw your Reject could suggest the same group again, and an Accept continued on a different computer could make a second, empty group.

After this change your choices travel to all of your agent's computers as small records on the journal they already share. A Reject anywhere hides the suggestion everywhere. A started Accept shows Continue everywhere, carries the group's name and which chats are in it (so even a computer that never built that suggestion can finish it), and every computer asks for the same group, because the request number is now worked out from the suggestion itself.

The trade-offs: the records keep the group's name and chat ids forever in the journal (they never carry message text); a computer on an older build keeps its own memory until it updates; and a few rare races in the upgrade window can still leave an extra group, which is the owner's ordinary group to keep or remove.

## Original vs Converged

- **Originally**, an `accepting` record held only the suggestion id and request number. Review showed another computer usually has not built that exact suggestion, so it could neither show Continue nor keep its chats out of new suggestions. **Now** the record carries a snapshot (name, chat ids, front door) checked against the suggestion id.
- **Originally**, two computers could each mint a random request number, and the dashboard on today's build keeps it in the browser, so two groups could form and chats be split. **Now** the request number is derived from the suggestion id on every computer.
- **Originally**, other computers' decisions were copied into each computer's own file, so a lost outbox would re-publish them as its own and switching the feature off would not restore the file. **Now** they are overlaid on read and never written; a ledger per loaded state tracks what was overlaid.
- **Originally**, rows were re-sent blindly (a blind re-send appends a new journal line every restart) and the retry loop had no brakes. **Now** each restart checks this computer's own journal and re-sends only what is missing; the drain backs off from 10 minutes to 6 hours, sends at most 100 rows a pass and rotates so refused rows cannot starve others.
- **Originally**, record identity left out the time and the earliest-time rule could prefer a newer start under clock skew. **Now** identity is the hash of the whole row, and a pre-upgrade start always wins.
- **Originally**, decisions made before the update were shared on the first suggestions request, which a computer may never serve. **Now** they are shared at boot.
- An ended Accept (rejected or finished on any computer) no longer keeps its chats out of new suggestions, and a build that started before a peer's Accept landed drops any group overlapping it.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, security+adversarial, integration+scalability, decisions+lessons, Standards gate (4 flags) | 13 | 12 | snapshot on accepting rows, content-hash keys, derived request id, AgentServer wiring path, kill switch, result on accepted rows, overlay never persisted, only proven sends count, abandoned-Accept end, decision-point rows, drain added |
| 2 | codex, integration+adversarial, decisions+lessons, gate (4) | 8 | 10 | snapshot governs differing local entries, frontDoorKey, legacy residual, boot re-offer, kill switch resolution, title normalization, overlay ledger per state, backfill time from local entries, drain backoff |
| 3 | codex, all-lens reviewer, gate (4) | 6 | 2 | boot checks own stream (no blind re-send), normalized title compare, backfill through the comparator, one timestamp per decision, accepting overlay restores local entry, build overlap filter, drain cap + breaker |
| 4 | codex, all-lens reviewer, gate (5) | 4 | 5 | legacy beats derived, drain keeps going at ceiling, legacy-id residual, timestamps in reject/accepted, local tap claims a peer value, record sends only its row |
| 5 | codex, all-lens reviewer, gate (5) | 5 | 1 | running-Accept test, rotating flush, batched backfill and landing, mixed-version residual, rollback wording |
| 6 | codex, all-lens reviewer, gate (5) | 3 (all fixed) | 4 | boot backfill, drain re-arms at base delay, Continue wording, field types |

Standards-Conformance Gate: ran each round (4, 4, 4, 5, 5, 5 flags). Internal reviewers ran on claude-opus-5-5 (the authoring session's model) every round.

## Proportion

Tier 2; spec ~200 lines; code ~650 lines across 9 source files plus 3 test files. Six rounds used of the Tier-2 cap of six. ⚠ Every round found design issues: the draft code was built alongside the spec from round 2, so reviewers kept finding real behavior defects in it; each was fixed in code and spec.

## Left behind

- Gate, Multi-Machine Entity / Pending exception (rounds 1–6): a decision on a machine lost before its row leaves is lost. Accepted risk: the rows are owner choices about advice, not Conversations-graph information, so Amendment 6's receipt states do not apply; same window as every WS2 store; recorded as a residual risk.
- Gate, Judgment Within Floors (rounds 2–6): the 12-member / 60-character snapshot limits. Accepted: they are the producer's own output domain (`SUGGESTION_LIMITS`); a correct machine cannot emit a larger snapshot, so no legitimate row is refused.
- Gate, No Unbounded Loops / Capacity Safety (rounds 2–6): the drain keeps retrying at the 6-hour ceiling. Accepted: the round-4 external review showed a stopping breaker strands a recovered journal; the rate is bounded (≤4 in-memory passes a day, ≤100 rows each) and each row is reported once.
- Gate, No Manual Work (rounds 4–6): a peer's Reject during an interrupted Accept leaves a partly built group. Accepted: it is the owner's own Reject; the group is ordinary owner state.
- Gate, A Refusal Stays a Refusal (round 6): permanent replication refusals are reported internally only. Accepted: the effect is that advice may be re-offered; the owner's action already took effect on the machine they used.
- Gate, Canonical Pipeline Must Drain (round 4) and Verify the State (round 4): resolved by the round-4/5 drain and legacy-rule changes.
- Mixed-version race and legacy-id binding: documented residual risks (same-agent trust boundary, upgrade window only).
- Precision items each round (wording, scope phrasing, field types, an unused helper `suggestionDecisionsKillSwitchOn` kept for tests): fixed in passing or not worth a round.

## Full Findings Catalog

Round 1 (design): accepting rows lacked the suggestion (codex, security, integration) → snapshot; dedupe key excluded time (codex) → content hash; `sga-` hijack (security) → derivation check; dashboard caches create id so two groups and split members (decisions) → derived id on main; no server.ts→service path (integration) → AgentServer option on both surfaces; kill switch receive side (integration, decisions) → store not built; `acceptResults` (integration) → result on accepted rows; overlay persisted (decisions, security) → never persisted; unconfirmed counted as sent (decisions) → not counted; abandoned accepting never ends (security, decisions) → Reject / closeAccept documented; reject-during-accept row (decisions) → decision-point row; peer flood (security) → one winner per slot; gate: drain cadence, retention basis, attribution, Pending → addressed.
Round 2 (design): snapshot not authoritative for project ids (codex, integration) → snapshot governs; legacy→derived duplicate after upgrade (codex) → residual; frontDoorKey missing (integration) → set; emitted means enqueued (integration) → boot handling; kill switch copied from trust journey (integration, decisions) → recommendedServices resolution; overlay strip rule unspecified (decisions) → WeakMap ledger per field; backfill time (decisions) → local entry time; gate: unbounded loop → backoff + cap.
Round 3 (design): blind boot re-send appends lines (all-lens) → own-stream check; title normalization mismatch (all-lens) → normalized compare; backfill holds() skip loses earlier legacy (codex, all-lens) → comparator; accepting overlay deletes original on save (codex) → restore; in-flight build overlap (codex) → publish filter; gate: breaker → added.
Round 4 (design): breaker strands recovered journal (codex) → keep going at ceiling; clock skew vs legacy (codex, gate) → legacy wins; legacy id unbound (codex) → residual; two timestamps in reject/accepted (all-lens) → one time.
Round 5 (design): ended local Accept still blocks builds (codex) → running-Accept test; capped flush starvation (codex) → rotation; backfill uncapped inside a request (all-lens) → recordMany; per-row outbox writes on landing (all-lens) → batched; mixed-version legacy race (all-lens) → residual.
Round 6 (design): Continue on a peer start not claimed locally (codex) → spec wording (the finish is recorded locally); drain timer not re-armed on a new decision (codex) → stop + re-arm; backfill only on first request (all-lens, data loss) → boot backfill.

## Convergence verdict

Converged at the round cap (round 6). Every design finding raised in round 6 was fixed in code and spec; nothing about safety, security or data loss remains open. The Standards-gate signals that recur are listed above as accepted risks with one line of reasoning each. Spec is ready for approval.
