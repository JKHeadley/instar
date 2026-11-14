# Convergence Report — Native Accounts, Spend and Resource usage screens (read-only)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on rounds 1-6 (round 1's first attempt degraded with `error` because the agent home's built reviewer resolved a retired model; it was re-run from the worktree build on `gpt-6-astra` and returned `ok`). Gemini was not available (`gemini-not-authed`); the Anthropic clean-door family was available but not run.

## ELI10 Overview

The Instar iPhone app gets three more native screens: Accounts (which AI subscription accounts are signed in, how much of each 5-hour and weekly limit is used, and when it resets), What thinking costs (recorded pay-per-use cost, paid-route limits, and conversation token totals), and Resource usage (CPU and memory for the agent, its server and each session). Until now the phone had to open the web dashboard for these.

The server gets three new read-only questions only the owner's phone may ask. Each answer is a cut-down summary of what the web console already shows the owner, built from an explicit list of allowed fields: no login folders, internal ids, credential references or raw errors. Nothing on these screens changes anything; signing in and spending limits stay in the dashboard.

The main tradeoff: the answers are honest about what they could not see. A machine that was offline or didn't answer is named and totals say they cover only the machines that answered; a stale reading says its age; a "$0" is never claimed for use that had no price.

## Original vs Converged

- Originally accounts trusted the machine name a peer wrote into its own rows. Now each peer's rows are attributed to the peer that was asked and named from this machine's registry (the console gets the same hardening).
- Originally spend was this machine's ledger only (justified as credential-bound, which reviewers rejected). Now recorded cost and conversation tokens are read from every online machine and added up, with each machine listed (answered, switched off, unreadable, didn't answer, offline); limits stay this machine's, with each paid route naming its designated machine and its committed figures hidden (not shown as $0) when they are booked elsewhere.
- Originally phone refreshes could multiply peer reads. Now pool answers are cached single-flight for 15 s and the three routes have their own 20-per-minute bucket.
- Originally a checked-and-failed login could read "signed in (not re-checked)", a repair in progress read "needs sign-in", a future-dated reading could win, and resource readings always said "now". All fixed; resource rows older than 5 minutes say their age, ended sessions show no current reading.
- Originally "Today" silently covered up to 48 hours. Now the answer returns `costSince` and `tokensSince` and the screen states them.
- Originally the "held by" sentence named the answering machine as the lease holder (wrong), and the designated-machine check compared against the mesh id only. Now the holder is per route and compared against both ids the money layer uses.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security/adversarial, scalability/integration, decision/lessons, codex | 12 | 14 | peer attribution, cache + bucket, spend posture, self row, partial headlines, repairs, login check, resource freshness, live proof timing, rollback wording |
| 2 | six-lens internal, codex | 7 | 3 | holder naming, peer 503 classification, amortized scope, generatedAt in cache, offline machines in spend, state precedence, merged flags |
| 3 | six-lens internal, codex | 3 | 5 | per-route designated machine with committedElsewhere, accounts offline listing |
| 4 | six-lens internal, codex | 4 | 3 | money-layer machine id, ELI16 claim, signed-in rule, coverage dates |
| 5 | codex (internal: none) | 1 | 4 | app partial note includes offline (spec text) |
| 6 (cap) | codex (internal not re-run: round-5 internal clean, round-6 spec changes textual) | 1 | 2 | accepted at the cap (see Left behind) |

Standards-Conformance Gate: ran in round 1 and returned `degraded: true` (`fit judgment errored — fail-open`, 0 findings), so the constitutional pass was not authoritative; the decision/lessons reviewer was asked to cover the registry standards touched (Maturation Path, Live-User-Channel Proof, Observability, Know Your Principal) and did. Later rounds: not re-run.

Internal reviewers ran as three combined subagents in round 1 (two lenses each) and as one six-lens subagent in rounds 2-5, on the authoring session's model (Opus 5.5).

## Proportion

Tier 2 (security-sensitive: widens device-key read access). Server: one new module (~560 lines), three allowlist entries, two extracted helpers plus one mount block, awareness lines; app: two new files plus a few lines in three shared files. Six of six rounds used. ⚠ That is the cap: rounds 3-6 each found one or two design-class corners in the multi-machine spend and money semantics (designated machine, coverage windows), none about access control.

## Left behind

- (accepted at the cap) Peers are asked with a relative window (`sinceHours`, `since=now-hours`), so a fan-out that crosses UTC midnight within its 5 s could count one more or one fewer day bucket on one peer than `costSince` states. Each machine's figure is correct for its own query; the coverage line is exact for this machine. Not safety, security or data loss.
- (accepted) `offline` and `unread` come from two peer snapshots milliseconds apart; a machine changing state in that instant can appear in both or neither.
- (accepted) A permanently retired machine still in the registry keeps headlines scoped "(on the machines that answered)" until it leaves the registry.
- Peers' sign-in repair episodes are not read (a peer's row under repair shows its pool status).
- No dedicated regression test for the peer-attribution hardening inside the extracted pool view (it is inline in routes.ts; the summarizer side is tested).
- The ELI16 and console parity notes: the phone counts accounts needing sign-in, the console counts account-and-machine cells.
- Background-check metrics, per-conversation token lists and the routing map are not on the phone's spend screen (additive later).
- The Anthropic clean-door second read was not run.

## Full Findings Catalog

Round 1 — security/adversarial: peer-supplied identity/freshness (DESIGN, fixed), uncached fan-out cost (DESIGN, fixed), route name source (DESIGN, documented + tested), money-status fields (PRECISION, allowlisted), inUse local only (PRECISION, fixed), numeric checks (PRECISION, fixed), key wording (PRECISION, fixed), app storage (PRECISION, documented). Scalability/integration: fan-out cache (DESIGN, fixed), self row in failed (DESIGN, fixed), ownerOrBearer location (DESIGN, documented), CapabilityIndex entry (DESIGN, kept separate empty-prefix entry with reason), spend posture key (DESIGN, made proxied-on-read), inUse posture (DESIGN, keyed), rollback claim (DESIGN, reworded), window mapping, part states, migration anchor (PRECISION, fixed). Decision/lessons: live proof timing (DESIGN, proof before app build reaches operator), repair episodes (DESIGN, local episodes read), forward compat, lifecycle list, split limits states, headline count, coverage, resource freshness, signed-out check, unpriced $0, graduation metric (PRECISION, all fixed). Codex: resource freshness (DESIGN, fixed), partial headlines (DESIGN, fixed), contract completeness (PRECISION, fixed).
Round 2 — internal: holder named wrong machine (DESIGN, fixed), peer 503 as off (DESIGN, fixed), amortized summed (DESIGN, this machine only), generatedAt / peer names (DESIGN, fixed); unread scrub, local off wording (PRECISION, fixed). Codex: offline machines not reported (DESIGN, listed), state precedence (DESIGN, defined), merged flags (DESIGN, OR'd); ELI16 scope (PRECISION, fixed).
Round 3 — internal: spec still described old holder (DESIGN, fixed), committed $0 on non-holder (DESIGN, null + committedElsewhere); heldBy null meanings, wording, offline in precedence, accounts offline, self-as-offline (PRECISION, fixed). Codex: accounts offline (DESIGN, fixed); holder contract, ELI16 sensitivity (PRECISION, fixed).
Round 4 — internal: wrong self id for designated machine (DESIGN, both ids), ELI16 lease claim (DESIGN, fixed); retired machines, disjointness (PRECISION, documented). Codex: unknown status + ok check (DESIGN, spec reworded, test added), coverage labels (DESIGN, costSince/tokensSince); §4 wording (PRECISION, fixed).
Round 5 — internal: no DESIGN; snapshot disjointness, ELI16 coverage, test list (PRECISION, fixed). Codex: app offline note in spec text (DESIGN, fixed; the app already did it); extraction wording, headline labels (PRECISION).
Round 6 — codex: peer midnight boundary (DESIGN, accepted at the cap with reason); extraction wording + attribution regression test (PRECISION, wording fixed, test left behind).

## Convergence verdict

Converged at the round cap (6) for a Tier 2 change. The one remaining design-class finding is a long-tail coverage edge on peer spend figures, not safety, security or data loss, and is recorded above as an accepted risk. Spec is ready for approval.
