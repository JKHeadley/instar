# Convergence Report — Feedback triage account-aware quota admission

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra reviewed the evolving draft four times and the final classified body once. Its final pass found no DESIGN-class issues. Gemini was not authenticated, and Claude review was unavailable under the operator's Fable stop; the six internal perspectives in the final rounds were supplied by independent Codex reviewers. This is design review, not implementation or live acceptance.

## ELI10 Overview

The feedback sorter currently asks the Codex account it happens to be using whether it has capacity. That account reached 78% of its weekly allowance, over the existing 75% pause line, while four other enrolled Codex accounts had much more room. The sorter stopped even though local capacity existed. The proposed change would check each available account's live allowance and give the sorter an account that is still below the same 75% limit.

The account choice would be tied to the actual model call. If the account, credential, machine owner, approved model, or quota reading cannot be verified, the sorter pauses and keeps the feedback for later. It would not silently switch to a different provider or model. We would turn on account selection in stages and measure actual decisions and merged fixes before calling the queue sustainable.

## Original vs Converged

The first draft described selecting an account from pool readings and passing its credential home to the model. Review showed that this was insufficient: an old reading could look fresh when reread, a different authentication source could fund the model call, and a router retry could spend on an unverified account or model. The converged contract requires a live, same-subscription reading, an exact Astra route in the router and provider, and a scrubbed effective authentication source in every mode, including rollback.

Review also tightened the work around the call: bounded two-account waves let a later healthy account be reached, the owner and authority check is transactional with the call reservation, cancellation has a launch barrier, and one reservation token covers the daily and retriage counters. The local credential evidence is kept off the replication path; a small allowlisted lifecycle audit can reconstruct a handoff. The design explicitly admits that a credential or owner may change after a child starts, and records that residual instead of claiming an atomic distributed spend lock.

## Iteration Summary

The four earlier Astra passes were preflight reviews that shaped the draft; the six formal convergence rounds below used all six internal perspectives. The last two formal rounds had zero DESIGN-class findings. `Standards-Conformance Gate` checked 93 registry articles and found zero flags in each formal round; the round 2 body was unchanged, so its external pass was delta-skipped with reviewable-body hash `6cf8dfbac93acd47a66c3dd9c4e73e618bd100ef074e9b9c4440a68fbc3875d8`.

| Formal round | Internal lenses | DESIGN findings | External GPT-6 Astra | Standards-Conformance Gate | Change |
|---|---|---:|---|---|---|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons-aware | 0 | ran; 0 blockers | ran, 0 flags | preflight repairs reviewed |
| 2 | same six | 0 | delta-skipped; body unchanged from round 1 | ran, 0 flags | none |
| 3 | same six | 0 | ran; 0 blockers on hash `542fa23c318d38f97c0e1c205b74fddee10a0b83738e494445359538108677bd` | ran, 0 flags | explicit decision-point classifications; no behavior change |
| 4 | same six | 0 | ran; 0 blockers on hash `1f1abc45760e27c69a3c821852e6331b13ad618a9a28f15e96a026b919fce989` | ran, 0 flags | structural `*(none)*` open-questions marker; no behavior change |
| 5 | same six | 0 | ran; 0 blockers on hash `7df026353e92983a63999054ebbe5a4357549f4eff781f1cf9d70a5f7b9d3635` | ran, 0 flags | moved execution addendum outside classified decision-point section; no behavior change |
| 6 | same six | 0 | ran; 0 blockers on hash `7802ca52396e0802e5f80a203c6955c8a0410685ba7a4fe8448aee3c088196a7` | ran, 0 flags | bolded five maturation labels to satisfy structural parser; no behavior change |

The round 3 classification edit was required by the convergence tag writer's structural decision-point check. The independent decision-completeness review contested each label in both directions and found the spend, owner and provider constraints invariant, with feedback disposition reserved for bounded model judgment. The round 4 marker replaced prose that the tag writer interpreted as an open question, though that prose stated there was none. Round 5 moved the normative execution addendum out of the classification section so the structural checker sees only the four actual decision points. These edits introduced no new design behavior. The final round still has zero open user design decisions. Spec approval itself remains the separate implementation gate.

## Full Findings Catalog

The preflight findings were resolved in the current spec; the original review artifacts were saved as `/tmp/feedback-triage-spec-astra-review*.md` during this run. The following catalog records the substance and disposition without treating a resolved finding as a current implementation pass.

| Preflight pass / perspective | Severity | Finding | Resolution in the converged spec |
|---|---|---|---|
| 1 / Astra, authority | DESIGN | Checking the `codex` quota family could still permit an unauthorized Sol model. | Pin exact `codex-cli` / `gpt-6-astra` before spend, including provider-internal fallback, retry and canary. |
| 1 / Astra, evidence | DESIGN | Old quota snapshots could acquire a new timestamp and appear fresh. | Remove cached admission and carry acquisition plus underlying observation freshness to the launch barrier. |
| 1 / Astra, ownership | DESIGN | A separate owner precheck could race the daily reservation. | Check owner, epoch, authority and cap in the reservation transaction; conditionally release an unstarted attempt. |
| 1 / Astra, credentials | DESIGN | A credential home string did not bind the credential consumed by the child. | Verify identity/version before and after read and immediately before launch; use scrubbed matching authentication environments and record the post-launch residual. |
| 1 / Astra, replication | DESIGN | Replicating a full attempt would leak local credential identity and path. | Keep the full attempt local and replicate only an explicit opaque audit projection. |
| 1 / Astra, maturation | DESIGN | “No owner-handoff spend” conflicted with an already-started call finishing after transfer. | Distinguish a prohibited stale-owner start from an acknowledged in-flight completion. |
| 2 / Astra, selection | DESIGN | Slow first-wave readers could starve a later healthy account. | Bound each two-account wave to five seconds and the whole selection to 30 seconds; cancel and reap children. |
| 2 / Astra, cancellation | DESIGN | Tick cancellation could occur between selection and launch. | Check cancellation before reservation and at launch; release unstarted reservations and audit launched calls. |
| 2 / Astra, ledger | DESIGN | An owner change could block cleanup, or an imprecise cleanup could refund a launched call. | Use an opaque reservation token with an atomic `reserved → launched` transition and idempotent release across handoff. |
| 2 / Astra, audit | DESIGN | The replicated audit could not prove launch ordering across an owner handoff. | Record correlated reservation, launch, release and completion events with owner epoch and authority generation. |
| 2 / Astra, freshness | DESIGN | A newly acquired live response could contain an old underlying observation. | Require and recheck observation time, or a provider guarantee of measurement during the read. |
| 3 / Astra, authentication | P1 DESIGN | `off` and `observe` could use favorable cached quota while the model used an API key. | Apply same-subscription live evidence and scrubbed auth-source binding to every mode. |
| 3 / Astra, parsing | P1 DESIGN | A malformed exhausted secondary window could be dropped as though absent. | Distinguish absent from malformed before normalization; reject the entire reading and test the mixed-window case. |
| 3 / Astra, counters | P2 DESIGN | Releasing an unstarted retry could refund the daily slot but leave its retriage subcap spent. | Bind both debits and their original UTC accounting day to one transactional token and refund. |
| Internal adversarial / integration | DESIGN | A router sibling-account retry could bypass the selected account's quota gate. | Prohibit unverified sibling and cross-framework tails for the primary triage authority. |
| Internal decision-completeness | PRECISION | Decision points lacked explicit structural `invariant` / `judgment-candidate` labels. | Classify all four points and state the bounded disposition floor. Final six-lens and Astra re-review found no behavior change. |

The external fourth preflight pass and all six formal convergence rounds reported zero DESIGN-class findings on their reviewed bodies. No finding is being marked “fixed in code” by this report.

## Convergence verdict

Converged after six formal rounds, including consecutive zero-DESIGN rounds and final structural rechecks. There are zero unresolved user design decisions. The spec and its ELI16 overview are ready for owner review. Implementation, all three test tiers, exact-head full-suite verification, staged rollout, and live throughput evidence remain open.
