---
title: "Four independent memory stores accumulate observations and never synthesise them, so each one degrades into noise while every individual entry stays correct"
date: 2026-07-31
author: echo
machine: Mac Mini
severity: high
status: open
kind: finding
relates:
  - "docs/findings/2026-07-30-correction-loop-cannot-promote.md"
  - "docs/findings/2026-07-30-promise-beacon-notifies-per-element.md"
  - "docs/decisions/2026-07-30-correction-loop-promotion-design.md"
  - "docs/STANDARDS-REGISTRY.md"
---

## The claim

Four unrelated subsystems — built at different times, by different hands, for different purposes —
share one structural defect: **they append observations without bound and never collapse them.** Each
was designed with a write path and a read path and no synthesis path.

The failure is hard to see because **every individual entry in every one of these stores is correct.**
Nothing is wrong per row. What degrades is the *signal*, and it degrades in proportion to how well the
store is doing its job. A store like this is at its least useful exactly when it has collected the most.

## Evidence — measured 2026-07-31, all four live

| store | what it accumulates | synthesis pass | measured state |
|---|---|---|---|
| `selfKnowledge.operationalFacts` | facts recorded by any session | **none** | **6 of 41 facts were one fact**, recorded 6 times over 3 weeks |
| `correction-ledger.db` | operator corrections | gate exists, never fires | **37 records in 28 days → 0 preferences.** The output file has never been created |
| PromiseBeacon | one message per open commitment | **none** | **105 messages from 11 commitments** in one topic in one day |
| Evolution action queue | filed follow-ups | **none** | **1,637 filed → 52 completed (3.2%); 992 still pending** |

### The operational-facts case, in full, because I caused it tonight

At 03:00 I needed the server auth token. I read it from `config.json`, got a 401, diagnosed it, and
**recorded a new operational fact** describing the remedy.

That fact was already in the store. Five times:

| # | recorded | text |
|---|---|---|
| 9 | 2026-07-24 | "The authToken in config.json is STALE — sessions must use the INSTAR_AUTH_TOKEN env var" |
| 11 | 2026-07-24 | "config.json authToken/dashboardPin/messaging tokens are vault-pointers {secret:true}" |
| 27 | 2026-07-29 | "API token is NOT in config.json … Use `secret-get.mjs authToken`" |
| 29 | 2026-07-29 | "authToken in config.json is a {secret:true} sentinel, not a value" |
| 30 | 2026-07-29 | "Server auth token: get it with `secret-get.mjs authToken`. It is NOT in config.json" |
| 40 | 2026-07-31 | *(mine, tonight — the sixth)* |

**All six are injected into my context at every session start.** I read past them and re-derived the
fact from a 401. That is not a memory that failed to store; it is a memory that stored six times and
communicated zero times.

Two mechanisms turn correct entries into noise here:

1. **Dilution.** Six near-identical entries in a 41-item list consume 15% of a block a reader skims. The
   more times a lesson is re-learned, the more of the list it occupies, and the *less* likely any single
   copy is to be read.
2. **Remedy divergence.** Three entries say "use the vault"; two say "use the env var"; one says the
   config value is "STALE" (it is not — it is a sentinel, by design). A reader gets three different
   answers and no signal about which is current. I verified tonight that the vault and the env var
   **return the identical value** and both authenticate — so no entry was wrong, and the *set* was still
   unusable.

### The correction ledger is the same defect one level up

The correction ledger exists to notice that the operator has corrected me the same way twice. It has 37
corrections and has promoted nothing, because it groups by exact-hash over LLM-authored sentences that
never repeat verbatim (`2026-07-30-correction-loop-cannot-promote.md`).

So: **the system built to stop me re-learning things cannot itself tell that two records are the same
record** — which is precisely the operation the operational-facts store also lacks. Two stores, one
missing capability.

## The blind-spot class

> **An append-only store that is read as a whole must synthesise, or it converts its own success into
> noise. Because every entry stays individually correct, no per-entry check — no test, no lint, no
> review — can detect the degradation. The only signal is an aggregate one, and none of these four
> stores computes one.**

This is why all four survived review. Each write is valid. Each read returns what was written. Every
test passes. The defect exists only at the level of the *collection*, and nothing was looking there.

It also explains the shape of the operator's complaint on 2026-07-27:

> *"each time you re-discover it like its the first time… We need infrastructure that actually allows
> you to learn and remember these mistakes in an intelligent way. Maybe something that allows each
> mistake to go into a list … along with regular reviews of the list that detects classes of mistakes
> and synthesises them into more potent and compact list items or list hierarchies so that the list can
> scale appropriately."*

He described the missing layer exactly, and named its purpose: **so the list can scale.** The lists have
scaled; the synthesis has not been built; and the four stores above are what that looks like in
production.

## What closes it

**A proposed standard — "An Accumulating Store Must Synthesise."** Any store that (a) grows from
repeated observations and (b) is read as a whole owes three things:

1. **A synthesis pass** that collapses near-duplicates into fewer, stronger entries. Near-duplicate
   detection must be semantic, not exact-match — the exact-match assumption is the specific bug in two
   of the four stores.
2. **A published aggregate health metric** — duplication rate, or promoted-vs-recorded ratio, or
   closed-vs-filed ratio. Entry count is not a health metric; all four stores look healthy by entry
   count and are unhealthy by every ratio above.
3. **A write path that consults before appending.** Recording a near-duplicate should merge and
   strengthen the existing entry rather than append a rival to it.

Requirement 3 is the load-bearing one. Without it, any one-off cleanup re-grows: I collapsed the
operational-facts family tonight (41 → 37, six entries → two), and nothing currently prevents a seventh
copy being written tomorrow by a session that hit a 401.

## Honest limits

- The four stores are measured; the *causal* claim that dilution is why I skipped the facts block is my
  own account of one incident and is not independently verified.
- The 0.30-token-overlap threshold used to find near-duplicates is a detection aid for this finding, not
  a proposed production constant. The correction-loop design doc argues that a similarity floor must be
  re-measured per corpus and recorded; the same caution applies here.
- Requirement 3 has a real risk that requirements 1 and 2 do not: a wrong merge at write time destroys a
  distinct fact. `[3]` in the facts store mentions `authToken` and matched my duplicate filter, but is
  actually about laptop SSH access — a naive merge would have eaten it. Merging must be conservative and
  reversible, and a synthesis pass that *proposes* merges is safer than one that performs them.
