# Constitution alignment map

How the 1.x registry and the 2.0 purpose and rule book compare, rule by rule. A working document, not a book and not an authority: where the two differ, the master governs (see `docs/specs/constitution-alignment.md`). Seeded from one reader's read on 2026-11-03; statuses are judgments, and an independent re-read comes before any conflict goes to the operator.

- 1.x: `docs/STANDARDS-REGISTRY.md` at JKHeadley/instar `7928ee0` (matches remote HEAD at audit time, 2026-11-03).
- 2.0: `docs/00-the-purpose.md`, `docs/01-the-rules.md` at JKHeadley/instar-2 `2f46478` (matches remote HEAD).

## 1. Counts

| Item | Count |
|---|---|
| 1.x articles with a `**Rule.**` line | 98 (92 at #2323, plus TCC from #2194, plus One Constitution, Two Books Aligned from #2708, plus The Person Decides; the Agent Does the Rest from #2734, plus Attributed Statements Trace to Their Source and No Feature May Require a Purchased Service, both from #2812, plus An Instar Agent Always Serves a Team from #3046) |
| 2.0 rule rows | 123 (numbers 1 to 123, each once, with instar-2 #189, #190, #191 and #192, and #200) |
| Purpose rules | 19, labelled Rule (Rule 5 is labelled Value, so it is not counted); 13 Values |

Map result: **53 aligned, 42 differs, 3 1.x-only**, plus 26 rule rows 2.0-only and 15 purpose rules 2.0-only (4 partial).

Of the differs rows: 8 `CONFLICT`, 10 `CONFLICT?` (a conflict on one reading, unsure), 15 `1x-extra`, 3 `2.0-extra`, 2 `both-extra`, 4 `minor`.

### Against the #2323 claim

| #2323 said | This audit | Reconciled? |
|---|---|---|
| 107 headings: 105 correspondences + 2 amendments | 93 Rule-bearing articles: 90 corresponded + 3 1.x-only | Partly. 107 included family and context headings. The third 1.x-only is TCC, which came later. |
| 24 unmatched rule rows | 26 | No. R118 was added later and has a 1.x mirror, so that does not explain it. I likely drew two boundaries differently (R95 and R115 are my closest calls). |
| 8 unmatched purpose rules | 15 with no article, 4 partial | No. Large gap, and my threshold is stricter. |
| "correspondences" | 41 of the 90 differ | The PR itself warned that correspondence does not mean identical wording. |

The desk map `CONSTITUTION-MAP-1023.md` is outside the repositories. A disk search hit its 60 second timeout with no result, so this is a count comparison, not an item-by-item diff.

## 2. How to read this, and where it is weak

- **`differs` threshold:** a duty a reader of the other book alone would not discharge, or a clash. Mechanism names and incident history do not count.
- **Depth:** all 93 Rule lines and all 137 2.0 rules were read. Full bodies were read for about 25 articles, chosen because they looked risky. An `aligned` row means no differing duty at Rule-line level. A remaining article body could still hold one (the merged-subsection text especially).
- **Not compared:** `Applied through` code. Instar-2 parts 02 to 16 were only searched, not read.
- **Quotes:** every quote here was machine-checked against the source text, ignoring markdown markers and line wraps.
- **Unsure:** every `CONFLICT?` row and any note saying "Unsure" is my judgment call, not a finding of fact.

## 3. Top conflicts, ranked

Following one book would violate the other. Ranked by how direct the clash is and how often it bites. On the terms of the #2323 header the master governs, so the 1.x side is the one out of line until the operator decides otherwise. Rank 1 needs a fix inside 2.0 as well.

| Rank | Conflict | Where | What breaks | Note |
|---|---|---|---|---|
| 1 | Who may block without the mind | #4, #89 vs R4, R86 | 1.x: stop only. R86: secrets and money only. R4: secrets, spend, stop, governed state. A credential guard breaks 1.x; a stop floor breaks the letter of R86. | R86 needs repair inside 2.0 first. Runtime safety authority, so ranked top. |
| 2 | When an audit is finished | #66, #72 vs R65 | Stopping at accepted residue breaks #66. Forcing a zero-new round or a two-round floor breaks "no fixed minimum round count". write-audit-convergence.mjs enforces the 1.x side. | #2305 landed the same day as #2323 and kept the 1.x bar on purpose. |
| 3 | Whether work needs a parent standard | #50 vs R49 | Halting ordinary work breaks R49 and R116; shipping it breaks #50. precommit requires parent-principle on specs. | Touches every spec. |
| 4 | How far structure goes | #1 vs R1 | Removing guards can fail the 1.x coverage ratchet; R1 says that is not a failure. Adding a check for every behaviour fails R116. | Standards Enforcement Coverage in CI enforces the 1.x side. |
| 5 | Ownership vs grant | #18 vs R18, R104, sign-off rule | Asking before using a granted account of the person follows #18 and breaks "No ability inside a granted role prompts". | Affects daily operator asks. |
| 6 | Holding a message when origin fails | #93 vs R95, R77 | Hold follows #93 and breaks "reachability to the user fails open". #93 claims precedence only inside 1.x, and the header says an amendment may not override the master. #2682 widened this to Slack and app today. | Newest and growing. |
| 7 | Red tests and flakes | #37 vs R37 | A push blocked on a flake follows #37 and breaks "the work it interrupted proceeds". | Pre-push hook enforces the 1.x side. |
| 8 | Losing a peer | #32 vs purpose single-machine rule | Refusing after peer loss follows 2.0 and may break "operate AS IS". 2.0 also says any one-available-machine reading that cannot function is wrong, so it may be internal. Unsure. | High blast radius, low certainty. |
| 9 | Status and progress messages | #55, #90 vs R92, R87 | Hourly check-ins follow R92 and break #55 unless they count as requested. | Unsure on direct-reply reading. |
| 10 | Deleting on lawful request | #7 vs R7 | Erasure follows #7 and breaks R7 as written. Part 14 suggests the intent is shared. Unsure. | Likely a wording fix. |
| 11 | A refusal with no 2.0 source | #70 vs purpose limit rule, R103 | The absolute TCC refusal is a "defect" by the purpose until 2.0 adopts it. | Easy fix: propose amendment. |
| 12 | Approval and merge | #49, #2 vs R82 | The #49 approved-spec path and "operator spot-check" against "they never merge". #2 also says canonical evolutions are never auto-merged. Unsure how far R82 reaches there. | — |

Lower-confidence conflicts are marked `CONFLICT?` in the map: #22/R22, #34/R34, #42/R41, #54/R53, #64/R63, #73/R70. One conflict sits outside any rule row: the rule-book preamble says "judge moments live only when the moment is irreversible" and the purpose repeats it as a Value, while 1.x says "OUTBOUND leak-gates fail CLOSED" and relies on live MessagingToneGate rules (B16, B18). Unsure how binding the preamble is.

Ranks 1 to 7 are direct text clashes. Ranks 8 to 12 depend on a reading, so treat the order there as rough.

**One-sided additions** (not conflicts) are every `1x-extra`, `2.0-extra`, `both-extra` and `minor` row below, the three 1.x-only articles, and the 2.0-only tables.

## 4. Changes since 2026-10-23

| Change | What changed | Reflected in the other book? |
|---|---|---|
| 1.x #2682 (merged 2026-11-04 02:32 UTC) | #93 origin duty widened from Telegram to every platform; Slack hold added with a live exception; WhatsApp and iMessage named as a gap (ACT-023) | **No.** R89 is nearest and does not require machine, harness and model records. The attributable reply facts of part 8 may overlap; I did not read them in detail, but the instar-2 adapter note says no 1.x origin record carries forward as signed evidence. It also widens conflict 6. |
| 1.x #2380 (a): single-provider floor | Sub-clause in #30 mirroring R118, 2026-12-21 countdown | **Yes, with drift.** Same obligation. The check differs: per provider and every feature, against per harness and live proofs. |
| 1.x #2380 (b): deferral-to-the-cadence well | New named well in #16 | **No.** R16 holds no list. A related "delay pitfall" is in an instar-2 harvest note only, and it means stopping to ask, which is a different failure. |
| 1.x #2194: TCC folders | New article #70, absolute refusal | **No.** Zero TCC hits in instar-2 docs and generated files. Not on the registry's amendment list either. |
| 1.x #2305: fractal 80/20 | Added to #72 practice text, with proportion and triage | **Partly.** Fractal 80/20 is in R65. Proportion is loosely in R48. Triage is absent. 1.x keeps audits at zero-new while R65 applies 80/20 to audits, so they differ on the core case (conflict 2). |
| 2.0 #182: Rule 118 | New rule, one provider is enough | **Yes.** Mirrored by #2380 in #30, not as its own article. |
| 1.x #2708 and 2.0 #189: One Constitution, and the last rung | New article #94 and R119; #75 and R72 name default-on as the last rung | **Yes, as a pair.** R72 and #75 share the last rung and still differ, as row 75 says. |
| 1.x #2734 and 2.0 #190: The Person Decides; the Agent Does the Rest | New article #95, a tree node under *Agent Proposes, Operator Approves*, and R120 | **Yes, as a pair.** Same obligation and the same two owed checks. 1.x keeps *Sovereignty*'s "if it's the human's, ask", which is conflict 5 and unchanged here. |
| 1.x #2812 and 2.0 #191: Attributed Statements Trace to Their Source | New article #96, a tree node under *Truthful Provenance — Speak Only as Yourself*, and R121 | **Yes, as a pair.** Same approved wording in both books. Neither is enforced yet. R89 and article 92 keep their own difference, unchanged here. |
| 1.x #2812 and 2.0 #192: No Feature May Require a Purchased Service | New article #97, a tree node under *Framework-Agnostic — and Framework-Optimizing*, and R122 | **Yes, as a pair.** Same approved wording in both books. Neither is enforced yet. Row 30 and R118 keep their own difference, unchanged here. |
| 1.x #3046 and 2.0 #200: An Instar Agent Always Serves a Team | New article #98, a tree node under *An Instar Agent Is Always a Multi-Machine Entity*, and R123 | **Yes, as a pair.** Same approved wording in both books, except one sentence: 2.0 says it extends #31 and #113, and 1.x names the same thing in its own terms, *An Instar Agent Is Always a Multi-Machine Entity* and its cross-machine posture declaration. Neither is enforced yet. The pull request numbers are added here when the pull requests are opened. |

Also #2323 itself (2026-10-23) is the header naming 2.0 as master. No purpose-doc commits since 2026-10-16, checked on the API with a query that does return older commits.

## 5. Map: every 1.x Rule-bearing article

`#` is the article's order in the file. R numbers are 2.0 rule rows.

| # | 1.x article | 2.0 | Status | Class | Difference | Evidence |
|---|---|---|---|---|---|---|
| 1 | Structure beats Willpower | 1 | differs | CONFLICT | 1.x demands architecture for anything that matters and ratchets guard counts upward; 2.0 limits structure to named floors and says reducing machinery is not a failure. | 1.x: "If a behavior matters, enforce it in architecture, not in instructions."; "the build fails when aggregate or per-family named-guard coverage falls below its committed floor"<br>2.0: "Use judgment for contextual choices within them."; "reducing machinery or machine-enforced rule counts is not itself a failure" |
| 2 | Self-Hosting | 2 (115 adjacent) | differs | 1x-extra | 2.0 keeps the ship-to-users duty but drops the discipline-travels and gated-canonical-loop duties. | 1.x: "the engineering conscience we hold ourselves to must travel with those tools"<br>2.0: "must also ship to users as a capability" |
| 3 | The Body and the Mind | 3 | aligned | — | — | — |
| 4 | Structure Decides Alone Only on an Exact Match | 4 | differs | CONFLICT | 1.x allows exactly one no-model decision (exact stop); 2.0 allows secret, spend, stop and governed-state enforcement. | 1.x: "There is exactly one exception, and this article is its whole extent"; "An exception that is not on the enumerated list does not exist."<br>2.0: "the three irreversible-miss cases — a live secret leaving, spend past a cap, and the operator's emergency stop — and deterministic enforcement of recorded governed state" |
| 5 | Documentation IS Being | 5 | aligned | — | — | — |
| 6 | Deferral = Deletion | 6 | aligned | — | — | — |
| 7 | Archiving May Never Mean Deleting | 7 | differs | CONFLICT? | 1.x permits deletion on operator request or lawful erasure and scopes the rule to memory; R7 states no exception. 2.0 part 14 mentions lawful capture removal, so the gap may be wording only. Unsure. | 1.x: "one the operator explicitly requests, and one a lawful erasure obligation requires"<br>2.0: "may never delete what the agent knows" |
| 8 | Close the Loop | 8 | aligned | — | — | — |
| 9 | Observation Needs Structure | 9 | aligned | — | — | — |
| 10 | Intelligence Infers, Keywords Only Guard | 10 | aligned | — | — | — |
| 11 | Recall Over Our Own Material Is by Meaning, Not by Word-Match | 11 | differs | 1x-extra | Reporting label and no-misadvertising duty are 1.x only. | 1.x: "a negative must be reported as no-literal-match"<br>2.0: "A keyword miss is not evidence something isn't there." |
| 12 | Intelligent Prompts — An LLM Gate Must Not String-Match | 12 | aligned | — | — | — |
| 13 | Quantitative Claims Must Bind a Subject | 13 | aligned | — | — | — |
| 14 | The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery | 14 (95) | differs | 1x-extra | Recoverability and the self-evidencing breaker for decision gates are 1.x only. | 1.x: "a self-evidencing circuit-breaker auto-recovers when the operator keeps messaging"<br>2.0: "When unsure, deliver." |
| 15 | The Agent Is Always Reachable — A Guaranteed Reachability Floor | 15 | differs | 1x-extra | Resource-denial notice and never-dark heartbeat are 1.x only. | 1.x: "emits ONE clear, plain-English user notice"<br>2.0: "At least one live session must always exist that resource limits can never deny" |
| 16 | Name the Gravity Wells | 16 | differs | minor | Same duty, but only 1.x holds an actual list; R16 lists none, and #2380 added a well there only. | 1.x: "deferral-to-the-cadence"<br>2.0: "The list's existence is checkable." |
| 17 | Architectural Agency in the Gap | 17 | aligned | — | — | — |
| 18 | Sovereignty — "I own what is mine" | 18 (104, purpose role + sign-off rules) | differs | CONFLICT | Different test: 1.x asks "is this mine, else ask"; 2.0 asks "is it inside a grant, else refuse", and granted accounts of the person need no asking. | 1.x: "If yes, act; if it's the human's, ask."<br>2.0: "including through the accounts granted with it, without asking again"; "Outside every grant it refuses and names the grant needed" |
| 19 | The Right to Stand Ground | 19 | aligned | — | — | — |
| 20 | A Wall Is a Hypothesis | 20 (99 extends) | aligned | — | — | — |
| 21 | Never a False Blocker | 21 | differs | minor | 1.x has a closed list that an escalation must cite (adds CAPTCHA, grant-only accounts, value judgments); 2.0 gives three examples. Unsure whether 2.0 meant them as closed. | 1.x: "the closed set an escalation must name an item from"<br>2.0: "a password only they know, a payment, a physical action" |
| 22 | The Stop Reason Is the Work | 22 (102 partial) | differs | CONFLICT? | 1.x forbids the stop (derive, proceed, flag); the R22 check accepts filing the item and exiting. R97 points the other way, so 2.0 may not mean it. Unsure. | 1.x: "write it down, proceed under it, and flag it for ratification"<br>2.0: "must file it as a work item before it exits" |
| 23 | Self-Unblock Before Escalating | 23 (purpose: not knowing) | differs | 2.0-extra | "Find out and cite the source" is 2.0 only; the named three-rung ladder is 1.x only. | 1.x: "nothing (resolve it yourself) → an approval (a yes/no tap) → an operator-only credential"<br>2.0: "the agent finds out before answering and cites the source" |
| 24 | Distrust Temporary Success — A Recurrence Is a Root Cause | 24 | aligned | — | — | — |
| 25 | Remove What Demands Attention. Do Not Supply More Attention. | 25 | aligned | — | — | — |
| 26 | Verify the State, Not Its Symbol | 26 | differs | 1x-extra | The 2026-08-06 duty on a check's account of itself is 1.x only. | 1.x: "(a) the condition it evaluates and (b) the claim its result will be read as certifying"<br>2.0: "A detector must confirm the real state of the world" |
| 27 | A Dispatch Supplies the Question and Withholds the Answer | 27 | differs | 1x-extra | Extension to reports (measurement vs hypothesis) is 1.x only; R108 is adjacent, not the same. | 1.x: "The same rule binds a report"<br>2.0: "give the question and never the answer you expect" |
| 28 | Know Your Principal — An Unverified Identity Is a Guess | 28 | aligned | — | — | — |
| 29 | Session Input Is a Principal | 29 | aligned | — | — | — |
| 30 | Framework-Agnostic — and Framework-Optimizing | 30, 118 | differs | 1x-extra | Subscription-fallback floor and raw-API ban are 1.x only. The mirrored floor differs in its check: per provider, every feature (1.x) vs per harness, live proofs (2.0). | 1.x: "Raw API is forbidden as a routine path."; "one per supported provider, that starts an agent with only that provider and exercises every feature"<br>2.0: "A single-provider boot test for each supported harness" |
| 31 | Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions | 31 | aligned | — | — | — |
| 32 | An Instar Agent Is Always a Multi-Machine Entity | 32, 113 partial, purpose single-machine rules | differs | CONFLICT? | 1.x: any machine operates as is when peers vanish. 2.0: an enrolled install keeps its replication demand after peer loss, so such operations refuse. Could be read as compatible if 1.x covers information only and not effects. Unsure. | 1.x: "An agent must be able to operate AS IS on ANY SINGLE machine it is installed on."<br>2.0: "Losing an enrolled peer never lowers that demand automatically."; "automatic fallback after a peer is lost refuses" |
| 33 | Cross-Store Coherence Is an Invariant | 33 | aligned | — | — | — |
| 34 | Testing Integrity | 34 | differs | CONFLICT? | 1.x says "significant" is undefined and adds wiring, semantic and Test-as-Self tiers; 2.0 glossary defines it and exempts reversible work from integration and E2E tests. | 1.x: "so "significant" is still decided by the author"; "plus wiring-integrity tests for every injected dependency"<br>2.0: "Those get unit tests and a review; they do not pay for integration and live end-to-end proof." |
| 35 | Test Identity Never Enters Production State | 35 | differs | 1x-extra | Tracked teardown obligation and throwaway-home duty are 1.x only. | 1.x: "opens a tracked teardown obligation at write time"<br>2.0: "must never be written into a real store" |
| 36 | Scrape/Parser Fixture Realness — feed the parser the REAL bytes | 36 | aligned | — | — | — |
| 37 | Zero-Failure | 37 | differs | CONFLICT | 1.x deliberately refuses a gate-scoped reading and blocks the push on red; 2.0 scopes to main and merge, permits branch red, and lets interrupted work proceed past a quarantined flake. | 1.x: "A weaker wording ("green at every gate") would restore exactly the loophole"; "do not push or release the change without a verified green suite"<br>2.0: "red-then-green on a branch is fine"; "quarantined and a defect is filed, and the work it interrupted proceeds" |
| 38 | LLM-Supervised Execution | 38 | differs | minor | 1.x says critical is author-decided; 2.0 glossary defines it. | 1.x: "a pipeline is critical when its author says so"<br>2.0: "The glossary defines critical for verification." |
| 39 | Observability — you can't tune what you can't see | 39 | aligned | — | Outcome/baseline, repeated evaluation, visual history, material components and accountable review sharpened together in topic 139374; universal enforcement remains an implementation obligation. | — |
| 40 | Expected Capacity Enforcement Is an Outcome, Not a Degradation | 40 | aligned | — | — | — |
| 41 | Never Silently Cut the Data a Decision Depends On | NONE | 1.x-only | — | Proposed amendment, pending 1.x ratification. Nearest 2.0 is purpose Rule 2, which does not carry the derive/disclose/refuse duties. | — |
| 42 | Observable Intelligence — No Autonomous LLM Action Is Unauditable | 41, 58 | differs | CONFLICT? | 1.x records metadata and is still pending ratification; the rule book calls full input/output an open decision while part 7 already requires it. Unsure which is current in 2.0. | 1.x: "the component, the resolved provider + model, the outcome"<br>2.0: "yes, the doorway keeps the full input and output by default"; "full input means the actual submitted input" |
| 43 | A Refusal Stays a Refusal — conservation of negative outcomes | 42 | differs | 1x-extra | Ack vocabulary, deciding-machine trace and loud-to-operator are 1.x only. | 1.x: "a refusal that affects the verified operator is ALWAYS loud"<br>2.0: "No layer may turn it into "ok."" |
| 44 | Runtime End-to-End Proof — the canary standard | 43 | aligned | — | — | — |
| 45 | Migration Parity | 44 | aligned | — | — | — |
| 46 | Migration-Consumer Completeness | 45 | aligned | — | — | — |
| 47 | Canonical Pipeline Operational Completeness — Accepted Intake Must Drain | 46 | differs | 1x-extra | Durable owner, fenced lease and no-default-human-approver are 1.x only. | 1.x: "A pipeline that makes a human its default approver is operationally incomplete"<br>2.0: "Anything the system accepts into a queue must eventually be processed." |
| 48 | Compaction Parity | 47 (110 extends) | aligned | — | — | — |
| 49 | Tiered Development | 48, 82 | differs | CONFLICT? | 1.x routes large work through an approved spec and an operator spot-check; 2.0 leaves converged drafts with no operator question to the agent. Unsure who "approved" means. | 1.x: "the full converged-and-approved-spec path"; "clean Tier-1 on green CI + operator spot-check"<br>2.0: "A draft whose questions-for-the-operator list is empty, and whose review desk has converged, is the agent's to merge." |
| 50 | Constitutional Traceability — No Unconstitutional Work | 49, 116 rationale | differs | CONFLICT | 1.x halts work with no named parent standard; 2.0 says ordinary work needs no parent and names that requirement as a cause of bloat. | 1.x: "If no current standard covers the work, the work halts"<br>2.0: "Ordinary engineering defaults belong to the agent; they do not require a new constitutional parent."; "requiring a constitutional parent for ordinary work reinforced that accumulation" |
| 51 | Friction Is a Spec — Productize the Workaround | 50 | aligned | — | — | — |
| 52 | Notice + Solve Inefficiencies — Efficiency Is a Standing Search | 51 | aligned | — | — | — |
| 53 | Bounded Notification Surface — no feature may flood the user | 52 | aligned | — | — | — |
| 54 | Notices Route to the Alerts Topic, Never a New One | 53 | differs | CONFLICT? | 1.x retains a dated legacy per-item carve-out; R53 has none and its lint would refuse it. Small in practice. | 1.x: "with one enumerated, deprecated exception: the attentionRouting.mode: 'per-item' legacy mode"<br>2.0: "Never a new conversation per event." |
| 55 | Conservative Outbound: Act, Don't Notify | 54 (92, 87) | differs | CONFLICT | 1.x treats status and progress as not a ping; R92 requires an hourly check-in and R87 allows progress lines. | 1.x: "status, progress, "I noticed X", housekeeping, self-health, "I'm about to", "I finished""<br>2.0: "Every autonomous session has a check-in cadence — one hour by default" |
| 56 | No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes | 55 | aligned | — | — | — |
| 57 | Keep the Doorway/Model Map Current | 56 | aligned | — | — | — |
| 58 | Judgment Within Floors | 57 (67) | differs | 1x-extra | Shadow-before-acting and mechanical corroboration are 1.x only. Also unsure: the deterministic last rung may read against the R67 check. | 1.x: "only after shadow-phase evidence shows it beats the deterministic default"; "always ends at a deterministic rung"<br>2.0: "It can narrow the options, never widen them."; "it swaps provider or it fails" |
| 59 | Decision Provenance & Outcome Review | 58 | aligned | — | — | — |
| 60 | Stall Coverage Is Enumerated, Not Discovered | 59 | aligned | — | — | — |
| 61 | Bounded Blast Radius | 60 | aligned | — | — | — |
| 62 | Capacity Safety — No Unbounded Self-Action | 61 | aligned | — | — | — |
| 63 | Live-User-Channel Proof Before Done | 62 (purpose Rules 3, 6) | differs | both-extra | Telegram AND Slack plus risk categories are 1.x only; real-conversation judgment against the purpose is 2.0 only. | 1.x: "Telegram AND Slack for a channel feature"<br>2.0: "a recorded real conversation judged against the purpose's mission, agency and self-knowledge statements" |
| 64 | Ownership-Gated Side Effects | 63 | differs | CONFLICT? | On an ownership-resolution error 1.x acts loudly; R63 says only the owner may act and states no error case. Unsure whether R95 resolves it. | 1.x: "ownership-resolution error fails toward action loudly and boundedly"<br>2.0: "Any other machine forwards or queues; it never acts locally." |
| 65 | Autonomous Throughput Floor | 64 | differs | 1x-extra | The legitimate-HOLD test is 1.x only. | 1.x: "A legitimate HOLD still requires both an actual open approval-gate record"<br>2.0: "A stalled autonomous run is visible without anyone watching for it." |
| 66 | Iterative Audit to Convergence | 65 | differs | CONFLICT | 1.x requires a zero-new final round, and its stamp script enforces at least two rounds. 2.0 ends at reviewer-accepted residue with no round floor, even while findings keep appearing. | 1.x: "until a clean pass returns zero new discoveries"; "refuses the stamp unless ≥2 rounds ended with a zeroed"<br>2.0: "does not by itself keep the review open"; "no fixed minimum round count applies" |
| 67 | A Decision That Can Block Must Live Where the Checks Can See It | 66 | aligned | — | — | — |
| 68 | No Silent Degradation to Brittle Fallback | 67 | aligned | — | — | — |
| 69 | An Autonomous Run Must Outlive Its Session | 68 | aligned | — | — | — |
| 70 | Avoid TCC-Protected Directories — No Agent State Under ~/Documents on macOS | NONE | 1.x-only | — | No TCC or ~/Documents text in instar-2 docs or generated files. Not listed as a proposed amendment, so the registry header is stale. Its refusal has no 2.0 source, which the purpose calls a defect. | — |
| 71 | References Run From Both Ends — the Registry Names the Code, the Code Names the Standard | 69 | aligned | — | — | — |
| 72 | Occam's Razor — Simplest Robust Route | 116 (65) | differs | 1x-extra | Rule text aligned. #2305 practice text adds proportion and on-the-spot triage (1.x only) and exempts audits from 80/20, which R65 does not. | 1.x: "A problem found during work is triaged on the spot"; "Audit-shaped sweeps keep the zero-new bar"<br>2.0: "Choose the simplest route that delivers the required behavior" |
| 73 | Bug-Fix Evidence Bar (verify before you claim) | 70 | differs | CONFLICT? | 1.x always requires reproduction and rejects unit tests; 2.0 sets evidence by bug class. Could conflict for a class whose bar is a test. Unsure. | 1.x: "the original failure has been reproduced and verified to stop. Unit tests are not evidence."<br>2.0: "A fix carries evidence of the kind its class of bug requires" |
| 74 | No Deferrals | 71 | aligned | — | — | — |
| 75 | Maturation Path — Test Agent → Development Agent → Fleet | 72 | differs | 1x-extra | Shared since #2708 and instar-2 #189: the three-rung ladder, default-on for the fleet as the last rung, and thresholds that raise and never flip. 1.x alone has the feature ladder and the build failure on a switched-off flag with no entry (2.0's equivalent needs building), two independent readings before the review opens a fleet-default change, the reviewer-independence terms, the ban on per-agent allowlists, and clause (h) from #2872 (each rung names an owner and a review-due date, and the carriers that re-surface a stalled rung are proven awake by a positive control before the clock starts; both halves are named as unenforced: the dated-owner half under the clause (c)/(d) countdown, the proven-awake half under its own, both dated 2026-12-21). 1.x states the *User-Facing Fixes Ship Live* exit in this article; 2.0 holds its exemption in R76, not in R72's sentence. | R72: "1.x holds the thresholds in its feature ladder and fails the build on a switched-off flag with no entry; 2.0's equivalent needs building." |
| 76 | A Dark Feature Guards Nothing | 73 | differs | 1x-extra | Incident-forced decision, recorded acceptance and mandatory postmortem question are 1.x only. | 1.x: "every postmortem must answer, as a mandatory section"<br>2.0: "It must have a date to graduate or be called what it is." |
| 77 | Side-Effects Review Gate | 74 | aligned | — | — | — |
| 78 | Token-Audit Completeness — An Unmetered LLM Call Is an Unaccountable One | 75 | aligned | — | — | — |
| 79 | User-Facing Fixes Ship Live | 76 | differs | minor | The doubt-sends-it-to-the-ladder rule is 1.x only; 2.0 relies on the glossary class. | 1.x: "should treat that doubt as sufficient reason to require the ladder"<br>2.0: "Use the glossary's user-facing classification" |
| 80 | The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred | 77 | aligned | — | — | — |
| 81 | No Manual Work (user *or* agent) | 78 | aligned | — | — | — |
| 82 | Mobile-Complete Operator Actions | 79 | aligned | — | — | — |
| 83 | Operator-Surface Quality | 80 | aligned | — | — | — |
| 84 | Dashboard UX Standard — Reachable, Self-Explanatory, Responsive | 81 | aligned | — | — | — |
| 85 | Agent Proposes, Operator Approves | 82 | differs | both-extra | Server-authored display integrity is 1.x only; never-merge and approval-outlives-proof are 2.0 only. | 1.x: "must be authored by the server from the structured request"<br>2.0: "and they never merge"; "An approval wait never outlives the proof it approves" |
| 86 | The Agent Carries the Loop | 83 | aligned | — | — | — |
| 87 | Agent Awareness | 84 (purpose: every agent has these) | differs | 2.0-extra | Identity and self-knowledge by default is 2.0 only. | 1.x: "Every feature must be written into the agent's briefing/template."<br>2.0: "Identity, self-knowledge, reflection and growth are present by default" |
| 88 | Never-Waste Feedback — corrections compound | 85 | aligned | — | — | — |
| 89 | Signal vs. Authority | 86 | differs | CONFLICT | The exception sets do not overlap: 1.x has stop only, R86 has secrets and money only. R86 also omits the stop that R4 keeps, so 2.0 disagrees with itself. | 1.x: "ONE NAMED EXCEPTION, and it is the whole extent of it"<br>2.0: "with exactly two ruled exceptions — secrets and money" |
| 90 | Near-Silent Notifications | 87 | differs | CONFLICT? | 2.0 explicitly admits progress lines during a reply; 1.x suppresses progress narration and preserves only direct replies. Unsure if a progress line counts as a direct reply. | 1.x: "narration (status/progress/"still on it"/"noticed") is suppressed by default"<br>2.0: "a short progress line at a slow, bounded pace is also part of the answer" |
| 91 | Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails | 88 | aligned | — | — | — |
| 92 | Truthful Provenance — Speak Only as Yourself | 89 | differs | 2.0-extra | 1.x governs messages delivered into an agent; 2.0 covers every message and requires automatic signing. | 1.x: "Every message delivered into an agent carries an identity"<br>2.0: "Outbound messages carry signed provenance." |
| 93 | Telegram Message Origin Is Mandatory; Its Display Is Optional | NONE | 1.x-only | — | Proposed amendment. Nearest is R89 and part 8 attributable reply facts. Widened to every platform by #2682. See conflict 6. | — |
| 94 | One Constitution, Two Books Aligned | 119 | aligned | — | — | — |
| 95 | The Person Decides; the Agent Does the Rest | 120 | aligned | — | — | — |
| 96 | Attributed Statements Trace to Their Source | 121 | aligned | — | — | — |
| 97 | No Feature May Require a Purchased Service | 122 | aligned | — | — | — |
| 98 | An Instar Agent Always Serves a Team | 123 | aligned | — | — | — |

## 6. 2.0 rule rows with no 1.x article

Closest neighbours are named where they exist. R102 is not listed because #22 partly covers it. R116 and R118 have 1.x counterparts (#72 and #30).

| R | Rule | Status | Note |
|---|---|---|---|
| 90 | History Is a Lookup | 2.0-only | Partial 1.x prose only ("How a new standard joins"), not an article. |
| 91 | A Document Reads as Its First Version | 2.0-only | The registry body is full of dated revision notes. Whether R91 reaches it depends on whether it is "governed". Unsure. |
| 92 | An Autonomous Session Reports on a Cadence | 2.0-only | Pulls against #55 and #90 (conflict 9). |
| 93 | A Directive Holds Until Superseded or Done | 2.0-only | — |
| 94 | A Waiver Comes Before the Act — and Feeds the Rule | 2.0-only | — |
| 95 | Fail Direction Is Declared Per Consumer | 2.0-only | Boundary call. 1.x has the seven-group "failure-direction defaults" section with no Rule line. Same idea, finer grain; origin hold is the live disagreement. |
| 96 | A Session Grounds in Its Full History | 2.0-only | — |
| 97 | Work Stops on Its Exit Test, Never the Clock | 2.0-only | #22 is adjacent only. |
| 98 | Silence Is Never the Operator's Consent | 2.0-only | — |
| 99 | A Settled Wall Carries a Recheck Date | 2.0-only | Extends #20; no recheck date in 1.x. |
| 100 | A Secret Is Stored Before It Is Spent | 2.0-only | Secret Drop appears in 1.x as an example, not an obligation. |
| 101 | Hooks Are Never Skipped Silently | 2.0-only | No --no-verify text in the registry. |
| 103 | Boundaries Come From Governance, Not Self-Declaration | 2.0-only | Would apply to 1.x-only refusals such as #70. |
| 104 | Every Authorization Is a Candidate Standing Grant | 2.0-only | Pulls against #18 (conflict 5). |
| 105 | Channel Parity | 2.0-only | #63 touches Telegram AND Slack only; no register. |
| 106 | A Link Handed to a Human Works | 2.0-only | No localhost or link rule in the registry. |
| 107 | Each Gate Has Its Own Bar | 2.0-only | — |
| 108 | A Conclusion and Its Reason Are Separately Falsifiable | 2.0-only | #27 is adjacent only. |
| 109 | A Document Under Review Is Frozen | 2.0-only | — |
| 110 | A Compaction Is Disclosed, Not Papered Over | 2.0-only | Extends #48. |
| 111 | A Review Audits the Layer Below | 2.0-only | — |
| 112 | Green History Is Preserved | 2.0-only | — |
| 113 | Every Change Declares Its Multi-Machine Posture | 2.0-only | #32 covers state posture only, not every change. |
| 114 | Agency Composes Recursively | 2.0-only | — |
| 115 | The System Has a Native Harness | 2.0-only | Boundary call. #30 names self-sufficiency as an aim; no shipped-harness duty. |
| 117 | One Agent, Many Sessions | 2.0-only | #33 and #64 are adjacent only; nothing on concurrent sessions. |

## 7. Purpose rules

| Purpose rule | Status | Note |
|---|---|---|
| a limit names the rule that requires it | 2.0-only | Same as R103. Makes #70 a formal defect. |
| every agent has these by default | 2.0-only | #87 is capability awareness only. Possible tension between "without naming the harness or model" and #93 default-on footer. Unsure; one is self-description, the other a record. |
| a design question this document cannot decide is a gap | partial: #22, #50 | Same instinct, different outlet: amendment rather than "derive and proceed". Unsure. |
| the agent never administers its own safeguards | 2.0-only | #85 display integrity is adjacent. |
| least revelation | 2.0-only | May constrain #93 visible machine/model fields in groups. Unsure. |
| a role is granted once, at onboarding | 2.0-only | Pulls against #18. |
| an irreversible act follows its durable cause | 2.0-only | — |
| a single-machine installation must be fully functional | partial: #32 Amendment 1 | 1.x speaks of information, 2.0 of function. |
| a single-machine installation is a supported deployment shape | 2.0-only | Replication-demand clause is the conflict 8 text. |
| ordinary bounded operations retain their whole cause at least locally | 2.0-only | — |
| automatic suggestions never widen themselves | 2.0-only | — |
| sign-off is kept for a short, fixed list | 2.0-only | Pulls against #18. Different question from #21 (blockers, not effects). |
| Rule 1: no rule ships without the check that holds it | 2.0-only | 1.x "Judgment-bound" and "UNENFORCED SUB-OBLIGATION" labels address this differently. |
| Rule 2: nothing that mattered is silently lost | partial: #7, #8, #41 | No detector-per-state duty in 1.x. |
| Rule 3: no claim of done without evidence | partial: #63, #73 | "A person used it" is 2.0 only. |
| Rule 4: a document may not assert what it cannot keep current | 2.0-only | — |
| Rule 6: the agent is accepted by being used | 2.0-only | Pulls against the #1 guard-coverage ratchet as a measure. |
| not knowing is a task | 2.0-only | Also in R23. |
| the boundary is checkable | 2.0-only | — |

## 8. Other drift worth a ledger line

- "The default on the residual is to ESCALATE to the operator, never to silently guess." (1.x residual section) against "never a stop-and-ask" (R102). Escalating need not mean stopping, so this may be compatible. Unsure.
- Master status: the purpose still says "Status: draft, awaiting approval.", yet the registry header says its Rules govern. Its newest changelog entry (revision 15) is also marked draft, "merge pending", although the commit is merged. Possibly just a stale label. Needs an operator-side answer before the ledger treats it as settled.
- The registry header lists two proposed amendments; #70 is a third with no 2.0 counterpart.
- #41 and #42 are the two articles marked pending operator ratification, so advisory in 1.x. R41 has no such status. The header names only #41.
- instar-2 `docs/16-conversation-adapters/10-...md` line 23 says no origin implementation was found in its 1.x snapshot. `src/messaging/telegram-origin` exists at i1 HEAD, so that 2.0 note is out of date.
- The rule book has stale text: "One open decision" (R41) and "What I want from you", although part 7 already decides R41.
