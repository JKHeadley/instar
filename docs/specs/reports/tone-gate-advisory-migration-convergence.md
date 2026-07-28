# Convergence Report — Tone-Gate Advisory Migration

## Cross-model review: codex-cli:gpt-5.5

RAN. A real GPT-tier external pass ran through the agent's codex CLI on **both**
rounds (round 1 verdict: SERIOUS ISSUES; round 2 verdict: MINOR ISSUES). The
spec's reviewable body changed between rounds, so round 2 was a genuine
re-review rather than a delta-skip.

## ELI10 Overview

Every message I write to you passes an AI check before it sends. Today that check
is a wall: if it objects, the message dies and I rewrite it. Separately we built a
system to record those decisions so we could later judge whether the check was any
good — and in seven days it recorded 1,440 decisions and produced **zero**
verdicts.

That turned out not to be a bug. It's arithmetic. If the check overrules me and I
have no say, nothing observable happens next — there's no moment where I agree or
disagree, so there's nothing for a judge to grade. The window for evidence closes
empty every single time, forever.

This change makes most of those checks into nudges I can overrule with a written
reason. That does two things at once: it puts the final call on my own prose back
with me (which is what you asked for after a check blocked a directory path), and
it creates the disagreement signal the grading loop was missing. One thing stays
an absolute wall — a live credential — and it moved to a plain pattern check that
keeps working even when the AI check is down, which is stronger than the
incidental protection it replaced.

## Original vs Converged

The review changed this design substantially. The honest summary is that the first
draft would have shipped several real defects.

**The wall would have blocked ordinary English.** I claimed the credential wall
only matched vendor-issued key shapes. It didn't — the pattern list I imported
also matched the *word* "password" or "token" near any longish word. Reviewers ran
the actual regexes: *"Disable password authentication in the sshd config"* and
*"Authorization: Bearer YOUR_DASHBOARD_TOKEN_HERE"* would have been unsendable by
any route, with no override, fixable only by a code deploy. And the same pattern
**missed** a real `password: hunter2`, because the value was too short. It blocked
English and passed the credential. Now: only vendor-prefixed value shapes, with
every one of those sentences pinned as a permanent test.

**The evidence would have been absent in the exact configuration meant for
rollout.** The recorder sits behind a *different* switch than the nudge behaviour,
and that switch defaults to recording nothing. Turning the migration on fleet-wide
would have delivered every loosening and captured no data — the whole point,
silently missing. Now the gate refuses to loosen itself when it can't record why:
no evidence capability, no nudge, and it says so instead of quietly reverting.

**I had widened your approval past what you actually said.** You approved making
*representation* checks advisory — the directory-path complaint. I had also
migrated the guards that stop me quitting mid-work or handing you my own tasks.
Those are a different animal: I'm the party being constrained, and my reason for
overriding would come from the same reasoning the guard distrusts. Those now stay
hard walls, and the question is yours rather than assumed.

**The feature was dead on arrival on the path you actually use.** My reply script
couldn't express an override and printed "BLOCKED" for a nudge — so the whole
thing would have been correct in the API and invisible in practice.

**A relayed conversation would have been stuck permanently.** When a conversation
runs on the other machine, the nudge came back as a generic network error with the
override fields stripped — so the message could never be sent and I'd never know
why.

**Round 2 caught me documenting a bias instead of fixing it.** Disagreement was
enforced; agreement was opt-in and depended on my memory. That guarantees the data
makes the checks look worse than they are. The server now correlates it itself.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec/code changes |
|---|---|---|---|
| 1 | security, adversarial, lessons-aware, integration, decision-completeness, scalability, Standards-Conformance Gate, codex-cli:gpt-5.5 (SERIOUS ISSUES) | 24 | Credential wall narrowed to provider-prefixed shapes + FP corpus ratchet; B15–B19 exempted; evidence-capturability invariant; `decisionRef` validation; always-on override audit; strong scrub on the evidence note; annotation deferred off the send path; oversize refusal; reply-script flags + branching 422 renderer + SHA registration; relay field forwarding + typed refusal; channel parity helper + ratchet; `selfReportShare`/`selfReportOnly`; dev-gated registry entry; live-read rollback; §3.2 false claim withdrawn; Decision-points / Multi-machine / Open-questions / Maturation sections added |
| 2 | Standards-Conformance Gate (2), codex-cli:gpt-5.5 (MINOR ISSUES) | 3 | Server-side compliance correlation built (removing the opt-in asymmetry rather than disclosing it); thesis sharpened to "no REACTION evidence"; graduation criterion changed to evidence-source-alive rather than a measured quality rate |
| — | Standards-Conformance Gate | — | Gate limitation adjudicated, NOT a spec change — see below |

**Standards-Conformance Gate: ran both rounds** (round 1: 1 finding + a parent
resolution failure; round 2: 2 findings + the same parent failure).

## Adjudicated and rejected (with reasoning)

**1. Signal-vs-Authority flag on the credential wall (round 1) — REJECTED.**
The gate flagged the deterministic wall as "a low-context filter acting as a hard
gate". `docs/signal-vs-authority.md` §"When this principle does NOT apply" carves
this out by name: *"Safety guards on irreversible actions … can and should be
hard-blocked by brittle pattern matchers, because the cost of a false pass is
catastrophic and the cost of a false block is merely 'try again with the right
arguments.'"* Both halves hold, and **Judgment Within Floors** is the correct
registry parent. Adjudicating it is what surfaced the far worse findings about the
wall's actual pattern set — the flag was wrong on the merits and productive anyway.

**2. "No dry-run stage" (round 1) — the argument SURVIVES, the gap it hid did
not.** A dry-run tier for a feature whose change is that the gate takes *less*
action would mean "log that we would have nudged, then hard-block anyway" — which
reproduces the zero-evidence state the migration exists to fix. But the Maturation
Path standard requires an agent-class ladder with a declared graduation criterion,
and that was genuinely missing. Added.

**3. Parent principle "does not resolve" (both rounds) — a GATE DEFECT, not a
spec defect.** The gate reports the named parent unresolvable. Verified directly:
the canonical registry parses to **80** articles and contains `Judgment Within
Floors` exactly; the running server loads the agent-home copy, which holds **22**.
The gate has been evaluating every spec against roughly a quarter of the
constitution while reporting confident per-standard results — the
"a dark feature guards nothing" class. Raised separately on the attention queue
(`ATT-conformance-partial-constitution`) rather than resolved by renaming the
spec's parent to something the partial registry happens to contain, which would
have hidden the defect and mislabelled the spec.

## Full Findings Catalog

### Round 1 — material

| # | Reviewer | Finding | Resolution |
|---|---|---|---|
| 1 | security, adversarial, lessons-aware, decision-completeness | `labeled-secret` / `bearer-token` hard-wall ordinary prose; `labeled-secret` also MISSES a real short password | Restricted `HARD_WALL_CREDENTIAL_KINDS` to provider-prefixed value shapes; `HARD_WALL_EXCLUDED_KINDS` documents each exclusion; FP corpus pinned in Tier 1 |
| 2 | security, integration, lessons-aware | Evidence write is a no-op when the quality seam is dark/dry-run (dryRun defaults TRUE) — fleet flip = pure weakening | Evidence-capturability invariant: advisory requires `decisionRef` + `decisionQualityRecordingLive()`, else block, tagged `advisoryUnavailable` |
| 3 | adversarial, decision-completeness | B15–B19 migrated on an inference from a leak-class approval | Exempted; rationale + the future `stop_reason_kind` shape recorded |
| 4 | adversarial, integration | `telegram-reply.sh` cannot express an override; prints "BLOCKED" for a nudge; `Issue: unknown` for the credential wall | Four flags added; 422 renderer branches by class; prior SHA registered in `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` |
| 5 | adversarial, integration | Relay strips the reaction fields and collapses the holder's 422 → relayed topic permanently unsendable | Fields forwarded through `kindMetadata`; typed `RelayRefusedError` re-emits the holder's body |
| 6 | security, adversarial | `decisionRef` caller-supplied and unvalidated → grades writable against other decision points | Shape-checked before reaching the annotate chokepoint |
| 7 | security | Evidence note scrubbed with a weaker pattern set than the wall (misses a 20-char AWS key) | `scrubForStore` applied at the seam before the clamp |
| 8 | security, integration | Override logged byte-identically to the verdict it overrode; the claimed "acked-advisory audit" never existed | `advisory` / `advisoryOverridden` / `advisoryUnrecordable` / scrubbed reason head added to the always-on log line |
| 9 | scalability | Annotation is a synchronous rollup recompute in the send path (~3 ms now, ~190 ms at 120k rows) | Deferred via `setImmediate` |
| 10 | integration | 4 of 7 outbound callsites lacked the reaction metadata, incl. the mandated post-update route | Shared `toneAdvisoryMetadata()` helper + a source-level parity ratchet |
| 11 | adversarial, lessons-aware | Flat `gradeDistribution` blends self-report with proof-grade evidence | `selfReportShare` + `selfReportOnly` markers |
| 12 | lessons-aware, security | "Credential protection is strictly stronger" is false | Claim withdrawn; honest trade stated (stronger for enumerated shapes, weaker for the rest) |
| 13 | integration | Rollback documented as no-restart but read a boot snapshot | Construction site layers the LIVE `toneGate` block; rollback is genuinely live |
| 14 | integration | Not registered in `DEV_GATED_FEATURES` | Registered with justification |
| 15 | lessons-aware | CLAUDE.md template asserts both "blocks" and "nudges" about the same gate | Preceding paragraph amended in template AND migrator |
| 16 | integration, decision-completeness | Missing `## Decision points touched` (tag writer refuses), `## Open questions`, `## Multi-machine posture` | All three added |
| 17 | lessons-aware | Missing `## Maturation plan` | Added with graduation criterion + dark window |
| 18 | decision-completeness, scalability | No input bound on the guard; two routes uncapped | `MAX_SCAN_BYTES` with a REFUSE disposition (opposite fail-direction from a detector fault, deliberately) |
| 19 | integration, decision-completeness | E2E asserted `rejected === undefined`, which is also true in dry-run | Strengthened to `applied === true` + a live-recording assertion |

### Round 1 — accepted as residual risk (stated, not fixed)

- **Credential shapes outside the enumerated list are weaker than before**, because the incidental LLM catch became overridable. Named explicitly in §3.2 rather than glossed.
- **The reason field is not itself credential-scanned** by the wall; `scrubForStore` at the write is the mitigation.
- **Injection-induced override** — untrusted quoted content could instruct an override. Named; the override rate is countable, which is the detection surface.
- **A split credential across two messages** defeats the wall. Pre-existing, not introduced.

### Round 2

| # | Source | Finding | Resolution |
|---|---|---|---|
| 20 | Conformance Gate ("No Manual Work"), codex | Compliance depends on the agent remembering an opt-in field while override is enforced → biased sample | **Built** server-side compliance correlation (topic + fingerprint + bounded window); no agent metadata required |
| 21 | Conformance Gate ("No Deferrals") | The structural fix was registered for later while the biased path shipped | Same fix — the deferral is gone because the work is done |
| 22 | codex | Graduation still rested on a self-report ratio | Criterion changed to evidence-source-ALIVE (both paths observed firing), explicitly not a measured quality rate |
| 23 | codex | "A hard block produces no evidence" overstated | Sharpened to "no REACTION evidence", with the retrospective-judging alternative acknowledged |
| 24 | codex | Lease churn between verdict and ack | The nonresolvable ref simply does not grade (safe direction) and is counted as an orphan — stated |

## Convergence verdict

**Converged at iteration 2.** Round 2 produced three findings, all resolved
in-round (two by building the compliance correlation, one by correcting a
graduation criterion) plus two adjudications. The remaining conformance-gate
signal is a defect in the gate's own registry loading, evidenced and raised
separately rather than absorbed into this spec.

Honest scope note: convergence here means the review round produced no *unresolved*
material finding, not that the design is beyond criticism. The residual risks above
are real and named; the self-report evidence class is deliberately weak and marked
as such; and the fleet flip is gated behind a declared criterion rather than this
report.
