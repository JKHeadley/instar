# Convergence Report — Context Budget: Layered Summaries

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in **every one
of the six rounds** (status `ok` each time, model `gpt-6-astra`). This is the
clean RAN state.

`clean-door-anthropic-review: claude-code:claude-fable-5-2` — a Claude Fable
5.2 read also ran every round through the `claude -p` door, by hand (the
clean-door reviewer's config pin for `claude-fable-5-2` landed as PR #3007
during the review). It is a same-family second read and is recorded as such,
never as a cross-model opinion. The operator asked for Fable 5.2 in design and
review; it also produced the pre-review design pass (spec Appendix A).

Internal reviewers (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) ran every round as subagents of the
authoring session, which runs on Fable 5.1 (`claude-fable-5-1`); no tier
escalation was in effect, so the per-round internal model was Fable 5.1
throughout.

## ELI10 Overview

Every long conversation an Instar agent runs keeps its whole history in
working memory until it is nearly a million tokens, then the engine squeezes
it with a generic summary. Until then each turn re-reads almost everything,
and when the squeeze comes it does not know which of the operator's words
matter; the step meant to restore our own briefing afterwards has never run.

This spec gives each topic a set of always-maintained layers (an anchor of the
topic's purpose in the operator's own words with its deliberate changes; three
summaries at three distances; a ledger of decisions as the operator's own
message rows; short summaries of finished stretches; the operator's messages
kept whole; and a searchable archive underneath), folds the agent's own bulk at
milestones in the work rather than at a meter, protects the operator's text
over the agent's, verifies after each fold that the session kept what mattered
(not merely that it can recite what it was just handed), and can undo a fold
from a byte-exact checkpoint. A sentinel watches that the session does the work
it owes and takes a short, bounded list of actions when it does not. It is a
general Instar feature, engine-agnostic, with Claude Code first and Codex built
in the same phase.

The main tradeoffs: a fold costs real tokens (a handoff turn, a packet write,
a quiz), so it only runs when the estimate says it will pay back; containment
during a fold briefly holds the topic's inbound and outbound messages; and the
engines differ in what they expose, so some capabilities degrade to named
lesser paths and are recorded as such.

## Original vs Converged

Originally (v1, 14:11 PST) the design was a fixed 200K working budget, a
shrink at 80% of it using our summaries, and a two-line readback afterwards.

After the operator's requirements (v2) the fixed budget became a judgment:
folds happen at milestones, size only changes how eagerly the system asks;
three summary horizons are maintained all the time; the topic's purpose is an
anchor kept verbatim with attributed evolutions; the operator's text is folded
last and quoted, never paraphrased.

After the Fable 5.2 design pass (v3) the session itself writes the handoff at
a clean stop, the fold became a transaction with rollback, folded tool output
got an archive so it can still be looked up, and the readback became a probe
of things the folded span contained.

After six review rounds (v4 to v9) the largest changes were: several existing
components the design planned to reuse turned out, when the reviewers read the
code, not to behave as assumed (the stand-down mute is Telegram-only and dark;
the lease store holds one lease; the durable inbound queue ships dark; the
replicated journal has finite per-kind retention; the Codex compaction
lifecycle synthesizes its pre-compaction event and has no post-compaction
producer), so the design now names what it will build in each place. The fold
got one coordinator with compare-and-swap transitions, owner-only actions, a
durable record that owns every carrier, a quarantine with verified
termination, and a lossless engine checkpoint separate from the scrubbed
archive. A bound operator quote became evidence rather than a decision; the
probe tests behaviour and delivery separately; every fail-closed rule is scoped
to the sessions and topics with an open fold; the canary detects compactions
through a channel independent of the hooks it checks and judges health over an
epoch that restarts after a fix; the compaction-recovery bug fix ships live
under the User-Facing Fixes Ship Live standard. The operator's three notes
(engine-agnostic, general feature, a sentinel beside the session) were folded in
at round 3 and reviewed in rounds 4 to 6.

## Iteration Summary

| Iteration | Spec | Reviewers who flagged (internal; external) | Design findings | Left behind | Spec changes |
|---|---|---|---|---|---|
| 1 | v3 → v4 | all six; GPT 5, Fable 10 | ~70 | ~25 precision | fold ladder, staged store writes, affirmatively live clean stop, row-bound ledger, PostCompact chunking, brakes, store path and posture, required sections (12, 13, 15, 16, 17, 18) |
| 2 | v4 → v5 | all six; GPT 4, Fable 5 | ~40 | ~20 precision | fold hold on the outbound funnel, keyed fenced lease, live inbound queue precondition, durable fold record and boot sweep, immutable checkpoint, decision transition, standing packet, warm-cache handoff, shadow answerer, canary positive control, Maturation plan, Defaults table |
| 3 | v5 → v6 | all six (five "minor"); GPT 4, Fable 5; operator notes | ~30 + 3 operator items | ~15 precision | prepared state, quarantine, scoped fail-closed, derived-settled, canary states on detections, 9.1 live, U row carrier, sibling archive root; harness-adapter contract, general-feature principle, `ContextBudgetSentinel` |
| 4 | v6 → v7 | all six (five "minor"); GPT 4, Fable 5 | ~30 | ~15 precision | `FoldCoordinator` with CAS, owner-only actions, quarantine owner and exit, engine checkpoint, chunked ledger bodies, `SelfHealGate` declarations, independent detection channel, honest Codex column, verification suite |
| 5 | v7 → v8 | all six (five "minor", one "blocking, narrowly"); GPT 3, Fable 4 | ~25 | ~20 precision | single-machine owner gate, channel-neutral row source, record-driven lifetimes, one detection rule, deterministic epoch, coordinator handover, per-machine bound, fourth gate extension, cache-blind estimator, checkpoint as carrier |
| 6 (cap) | v8 → v9 | GPT 3, Fable 2; internal verdicts below | 5 external (folded after the cap) | Fable's 11-item residue list, folded | probe reads restricted to packet and lookups, canary verification epoch, verified termination before release, `shadow-probing` state, estimator costs at the uncached rate |

Standards-Conformance Gate: ran every round against the full text (97
standards). Round 1: 2 flags (Judgment Within Floors on the pending-evolution
expiry; Never Silently Cut on the Anchor cap), both adopted. Round 2: 1 flag
(the review-plan round cap), answered in section 19. Round 3: 1 flag
(User-Facing Fixes Ship Live on the 9.1 fix), adopted. Round 4: 1 flag (the
round cap, Judgment Within Floors), answered. Rounds 5 and 6: no flags.

Externals were run on every round because the spec's reviewable body changed
every round (body hashes: round 1 `1721cdfe…`, round 2 `1797f9e9…`, round 3
`568765fe…`, round 4 `83dce951…`, round 5 `0d88061b…`, round 6 `18f44174…`); no
round was delta-skipped. The detection record for the mandatory-check was
written at round 1 (`codex-cli` available, `gemini-cli` not installed,
`grok-build` not enabled).

Round-6 internal reviewer verdicts: security **converged** (2 narrow residues);
scalability **converged** (1 low residue); adversarial **converged** (1
one-sentence residue); integration **converged** (3 small residues);
decision-completeness **converged** (1 small residue; tag-writer preflight
refuses nothing; counts frontloaded 17 + 38 Defaults rows, cheap-tags 0,
contested-then-cleared 38 of 38, open user decisions 0); lessons-aware
**converged** (2 residues; no material fixed-limit rows remain; no round 7
requested). All eleven internal residues were folded into v9 after the cap and
are listed in spec Appendix G with the five external items.

## Proportion

Tier 2 (a feature with new routes, stores, hooks, a transaction and a sentinel;
irreversible consequences for user context). Six rounds used of a six-round
cap, on a spec that grew from 279 lines (v1) to about 2,300 lines (v9). The
effort is large and in proportion to a change that touches how every topic
session carries context on every engine and every machine; the operator was
told at each stage. ⚠ The round-6 external findings were folded in after the
cap without a further round, by the skill's own stopping rule; they are listed
below and in spec Appendix G so the approver can weigh them.

## Left behind

Precision items not iterated on, by theme (the per-round lists are in the
reviewer reports and spec Appendices B to G):

- Response shapes of the five new routes are additive-only after Phase 1; exact
  shapes are a build decision.
- Standard B field values for the breaker beyond those declared (dedupe key
  granularity, exact audit file names).
- The sampler's priority order within the "error or file path" class is stated;
  tie-breaking inside a class is a build decision.
- `lessons-engaged` completeness beyond the principles and memories now listed.
- Several naming notes (which module injects `hasLiveToolShell`, two summary
  routes with similar names, the backup manager's glob rules).
- Age stamps on every rendered layer line are specified; their exact format is
  not.
- The minimum sample size for the success test is 40 folds; the statistical
  confidence at that size is not claimed.
- Glossary and version-reference residue was cleaned each round; a final
  read-through for stale cross-references is a build-time task.

Round-6 findings fixed after the cap and **not re-reviewed** (none is a
safety, security or data-loss item left open; each is a tightening of an
already-specified mechanism), external first: probe turns may not read files (the checkpoint
and archive are on disk); the canary's health epoch restarts after a
remediation; quarantine releases containment only after verified termination;
a shadow fold runs its probe under a non-terminal `shadow-probing` child state;
the cache-blind estimator prices costs at the uncached rate; and Fable 5.2's
eleven wording-residue items. Internal: the owner test defaults to the host
when the session pool is dark; the backup entry uses the WAL glob; the unused
hold bypass is removed; the inject-store fallback gates on the
not-actively-working predicate; the shadow answerer's token gets a synthetic
place and `omitAuthEnv`; the candidate's session id is coordinator-supplied;
the episode store is a per-key ring in the sentinel's own file; per-incident
keys everywhere; the synthetic press joins the action list and canary scope;
the channel-neutral row writer gets a cross-machine key rule; a second fold at
the point of no return is declined as `machine-busy`.

Accepted as follow-on specs rather than left open: generalising the
actor-plus-sentinel pattern to other agent responsibilities (after Phase 3
numbers); the user-words digest (measured now, built when a topic needs it).

## Full Findings Catalog

Every finding, with its reviewer, class and resolution, is catalogued in the
spec itself: Appendix A (the Fable 5.2 design pass), Appendix B (round 1),
Appendix C (round 2), Appendix D (round 3 and the operator's notes), Appendix
E (round 4), Appendix F (round 5), Appendix G (round 6). The verbatim reviewer
reports for every round are retained in the authoring session's scratch
directory and summarized in the per-round rows above; the Fable 5.2 design pass
is retained verbatim at
`docs/specs/reports/context-budget-layered-summaries-fable52-design-pass.md`.
Nothing raised in any round was rejected; two items were adopted in a narrower
form (the critical cap remains as a bounded checkpoint request; `/compact`
remains as the unplanned backstop).

## Convergence verdict

Converged at round 6, the Tier-2 cap, by the fractal 80/20 rule: rounds 4, 5
and 6 each confirmed the previous round's resolutions as genuine, five of six
internal reviewers reported "minor issues" from round 3 onward, and the
round-6 findings were paragraph-sized tightenings of already-specified
mechanisms with no safety, security or data-loss item left open. Those
round-6 items were folded into v9 after the cap and are marked as not
re-reviewed. Open questions: zero (every former question is a frontloaded
decision the operator can override at approval). The spec is ready for the
operator's review and approval.
