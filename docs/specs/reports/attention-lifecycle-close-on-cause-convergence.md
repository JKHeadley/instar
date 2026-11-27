# Convergence Report — Attention Lifecycle: items close when their cause clears

## Cross-model review: codex-cli:gpt-6-astra + gemini-cli:gemini-4-argon

RAN — one round, two external families in parallel through the agent's own CLIs: GPT-6 Astra (codex `exec`, reads the worktree, report `attention-lifecycle-close-on-cause-review-r1-astra.md`) and Gemini 4 Argon (gemini CLI, source bundle on stdin, report `attention-lifecycle-close-on-cause-review-r1-argon.md`). Verdicts: Argon "ready with changes" (8 findings), Astra "not ready" (8 findings). The two sets overlapped on six points. Every finding is answered in the spec's "Review changes" table: accepted, narrowed, or declined with the reason. Convergence was called at one round under the 80/20 convergence standard: the remaining open positions (allowlist-only expiry; deferring commitment expiry) are recorded operator-direction decisions, not unresolved design defects, and a second round would re-argue them rather than change the build.

## ELI10 Overview

The agent keeps a list of things that need its person. On Justin's agent that list had over a thousand open entries across four machines and he ignored all of them, because almost none still needed him. Nothing ever closed an entry, the same problem got a fresh entry every time it was noticed, and nothing aged out. This spec puts three rules into the list itself: one entry per problem, entries close when the source can see the problem is over, and automated notices nobody touched for two weeks are closed with a label that says "expired" rather than "done". Security items and anything the person has acknowledged are never touched. Promises waiting on the person for two weeks close as unanswered.

## Original vs Converged

**Originally** the draft keyed conditions by blanking every "volatile-looking" token in an id (including UUIDs and hex), treated any TERMINAL sign-in episode as "cleared", treated "no due held forwards" as "all held replies delivered", bumped-and-returned repeats without refreshing a changed ask, applied age-only expiry (no dedupe or verification of the existing pile), gated stale-owner escalation to the lease holder, and included a dark re-ask engine for commitments.

**The review found** that UUIDs can identify separate losses (two lost replies to one topic would merge); that `failed`/`refused` are TERMINAL too, so the draft would have closed exactly the rows the operator must see; that the held-reply query returns only rows due now (backoff looks like delivery); that "bump and return" swallows approve→phone-tap; that `:ep-1` prefixes `:ep-10`; that the sweep would not reconcile last week's duplicates or crash-orphaned condition records; that `source` is not a field (HTTP maps it to `sourceContext`) and `autoExpiry.dryRun` defaults true; that lease-gating would silence every witness when the holder is dark; and that re-ask was scope without a user.

**Converged:** one admission helper shared by every writer (refresh on change, reopen as a new episode, WONT_DO held by condition); no UUID/hex blanking, dotted attempt suffixes and epoch-seconds added, titles keep digits; verified-only clears for sign-in and held replies (new all-rows store query); delimiter-bounded prefixes and the store passing its base key; a three-step idempotent reconciliation pass (supersede → verified clears → expiry) whose first run per machine lists expiry as a dry run; ACK/IN_PROGRESS and active-condition rows never expire, security matched on title too, sticky refused in every automatic close path; the classifier reuses `admitItemToHub`; the operator-wait branch has its own `dryRun:false` and runs before the agent rule; re-ask, the predicate clear and lease gating cut. Declined: an allowlist-only expiry (it would leave the ~62-producer long tail the operator complained about) and deferring commitment expiry (item 3 of the brief).

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|---|---|---|---|
| 1 | GPT-6 Astra (codex), Gemini 4 Argon (gemini) | 16 raised, 10 distinct | §3.1 one writer helper + conservative derived key; §3.2 delimiter-bounded prefix + base-key callback + sticky refusal; §3.3 verified-only clears, lease gating cut; §3.4 reconciliation pass + first-pass dry run + never-expire floors; §3.5 own dryRun, judged first, re-ask cut; §3.7 config moved beside its siblings |
