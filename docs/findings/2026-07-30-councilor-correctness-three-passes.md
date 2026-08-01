---
title: "Councilor correctness — one session, measured three ways, each pass inverting the last"
date: 2026-07-30
author: echo
machine: Mac Mini
severity: medium
status: open
kind: finding
relates:
  - "docs/findings/2026-07-30-armed-deleter-with-no-evidence-trail.md"
  - "docs/STANDARDS-REGISTRY.md"
---

# Councilor correctness — one autonomous session, measured three ways

**Why this exists.** On 2026-07-27T16:39:34Z the operator asked for two things: a
**per-councilor mistake list with periodic synthesis**, and a **councilor-review collection
mechanism**. An outside observer reviewing this topic's history flagged both on
2026-07-30T01:20Z as *"open, unscoped, and unmentioned."*

**Scope.** Every guard ("councilor") that acted during autonomous session 4
(2026-07-29 23:06Z → 2026-07-30 ~04:15Z, ~5h) on this machine.

**Method, and why it took three passes.** Pass 1 read the session's own run file. Pass 2
swept the durable JSONL logs. Pass 3 enumerated *every* `logs/*.jsonl` and `state/*.jsonl`
rather than the files I thought to name — because my pass-2 candidate list was itself a
guess, and a guessed inventory reproduces the same bias it is meant to remove.
**Pass 1 found 13 events. Pass 3 found 164.** Each pass changed the conclusion, which is
the whole argument for not stopping at one.

---

## Part 1 — the councilors I noticed (pass 1: my own notes, n=13)

| # | Councilor | What it did | Verdict |
|---|---|---|---|
| 1 | Tone gate | Blocked a security message carrying config keys + shell commands (hard block, no override) | **Correct** |
| 2 | Grounding hook | Blocked an *experiential* claim I had inferred rather than observed | **Correct** — it held when tested, but I hadn't checked when I wrote it |
| 3 | Grounding hook | Blocked a "reporting nothing found" message | **Correct** — three sources turned "can't confirm" into "it landed" |
| 4 | Rediscovery guard | Surfaced ACT-1512 before I re-investigated the decision grader | **Correct** — caught a *third* re-derivation of a finding already recorded twice |
| 5 | Observer session | Caught me re-parking the git-credential issue after recording twice that it was mine | **Correct** |
| 6 | `lint-llm-attribution` | Failed the build when I hoisted a component literal into a constant | **Correct** — the lint reads callsites statically; attribution would have gone dark |
| 7 | Second-pass reviewer (#1749) | Blocked my three-branch payload-preservation fix | **Correct** — verified in source that one branch could re-deliver to a live session |
| 8 | `write-trace.mjs` | Refused because the fresh worktree had no husky hooks | **Correct**, and the best-worded guard of the night |
| 9 | Pre-push gate | Refused a push for a missing release-note fragment | **Correct** — without it the change merges but never ships |
| 10 | instar-dev pre-commit | Flagged `belowFloor` on my Tier-1 declaration against a floor of 2 | **Correct as a signal**; I overrode with recorded reasoning |
| 11 | Spec-converge external reviewer | 10 rounds; 9 produced a real finding, 3 about claims of mine that were false | **Correct** |
| 12 | Grounding hook | Blocked a correct message on `there (is\|are) no` matching inside **"nothing"** | **FALSE POSITIVE** — fixed in PR #1752 |
| 13 | Grounding hook | Blocked my own *test harness* and a *run-file write*, because the Bash command string contained a messaging script name | **FALSE POSITIVE** — open, see below |

**Noticed tally: 11 correct, 2 false positives.**

## Part 2 — the councilors I did not notice (passes 2–3: durable logs, n=164)

| log family | events tonight | mentioned in my notes? |
|---|---|---|
| `reaper-audit.jsonl` | 76 | no |
| `outbound-advisory.jsonl` | 36 (all `clean`, 0 advisories raised) | no |
| `sentinel-events.jsonl` | 18 (rate-limit throttle → 6 backoff retries → recovery) | no |
| `routing-spend-alerts.jsonl` | 7 | no |
| `machine-coherence.jsonl` | 6 | no |
| `threadline-negotiator` (2 files) | 6 | no |
| `threadline-relay-events.jsonl` | 4 | no |
| `resume-queue.jsonl` | 3 | no |
| `time-awareness-signals.jsonl` | 3 | no |
| `mesh-selfheal.jsonl` | 2 | no |
| `reap-log.jsonl` | 2 | no |
| `playwright-profiles.jsonl` | 1 | yes (I caused it) |

*(9 further log files had zero entries tonight — the control proving the time filter
discriminates rather than matching everything.)*

The `sentinel-events` rows are worth reading directly: a rate-limit throttle was **detected**,
retried through **six backoff attempts**, and **recovered** — a resume nudge injected into this
very topic — while I was working. I never noticed, and never recorded it. A councilor
silently kept the session alive.

---

## The finding

**The two sets barely overlap, and the reason is structural.**

- The councilors I *noticed* are the ones that **blocked** me. Verified: the grounding hook
  writes no durable log at all; the rediscovery guard only *reads* (4 `readFileSync`, zero
  write calls); `convergence-check.sh` logs exactly **one** of its seven categories. So
  **11 of my 13 noticed firings left no trace on disk.**
- The councilors I *missed* are the ones that **log**. All 164 logged events came from
  sentinels, reapers and advisory layers that never interrupt an agent, so nothing brings
  them to attention.

**What blocks doesn't record. What records doesn't block.**

That is the answer to why this ask has sat open. A collection mechanism built from an
agent's recollection captures only the councilors that annoy it — a systematically
uncharitable sample, since a guard that *saves* you silently never enters the record.
A mechanism built from logs alone captures only the councilors that never needed
attention. Neither half is the thing that was asked for.

**Corrected headline.** My pass-1 draft concluded "the councilors are not blind, they fired
13 times and were right 11." Both halves of that were an artifact of the sample. The honest
version: **councilor activity is roughly an order of magnitude higher than an agent
perceives (13 noticed vs 164 logged), and the perceived sample is biased toward
interruption.** I am recording the wrong first conclusion rather than replacing it, because
the correction is the useful part.

**Also honest:** correctness was assessed for the 13 I observed. For the 164 logged events I
verified only that they *occurred*, not that each was right. Calling this a per-councilor
*correctness* record for the full population would be exactly the overclaim three separate
spec-review rounds caught me making this week.

---

## Scoping the second ask: the collection mechanism

**A home already exists.** `GET /decision-quality` is this substrate — per-decision-point
right/wrong/unknown grades joined to what decided. It is wired and the grading pass runs on
cadence and writes.

**The gap is two-layered, both code, both verified against source at 1.3.1069:**

1. **No scoring rule.** In `decisionGradingPass.ts`, `grade: 'right'` appears on exactly
   **one** line (241), inside a branch gated to a single decision point;
   `grade: 'wrong'` appears **zero** times. The four `WINDOW_UNKNOWN_RULES` points —
   including both high-volume ones (tone gate, completion-claim-verify) — can only
   terminalize as `unknown`. So `settledGrades: 0` is the instrument saying *"I cannot tell
   you,"* not failing. *(Counted with both a must-be-present and a must-be-absent control,
   after an initial miscount from broken shell quoting returned three false zeros.)*
2. **No ingress.** Only two `/decision-quality` routes exist — the read and the grade-pass —
   out of 834 route registrations. Nothing can record an externally-observed verdict.

**What this measurement adds to the design.** The mechanism must read **both** halves,
because neither alone is representative: the blocking councilors need to *start* writing a
durable record, and the logged councilors need an outcome verdict attached. The 13 rows in
Part 1 are the shape of the missing input — and they are exactly the `right` verdicts the
meter structurally cannot generate today.

**Deliberately not built here.** It is a real change to a measurement surface and deserves
its own spec, not an append at the end of a long session. What this removes is the excuse
that it was unscoped.

## Open, unfixed

Row 13 — the grounding hook matches a messaging keyword **anywhere in a Bash command**, so
writing prose that merely mentions a relay script is treated as sending a message. It fired
on ordinary tool use twice tonight. Not fixed here **on purpose**: unlike row 12, narrowing
this one risks the hook *missing a real outbound message*, which is the dangerous direction
for a safety gate. It needs a spec, not a quick patch at 04:00.
