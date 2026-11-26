# Convergence Report — Quota pacing, step 4: project priority and each project's share of each account

## Cross-model review: codex-cli:gpt-6.2-astra

GPT-6.2 Astra (through the agent's Codex login) reviewed the spec in all six rounds, each time on a changed body (hashes recorded below), so no round was delta-skipped. Gemini was detected but not signed in (`gemini-not-authed`), so it could not run. The clean-door Anthropic second read (`claude-code:claude-fable-5`) ran in rounds 1 and 2; it is a separate disclosure and does not count as cross-model.

## ELI10 Overview

Instar runs on a group of Claude and Codex subscription accounts. Earlier steps taught it to read how full each account is, to forecast where it will land at reset, and to prove which account really did each piece of work. The next steps will suggest changes when an account runs tight. Before they can, two facts are missing: which projects the owner cares about most, and which projects each account's quota actually went to.

This spec adds both. The owner sets each project's priority (high, normal or low) with one tap in the Instar app on their phone, or with a single button the agent sends in Telegram when they ask for it there. The agent can read it but never set it, and a project nobody rated reads "Normal (not set)". A new read adds up the recorded work per project and per account, with every piece of work that can't be tied to a project or a proven account shown as its own slice, and it says plainly when some machine's records are missing.

Nothing acts on either number in this step. The main trade-off is honesty over convenience: the dashboard can show priority but not change it, because its PIN is something the agent can read; and the share read marks itself incomplete rather than guess whenever a machine is silent, was restored from a backup, or pruned old records.

## Original vs Converged

- **Who can set priority.** The draft let the dashboard set it with the console session. Reviewers showed that session is unlocked by a PIN any session holding the agent's token can read, so a dashboard tap would not prove the owner chose. The dashboard is now read-only for priority, as it already is for Pause and Finish.
- **Setting priority no longer restarts work.** Every other owner tap also renews the Chief of Staff's check-in, which can let it resume restarting and redirecting work. A priority tap now writes no check-in, so the step really changes no work.
- **The Telegram button.** The draft reused the pause button's store, so asking about priority would have silently removed a pending Pause button. Priority asks now have their own store and button id, name the project and level the server resolved (so a wrong pick by the agent is visible before the tap), and are expired by comparing which decision currently wins, not by comparing two machines' clocks.
- **Matching usage to conversations.** The draft built Slack keys from the bare channel id, which never matches the key a Chief of Staff project uses; every Slack project would have shown zero use. The key now comes from the same shared function the rest of the system uses. Reviewers also caught that the new column would have broken the hourly backup snapshot and the restore of older snapshots; both are now handled.
- **How the share is computed across machines.** The draft never said what each machine sends back. Now each machine returns day-by-day grouped sums plus its own coverage verdict, so the holder can tell a quiet machine from one that lost records to a restore or a prune. Paired requests count once, accounts are bucketed by step 3's evidence table, a broken project tree has its own bucket, and "complete" means every machine answered and can show its records reach back far enough.
- **Build order.** The share read depends on step 3, which is still in review. The spec now splits into slice 1 (priority, buildable now) and slice 2 (shares, built after step 3 merges).

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | GPT-6.2 Astra (4), clean-door (1 conditional), security+adversarial (4), scalability+integration (7), decision-completeness+lessons (6); gate 10 flags | about 16 distinct after merging duplicates | 12 precision | full rewrite: console read-only, no check-in, own ask store, canonical conversation key, snapshot handling, peer payload, basis table, unresolved-tree bucket, retention check, 31-day cap with per-day yield, slice split |
| 2 | GPT-6.2 Astra (5), clean-door (0), all-lenses internal (2); gate 8 flags | 7 | 10 precision | step 3's row selection reused; common interval for cross-account splits; completeness from every pool member; switch recheck at tap; PIN-route claim corrected; app-prefix-only memory key; pre-upgrade snapshot restore |
| 3 | GPT-6.2 Astra (4), all-lenses internal (2); gate 6 flags | 6 | 4 precision | ask names the resolved project; backfill limited to transcript and rollout rows; unconfirmed accounts keyed by basis; `projectInterval`; platform-argument derivation moved with the key function; restore-aware coverage |
| 4 | GPT-6.2 Astra (4), all-lenses internal (1); gate 4 flags | 5 | 6 precision | peer coverage verdict and switch history; pair contribution rule; UTC-date rolling bounds; closed-project tap answer; prune watermark |
| 5 | GPT-6.2 Astra (3), all-lenses internal (0); gate 5 flags | 3 | 4 precision | clock-free ask expiry; per-status pair contribution from the ledger's totals rule; tracking-start-aware retention; route-by-switch table |
| 6 (cap) | GPT-6.2 Astra (4); gate 6 flags | 4, resolved at the cap without a further round | 0 | retention evidence precedence (old rows never prove coverage); coverage metric counted in requests after pairing; pair day from the transcript row; phone `allowed` from the write gate's preconditions |

Standards-Conformance Gate: ran every round (10, 8, 6, 4, 5, 6 flags). Each round's flags were contested in the internal review; those accepted were fixed, the rest are listed under Left behind with the reason.

Reviewer models: the internal reviewers ran as Claude subagents on the authoring session's model (Opus 5.5). Round 1 used three reviewers covering two lenses each; rounds 2 to 5 one reviewer covering all six lenses; round 6 ran the external pass and the gate only, at the cap. External: GPT-6.2 Astra ran in all six rounds; the clean-door read ran on claude-fable-5 in rounds 1 and 2. Body hashes of the externally reviewed versions: d4dfc30e, 6983ccdd, 15c73256, da877ee8, 4be95363, d1c688c2.

## Proportion

Tier 2 (a new owner-authority record, a ledger schema change on a backed-up table, a pool-wide read; about 260 spec lines; an estimated 12 to 16 source files plus tests across two slices). 6 rounds used of a 6-round cap. The external reviewer kept finding real accounting and boundary issues in the share read through round 6, each smaller than the last; the priority half was stable from round 2.

## Left behind

**Round 6 design findings, resolved at the cap without a seventh round.** None concerns safety, security or data loss: the feature is read-only, and the four findings were about accounting precision (retention evidence order, which timestamp a pair uses, how the coverage measure counts) and one display flag (`allowed` on the phone row). Each was applied as a direct fix with its own test in the spec, and the build's tests and the test-agent rung check them.

Gate flags and review items contested and kept (one line each):
- 200-character bound on a priority word: kept; it is the store's existing bound for any lifecycle event word and is the published contract for future levels, and a longer word would already be refused as an event name.
- One open Telegram priority ask per project: kept; the owner can always tap the row in the app, and two competing buttons for one project's level invite contradictory taps.
- Slack and app-conversation owner requests cannot become a button (the marker format names Telegram messages): left for a later change; the owner's phone row covers every channel today.
- Attribution of Justin's words: `GET /attribution/trace` has no lineage for either message (both predate the ledger); the topics and dates are cited, and approval rests on the repository standard, not on a quote.
- Team access: priority and project rows stay owner-only, as the Work door's project rows already are; a member-owned project's priority is a later spec once project rows themselves are shared.
- 31-day maximum and 2 MB per-peer answer: kept as judgment-candidates with the graduation review as arbiter; the 2 MB is to be checked against measured answer sizes.

Precision items carried to the build:
- Note in §4.1 that restored rows come back as `replay`, so slice 2's reconciliation test seeds a post-restore ledger (stated in the tests list).
- The "callback machine" is the awake machine (`coordinator.isAwake`); wording kept as in the pause ask.
- Name `GET /usage/projects`'s shared off code in its 503 detail (done).
- A share line on each Work row, and turning shares into weekly points through step 3's `costPerPoint`: later steps.

## Full Findings Catalog

Round 1: console operator session is not owner proof → console read-only; priority tap renews the check-in lease and can restart work → no check-in; peer aggregation cannot split `beforeBinding` → day-grouped peer payload; denominator mislabelled as share of the week → `shareOfObservedCost` with caveats; `session_bindings` is snapshotted and replicated, so the new column breaks snapshot writes and is dropped on restore → snapshot builder and restore list updated, replication deliberately unchanged; Slack key built from the bare channel id → shared `conversationRefForSession`; Telegram ask collides with the pause-ask store and callbacks → own store and `cos:pr:`; step 3 not merged → two slices; unconfirmed rows bucketed by the wrong field → basis table; 90-day maximum not a completeness guarantee → `retention-incomplete`; broken tree reported as not-in-a-project → `unresolved-tree`; 32-character level cap could stall a peer stream → store's event-word bound; 16-hop walk cap unneeded → removed; 90-day grouped scan blocks the event loop → 31-day cap and per-day yield; Codex attribution coverage unstated → framework breakdown and a test-agent check; machine-local tick log undefended → ladder reads unified sources; app key timing → memory-place key first plus registration backstop; device allowlist entry → named.

Round 2: share denominator did not reuse step 3's row selection → shared selector and a reconciliation test; cross-account project split mixed cycle lengths → common interval; partial pool could pass the completeness check → every member's validated answer required; outstanding Telegram buttons after switch-off → recheck at tap; "nothing lets the agent write owner decisions" was false (PIN routes for binding and confirm-done exist) → claim scoped and tested; Slack memory-place key lacks the team id → app-prefix only; restoring a pre-upgrade snapshot would throw on a missing named parameter → null default.

Round 3: wrong-project risk in the Telegram ask → server-resolved title and level, bound to the stored message; backfill could give invocation rows a project by timing → transcript and rollout rows only; account entries merged two step 3 bases → keyed by basis; `projects.interval` cannot live on an array → top-level `projectInterval`; the key function's platform argument was not specified → derivation moved with it, lazy registry; restore made `earliestRowTs` read complete falsely → restore-aware check.

Round 4: holder could not infer a remote restore or a switched-off peer → peer coverage verdict, switch history; pair contribution unspecified → rule stated; partial-day rolling bounds unrecoverable from day groups → UTC dates only; finished-project tap race → `closed: true`; an idle machine read as retention-incomplete → prune watermark.

Round 5: watermark missing right after upgrade → `prune_tracked_since` and `retention-unknown`; reconciliation between endpoints sharing a selector cannot catch a shared error → independent expected totals and the ledger's per-status totals rule; clock comparison for outlived asks → fold-winner comparison.

Round 6 (cap): an old promoted row could prove coverage after a prune → evidence precedence, old rows never proof; the coverage measure counted rows, not attributed requests → requests after pairing; pair rows straddling midnight → transcript row's day, unbounded counterpart lookup; phone `allowed` ignored the write gate's preconditions → derived from the gate.

## Convergence verdict

Converged at the round cap (round 6, Tier 2). The internal reviewers found nothing that changes what gets built in round 5; the external reviewer's last four findings were accounting-precision and display issues, none about safety, security or data loss, and were resolved in the spec at the cap with a test each. No open questions remain. The spec is ready to approve and build, slice 1 first and slice 2 after PR #3491 merges.
