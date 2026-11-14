---
title: "Context Budget: Layered Summaries"
slug: "context-budget-layered-summaries"
author: "echo"
created: "2026-11-09"
revised: "2026-11-09 (v9 — round 6 external findings folded in after the cap; v4 round 1, v5 round 2, v6 round 3 + operator notes, v7 round 4, v8 round 5)"
status: "draft v9 (final review round complete)"
approved: true
approved-by: "Justin, topic 141133, 2026-11-09 17:22 PST: \"Approved on the spec\""
approved-at: "2026-11-09T17:22:00-08:00"
approval-notes: "Build on Opus 5.5; frontier models (Fable 5.2) for design and review, efficient models for building."
commitment: "CMT-1536"
requested-by: "Justin, topic 130742, 2026-11-09 14:01 PST; refined in topic 141133, 2026-11-09 14:12 PST"
parent-principle: "Structure beats Willpower; Harness built-ins before our own; intelligent assessment, not hard caps"
supersedes: "compaction-resume-payload (payload shape; its preamble rules are kept), compaction-preamble-tone-and-intent (carried into the reseed packet), the TopicSummarizer rolling summary (retired into H3 through the retirement path)"
design-participants: "Echo (Fable 5.1 session), Fable 5.2 (design pass + round-1 clean-door read), GPT-6 Astra (round-1 external pass)"
review-plan: "/spec-converge, Tier 2; the skill's round cap is a cost stopping rule and a capped stop is recorded incomplete, never as convergence; Claude clean-door reviewer pinned to claude-fable-5-2 once PR #3007 ships (rounds 1 and 2 ran it by hand through the same door)"
lessons-engaged:
  - "P1 Structure > Willpower — every 'internal' or 'suppressed' property names its carrier (the fold hold on the outbound funnel, the marker-file tool policy, the lock-window skip), never agent discipline"
  - "P2 Signal vs Authority — LLM classifications (evolution cause/effect, handoff audit, probe grades) are signals; the sole write paths to the Anchor and ledger are deterministic bindings to operator-authored message rows"
  - "P3 Migration Parity — the clear matcher, PostCompact entry, PreCompact steering hook and config switches all ship through PostUpdateMigrator in the same PR as init"
  - "P4 Testing Integrity — section 18 carries all three tiers, wiring integrity and the L7 before/after evidence for the 9.1 bug fix"
  - "P7 LLM-Supervised Execution — section 15 declares a supervision tier and validator for every new LLM pipeline"
  - "P14 recurrence is a root cause — both post-compaction injectors are inventoried and reduced to one carrier"
  - "P17/P22/P23 bounded, self-heal-first notices — rollback is the self-heal; the operator hears on failed rollback or breaker trip, through the outbound gate and quiet-by-default"
  - "P19 No Unbounded Loops — every repeating LLM path (cadence, asks, audits, probes, H3 rebuild) declares brake, breaker and ceiling"
  - "P20/L5 Verify the State, Not Its Symbol — section 17 is the symbol/state/corroboration/unmeasurable table; a missing hook source is unknown, never startup; a standing canary counts compactions against recovery blocks"
  - "P21 multi-machine entity — section 14 declares a posture per surface; no undefended machine-local"
  - "P24 Never silently cut the data a decision depends on — oversize packets refuse the fold; inherited head-first truncations are replaced, not reused; bounded summaries disclose in-band"
  - "L2 context-death pitfall — the template sentence promising recovery is corrected with the fix"
  - "L7 bug-fix evidence bar — 9.1 ships with a reproduced before/after transcript"
  - "L9 ELI16 companion — docs/specs/context-budget-layered-summaries.eli16.md"
  - "P5 Agent Awareness, P9, P18 (the refusal count, lookup count and canary states are the artifacts), B22 one lifecycle owner (the fold record owns every carrier by foldId), B37 protected sessions (reap-guard veto)"
  - "User-Facing Fixes Ship Live — the 9.1 bug fix ships live to the fleet as soon as the test agent's canary is healthy; its switch exists for rollback, not for a dark window (13.11)"
  - "L16/L17 Project Scope and commitments — the five phases are one Project Scope entry with a commitment and beacon per rung (13.17, 16)"
  - "P10 Comprehensive-First — the Codex adapter is in Phase 1 scope, not a deferral <!-- tracked: CMT-1536 --> (operator note, 2026-11-09 15:59: engine-agnostic)"
  - "memory: a-dark-guard-is-worse-than-no-guard — every reused carrier was read in code; the stand-down muzzle, the single-lease store and the dark inbound queue were replaced or made preconditions (round 2)"
  - "memory: no-static-caps-on-agent-growth — every number is a floor with a named irreversible consequence or a judgment input; the two caps are named as caps"
  - "memory: prove-no-quality-loss-before-adopting — the delta-only hook and every fold are measured in shadow before they reduce what a session loads"
  - "memory: dark-by-default-needs-a-dated-owner — section 16 maps phases to maturation rungs with owner, commitment and re-arm dates"
  - "memory: compaction-recovery-never-runs — the fix is Phase 0 and the canary is permanent"
  - "memory: the-autonomous-maturation-design-already-exists — the phase ladder is the maturation ladder, not a parallel one"
  - "declined: per-topic pressure-band overrides (dropped), the user-words digest (measured, deferred <!-- tracked: CMT-1536 --> with owner), a new workflow engine for the fold transaction (reuses Durable Inbound Message Queue, PendingInjectStore, LlmQueue, SelfHealGate, the outbound funnel and the recovery veto)"
review-convergence: "2026-11-10T00:52:33.430Z"
review-iterations: 6
review-completed-at: "2026-11-10T00:52:33.430Z"
review-report: "docs/specs/reports/context-budget-layered-summaries-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 17
cheap-to-change-tags: 0
contested-then-cleared: 38
---

# Context Budget: Layered Summaries (v9)

Status: **draft v9. Six review rounds complete (the Tier-2 cap); the round-6 findings below were folded in after the cap and are so marked in the convergence report.** No code yet. Needs `/spec-converge` (with Fable
5.2 as a reviewer) and Justin's read before any build.

## Tracked carriers

> **CMT-1536** — "Spec, review, build and measure a working-context budget for long sessions that shrinks them at clean stopping points using our layered topic summaries, with history lookup and a post-shrink goal check. Work and updates in topic 141133."

Every deferral <!-- tracked: CMT-1536 --> mention in this spec is tracked under CMT-1536, the commitment
that carries the whole programme through its maturation rungs (section 16).

## 0. What changed, and why

**v1 → v2 (Justin's 14:12 message).** v1 proposed a fixed 200K working budget
with a shrink at 80% and a post-shrink readback. Justin's message, written
before he had read the v1 summary, changed the shape: milestones instead of a
meter; three summary horizons as an ongoing product of every topic; an Anchor of
the original purpose with its intentional evolutions; user content protected and
agent content folded first; Fable 5.2 in design and review.

**v2 → v3 (Fable 5.2 design pass, Appendix A).** The pass found that v2 still
had a meter in disguise (four pressure bands), that its drift check tested
recitation rather than retention, that its fold could not be done the way it
was described (Claude Code cannot remove a middle span), that it had no real
rollback, and that the detail a session most often needs after a fold (tool
output) does not live in the store the spec pointed at. v3:

1. makes the **session itself** write the handoff at a clean stop (what
   finished, what it still needs verbatim, open threads), with a small model
   auditing it against the Anchor and the ledger; this replaces a separate seam
   judge, chunk summarizer and readback (section 7);
2. replaces pressure bands with **one benefit estimate** (break-even turns,
   cache-aware), **one no-fold floor** and **one backstop**, and names the two
   caps that remain honestly (section 7.2);
3. defines a fold as a **transaction**: packet staged and verified on disk,
   session snapshot, inbound lock, rollback by resume, backoff (section 9);
4. adds a **per-topic transcript archive** so folded tool output stays
   retrievable (section 6, L0);
5. verifies retention with a **held-out probe**, not a readback (section 10);
6. gives user messages **referent stubs** and gives decisions and evolutions a
   **supersedes** link in **one ledger** (sections 6.1, 8);
7. defers the user-words digest, retires the old rolling summary into H3, makes
   the per-prompt hook emit only deltas, and adds backfill for existing topics.

**v3 → v4 (spec-converge round 1).** Six internal reviewers, a GPT-6 Astra
external pass, a Fable 5.2 clean-door read and the Standards-Conformance Gate
produced about seventy design-class findings, heavily overlapping. v4 resolves
them in one pass. The shape that changed most: the fold is now a **three-rung
ladder** (clear-and-seed; kill-and-respawn with the packet; no fold, backstop
only), because the `clear` hook matcher the v3 path relied on is installed
nowhere and `/clear` is not an injectable control command today; **store writes
are staged by fold id and committed only on probe pass**, so a rollback restores
the layers as well as the session; the **clean-stop check must prove the
session alive**, since the existing idle check returns idle for a dead session;
**ledger and Anchor writes bind to an operator-authored message row**, never to
a quote found as a substring or an LLM's label; **unplanned compactions now
produce chunks and archive entries** rather than a hole in the layers; every
repeating LLM path has a **brake, a ceiling and a budget lane**; the layer store
and transcript archive have a **named path, permissions, scrub, retention and
multi-machine posture**; and the spec gains the sections the convergence tag
requires: Decision points touched, Frontloaded Decisions, Multi-machine posture,
Supervision tiers, Verify-the-state table, Testing. Appendix B lists every
round-1 finding with its disposition.

**v4 → v5 (spec-converge round 2).** Every reviewer confirmed the round-1
resolutions and then read the carriers v4 named one layer down. Several did not
behave as assumed: the "topic muzzle" is the duplicate-session stand-down
registry (Telegram-only, dark, dry-run, releasing on the owner); the lease
medium holds exactly one lease; the Durable Inbound Message Queue ships dark
with a 90-second hold; the replicated journal has finite per-kind retention.
v5 replaces or gates each: a **fold hold** of its own on the shared outbound
chokepoint, fail-closed, for every channel; a **keyed fenced lease** gated on
topic ownership, not the Telegram lease; a live inbound queue as a lock-time
precondition; declared bounds for the layer kind with U bodies re-derived rather
than replicated. It also adds a **durable fold record with a boot sweep**, an
**immutable checkpoint** as the rollback target with epoch-fenced recovery, a
**decision transition** so a bound quote is evidence and not a decision, a
**standing packet** for unplanned compactions with an oversize rule, the
handoff written while the cache is warm, a shadow-probe answerer, corrections
that land in the staged store, a canary with a positive control and a heal
ladder, the 9.1 fix behind its own switch through the ladder, the tag writer's
`Maturation plan` section with dated dark-windows, a Defaults table for every
policy number, and honest cost-default labels where v4 claimed external
constraints. Appendix C lists every round-2 finding with its disposition.

**v5 → v6 (spec-converge round 3, and Justin's notes of 15:59).** Five of six
internal reviewers moved to "minor issues"; the remaining design findings were
seams between v5's own fixes, and v6 closes them: the warm-cache handoff and
the fold lock no longer contradict (a `prepared` state, one lock for recheck,
replace and probe, the replace-later variant measured rather than assumed); a
lease that expires beside a live seeded session **quarantines** the fold until
the sentinel or the boot sweep kills the candidate and reconciles; the
**decision transition** is honestly a judgment-candidate with an enumerated stub
`kind` and a `derived-settled` state; every fail-closed rule is **scoped** to
topics and sessions with a known open fold; the canary's states are defined on
detections with a synthetic positive control; everything keyed on a PostCompact
record is conditioned on the recovery switch; the 9.1 fix ships **live** once
the test agent proves it (the User-Facing Fixes Ship Live standard); U rows get
a real carrier on topic move; the archive moves to a sibling root; per-record
caps are derived from the journal's constants and never sit on a state
transition; the fold record owns every carrier by `foldId`.

Justin's three notes, written after reading the v3 page, are structural:
**engine-agnostic** (section 9.6 becomes the harness-adapter contract, with the
Codex adapter in Phase 1 scope rather than a deferral <!-- tracked: CMT-1536 -->); **a general Instar
feature, not an Echo one** (principle 5.10); and **a sentinel beside the
session** that catches the work the session fails to do (section 7.8, the
`ContextBudgetSentinel`, and the actor-plus-sentinel pattern it instantiates).
Appendix D lists every round-3 finding and operator note with its disposition.

**v6 → v7 (spec-converge round 4).** Five of six internal reviewers again
reported "minor issues"; the remaining items converge on a short list and v7
closes them: the handoff turn is covered by the hold and the tool policy from
the **prepare** step, and the default path takes the lock before the handoff;
one **`FoldCoordinator`** owns every fold transition with compare-and-swap, and
every fold or sentinel action is **owner-only**; **quarantine** has an owner,
a numbered bound and an exit; a **lossless engine checkpoint** is kept apart
from the scrubbed retrieval archive; the ledger's bodies travel by a **chunked
content-addressed carrier**; the user corpus travels by **continuous
lease-holder-to-owner row replication**; the sentinel's ladders are
**`SelfHealGate` declarations** (the gate already exists with three consumers),
not prose; the canary detects compactions through a channel **independent of
the hooks it verifies**; the Codex column of the adapter contract now states
what the lifecycle **actually provides today** (a synthesized pre-compaction
threshold, no post-compaction summary, no trigger), with the real carriers and
the Phase 1 producers named; adapter verification is a re-runnable Phase 0
suite keyed per machine, engine and version, with a per-engine shadow minimum
before fleet. Appendix E lists every round-4 finding with its disposition.

**v7 → v8 (spec-converge round 5).** Every reviewer confirmed the round-4
resolutions; what remained was paragraph-sized, plus two findings that decide
the feature's reach. v8: the fold gate is **"this machine hosts the topic's
live session and, in a pool, owns the topic"**, so the feature runs on a
single-machine agent and not only in a pool; the protected class needs a
**message-row source on every channel**, and today Slack rows collapse and app
conversations write none, so a channel-neutral row writer is a Phase 1
prerequisite and a topic without one refuses to fold; containment lifetimes
are **record-driven everywhere** (no "short expiry", the candidate and the
shadow answerer carry their own markers, a stale marker denies while the record
is open); the canary has **one detection rule** (the engine's compact-boundary
entry alone detects; a size drop needs corroboration and is excluded over a
fold's own range; a native event alone never detects) and the seed fallback
goes through the idle-gated inject store, never a bare inject; the context
epoch is a **deterministic transcript key**; quarantine takeover is a named
**coordinator handover** rather than a re-acquire the lease store would refuse;
non-preemptible judge slots are **bounded per machine**; the `SelfHealGate`
gains a **fourth extension** (per-incident keys with bounded pruning); engines
without cache accounting get a **cache-blind conservative estimator** so Codex
can fold; the engine checkpoint is a tracked `foldId` carrier with a posture
row and the sentinel as its grace actor; ledger blobs have liveness and
re-emit rules; the prepared window holds inbound for the handoff's bound; the
verification suite has a named runner and store. Appendix F lists every round-5
finding with its disposition.

**v8 → v9 (round 6, the cap).** The final round found nothing structural;
its paragraph-sized items are folded in here and marked in the convergence
report as fixed after the cap without a further round: probe turns may read
only the packet in context and the mediated lookups (no file reads, so the
on-disk checkpoint and archive cannot leak into a "retained" answer); the
canary's health is judged over a **verification epoch** that restarts after a
remediation, so a once-broken hook can become healthy again; quarantine
exhaustion releases containment only after **verified termination** of the
candidate, otherwise quarantine stays and the operator is told; a shadow fold
runs its probe under a non-terminal **`shadow-probing`** child state; the
cache-blind estimator prices costs at the uncached rate; and the wording
residue the round listed is cleaned. Appendix G lists round 6.

The v1 findings about today's failures (section 3) stand; they were re-verified
on a second machine, and the round-1 lessons-aware reviewer independently
confirmed the dead compaction branch against the installed binary.

## 1. What Justin asked for (his words)

Topic 130742, 2026-11-09 14:01 PST:

> "Ideally, I would like our infrastructure to be as highly optimized as
> possible, which includes the ability to reference longer context as needed to
> fill in details, but also to leverage highly optimized summaries on different
> levels ... we should already have infrastructure that's attempting to do
> this, but it seems to be failing ... we should be having some sort of rolling
> summary on multiple fractal levels as conversations grow."

Topic 141133, 2026-11-09 14:12 PST (sent before he read the v1 summary):

> "I think this is good, but we need to be really careful here. What we build
> in being extremely intelligent and not just a hard cap. It's also needs to
> reduce or impact the context being used at intelligent intervals based on
> milestones rather than hard limits.
>
> We should also make sure each topic or conversation has ongoing summaries at
> various levels, including a summary of the most recent efforts and work, a
> summary at a midsize perspective when relevant, and a summary at a long-term
> holistic perspective.
>
> Some other critical factors should be keeping an anchor of the original
> purpose of the topic along with any intentional evolutions applied to that
> anchor based on the user or any insights gained during the conversation.
>
> And finally, I personally believe that compaction in the sense we're talking
> about here with the intelligent process should be applied asymmetrically in
> regards to context brought in or created by the agent and context provided by
> the user. In other words, it is my observation that user context, or context
> created by the user, i.e. the user messages, builds up much more slowly than
> the messages in context generated by the agent, and that the user messages
> typically represent a much more grounded form of what the topic represents.
> Therefore we should avoid compacting or removing the user messages or user
> context as much as possible, unless it grows very significantly.
>
> Finally, please make sure Fable 5.2 is involved in the spec design and review
> process."

He is also worried that shrinking context has caused drift before. The bar is
two-sided: **use far fewer tokens per turn, and do not lose the thread.**

## 2. What is happening today (measured 2026-11-09)

- Long topic sessions run until Claude Code's own auto-compact fires at roughly
  **968K tokens**. The build desk compacted 4 times in 2,714 turns; the Instar
  App topic 22 times in 8,097 turns. Between compactions almost every turn
  re-reads hundreds of thousands of tokens.
- Opus 5.5 used about **4.4B tokens on the Mac Studio in 24 hours**, mostly
  cache reads: the cost of re-reading a huge context every turn.
- Our summaries exist but are **added on top** of the conversation; they never
  replace it. Nothing makes the live context smaller except Claude Code's
  generic compaction near the wall.
- **Justin's asymmetry observation holds, and by a wide margin.** The largest
  Claude Code transcript on the Mama PC (38.5 MB, 2 compactions) breaks down
  by characters as: user-side text 7.7% (an upper bound, since hook-injected
  context arrives as user text), tool results 64.1%, the agent's tool inputs
  13.1%, the agent's own prose 1.0%, other structure 14.1%. The agent and its
  tools produce more than three quarters of the context; the human produces well
  under a tenth. Phase 0 repeats this across the fleet's transcripts.

## 3. What already exists, and where it fails

Line numbers are against `origin/main` at `d855bad39a` (2026-11-09).

### 3.1 Layers we already have

| Layer | What it is | Where | Fresh? |
|---|---|---|---|
| Full history (verbatim) | Every topic message in SQLite with full-text search | `src/memory/TopicMemory.ts` (search at `:605`), `GET /topic/search` (`src/server/routes.ts:30954`) | Yes, written live |
| Rolling topic summary | One LLM summary + PURPOSE line, updated incrementally | `src/memory/TopicSummarizer.ts` (threshold 20 msgs, `:45-49`), stored by `TopicMemory.saveTopicSummary` (`:671`) | **No. See 3.2** |
| Topic / recent arc / current work | Three-level "awareness" projection written by the intent extractor | `src/core/TopicIntentExtractor.ts` (prompt `:255-276`), `src/core/TopicAwareness.ts`, rendered by `src/core/TopicIntentBriefing.ts` | Yes, per message, where the layer is enabled |
| Decisions / facts / goals | Evidence-scored propositions; each piece of evidence keeps `sourceMessageId` and `userAuthored` | `src/core/TopicIntent.ts:60-85` | Yes |
| Pending-confirmation records | An inferred intent the agent asks about conversationally before relying on it | `docs/specs/topic-intent-layer.md` (v14, approved 2026-05-22) | Yes |
| Draft-vs-arc check | Signal-only check of a draft reply against settled items | `src/core/TopicIntentArcCheck.ts` | Yes (signal only) |

The three awareness levels already are, in Justin's vocabulary, the recent
effort, the mid-size perspective and the long-term perspective. This spec
extends them; it does not build a second set.

### 3.2 Where it fails

1. **The rolling summary only updates when a session ends.** It is wired to
   `sessionManager.on('sessionComplete')` (`src/commands/server.ts:13571-13585`).
   Long topic sessions rarely end, so the summary goes stale exactly where it
   matters most. On the Mac Studio, 2026-11-09: one topic's summary is **1,516
   messages behind** (last updated 2026-10-26); Justin's topic 130742 is 42
   messages / two days behind. On the Mama PC, where sessions end often, the
   same table is at most one message behind: the mechanism works, the trigger is
   wrong.
2. **Summaries are added, never substituted.** At spawn, `formatContextForSession`
   (`src/memory/TopicMemory.ts:1005`, called from `src/commands/server.ts:1551`)
   prepends summary + last 50 messages. On every prompt,
   `telegram-topic-context.sh` (`src/templates/hooks/telegram-topic-context.sh:76-102`)
   prepends the intent briefing and the last 15 to 30 messages. All of it sits
   on top of the full live conversation, so total context only grows.
3. **The compaction-recovery hook does not run after compaction, and the
   server-side injector that does run is partial.** There are two post-compaction
   paths today. (a) Settings wire `SessionStart` matcher `compact` to
   `session-start.sh` (`src/commands/init.ts:5456-5459`; the installed body is the
   inline literal `getSessionStartHook()` at `src/core/PostUpdateMigrator.ts:19400`),
   which decides whether this is a compaction from `CLAUDE_HOOK_MATCHER`
   (defaulting to `startup`) and only then `exec`s `compaction-recovery.sh`. **The
   installed Claude Code (2.1.321) never sets `CLAUDE_HOOK_MATCHER`**: zero
   occurrences in the binary on two machines; it passes `source: "compact"` in the
   hook's stdin JSON instead. So this branch has never run. (b) Server-side,
   `PreCompact` → `hook-event-reporter.js` → `CompactionSentinel.report` →
   `recoverCompactedSession` (`src/commands/server.ts:15313-15350`), which injects
   `formatContextForSession(topicId, 20)` plus the calm-resume preamble tagged
   `[telegram:N]`, but only when the last real topic message is the user's, and
   the sentinel stands down as "recovered" with zero injects when the pane shows
   active work (`CompactionSentinel.ts:371-383`). So after a mid-turn auto-compact
   nothing re-seeds; after an idle one, the server payload arrives on top of the
   startup orientation. One checked transcript had 12 compaction summaries, 60
   ordinary session-start blocks, and **zero** compaction-recovery blocks. This is
   plausibly part of the drift Justin has seen, and the `context-death-pitfall-
   prevention` stop-gate and the CLAUDE.md "Compaction Survival" text both rest
   on the path that never ran. (Phase 0 counts both paths across more transcripts.)
4. **The one "compact before the wall" feature was retired unused.**
   `ProactiveCompactionSentinel` was opt-in, never enabled anywhere, and removed
   on 2026-10-28 (`docs/specs/retire-staged-features-2026-10-25.md:38`, PR #2363).
   Today the only server-pressed `/compact` is the context-wall recovery rung
   (`src/monitoring/ContextCompactionControl.ts:21-47`), which fires only after
   the wall is hit. Its design, a size threshold, is also exactly what Justin has
   now ruled out.
5. **The pre-compaction hook only reports.** `PreCompact` runs
   `hook-event-reporter.js` (`src/data/http-hook-templates.ts:56`) feeding
   `CompactionSentinel` (`src/monitoring/CompactionSentinel.ts:226`) and the
   optional, default-off `PreCompactionFlush` (`src/core/PreCompactionFlush.ts`).
   It never shapes what the compaction keeps.
6. **Instar never sets any Claude Code compaction setting.** No source file sets
   the auto-compact window, so every session uses the model's full ~1M window.
7. **The topic-intent briefing is not present on every machine.** On the Mama PC
   `GET /topic-intent/141133/briefing` and `/18330/briefing` return empty. The
   capture loop requires `sharedIntelligence`; on a codex-only or
   intelligence-less machine capture is skipped. The three awareness levels are
   therefore not a fleet-wide guarantee today, and the approved topic-intent spec's
   per-topic token budgets and rate limit exist only in prose (the only brake in
   code is the shared `LlmQueue`). Phase 1 makes the layer a prerequisite with a
   freshness check and gives it real brakes (section 9.6).
8. **The inherited paths truncate user text head-first.** `compaction-recovery.sh`
   cuts to 15 messages of 300 characters, `TopicSummarizer` to 1,000 characters
   per message, and the briefing hides "N more settled items". None of these may
   be reused for the Anchor, the ledger or the user corpus (section 8).

## 4. What Claude Code lets us control (verified, not guessed)

Verified by reading the strings of the installed binary, version **2.1.321**, on
two machines on 2026-11-09. These are internal behaviours of a fast-moving
program; Phase 0 re-verifies each one live before anything relies on it.

| Lever | What it does | Evidence |
|---|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var | Sets the auto-compact window in tokens, **100,000 to 1,000,000** (e.g. `250k`). Out-of-range values warn. | `pI=1e5`, `dW=1e6`; warning "Set it to a size from 100k to 1M" |
| `autoCompactWindow` setting (top-level or per model) and `/autocompact [auto\|<tokens>]` | Same window, from settings.json or a slash command (saved per model). | settings schema; command "Set how full the context gets before auto-summarizing" |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Lowers the threshold by percent, **but only when `CLAUDE_CODE_REMOTE` is set**. Not usable for our local sessions. | condition in `vre()` |
| `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, `autoCompactEnabled` | Turn auto-compact (or all compaction) off. | env/setting names present |
| `/compact [instructions]` typed into the session | Manual compaction with our own instructions. We already inject `/compact` (`src/core/SessionManager.ts:9395`). | existing code |
| **`PreCompact` hook** | Receives `trigger` (`manual`/`auto`) and `custom_instructions`. Can **block** the compaction ("Compaction blocked by PreCompact hook") or **add instructions** merged into the summary prompt (`newCustomInstructions`). Applies to auto, reactive and precomputed compaction. | hook schema; `GMt(…, newCustomInstructions)`; `blockedBy` handling |
| **`PostCompact` hook** | Receives `trigger` and `compact_summary`, the summary Claude wrote. We can store and check it. | hook schema `hook_event_name: "PostCompact"` |
| `SessionStart` hook, `source: "compact"` / `"clear"` | Runs after compaction or `/clear`; its output is injected into the fresh context. **Lever exists in the binary; Instar wires only the `startup`/`resume`/`compact` matchers today** (`init.ts:5455-5459`, `PostUpdateMigrator.ts:17164`), and `injectInternalControlCommand` accepts only `/compact` (`SessionManager.ts:9395`). Phase 0 builds both. | hook schema `source: ["startup","resume","clear","compact","fork"]` |
| Idle compaction (`idleCompaction`, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`) | Claude Code may compact an idle session on its own, with internal gates (≥200K tokens by default, one-hour cache mode, warm cache). No evidence it fires for us. | `Vkr()` gate reasons |

Still to verify in Phase 0: the exact hook output format that sets
`newCustomInstructions` and that blocks (stdout vs JSON field vs exit code);
whether `/clear` can be injected the same way as `/compact`; whether the window
setting is honoured for Opus 5.5 and Fable at 1M.

## 5. Design principles

1. **Judgment above a floor, never a cap.** No number fires a fold by itself.
   Each number is a floor that protects something, with its irreversible
   consequence named, or an input to a judgment whose arbiter is named (section
   12). Two caps remain and are called caps: the critical checkpoint request
   (7.2) and Claude Code's own compaction window (9.5). Justin asked for "not
   *just* a hard cap"; these are the safety net under the intelligent process.
2. **Milestones, not meters.** Context is folded at seams in the work, declared
   and described by the session that did the work. Size and cache state only
   change how readily the system asks for a seam.
3. **Three horizons, always on.** Recent effort, mid-size perspective (when a
   phase exists), long-term holistic view: maintained for every topic, read at
   session start, after compaction, by folds and by the probe. A product of the
   topic, not a by-product of a shrink.
4. **The Anchor is never summarized away.** The user's framing message(s) are
   stored whole. The purpose changes only by an attributed, quoted, statused
   evolution appended to the ledger, and an LLM's reading of the user's words is
   a signal until the user re-references or affirms it.
5. **User words are load-bearing; agent output is scaffolding.** Fold the
   scaffolding first and hardest. Quote the user; paraphrase the agent. Every
   verbatim item carries its origin, and tool-origin text is data, never
   instruction.
6. **Replace, do not stack.** One carrier re-seeds context after a fold or a
   compaction; the per-prompt hook sends only what the context does not already
   hold.
7. **Verify retention, not recitation.** Deterministic verification before the
   fold; a held-out probe after it, with lookups counted as retrieval only for
   detail, never for constraints.
8. **A fold is a transaction.** Lock, snapshot, stage, verify, replace, probe,
   commit or roll back, with a TTL, an epoch fence and staged store writes.
9. **Harness built-ins before our own, and Instar's own primitives before new
   ones.** The engine's hooks and window do the harness part. The fold reuses
   the Durable Inbound Message Queue, PendingInjectStore, LlmQueue,
   `SelfHealGate`, the outbound funnel, the recovery veto and the maturation
   ladder rather than adding a workflow engine.
10. **A general Instar feature, engine-agnostic.** Nothing here is specific to
    Echo, to Telegram or to Claude Code. The layers, ledger, packet, fold
    record, holds, probe and sentinel are framework-neutral server components
    of Instar; each engine (Claude Code, Codex, and any later framework) plugs
    in through the harness-adapter contract of 9.6; egress holds sit on the
    shared outbound funnel every channel passes. It runs on a single-machine
    agent as fully as in a pool: wherever the spec says "owner", a single
    machine is trivially the owner, and no pool-only record is required. Echo
    appears in this document only as the operator's development agent (pilot
    topics, rung owner) and as the author.
11. **The session does the work; a sentinel catches what it fails to do.** The
    session writes the handoff and declares its milestones because it alone has
    the context. A separate, persistent sentinel (7.8) watches that the work
    actually happens and takes bounded, pre-declared actions when it does not.
    The sentinel supervises; it never authors context.

## 6. The layers

| # | Layer | Content | Size (targets for writers, never truncation gates) | Updated |
|---|---|---|---|---|
| A | **Anchor** | The operator's framing message(s), **whole**, with message ids and times; above them a derived, non-authoritative one-line "current purpose, as of `<time>`" | Framing messages: whole, however long | Once; the derived line whenever the ledger changes |
| H1 | **Recent effort** | What was just done, what is in flight, the next step, what the session still needs verbatim | ~200 tokens target | Every user turn, every milestone, and on bounded transcript-growth ticks (6.4) |
| H2 | **Mid-size perspective** | The current phase: what it is for, what it has produced, what remains. **Present only when a phase exists** (6.3) | ~300 tokens target | Every arc change |
| H3 | **Long-term holistic view** | The whole topic's story, rebuilt from a **bounded selection** of chunks: open chunks, chunks referenced by the current phase, and the C2 range summaries for everything older (6.5); **the single writer of the topic summary table** from Phase 1 on | ~2 to 4K tokens target | Every fold and, debounced per topic, on chunk creation |
| G | **Ledger** | One attributed, quoted, statused record for **decisions and evolutions** (`type: decision \| evolution`), newest first, with `supersedes` links; a settled entry **is** its bound operator message row (6.2); **live** entries selected by status and reference, not age | Live set ~3K tokens target; archive bounded by the replicated kind's retention with quotes intact, older entries reconstructable from TopicMemory rows (14) | Every decision or evolution |
| C | **Chunk summaries** | One per span of work, created at folds **and** independently when a span closes without a fold (6.5), built from the raw span through the bounded sampler (6.5); what was attempted, outcome, artifacts, open threads; pointers to message ids and transcript entry ranges; `author`, `foldId`, `status`, in-band "sampled from N entries" when sampled | ~300 to 600 tokens target each | Every closed span |
| C2 | **Range summaries** | One per closed range of ~20 chunks or ~8K chunk tokens, built from the C entries and their artifact lists; what H3 reads for old history | ~500 tokens target | When a range closes |
| U | **Protected user corpus** | The operator's own typed messages, verbatim and timestamped, each with a one-line bracketed **referent stub** written beside (never into) the quote, `author: derived` ("[answering: should the gate block or warn?]"); forwarded, relayed and third-party rows are kept and labelled but carry no authority (8) | Governed by section 8 | Live |
| L0 | **Full history** | Topic messages (TopicMemory, searchable) **and a per-topic transcript archive**: the session JSONL entries that folds or compactions removed, deduplicated by entry id, compressed, indexed by entry id and message id, scrubbed, retained under Disk Steward (9.7) | Bounded by retention policy, never loaded whole | Live |

Every rendered layer line states `as of <time>, <n> messages behind`, so the
1,516-message staleness of 3.2 can never be invisible again. Every H/C/C2/G
entry carries `author` (session id, machine, model, `derived | handoff | user`)
so a reseeded session can tell its own handoff from a twin's or the extractor's.

Mapping to what exists: A extends the PURPOSE line and the topic-level
awareness; H1/H2/H3 are the awareness projection's three levels
(`TopicIntentExtractor`), with H3 given one definition; G is rendered from
existing decision refs by `sourceMessageId` and absorbs the evolutions; C, C2, U
and the transcript archive are new. **The rolling summary is retired by making
H3 its single writer**: in Phase 1 the extractor's `rollingSummary` input
becomes H3; the topic summary table is written by H3 (its `saveTopicSummary`
sets `lastMessageId` to the last TopicMemory message H3's selection covers and
`purpose` from the Anchor's derived line) and read by its existing readers,
enumerated honestly: `TopicIntentCapture`, `JobScheduler`, `POST /topic/summarize`,
the spawn path's `formatContextForSession` (which from Phase 1 reads the packet
or H3 plus the last N messages), and TopicMemory's own `getTopicContext`,
`needsSummaryUpdate`/`getMessagesSinceSummary` and `formatContextForUser`.
`POST /topic/summary` is a second **writer** today; under `contextBudget.enabled`
it returns 409 `summary-written-by-h3`, and `/topic/summarize` returns the H3 text
with `writer: h3` (both listed in the CLAUDE.md template change). `TopicSummarizer`'s
writer is disabled the moment H3 writes. Never two writers. Old summaries are
archived through the retirement path.

### 6.1 The Anchor and evolutions

The Anchor's framing message(s) are the first substantive operator-authored
message(s) stating what the topic is for (an opening "hey" is skipped), bound
to message rows with `from_user=1`, `forwarded=0` and the operator's person key
(mapped from the row's `user_id`/`telegram_user_id` through the people registry;
TopicMemory gains no new column for this). A topic with no such message (a
shared topic opened by someone else, the Threadline hub, a topic opened by an
agent message) has `status: no-anchor`: H3 carries the purpose, and no
evolution can be recorded until an operator message frames it.

Every change to the purpose is a ledger entry of `type: evolution`, routed
through the **TopicIntent evidence model** (`topic-intent-layer.md` v14), not a
separate authority:

- `cause`: `user-directed` (bound quote required, same binding as above) or
  `insight-derived` (evidence message ids required);
- `effect`: `additive` or `narrowing` (narrows, replaces or contradicts the
  original purpose or a settled decision); the classification is an LLM read,
  **logged as a signal** with its evidence, never acted on alone;
- `status`: `tentative`, `confirmed`, `withdrawn`, `expired`, `unconfirmed`;
  `supersedes`.

Rules:

- **The user's explicit words are an instruction and are followed at once.** A
  "stop X, do Y instead" moves H1's next step immediately; that is ordinary
  operation. What stays `tentative` is the *purpose record*: the derived
  current-purpose line shows the change hedged ("now also Y; confirm?").
- A `user-directed` evolution is `tentative` on write and becomes `confirmed`
  only by a qualifying episode (user re-reference, affirmation, or a positive
  pending-confirmation), per the v14 weights. **Silence never confirms.** Every
  `narrowing` evolution, whatever its cause, is surfaced in one line in the next
  natural reply before any confirmation clock starts.
- An `insight-derived` + `additive` evolution is `tentative`, surfaced in the
  next natural reply, confirmed by agreement. An `insight-derived` +
  `narrowing` evolution waits for an **explicit yes**. "The user acted on it" is
  never confirmation.
- Surfacing uses `TopicIntentPendingConfirm`, **extended**: a new `kind:
  evolution`, a per-kind TTL, priority over ref confirmations (a displaced ref
  confirmation is requeued, not dropped), and queue overflow becomes `deferred <!-- tracked: CMT-1536 -->`
  with telemetry rather than a silent drop. A `tentative` entry's clock (default
  7 days) counts from surfacing and only after the user has sent at least one
  message since.
- **Expiry removes only the pending confirmation.** A `user-directed` entry
  with a bound quote stays in force as `unconfirmed` until withdrawn or
  superseded (the user's own words never revert to the previous purpose by
  timeout); only `insight-derived` entries lapse to `expired`. Expired and
  unconfirmed entries are listed, never deleted.
- The probe (section 10) treats `tentative` and `unconfirmed` evolutions as in
  force but unconfirmed: a readback that follows them is not a mismatch; one
  that treats them as settled authority is.
- Existing topics are **backfilled** from TopicMemory only (Anchor + ledger;
  background lane, daily cap, topic-recency order, on the topic owner): entries
  are `status: backfilled-unconfirmed`, fully usable and so labelled in the
  packet; confirmation is requested only when the agent next replies in a
  topic with user activity since the backfill, folded into that reply, never as
  a standalone message, never blocking any phase. Pending backfill
  confirmations appear on the dashboard card and in Home's count.

### 6.2 Decisions in the same ledger: a quote is evidence, not a decision

A `type: decision` entry **is** an operator-authored message row (`from_user=1`,
`forwarded=0`, operator person key): its full text, its referent stub written
at the time, time, `supersedes`, and `status`. An optional `paraphrase` is
always rendered as `agent-derived`. Row binding proves **who wrote the text**;
it does not make the text a decision. That second step is the **decision
transition**, and it is a judgment-candidate, not a deterministic check: the
referent stub carries an enumerated `kind` (`answer | directive | question |
hypothetical | rejection | other`) written by the tier-1 stub writer (15), and
only `answer` or `directive` may settle; the row must post-date the entry it
`supersedes` and lie within the span the entry is written for. An entry settled
this way is `derived-settled`: carried in the packet and the probe as settled,
but **not** authority for a breaker re-arm (9.3) and **not** immune to the
live-set floor's "never archive" rule until a qualifying user episode
(re-reference or affirmation, v14 weights) promotes it to `settled`. A row
whose stub is `question`, `hypothetical`, `rejection` or `other`, a statement
the session or extractor asserts without a bound row, or a stub that
contradicts the statement, is written `pending`, agent-proposed, and never
renders as settled. **The bound row is the sole write path to A and to any
settled state in G**; the stub writer, the handoff audit and the extractor are
signals, each logged with its evidence.

Live-set selection (what the packet carries): `superseded`, `withdrawn`,
`expired` and `unconfirmed`-and-superseded entries archive first; a `settled` or
`confirmed` entry referenced by the current phase's H2, or re-referenced by the
user within the last N operator turns (the same N as section 8), never
archives; age is the last rung. G replicates **per entry** (14), so this floor
is never cut by a record cap. Archived entries stay retrievable with their
quotes.

### 6.3 "When relevant": when H2 exists

H2 is present when the extractor identifies a phase: a stretch of work with its
own goal, part of the topic's purpose, spanning more than one milestone. The
rule is deterministic on the extractor's arc structure (`TopicIntent.ts` arc
records). A topic that is a stream of unrelated small requests has no H2, and
the packet says so.

### 6.4 Cadence and its brakes

Horizons update on user turns and milestones, and on **bounded transcript-growth
ticks** so a tool-heavy session with no messages still keeps H1 current. A tick
feeds the extractor at most the last K tool names (default 12) and the first
and last 500 characters of each result (≤ 4K tokens total, scrubbed with
`scrubForStore` before the call, with "N results sampled" disclosed in the H1
it produces, and tick-derived H1 text tagged `origin: tool`), runs no more often
than a per-session minimum interval (default 10 minutes, growing with the
number of recent updates), skips while the session is mid-turn, and is counted
on the dashboard card. The referent-stub writer (6, row U) runs inside the
extractor's existing per-message call, never as a second call, and shares its
brakes. This gives the topic-intent layer the brakes its approved spec described
but never carried.

### 6.5 Chunks independent of folds; bounded builds; H3 bounded

A chunk is created when a span **closes**, whether or not a fold follows: a
milestone the session declares, a deterministic signal the session confirms, or
a coverage watermark the server keeps per topic (the first unchunked entry). At
a fold the handoff is the chunk's source (the session's warm turn). On the other
paths (span close, watermark, PostCompact) the raw span is read through the
**same deterministic sampler as probe generation**: span tail, every tool result
containing an error or a file path, all agent prose, all message ids, default
ceiling 30K tokens (a cost default; floor: every handoff-named or ledger-named
item in the span is always included), with "sampled from N entries" disclosed on
the chunk. When the producing session is alive and idle, the chunk is requested
from it in a coalesced turn instead (it has the span in cache). The active span
is represented in H1 until it closes. In Phase 1, before any folding, H3 already
updates from fresh chunks, and the first fold on an old topic does not have to
summarize its whole past: the pre-existing history becomes one `pre-layer`
chunk pointing at the archive, and raw-history chunking of old spans is done
only for the pilot topic, through the background lane.

H3 is rebuilt, debounced per topic (at most once per 10 minutes or per fold,
within the `LayerUpdate` budget), from a bounded selection: open chunks +
chunks referenced by the current phase (**never dropped for budget**; if they
alone exceed the budget that is the signal to close a range) + C2 range
summaries for everything older. The rebuild input default is 24K tokens (a
cost default under the `LayerUpdate` budget; consequence: beyond it, older
ranges are read through C2 only), and the packet states in-band which ranges
are read through C2.

## 7. Milestone-driven folding

### 7.1 Who declares a milestone

1. **The session itself**, through three agent-side controls carried by the
   handoff schema and also exposed as `POST /topic/:id/fold/{milestone,pin,veto}`:
   declare a milestone and the span it closes; pin a span as still needed; veto
   or defer a proposed fold. The controls bind to the calling session through
   the session guard's place binding (a session acts only on its own topic),
   log the caller, rate-limit `veto`, and are refused with a named, audited
   reason while a fold lock is held. Listed in the CLAUDE.md template and
   reference files in the same PR.
2. **Deterministic signals**: PR merged or closed; build or test run at a final
   result; commitment or H1 next step marked done; worktree removed; release
   published; job finished; extractor arc change. They *propose*.
3. **Opportunities**: a long idle gap, an expired prompt cache, an imminent
   compaction (PreCompact fires with `trigger: auto`). They make the system
   ask; they never decide. A PreCompact that fires **mid-turn** cannot start a
   fold: it attaches the keep-instructions (9.5) and records the event.

User phrases ("done", "next", "let's move on") are evidence for the extractor's
arc judgment, never a string match. **Milestone claims are audited in both
directions** (7.4): a span the session calls finished whose PR is open, whose
test run is red, or whose commitment is still open is demoted to the verbatim
tail, not folded; a merged PR the session did not mention is asked about.

### 7.2 Benefit, floor, and the two caps

The server knows each session's live context size and cache state from the
transcript (the JSONL `TokenLedger` already scans; the estimate is marked
`unknown`, and no fold is proposed, while the poller lags the live file). It
estimates the **benefit of folding now** as:

> break-even turns = total incremental fold cost ÷ per-turn saving after the
> fold, where the cost is the **handoff turn and any send-back priced by cache
> state** plus the packet cache write, the audit, probe generation, the probe
> turns and grading (the fixed part measured in Phase 0), compared with the
> **expected remaining turns**, estimated from the trailing turn rate and the
> count of open threads in H1 (a deterministic read of H1, not a model call).
> The estimator is an input, named as such; a fold is worth asking for when
> expected remaining turns exceed break-even by the margin (default 1.5×). On
> an engine with no cache accounting (9.6) the estimator is **cache-blind and
> conservative on both sides**: the saving is priced at the cache-read rate (a
> lower bound) and every cost term (handoff turn, send-back, packet write,
> probe turns) at the uncached-input rate (an upper bound), so the fold is
> never over-sold; shadow handoffs on such an engine use the same estimator;
> `unknown` is reserved for poller lag, never for a missing cost model.

**The handoff is written while the cache is warm** (right after a reply, or at
idle shortly before the cache TTL expires). **Default: the lock is taken before
the handoff**, so the handoff, the stage, the replace and the probe run under
one lock, one hold and one marker, and the packet's cache write is paid once.
The `prepared` state (9.3 step 0) exists for the replace-later variant and for
shadow handoffs; in it the fold hold and the marker are written **at prepare**, keyed by `foldId` and released by the record's transition when the stage is invalidated, before the user's message is answered. The alternative,
**replace at the next clean stop after staging**, keeps the staged packet only
while no transcript entry has been added past the recorded last entry id (a
user message both invalidates the stage and is answered normally; the stage is
discarded and re-asked later, its cost counted); it trades a second packet
write for a cheaper probe window and is **measured in Phase 0 and chosen per
machine from Phase 2 data**, never assumed. There is no "replace on the next
inbound message": an inbound message always invalidates a stage. Break-even is
**recomputed on the staged packet** (a session can pin most of its context), and
a fold whose saving falls below the floor is declined and recorded; a
pin-everything decline counts toward Cap 1's bounded requests.

- **No-fold floor**: below break-even the system does not ask. Consequence
  named: below it, folding costs more tokens than it saves.
- **Asking eagerness**: above the floor, the better the benefit and the stronger
  the milestone evidence, the more readily the system asks at the next clean
  stop.
- **Ask brakes** (P19): a veto, defer or `not-yet` applies a per-topic backoff
  (default 30 minutes); asks are capped (default 2 per hour per topic;
  consequence: a busier cap spends a full-context turn per ask); an ask is
  coalesced into the session's next natural turn when a user turn is expected
  within the backoff, rather than injected standalone.
- **Cap 1, the critical checkpoint**: when the session's estimated
  **turns-to-wall**, measured against the **effective auto-compact window**
  (9.5), falls to the floor (headroom for one handoff turn plus one packet
  write, from the recent growth rate), the system asks the session to **bring
  its work to a checkpoint**: pause background work, write the handoff. Any
  ordinary milestone ask may also offer pause-and-re-arm of background work.
  After a bounded number of declined, missed or decline-by-break-even
  checkpoint requests (default 3), the request names the consequence and the
  session is asked once more to pause everything it can; if a clean stop still
  cannot be reached, the accepted outcome is the backstop compaction with our
  keep-instructions, recorded as `checkpoint-unreachable`. Consequence named:
  Claude Code's generic compaction runs.
- **Cap 2, the backstop**: Claude Code's own auto-compact window (9.5).

Per-topic overrides of these numbers are not built; data from Phase 3 decides
whether they are ever needed.

### 7.3 Clean stopping point

A fold replaces context only when the server can **affirmatively** show, with
the evidence it actually has: the tmux session is present and its pane shows
the idle prompt (absent or `indeterminate` is not clean); no tool call is in
flight; the SubagentTracker has no live helpers for the session; no live child
process under the session (`SessionManager.hasLiveToolShell`, injected into the
reaper; `WorkEvidence` is presence-only and cannot say "none", so it is
corroboration, not the test); **no background task open**: the carrier is the
session transcript the adapter exposes (for Claude Code the JSONL that
`TokenLedgerPoller` already scans), where a start is a `tool_use` with
`run_in_background` or a `Monitor` call and a completion is the
task-notification entry for that task id, so every start since the last fold
with no matching completion ⇒ `unknown` ⇒ not clean (Phase 0 verifies the
notification entry's shape per engine version; hook events show starts only
and are corroboration); the handoff's "background work paused" attestation
does not contradict any of these (a declared-none with a live child ⇒ not
clean); no user message is waiting; and the next commitment check-in (read
from `CommitmentTracker`, not a constant) is further away than the
Phase-0-measured fold duration times a safety factor (default 2). Anything
`unknown` ⇒ not clean, recorded, and counted toward Cap 1's bounded requests
rather than silently retried.

### 7.4 The session-authored handoff

At the clean stop the session is asked, through an internal turn whose carrier is
defined in section 10, to write one structured handoff from its full context:

- **finished**: each completed stretch, by message id range and wall-clock
  bounds (the server resolves transcript entry ranges; the model never sees
  entry ids), outcome and artifacts;
- **still needed verbatim**: anything from those stretches to keep word for word,
  each item with its **origin** (`user | agent | tool:<entryId>`); the verifier
  accepts `user` only when the bytes match a whole operator row (6.2 binding),
  otherwise relabels `agent` and records the relabel, and `tool:<entryId>` must
  resolve to an entry in the archived snapshot;
- **open threads** and the next step; background work paused or still live;
- **decisions or evolutions** it believes settled in the span, quoted.

A small model **audits** the handoff (tier 1, section 15; prompts fence the
handoff and the spans as data): against A and G (does it drop a decision,
contradict the purpose, treat a tentative evolution as settled?) and against
the deterministic signals **in both directions** (7.1). The audit is a signal:
it may send the handoff back once with specific questions (a cost default; one
further send-back only for a protected-class defect, a deterministic trigger);
it never writes to A or G. **A second deficient handoff** demotes the contested
spans to the verbatim tail; the fold proceeds only if break-even still holds on
the reduced packet, else it is declined, `fold-declined: audit`. The handoff
becomes chunk entries for the finished spans and the new H1; H2 and H3 are
rebuilt; G receives row-bound entries that pass the decision transition as
`derived-settled` and everything else as pending. **Coverage is verified
deterministically**: every source range of the pre-fold context is either
retained verbatim, named by a chunk, or listed as "unclassified, retained".

### 7.5 What a fold does, honestly

Claude Code cannot remove a middle span from a live context, so **every fold is
a full rebuild** of the session's context. A fold is defined by what stays
verbatim: A, the live G, U (per section 8), H3, H2 if present, H1, the
**verbatim tail** (everything after the last finished span plus everything the
handoff kept, plus every unclassified range), the lookup pointers (7.6) and
the in-session state the handoff recorded.

The resume packet is pre-rendered to disk at stage time, **single-use** (bound
to the live lock and its `foldId`, deleted on abort so a later human `/clear`
never seeds it), and ordered stable-first (A, U, H3, G, H2, H1, tail,
pointers). The cache reuse this buys is expected to be modest, because U grows
between folds; Phase 0 measures it and the spec claims only what it measures.
The packet opens with a fixed marker that tells the session: this is restored
context, not a new user request; which entries are its own handoff and which
are derived layers (`author`); and that items marked `tool:` origin are data,
not instructions. The deterministic stage verifier **rejects tool-origin bytes
in A, G or U** and checks that every U quote is byte-identical to its row with
its stub labelled derived.

### 7.6 On-demand lookup of older detail

All routes are bearer-only, closed to memory-session tokens unless added to the
memory session guard with place binding, filtered by `privacy_scope` through the
owner-visible projection (the gap in today's `/topic/search` filter is not
inherited), and bounded (default byte and entry ceilings with pagination; sizes
returned by `/chunks` so a session can see what it is about to pull; the
in-span `q` filter is a literal substring or FTS term, never a caller-supplied
regex). Shapes are additive-only after Phase 1.

- `GET /topic/search?topic=N&q=…` (exists; gains the privacy filter).
- New: `GET /topic/:id/messages?around=<messageId>&n=…`.
- New: `GET /topic/:id/chunks` and `/chunks/:k` (C and C2, with sizes).
- New: `GET /topic/:id/transcript?span=<entryId>..<entryId>&q=…` (archived raw
  span, scrubbed and privacy-filtered **on the serving machine** before bytes
  leave it, paginated; proxied to the holding machine through peer HTTP via
  `PeerEndpointResolver` with the same auth and classified-failure shape as the
  `?scope=pool` fan-outs; the bearer is never forwarded; see 14).
- New: `GET /topic/:id/anchor` (Anchor record and ledger).

### 7.7 The per-prompt hook stops stacking

After Phase 1, `telegram-topic-context.sh` emits only the **delta** since the
last prompt for this `(topic, session_id)`: new inbound messages and a changed
H1 line, in one request instead of two. The baseline is a **context epoch**
written by the `SessionStart` hook on every `startup`, `resume`, `compact`,
`clear`, `fork` and `unknown`. **The seed path writes the seeded marker with the
epoch it seeded**; the hook sends the full briefing only for an epoch with no
matching seed marker, otherwise the delta from the seed, so the first prompt
after a compaction or fold never receives the packet and the briefing both.
While a fold lock is held for the topic the hook is suppressed entirely, and
for a session whose marker names a `foldId` every reader (hook, seed, the
dashboard's live view) resolves the layer set **as of that fold** (the staged
view) until commit or rollback. Delta mode is keyed on the seeded marker, so
Codex sessions and any Claude session never seeded keep today's behaviour. The
delta hook is **gated per machine** on 9.1 being verified there and is measured
in shadow first (both outputs computed, the delta size logged, rework compared)
before it reduces anything a session loads.

### 7.8 The session and the sentinel

The session is **responsible** for the work only it can do: declaring
milestones, writing the handoff, pinning what it still needs, answering the
probe. The **`ContextBudgetSentinel`** is responsible for noticing when that
work does not happen and for the bounded actions the session cannot or will not
take. It is one server-side watcher per machine (the monitoring pattern of
`CompactionSentinel`, `SessionWatchdog` and `PromiseBeacon`), framework-neutral,
and it gathers the pieces v5 had scattered across sections: the canary (9.1),
the boot sweep and quarantine reconciliation (9.3), the breaker (9.3), the
"zero folds on an eligible topic" digest signal (9.3), the layer-freshness
check (6), the hold-store health watcher (10), and Cap 1's bounded checkpoint
requests (7.2).

What it watches (each a row in 17): a topic whose layers are stale beyond
target; an eligible topic with no handoff for a day while the estimator said a
fold would pay; a session that declines or ignores checkpoint requests; a fold
record non-terminal past its bound; a hold or marker outliving its record; a
canary divergence; a standing packet over the compact-path limit; a reduced
packet still unrestored.

What it may do, all pre-declared and bounded (Standard B), **only on the
machine that owns the topic** (`ownerOf(topic) === self`; sentinels elsewhere
observe and record): ask the session (milestone ask, checkpoint request, up to
the counts in 7.2); re-stage and re-verify a packet; run the heal ladder of
9.1; press a synthetic compaction on a **throwaway** session (the canary's
positive control, 9.1; never on a live topic); run the adapter verification
suite (9.6); quarantine, roll back or sweep a fold (9.3); drop a topic to
shadow mode (the breaker); pre-render a reduced packet (9.5); raise one notice
when a ladder is exhausted. **Each ladder is a `SelfHealGate` declaration**
(`src/core/SelfHealGate.ts`, already in production with three consumers): a
`SelfHealSpec` per cause with `remediationActions` (operation, idempotency
guard, compensation), `maxAttempts`, `backoffMs`, `maxWallClockMs`, `classId`
and severity, run through the gate's episode store, so the brakes are enforced
by the gate and declared once, not re-implemented per watcher. The gate needs
four named extensions for this use, built in Phase 0: a `pool-shared`
controller resource that **refuses** (not merely records) when this machine is
not the owner; an asynchronous remediation (the gate's remediation is
synchronous today; rollback and re-stage are not); **per-incident episode
keys** (`topic+cause+incidentId`) with **bounded pruning** of terminal episodes
(the store today holds 256 rows, never prunes, and treats `exhausted` as
terminal per key, which would make every ladder one-shot per topic and page the
operator when the store fills); and a **per-key ring** (the derived cap is
four episodes per `topic+cause`, evicting the oldest terminal episode, refusing
only when all four are live, and pruning terminal episodes at the next tick),
in the sentinel's **own episode store file** so its cap is per controller and
never darkens another consumer's gate. Fields common to every ladder: `dedupe-key:
machine-topic-cause-incidentId`; `breaker: 3 same-cause exhaustions in 24 h ⇒ one notice`;
`max-notification-latency: 300s`; `audit-location:
context-layers/<topic>/fold-records`; `class: recoverable` (data-loss class
escalates on the same tick). The sentinel ticks every 5 minutes (Defaults) over
the topics this machine owns; the exhaustion notice for a topic whose hold is
still held goes to the **Attention queue and the dashboard** immediately, and
to the topic itself only once the hold is released; the fold hold admits no
bypass, so the operator hears about a stuck fold through Attention, never
through the held topic.

What it never does: write A, G, U, C or H3 (it may request a rebuild; the
layer writers write); author or alter a handoff; send to the user outside the
one-notice breaker; replace a session's context except through the fold
transaction's own rollback and reduced-packet paths. The session acts; the
sentinel catches. Both are measured on the same card, so a sentinel that acts
often is itself a finding about the session's design.

**The pattern.** Actor-plus-sentinel is already how Instar handles compaction
recovery, stuck sessions and commitments, and `SelfHealGate` already carries the
bounded-ladder half of it. What this spec adds is the other half as a named
piece: a declaration of **what the actor owes** (the handoff, the milestone,
the probe answer), the **symbols the sentinel reads and the states they prove**
(17), and the rule that the sentinel never authors what the actor owes.
Generalising that half to other agent responsibilities is a follow-on spec once
Phase 3 has shown the numbers (how often the sentinel acted, and whether each
action was right).

## 8. Asymmetric treatment of user and agent content

Measured (section 2): the agent and its tools generate over three quarters of
the context; the user under a tenth. The user's messages are also the ground
truth of what the topic is. So:

**Definition of U.** U is sourced from TopicMemory by **sender row**, never from
transcript roles (hook injections arrive as "user" in the transcript and are not
the user). The operator's own typed messages are the protected class. Rows with
`forwarded=1`, with a relay or A2A origin (a new `origin` column on TopicMemory
written by the relay and A2A inbound paths; the build adds it before the
exclusion can be enforced), or with another person's sender are kept in U,
labelled, and carry **no authority** for the Anchor, the ledger, confirmations
or evolutions. Large pasted artifacts are kept whole until superseded, then by
excerpt and pointer, with in-band disclosure.

**Protected class** (kept verbatim through every fold):
- the Anchor's framing messages and every ledger row;
- U, with referent stubs and timestamps;
- the last N operator turns, where N is a floor (default 20; `basis:
  irreversible-consequence; evidence: a folded user turn cannot be re-asked`).

**Folding order** (what a handoff may fold first):
1. tool results of finished work (the bulk);
2. the agent's tool inputs of finished work;
3. the agent's narration and progress messages;
4. the agent's superseded intermediate artifacts;
5. **only then, and only under 8.1**, operator content older than the floor.

**Authorship rule**: summaries of agent content paraphrase; anything that
touches user content quotes. A chunk never rewrites a user sentence. A
compaction instruction (9.5) cannot make Claude's summary hold U verbatim; only
the reseed does, and the spec says so.

**Supersession, not deletion**: a stale instruction stays in U; its ledger entry
is marked superseded with a link to the replacement, so protection does not
itself cause drift. Referent stubs keep "yes, the second one" meaningful after
the agent's question has been folded.

### 8.1 When the user corpus itself grows large (measured, deferred <!-- tracked: CMT-1536 -->)

Justin's condition: "unless it grows very significantly." The measured share of
real operator text is under 7.7%, so U alone will not reach a working size that
matters for a very long time on most topics. v5 **measures** U per topic (tokens
and messages, on the dashboard card) and **defers** building the user-words
digest until a topic's U exceeds the trigger: the lower of 100K tokens of
operator text and one third of the measured delivery limit of the rung in use
(so a topic cannot become permanently unfoldable before the digest exists);
repeated oversize refusals on one topic surface to the owner on the card.
Owner of the trigger: Echo, reviewed at each maturation rung review (section
16). When built, it folds the oldest operator messages into a list of quotes
with message ids grouped by phase, never a paraphrase; the ledger and the last
N turns are never folded; every such fold is counted and visible.

### 8.2 Agent content that is protected anyway

Whatever the handoff lists as still needed verbatim stays verbatim past the
fold, labelled with origin: the current build's failing output, the plan being
executed, the last reply sent to the user, review comments still being
addressed.

## 9. Mechanics with Claude Code

### 9.1 Fix first, live as soon as it is proven

Make the installed `session-start.sh` (the `getSessionStartHook()` literal in
`PostUpdateMigrator`) read `source` from its stdin JSON. The hook distinguishes
an **expected absence** from an unknown one by the framework discriminator
Instar already sets at every spawn (`INSTAR_FRAMEWORK`): a non-Claude engine ⇒
that engine's adapter branch (9.6), counted as `n/a: <engine>`, no record;
Claude Code with a missing or unparseable `source` ⇒ `unknown`: emit the
startup orientation **and** write a degradation record, never silently
`startup`. Add a dedicated `PreCompact` steering hook (a separate command script
that reads **pre-rendered** keep-instructions from the staged packet directory
and never composes them, left alone by the reporter and native-events
migrations) and a `PostCompact` hook plus settings entry and server route
(session → topic) that stores `compact_summary` under the 9.7 store after
`scrubForStore`. All ship through `PostUpdateMigrator` (settings,
always-overwritten hook scripts, config defaults) in the same PR as `init`.
Correct the CLAUDE.md "Compaction Survival" sentence through `migrateClaudeMd`.
Ship with L7 evidence: a reproduced before/after transcript showing a recovery
block after a real compaction. The SessionStart hook's 5 s timeout is Instar's
own setting and stays, because the seed only reads a staged file.

**Maturation of the fix (User-Facing Fixes Ship Live).** This is a bug fix to
user-visible context loss, so it does not get a dark window. It ships behind
`contextBudget.compactionRecovery.enabled` **default on**, after Phase 0 has
proven it on the test agent with a synthetic positive control (below) and the
L7 transcript; the switch exists for rollback. During the hours before that
proof, and on any machine where the switch is off, **every behaviour keyed on a
PostCompact record** (the `CompactionSentinel.report` early return, the archive
and chunk enqueue, the standing-packet reseed) is conditioned on the switch
**on that machine**: the PostCompact hook may still write its record for
observability, but `report` runs today's path unchanged. A fleet machine's
post-compaction behaviour with the switch off is exactly today's.

**Standing canary** (P20, Standard B; run by the `ContextBudgetSentinel`, 7.8).
Scope: **topic-bound sessions, plus the throwaway sessions the synthetic press
targets** (job and other sessions have no packet and are out of scope). Per `(machine, engine, version)`, counts of compaction
detections, PostCompact records and recovery blocks in the transcript. **The
detection channel is independent of the hooks under test, with one rule**: the
engine-written **compact-boundary entry** in the transcript (for Claude Code it
carries the trigger and pre- and post-token counts) **alone is a detection**; a
context-size drop between consecutive turns needs corroboration by that entry
or by a server-pressed synthetic compaction, and is **excluded** over any entry
range covered by a fold record or a seeded `clear` epoch for that session (a
fold's own size drop is not a compaction); the engine's native pre-compaction
event alone is never a detection. A hook family that never fires therefore
reads `diverged`, never `uninitialized`. The synthetic press is a gated sentinel
action on **throwaway sessions only**, never on a live operator topic. An
engine whose detection is only `synthesized` (9.6) is counted but never healed
by injection. The **context epoch** is a deterministic transcript key: the
compact-boundary entry's id after a compaction, the `foldId` after a fold, the
spawn id otherwise; every writer of the seeded marker derives it the same way. States, defined on **detections within the current verification epoch**
(the epoch restarts whenever the switch turns on or a remediation completes,
so a historical failure is preserved in the audit but never blocks recovery):
`n/a: switch-off`; `uninitialized` (switch on, zero detected compactions in the
epoch); `diverged` (≥ 1 detected compaction in the epoch, fewer than all with
both artifacts); `healthy` (≥ N detected in the epoch, default 3, all with both
artifacts, at least one of them a fresh positive control after the last
remediation). Phase 0 runs a
**synthetic positive control** on the test and dev agents (a server-pressed
compaction through the adapter's control-command path), so `healthy` is
reachable in hours and a hook that has never worked is caught in Phase 0, not
in the field; a machine with few natural compactions earns its positives the
same way. Self-heal is a **ladder by cause** with `remediation-actions:
[re-run-migration, re-stage-and-reinject-seed, record-only]`: hook not
installed ⇒ re-run the migration; installed but no recovery block ⇒ re-stage
the standing packet and inject it once through the **injection step** of the
`recoverCompactedSession` helper called directly (never through `report`, which
this section short-circuits), idempotent on `(session, context epoch)`,
with compensation: the seeded marker (7.7) makes a later hook seed for that
epoch a no-op; detection without a real compaction ⇒ record only. Brakes:
`max-attempts: 3` per session per day, `backoff: 10 min, 1 h`, `max-wall-clock:
30 min`, `dedupe-key: machine-session-epoch` (the context epoch of 7.7, per incident), `breaker: 3 heals of the same cause in
24 h ⇒ raise once`, `max-notification-latency: 300s` (the registry ceiling),
`audit-location: context-layers/<topic>/fold-records (scrubbed)`, `class:
recoverable` (a lost protected-class item after a failed rollback is data-loss
class: raise on the same tick, heal concurrently).

**One carrier of post-compaction context, chosen by evidence**: the adapter's
post-compaction seed (for Claude Code the `SessionStart` (`compact`) hook),
reading the **standing packet** for the topic (9.5). `recoverCompactedSession`'s
payload is retired into it (its calm-resume preamble rules are kept in the
packet marker). With the switch on, `CompactionSentinel.report` short-circuits
**only when the seed succeeded**: the seeded marker (7.7) for this compaction
epoch exists within a bound (default 30 s **after the compact-boundary entry**,
that is after compaction completed, not after the pre-compaction event). If no
marker appears, the server-side path runs once with the standing packet
through the **idle-gated** inject path (`PendingInjectStore`, whose
redelivery for this record is released only when `isSessionActivelyWorking()`
is false **and** the pane shows a ready prompt, re-checked each tick within the
step bound; the store's readiness probe alone is not the predicate; never a
bare `injectMessage`), idempotent on the compaction epoch (the compact-boundary entry's id), whose
seeded marker then makes any late hook seed a no-op. One injector at a
time, never keyed on the PostCompact record alone (that record comes from the
hook family being verified).

### 9.2 The fold ladder

Phase 0 **builds and verifies** both rungs below; the fold uses the first rung
that passes on the machine **for the installed Claude Code version** (Instar
launches from a per-version binary copy; a version change re-verifies), recorded
per fold:

1. **Clear-and-seed**: inject `/clear` through `injectInternalControlCommand`
   (its closed union and runtime check widened to `/compact | /clear`, same
   change, same test; never `rawInject`), and the `SessionStart` hook with
   `source: "clear"` (a `clear` matcher added in `init` and `migrateSettings`)
   `cat`s the pre-staged packet file within the hook's 5 s timeout. The hook
   seeds **only** when a staged, verified, single-use packet exists for that
   session under a live lock; otherwise a human-typed `/clear` behaves as
   today. A rung-1 failure at fold time (hook timed out, packet not seeded)
   rolls back through 9.3 step 8; it does not step down a rung mid-fold.
2. **Respawn with the packet**: suspend the session and spawn a fresh one
   through the existing spawn path with the packet as the initial context (the
   `formatContextForSession` injection point). The old session is **suspended**
   (pane detached, registered with the reap guard and carrying a `foldId`
   exemption in the duplicate-session reconciler and the stand-down registry,
   so nothing sends to or kills it) until commit, then ended; rollback is
   un-suspending it. Two registered sessions exist on the topic by design for
   the lock's lifetime, and the reconciler's exemption is named here so it is
   built, not assumed.
3. **No fold**: backstop only (9.5), recorded `fold-path-unavailable`.

A rung passes Phase 0 on a machine only if **rollback restore is verified** for
it (9.3 step 8); a machine where rung 1's restore fails runs rung 2 or 3.

When a verified packet exceeds the measured delivery limit of the rung in use,
the fold is **refused** (P24), never truncated; the refusal is audited and
counted. Phase 0 measures delivery capacity (truncation, the role the model sees
the seed in, intact arrival at 50K to 150K tokens, emit latency), hook ordering
for `PostCompact` vs `SessionStart(compact)`, what survives `/clear` and
`/compact` (background shells, subagents, wakeups, todo state, read-file
tracking, whether `/clear` rotates the JSONL path, session id and transcript
path continuity that `TokenLedger` and topic mapping depend on), and the cost of
one fold at the cache TTL in use. If a lever fails verification (the window is
ignored at 1M for a model, PreCompact cannot add instructions), the result is
"today's behaviour, recorded"; the builder does not stop.

### 9.3 The fold transaction

The fold record is a **durable state machine** under the 9.7 store, **state and
pointers only** (foldId, step, ownership epoch, lease generation, checkpoint
pointer, counts), never size-refusable, and it has **one writer**: the
`FoldCoordinator` on the topic's owner, whose transitions are compare-and-swap
on `(foldId, step, generation)` in the `CommitmentTracker.mutate` shape, so a
late runner, the sentinel and a boot sweep can never act on the same record
twice. Every fold and sentinel action is **owner-only**, where "owner" means **the
machine hosting the topic's live session, and, when the session pool's
placement is live, also the topic's ownership record** (`ownerOf(topic) ===
self`; on a single-machine agent, and on a multi-machine agent whose session
pool is `dark`, the host is the owner by default and no record is consulted;
when placement is live and the record is missing ⇒ `fold-skipped:
owner-unknown`); a non-owner machine
holding a replica of the record observes and records, never acts; lists (discarded entries, lock-window
entry bounds) live in sidecar records keyed by `foldId`. States: `prepared`,
`shadow-probing`, `locked`, `snapshotted`, `staged`, `replacing`, `probing`,
`committed`, `rolled-back`, `quarantined`, `aborted`. **Every carrier the fold touches is
keyed by `foldId`**: the staged packet, the fold hold, the per-session marker
files (the live session's, the rung-2 candidate's and the shadow answerer's;
the coordinator supplies the candidate's and answerer's `INSTAR_SESSION_ID` to
the spawn call so their markers exist before their first tool call), the
`hold: fold` queue rows, the `PendingInjectStore` records, the suspended
session's reconciler exemption, the reap-guard veto, the PresenceProxy
suppression, and the **engine checkpoint** (whose grace deletion the sentinel
performs). **Every carrier's lifetime is record-driven**: none expires on its
own while the fold record is non-terminal, and all are released by the
terminal transition. A **boot sweep for folds** (`recoverPendingFolds`, run by the
sentinel on the owner) executes on the same unconditional synchronous path as
the inbound sweep, **before it**, and resolves every non-terminal record and
every orphan carrier whose `foldId` has no record: at or before `staged`, and
`shadow-probing`, ⇒ discard staged writes, delete the packet, release lock,
hold and markers (synchronously); `replacing`, `probing` or `quarantined` ⇒ mark `quarantined`
synchronously and hand step 8 to the sentinel's asynchronous path. A record
restored from backup in a non-terminal state is swept to `aborted`. Inject records
carrying a `foldId` are never redelivered by the generic sweep; an orphan is
discarded **loudly** (recorded, counted).

0. **Prepare** (replace-later variant and shadow handoffs only; the default
   path starts at step 1). Preconditions: the same as step 1's (owner, sentinel
   heartbeat, row source, live inbound queue) except the exclusive-session and
   layer-kind checks, and no other non-terminal record for the topic. The fold hold and the
   per-session marker are written **first**, keyed by `foldId`; inbound is held
   with `hold: fold` **for the handoff step's wall-clock bound only**; the
   handoff turn runs under the lock-window suppression (10); the packet is
   built and verified (step 4's rules) and staged under the `foldId` with the
   transcript's last entry id. At handoff-turn end the coordinator records the
   transition: for a shadow handoff the live session's hold, marker and inbound
   are released at once and the record moves to the non-terminal
   **`shadow-probing`** state (a child record under the same `foldId`) that
   owns only the staged packet and the throwaway answerer's marker, is bounded
   by the probe step bounds, is swept by the boot sweep as a discard, and ends
   `aborted`-by-design once the shadow probe is graded; for the replace-later
   variant the record stays `prepared` under a coordinator-enforced bound
   (default: the cache TTL) after which it goes `aborted`. A stage is invalidated by any later transcript
   entry, and held inbound is delivered as the record goes terminal.
1. **Lock.** Precondition: this machine **owns the topic** (hosts its live
   session; in a pool also `ownerOf(topic) === self` with the record not
   `placing`/`transferring`/`released`); **no other non-terminal fold record
   exists for the topic** (its own `prepared` record is the one it continues);
   the topic's channel has a **message-row source** (14; else `fold-skipped:
   no-row-source`); the owner's sentinel has a
   fresh heartbeat (else `fold-skipped: no-sentinel`); exactly one live session
   serves the topic (per-peer answers; a peer presumed dead by
   `isPeerPresumedDead`, not the owner and named by no ownership record, counts
   as no session there; a peer that **has served the topic**, meaning it is
   named by the current or previous ownership record or holds a session not
   confirmed ended at transfer, and is merely unreachable ⇒ `fold-skipped:
   peer-unknown`; every other unreachable peer is ignored and the fence bounds
   the residual); the Durable Inbound Message Queue is live and
   not dry-run on this machine (else `fold-skipped: no-hold-queue`); the layer
   kind is present on this version (else `fold-path-unavailable:
   layers-not-replicated`); the topic's TopicMemory rows are present here (14).
   Take the per-topic lock through a **keyed fenced lease** (`LeaseStore`
   generalised with a key that is part of the signed `FencedLease` tuple;
   `local` medium on a single machine; CAS push per step on the `git` medium,
   measured in Phase 0). Record the ownership epoch and the lease generation;
   at most one fold per machine may be past the point of no return at a time
   (Defaults; a second fold reaching step 5 is declined, `fold-skipped:
   machine-busy`, never queued), which also bounds the non-preemptible judge
   slots.
   Write the **fold hold** and the **per-session marker file** (10) if the
   prepare step did not; the handoff turn then runs under them. Register the
   reap-guard veto and the all-tier PresenceProxy and stall suppressions.
   The lock's base TTL is the Phase-0 p99 fold duration (floor ≥ p95); it is
   **renewed while a step reports progress**, every step has its own
   wall-clock bound (a probe turn or judge call that reports nothing within its
   bound is a failed step, not an open one), and every step also has a **hard
   maximum** regardless of progress reports (default 3× its bound), so a
   step that keeps reporting is still bounded. Each renewal re-stamps the
   marker files.
2. **Re-check quiescence** (7.3) under the lock; abort if the stage was
   invalidated.
3. **Checkpoint.** Two artifacts. The **retrieval archive** (9.7): every
   transcript entry not already present for the topic, deduplicated by entry
   id, scrubbed per field, compressed, streamed off the request loop. And the
   **engine checkpoint**: a byte-exact copy of the pre-fold transcript file
   (unscrubbed, because a scrubbed transcript cannot restore the original
   context), mode 0o600 under the archive root's `checkpoints/`, never served,
   never replicated, never backed up, deleted on commit or after rollback plus
   a grace period (default 24 h). The checkpoint pointer names both; the engine
   checkpoint is the **immutable restore target**, and Phase 0 verifies the
   restore with scrub-triggering and oversize entries present.
4. **Stage (or re-verify the prepared stage).** Deterministic verifier: Anchor
   bytes identical to the store; every settled or derived-settled ledger entry
   bound to its row with a settling stub `kind` (pending entries and evolutions
   carry their own status); U rows byte-identical with stubs labelled derived and
   the last-N floor satisfied; every "still needed" item present with a
   verified origin; no tool-origin bytes in A/G/U; every source range retained
   or chunked; size within the rung's delivery limit; break-even recomputed on
   the real packet. Store writes are **staged** with `foldId`; only committed
   entries render, feed hooks or feed H3, except for the seeded session's own
   staged view (7.7).
5. **Point of no return check.** A stage invalidated by a user message, a
   **native** pre-compaction event or a compact-boundary entry for the locked
   session (`fold-aborted: compaction`; 9.5 takes over; a `synthesized`
   threshold crossing on an engine without a native event does not abort), or
   an epoch or generation change aborts the fold.
6. **Replace** by the ladder rung in use (9.2).
7. **Probe** (section 10), each turn within its wall-clock bound; a judge call
   past the point of no return holds a **non-preemptible** `LlmQueue` slot (an
   extension to the queue's preemption rule, Phase 0) so interactive load
   cannot abort it. On pass, **commit** the staged store writes (fenced by
   epoch and generation), release lock, hold and marker, deliver held inbound.
8. **Rollback.** On rung 2, end the candidate and **un-suspend** the old
   session. On rung 1, first end the seeded candidate and confirm it is gone
   (tmux absent, `hasLiveToolShell` false), then restore from the **engine
   checkpoint**: resume the recorded session id only when its transcript's last
   entry id still equals the checkpoint's; otherwise **materialise** the
   checkpoint as a new session transcript in the engine's transcript directory
   and resume that (one uncached full-context read, counted; Phase 0 verifies
   the restore per rung and per engine version). If the restore itself fails,
   respawn through the spawn path with the last committed packet plus the
   verbatim tail and record `rollback-degraded`. Discard the staged store
   entries (listed in the sidecar); deliver held inbound; apply the per-topic
   rollback backoff. After K consecutive rollbacks the topic **drops to shadow
   mode** and the breaker raises one notice (13.2). **Re-arm**: a PIN-gated
   tap on console Settings → Context (a `needs-model.js` row; never from chat
   text), or automatically at most once per topic per day on a `settled` entry
   (not `derived-settled`) bound to an operator row that post-dates the trip.

**Quarantine.** If the lease expires, or a step's bound or hard maximum
passes, while a seeded candidate is live (`replacing` or `probing`), the record
moves to `quarantined`: the fold hold, the markers and the inbound hold **stay
in force while the record is non-terminal**, nothing is committed, and the
owner's sentinel takes over through a **coordinator handover**: the
`FoldCoordinator` on the same machine transfers the keyed lease to the sentinel
with a new generation under the same `foldId` (a handover, not a re-acquire,
because the lease store refuses to acquire a lease it still considers held by
a live peer), and the sentinel runs step 8; non-owner sentinels observe only. A hung
coordinator that cannot perform the handover falls to lease expiry, after which
the boot sweep or the sentinel's next tick takes the record as `quarantined`. Reconciliation has a
numbered bound (default 15 minutes, Defaults). If step 8 cannot confirm the
candidate is gone within it, the sentinel **force-ends** the candidate and
**verifies termination** (tmux absent, no live child process, no transcript
growth for one tick); only then does it take the `rollback-degraded` path,
release the holds and raise one notice (7.8). If termination cannot be
verified, containment **stays**: the hold, the deny-all marker and the inbound
hold remain, the record stays `quarantined`, and the sentinel escalates to the
operator through the Attention queue with the topic named; nothing is released
on an unknown. Holds are released only by a terminal record, never by expiry
alone.

**Fencing.** Every session mutation, commit, and release of a hold or queue is
fenced by the ownership epoch **and the record's current lease generation**
(the one written at step 1 or at the quarantine handover).
On ownership or lease loss the old owner **stops**; the new owner's ownership
sweep reconciles the durable fold record (rollback by default).

**Held inbound.** Rows live in the Durable Inbound Message Queue with a `hold:
fold` reason and the `foldId`; a held row's `entryTtlMs` clock is **frozen**
while its fold record is non-terminal, and the drain **refuses to release a row
whose fold record is non-terminal** (the record, not sweep ordering, is the
gate). The per-reason maximum hold is the configured maximum lock TTL ceiling
plus the reconciliation bound, exempted from the `holdMaxMs < entryTtlMs`
validator by reason. If the queue is dark at a later boot and gate-expires a
fold-held row, the fold record moves to `rolled-back` on the same tick and the
loss notice names the fold. In-flight injects live in `PendingInjectStore`
tagged with the `foldId`.

**Judge availability.** If the audit or probe model is unavailable (provider
down, `LlmQueue` admission refused) before the point of no return, **no fold
runs** (`fold-skipped: no-judge`). A judge call aborted by interactive
preemption (`LlmAbortedError`) or refused admission **after** the point of no
return holds a non-preemptible slot and is retried within the step's bound; if
it still cannot run, the fold **rolls back** (terminal), recorded
`fold-deferred <!-- tracked: CMT-1536 -->: judge-preempted` and **excluded from the breaker count**. A day with zero folds on an eligible topic
is a sentinel row (7.8) and surfaces in the degradation digest.

### 9.4 What survives a clear or a respawn

Background shells, subagents, scheduled wakeups, todo state and read-file
tracking may not survive `/clear` and do not survive a respawn. Their absence
is a 7.3 precondition; the handoff records any that were paused so the reseeded
session can re-arm them; Phase 0 measures exactly what is lost per rung.

### 9.5 Backstop for unplanned compaction, and the standing packet

Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for topic sessions at spawn time (running
sessions keep their window until respawn; Phase 0 records precedence against an
`autoCompactWindow` persisted in settings) to a generous default (400K; `basis:
external-constraint; evidence: Claude Code compacts at ≤ 1M regardless; range
100K–1M`; the value is a config default with the dark-window review in the
Maturation plan). The PreCompact steering hook adds pre-rendered instructions to
every compaction: keep the Anchor, the ledger rows, the in-flight work.

Because an unplanned compaction has no handoff, no stage step and no verbatim
tail, every topic keeps a **standing packet**: re-rendered and verified on every
layer commit, with the tail defined as empty and Claude's `compact_summary`
standing in for it. The **PostCompact** hook archives the pre-compaction span
(deduplicated), enqueues a chunk built from that span through the 6.5 sampler,
and rebuilds H1 and H3 if the `LayerUpdate` lane admits them in time; otherwise
the packet carries the previous committed H1 and H3 plus an explicit
"unsummarized gap: entries X..Y, chunk pending" pointer. Then the `SessionStart`
(`compact`) hook re-seeds the standing packet, which is the only thing that
restores U. **Oversize on this path cannot refuse** (the compaction has
happened): the hook seeds a **declared reduced packet**, dropping H3 in favour
of C2 first, then the chunk list, with in-band disclosure of what was reduced,
protected class last and only with disclosure, and the server schedules a
respawn fold (9.2 rung 2) at the next clean stop to restore the full packet.
The reduced variants are **pre-rendered** beside the standing packet whenever
it exceeds the compact-path limit (the 5 s hook only reads). Where no fold can
run (Phases 1 and 2, shadow mode after a breaker trip, a rung-3 machine), the
**delta hook carries the dropped protected items** over the following prompts,
bounded per prompt, until the packet is whole, with the deficit on the card;
never an instruction to the session to fetch its own protected text.
The window is lowered **per machine**, only where the canary is `healthy` and
delivered packet bytes match staged bytes on that machine's compact path;
lowering it first would route more compactions into a broken path.

### 9.6 Engine adapters: the harness-adapter contract

The feature is engine-agnostic by construction. Everything in sections 6, 7,
8, 10 to 15 is framework-neutral; each engine supplies one **harness adapter**
with these capabilities, each declared `supported`, `partial` (with the exact
behaviour named per row), `synthesized` (Instar derives it, the engine does
not provide it) or `absent` per engine version, verified by the **adapter
verification suite** (the Phase 0 checks made re-runnable; runner: a `FoldCoordinator`
job on a **throwaway headless session**, never a channel topic; triggers:
adapter build and any change of the retained engine binary version; results
stored in the layer kind keyed per `(machine, engine, version)` and
transferable between machines sharing the same retained binary; cost bound:
one throwaway session per run):

| Capability | Claude Code adapter | Codex adapter (as the code stands today) | `absent` / `partial` outcome |
|---|---|---|---|
| Transcript read (entries, ids, background start/completion; cache counters where the engine writes them) | the session JSONL (`TokenLedgerPoller`) | the rollout read-then-tail bridge and the ledger's Codex scan: `supported` for entries and ids; cache counters `absent` (see the cost-model row) | no transcript ⇒ no estimator, no clean stop, no fold |
| Control-command inject (`/compact`, `/clear`) | `injectInternalControlCommand` | `absent` (`triggerCompact` throws `UnsupportedCapabilityError`) | rung 2 only |
| Compaction detection | native `PreCompact` hook plus the transcript channel | `synthesized` (`trackContextUsage` fires at 85% of an assumed 200K window, with no callers wired today) plus the transcript channel | synthesized ⇒ counted by the canary, never healed by injection; Phase 1 wires the caller |
| Pre-compaction steering | `PreCompact` + `newCustomInstructions` | `absent` (the engine takes no instructions) | the standing packet is the only recovery; the window is not lowered |
| Post-compaction event with the summary | `PostCompact` hook | `absent` (`postCompactEmitter` has no producer; no summary is exposed) | the tail of the standing packet is empty; detection comes from the transcript channel |
| Fresh-context seed after compaction | `SessionStart` (`compact`) hook reading the staged file | `absent` (a verified sibling spec records that Codex `SessionStart` does not fire on compaction); **the real carrier is the `UserPromptSubmit` hook**, which delivers the standing packet on the first prompt after a detected compaction | seed by next-prompt delivery, disclosed in the packet marker |
| Fresh-context seed after clear (rung 1) | `SessionStart` (`clear`) | `absent` | rung 2 only |
| Spawn with initial context (rung 2) | `formatContextForSession` injection point | the same spawn path: `supported` | no spawn ⇒ rung 3 |
| Materialise-and-resume restore (rung 1 only) | project-hashed JSONL directory + resume | `partial` until the Phase 1 suite verifies the rollout format resumes | no restore ⇒ rung 1 unavailable; rung 2 (un-suspend) unaffected |
| Compaction window setting | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `autoCompactWindow` | `absent` | no backstop; recorded |
| Per-prompt delta injection | `UserPromptSubmit` hook | `UserPromptSubmit` hook: `supported` | no delta ⇒ full briefing each prompt and no reduced-packet carrier ⇒ window not lowered |
| Per-session tool policy for probe and handoff turns | PreToolUse hook with the marker file | PreToolUse with matcher `.*` (installed today): `supported` | truly `absent` ⇒ **no fold** (rung 3): a candidate spawned with the agent's bearer and open network is not containment |
| Clean-stop signals (idle prompt, subagents, child processes) | pane pattern, SubagentTracker, `hasLiveToolShell` | pane pattern and child processes: `supported`; subagents: `partial` (no tracker; a child-process check and the handoff attestation stand in, so the signal is `none-observed`, not `unknown`) | a truly unobservable signal ⇒ not clean |
| Cost model (cache pricing and TTL for the estimator) | first-party pricing table | `partial` (no cache accounting exposed) | the cache-blind conservative estimator (7.2) applies; `unknown` is reserved for poller lag |
| Framework discriminator | `INSTAR_FRAMEWORK` | same: `supported` | `unknown` branch |

The Claude Code adapter is the first implementation. **The Codex adapter is in
Phase 1 scope** (Justin, 2026-11-09 15:59: engine-agnostic): Phase 1 wires the
`trackContextUsage` caller, builds a post-compaction producer from the
transcript channel, and routes the standing packet through `UserPromptSubmit`;
the adapter verification suite then records the table above as measured, and
**a per-engine minimum of shadow folds** (default 20) is required before Phase 4
enables that engine. Capabilities the engine lacks degrade to the rung the
table names and are recorded, never silently assumed. A later engine plugs in
by implementing the same table. The CLAUDE.md template and reference files describe the
feature by capability, not by engine.

### 9.7 The layer store and transcript archive

Two sibling roots, both mode 0o700 with files 0o600 (as `IdentityKeyFile`
does): `.instar/state/context-layers/<topic>/` for the small layers (A, G, C,
C2, U stubs, H1–H3), fold records and sidecars, PostCompact summaries and probe
records (question, answer, reference span, grade); and
`.instar/state/context-archive/<topic>/` for the compressed per-span transcript
files. Everything written to either passes `durableSecretScrub.scrubForStore`
**per transcript entry per text field** before compression (never a whole span
as one field: the scrub's 1 MB oversize fail-safe would otherwise redact the
archive entirely), **plus a live-value pass** against the agent's own secrets
(auth token, lifeline secret, secret-store values), because shape patterns miss
`KEY=value` dumps and this is the first durable store of raw tool output under
`.instar/`. An oversize field is kept as a pointer with its size, disclosed. **Protected
records are references, not scrubbed copies**: A, G and U are stored in the
layer store as row references (message id, hash, length) and rendered into the
packet **from the TopicMemory rows themselves** at stage time, so the verifier's
byte-identity check is against the source row, never against a scrubbed copy;
the packet file is transient under the lock (0o600, deleted on commit or
rollback, never served or replicated), and only derived projections (H1–H3, C,
C2, stubs, probe records, PostCompact summaries) and the retrieval archive are
scrubbed. A protected row that contains a live secret is still the operator's
row; it is carried verbatim in the packet and in TopicMemory, and the archive's
scrubbed projection of it is marked `scrubbed` so a lookup never claims to be
the original.
`.instar/state/` is already gitignored and never git-synced; both roots are
added to the File Viewer's `NEVER_SERVED_PREFIXES`; `state/context-layers/*/`
is added to backup `includeFiles` as the directory entry `state/context-layers/` (a glob with a wildcard in a middle segment is silently skipped by the backup manager) and `state/context-archive/` is **not**
(the derived layers are LLM outputs; A, G and U are row references into
TopicMemory, so `topic-memory.db*` (the WAL set, the glob shape the backup manager
already uses for two other databases) **joins the backup** `includeFiles` with
this feature; fold records and sidecars are listed in `NEVER_BACKUP_PATH_SEGMENTS`
so a restore never resurrects a fold in flight; the archive is declared
reconstructable-or-lost, and on a single-machine agent a disk loss rebuilds the
derived layers from the backup's rows plus `pre-layer` chunks; the
`checkpoints/` directory is excluded from backup and sits under the same Disk
Steward category). The scrub also runs on every `/topic/:id/transcript` read.
Dashboard team members and guests never reach either root. Retention is a new
Disk Steward category (a code addition to the closed `CategoryId` union plus a
forecast row): raw spans are kept while any chunk points at them; evictable
oldest-superseded-first under the steward's forecast, never the current phase's
spans; an evicted span leaves its chunk marked `raw-evicted`; archive bytes per
topic appear on the dashboard card. The `FoldAudit`, `FoldProbe` and
`LayerUpdate` components run under an **`enforced` routing plan** pinned to the
conversation's own provider family, which the non-gating failure swap already
excludes, so handoffs, folded spans and U never cross to a vendor the
conversation never used.

## 10. Verifying retention: the held-out probe

A readback ("state the goal and next step") tests recitation of a packet the
session was just handed. So:

1. **Before the fold** (9.3 step 4): deterministic verification against the
   store.
2. **Question generation at stage time**, from the **folded spans the handoff
   named**, through the 6.5 sampler (default 30K tokens; floor: every
   handoff-named decision, evolution and "still needed verbatim" item is always
   in the sample). In addition, an **independent sample** is drawn from the raw entries the
   sampler excluded, stratified across the folded span (default 20% of the
   question budget), so the probe can fail on something neither the handoff nor
   the sampler named; coverage (share of the span represented) and sampled
   loss are reported separately on the card (11); a `lost` item from the
   independent sample follows the same correction and rollback rules as a named
   item. Questions are typed: `constraint`, `rejected-approach`,
   `open-thread`, `detail`; an item sourced from a ledger entry, an H1 next step
   or a still-needed item is never `detail`. Count: at least one per finished
   span and per open thread (floor 1), with a deterministic ceiling set by the
   `FoldProbe` budget.
3. **After the seed**: the reseeded session answers them using the packet and
   the mediated lookups only (file-reading tools are denied for the turn, 10's
   policy; an attempted read of the checkpoint or archive is a denied, counted
   event and the Tier 2 tests include one), each probe turn within its
   wall-clock bound. Grades are constrained to `retained`, `retrievable`,
   `lost`, and **delivery and behaviour are tracked separately**: a deterministic presence search of the
   packet bytes corrects a grader's claim that an item was *absent* (a false
   "not delivered" diagnosis), but a wrong or missing *answer* about a
   constraint that is present stays `lost`; presence never converts a failed
   behavioural probe into a pass. **`retrievable` passes only for `detail`
   items**, and only when the lookup call actually appears in the transcript
   (the corroboration); constraints, rejected approaches and open threads must
   be `retained`, and a lookup used to answer one of them caps that item at
   not-retained.
4. **Corrections land in the staged store and reach the answerer.** A
   non-retained item is patched into the staged chunk or the staged H1 ("still
   needed") as `author: derived` with its reference span; ledger patches may
   only be `pending`; the store is re-verified; then the corrected packet is
   **delivered**: on rung 1 as a lock-window turn into the live session (the
   per-prompt hook is suppressed, so this is the only path), on rung 2 by
   restarting the candidate from the corrected packet. The item is re-probed
   once. The correction's cost is counted in the fold's term.
5. A `lost` **protected-class item** (an Anchor row, a ledger row, a U message)
   rolls back immediately (`basis: irreversible-consequence; evidence: the
   user's words left the live context`). Any other `lost` gets one correction
   and a second probe on that item; the grader may grant one more correction
   for a `detail` item only; a second `lost` rolls back (9.3 step 8).

The probe grader is **tier 1** (section 15): grades are an enumerated set, every
decision logs question, answer, reference span and grade (under 9.7), and a deterministic rule (protected-class lost ⇒ rollback; byte presence corrects only an "absent" diagnosis, never a wrong answer) sits above the model's grade. **Shadow mode** (Phase 2 and the breaker's
shadow state) answers the probe in a **throwaway headless session seeded with
the staged packet**, running the live session's model (so the would-be `lost`
rate predicts live behaviour), under the same fold-marker tool policy, with a
read-only lookup token bound to a **synthetic non-channel place** for the topic
(the memory session guard's channel places are group-wide, so a new place kind
is added) and spawned with `omitAuthEnv`, costed on its own budget line and
counted in the Phase 2 break-even measurement; the live session is not the
answerer.

**Suppression carrier.** The handoff turn and the probe turns are internal. The
unit of suppression is the **lock window**: the fold record's sidecar stores
transcript entry bounds from handoff injection to lock release (and the short
`prepared` window around a warm-cache handoff), and every consumer on an
enumerated allowlist (TopicMemory ingestion, the intent extractor and its
ticks, H1 updates, the ledger, attribution trace, correction learning,
`TokenLedger` tagging, the per-prompt hook) skips that range, not merely marked
turns.

Egress is held by a **fold hold**: a per-topic record keyed by `(topic,
foldId)`, independent of `monitoring.standDown`, never `dryRun`. **The primary
check is on the topic owner**, where the probe session's send originates and
the hold is a local fact: in `evaluateOutbound` (the single funnel every
channel passes), in `authorizeTelegramSessionSend` (which runs **before the
relay fork** that `checkOutboundMessage` skips when the origin will relay to
the lease holder), and in the prepared-transport `review` before any forward,
backed by an **in-memory known-holds set** written at lock time and rebuilt
from the records at boot. The lease holder's chokepoint reads the replicated
hold as defence in depth. Fail direction, **scoped**: a send for a topic whose
hold is held and unexpired is refused with `fold-hold` and audited; if the hold
store is unreadable, only topics whose **last successfully read** state was
held are refused, for as long as that fold's record is known non-terminal, and
otherwise bounded by the configured maximum lock TTL ceiling from the first
unreadable read (or a stated constant when none was ever read); a read
error with no last-known hold for the topic ⇒ allow, audit
`fold-hold-unreadable`, degradation record; sustained unreadability is a
sentinel watcher (7.8; heal: re-open the store; notify on exhaustion). The
enumerated paths that bypass `evaluateOutbound` (the `refuseIfCredential`
callers) carry no session-authored text and are listed in the build.

Tool use in the probe and handoff turns is governed by a **fold-marker tool
policy** of its own (for Claude Code a PreToolUse hook), **session-scoped by a
marker file** the owner writes at prepare or lock time (foldId, the Instar
session id from `INSTAR_SESSION_ID`, never the engine's own session id, which
can rotate at a clear; an expiry equal to the lock TTL ceiling that is
**ignored while the fold record is non-terminal**, so containment is sticky for
an unresolved fold and is removed only by a terminal record), not by a server
query: no marker ⇒ the hook allows and exits (every other session is untouched,
including the lifeline's); a malformed marker ⇒ deny; marker present ⇒
a **strict command-shape allowlist, match-fail-closed** (the doorway-scan
guard's shape): **no file-reading tools at all** during a probe turn (file read, glob, grep and
web fetch are denied, because the engine checkpoint, the archive and the layer
store sit on the same disk and a read of them would count as retention), only
shell invocations whose argv is exactly a `GET` to a localhost lookup route by
prefix (the mediated, logged lookups, which are what `retrievable` counts); **deny by default** everything else, including file
writes, sub-agents, `bash -c`, `python3 -c`, `node -e`, compound
commands, URLs built from variables, any `curl`/`fetch` to `/telegram/*`,
`/slack/*`, `/deliver*` or `api.telegram.org`, the relay script and the
message-sending MCP tools; a stale marker past its stamped expiry ⇒ **deny while the local fold record for its `foldId` is non-terminal**, allow and record once it is terminal.
The audited refusal count per fold and the allowed lookup count are the
artifacts that prove suppression ran, and they come from the **owner's**
refusal log.

## 11. Measurement

Recorded per session and per topic, shown on one dashboard card (console
Settings → Context, with rolled-back folds, breaker trips awaiting re-arm,
pending Anchor confirmations and `checkpoint-unreachable` events joining Home's
count through `dashboard/console/needs-model.js`):

- tokens per turn, **cost-weighted** (cache read, cache write, uncached input at
  their relative prices), before vs after rollout, **including the fold's own
  calls** (handoff, audit, probe generation, probe turns, grading, cadence
  ticks, chunk builds);
- live context size over time; folds per day by who declared the milestone
  (session, signal, critical checkpoint), estimated vs realised break-even,
  asks per fold, declines, `fold-skipped: no-judge` / `no-hold-queue`,
  `fold-deferred <!-- tracked: CMT-1536 -->: judge-preempted`, `fold-path-unavailable`, `fold-aborted:
  compaction`, `checkpoint-unreachable`;
- probe results by item type: retained / retrievable / lost / rolled back, with
  the independent sample's loss reported beside the named-item loss and the
  span coverage share;
- **rework**: files re-read and commands re-run in the 30 turns after a fold vs
  baseline, computed in the `TokenLedger` scan (eventually consistent);
- lookups used after a fold, by route; archive bytes per topic; replicated
  layer bytes per topic;
- **user-content retention**: share of operator messages verbatim in context;
  U size per topic; count ever folded (expected zero);
- **Anchor stability**: evolutions by cause and effect; tentative, confirmed,
  unconfirmed, withdrawn, expired; backfilled-unconfirmed count;
- extractor calls and tokens per day by trigger; LlmQueue component spend per
  feature (`FoldAudit`, `FoldProbe`, `LayerUpdate`) against the fold cap;
- canary state per machine; user corrections in the 30 turns after a fold vs
  baseline.

These are evidence for the rung-review judgment in section 16, not trip-wires.
The bar the pilot must show before the fleet rung: cost-weighted tokens per turn
on long topics down by at least half; `lost` under 5% across at least 40 folds
with no unrecovered rollback; no rise in rework or corrections; zero
user-content folds.

## 12. Decision points touched

> Each row: classification; basis or floor + arbiter; evidence. Numbers that are
> policy defaults are listed in section 13's Defaults table with the measurement
> that may later replace them.

| Decision point | Classification | Floor / basis | Arbiter |
|---|---|---|---|
| Fold / no fold (7.2) | judgment-candidate | floor: no fold below break-even (consequence: costs more than it saves); affirmatively clean stop (7.3); no judge ⇒ no fold; no live hold queue ⇒ no fold; estimator `unknown` beyond the poller tolerance ⇒ no fold | benefit estimator + session veto; last rung deterministic (no fold) |
| Exclusive session (9.3) | judgment-candidate | floor: refuse when ownership is unverifiable or a peer that has served the topic is unreachable; a peer presumed dead and named by no ownership record counts as no session; residual: a waking twin receives no inbound and is bounded by the fence | `isPeerPresumedDead` + ownership record |
| Replicated record caps (14) | invariant (ceilings) | `basis: external-constraint; evidence: the journal applier cap (DEFAULT_MAX_ENTRY_BYTES 8 KB, per-kind raise to 64 KB) and the 80 KB wire limit`; state transitions never size-refusable; G per entry; H3 over cap ⇒ rebuild under a tighter C2 selection with disclosure | deterministic |
| Sentinel actions (7.8) | judgment-candidate | floor: only the pre-declared `SelfHealGate` remediation actions, owner-only, each with the gate's brakes; never writes a layer, never authors a handoff, one notice per exhausted ladder | the gate's ladders; operator on the notice |
| Fold record transitions (9.3) | invariant | `basis: enumerable-domain; evidence: compare-and-swap on (foldId, step, generation) by the owner's FoldCoordinator; any other writer is refused; every carrier's lifetime follows the record` | deterministic |
| Folds past the point of no return per machine (9.3) | invariant (ceiling) | `basis: external-constraint; evidence: the LlmQueue background lane's concurrency (maxConcurrent 3), of which at most one slot may be non-preemptible without starving interactive work`; default 1; a second fold at step 5 ⇒ `fold-skipped: machine-busy` | deterministic |
| Milestone / pin control rate (7.1) | judgment-candidate | floor: excess controls are **coalesced** into the next ask, never refused; default 6 per topic per hour | deterministic brakes |
| Quarantine reconciliation bound (9.3) | judgment-candidate | floor: holds stay until a terminal record; default 15 minutes then force-end, rollback-degraded, release, one notice | the owner's sentinel |
| Engine capability resolution (9.6) | invariant | `basis: enumerable-domain; evidence: each adapter capability is supported/partial/synthesized/absent per (machine, engine, version) from the verification suite`; each value maps to a named outcome; absent tool policy ⇒ no fold | deterministic |
| Clean stop (7.3) | judgment-candidate | floor: tmux present + pane idle + no in-flight tool + SubagentTracker empty (or, where no tracker, child-process check plus attestation) + no live child process (`hasLiveToolShell`) + every transcript background start matched by a completion + handoff attestation consistent + inbound empty + CommitmentTracker next-due beyond measured duration × factor; any `unknown` ⇒ not clean, counted toward Cap 1 | deterministic floor; the handoff attestation is the judgment input |
| Milestone accepted as finished (7.1, 7.4) | judgment-candidate | floor: contradicted by a deterministic signal (open PR, red test, open commitment) ⇒ demoted to tail | handoff audit model (signal); deterministic demotion rule |
| Handoff audit send-back (7.4) | judgment-candidate | one send-back as a cost default (consequence: a second full-context turn); one more only for a protected-class defect; second deficient handoff ⇒ demote contested spans or decline | audit model; deterministic trigger for the extra send-back |
| Evolution cause/effect classification (6.1) | judgment-candidate | floor: tentative on write; authority only by qualifying user episode (v14 weights); narrowing always surfaced; silence never confirms; user-directed never reverts by timeout | TopicIntent evidence model; user |
| Row binding for A and G (6.2) | invariant | `basis: enumerable-domain; evidence: an operator-authored row (from_user=1, forwarded=0, operator person key); no other write path reaches A or a settled state` | deterministic binding |
| Decision transition (6.2) | judgment-candidate | floor: only stub `kind` answer/directive may settle; result is `derived-settled` until a qualifying user episode; question/hypothetical/rejection/other ⇒ pending; derived-settled never re-arms the breaker | tier-1 stub writer (signal); user episode (authority) |
| Ledger live-set selection (6.2) | judgment-candidate | floor: superseded/withdrawn/expired archive first; settled entries referenced by the current phase or the last N operator turns never archive; age last | handoff audit model |
| Pending evolution expiry (6.1) | judgment-candidate | floor: never before surfaced once and ≥ 1 user message since; default 7 days from surfacing; user-directed entries become `unconfirmed`, never lapse | deterministic clock above the floor |
| H2 presence (6.3) | invariant | `basis: enumerable-domain; evidence: the extractor's arc records` | deterministic |
| Probe grade (10) | judgment-candidate | floor: enumerated grades; protected-class lost ⇒ rollback regardless of grade; delivery and behaviour tracked separately (byte presence corrects an "absent" diagnosis, never a wrong answer); retrievable only for detail with a logged lookup; ledger/H1/still-needed items never detail | grader model (tier 1) |
| Probe count (10) | judgment-candidate | floor: ≥ 1 per finished span and open thread; ceiling: `FoldProbe` budget | generator |
| Rollback (9.3 step 8) | invariant | `basis: irreversible-consequence; evidence: a lost protected-class item means the user's words left the live context`; second lost on any item | deterministic |
| Consecutive-rollback breaker (9.3) | judgment-candidate | floor: K = 2 within 24 h ⇒ shadow mode; re-arm by PIN-gated tap, or once per day on a `settled` (not derived-settled) operator-bound entry post-dating the trip; judge-preempted rollbacks excluded | deterministic trip, operator re-arm |
| Fold lock TTL and quarantine (9.3) | judgment-candidate | floor: base ≥ Phase-0 p95 fold duration (consequence of shorter: successful folds aborted); renewed while a step reports progress; each step has a wall-clock bound; expiry beside a live candidate ⇒ `quarantined`, holds kept until reconciliation | deterministic |
| Inbound hold during fold (9.3) | invariant | `basis: irreversible-consequence; evidence: a message delivered into a half-replaced context is answered from the wrong state`; released only when the fold record is terminal (data-coupled); row TTL frozen meanwhile; bounded by the lock TTL ceiling plus reconciliation; arrival before the point of no return aborts | deterministic |
| Critical checkpoint distance (7.2) | judgment-candidate | floor: turns-to-wall against the effective auto-compact window ≥ one handoff turn + one packet write; bounded requests (3) then `checkpoint-unreachable` | benefit estimator; last rung Claude Code's window |
| Backstop window (9.5) | invariant (cap, named) | `basis: external-constraint; evidence: Claude Code compacts at ≤ 1M regardless; range 100K–1M`; default 400K is a config default with a dark-window review | deterministic |
| Protected last-N operator turns (8) | invariant (floor) | `basis: irreversible-consequence; evidence: a folded user turn cannot be re-asked`; N = 20 | deterministic |
| U digest trigger (8.1) | judgment-candidate | floor: never below the last N; trigger min(100K operator tokens, one third of the rung's measured delivery limit); measured, deferred <!-- tracked: CMT-1536 --> | Echo at rung review |
| Cadence tick (6.4) | judgment-candidate | floor: ≤ 4K tokens input, scrubbed, disclosed; minimum interval growing with recent updates; skip mid-turn | deterministic brakes above the extractor |
| Ask rate (7.2) | judgment-candidate | floor: per-topic backoff after veto; hourly cap; coalesce with next natural turn | deterministic brakes |
| H3 rebuild input (6.5) | judgment-candidate | floor: open and current-phase chunks are never dropped for budget; default 24K is a cost default under `LayerUpdate`; C2-only ranges disclosed in-band | `LayerUpdate` budget |
| Chunk / probe-generation sampler input (6.5, 10) | judgment-candidate | floor: every handoff-named or ledger-named item in the span is always included; default 30K is a cost default; sampling disclosed on the chunk | `FoldProbe` / `LayerUpdate` budget |
| Packet oversize on a fold (9.2) | invariant | `basis: irreversible-consequence; evidence: a truncated protected class is a silent cut (P24)`; refuse, never truncate | deterministic |
| Packet oversize on the compaction path (9.5) | judgment-candidate | floor: protected class reduced last and only with in-band disclosure; a respawn fold is scheduled to restore the full packet | deterministic reduction order |
| Fold ladder rung (9.2) | invariant | `basis: enumerable-domain; evidence: Phase 0 pass/fail per rung per machine per installed Claude Code version` | deterministic |
| Probe/handoff suppression (10) | invariant | `basis: irreversible-consequence; evidence: a leaked probe is a user-facing incident`; fold hold checked first on the owner, scoped to topics with a known hold, sticky-last-known under store faults with a TTL-ceiling bound; marker-file tool policy scoped to the marked session, match-fail-closed, a stale marker denies while its record is open | deterministic |
| Archive retention (9.7) | judgment-candidate | floor: never evict a span a chunk points at while the phase is current; chunk marked raw-evicted on eviction | Disk Steward |
| Rollback notice (13) | invariant | `basis: enumerable-domain; evidence: failed rollback or breaker trip ⇒ one line in the topic through the outbound gate; successful rollback ⇒ dashboard + Home count` | deterministic |
| Fold controls (7.1) | invariant | `basis: enumerable-domain; evidence: accepted only from the topic's own live session (place binding); refused while a lock is held` | deterministic |
| Phase / rung advance (16) | judgment-candidate | floor: the section 11 bar and the Maturation plan's graduation criterion; Run C gated on a one-tap operator approval | Echo (rungs 1–2), operator (fleet) |

## 13. Frontloaded Decisions

Decisions the build would otherwise stop to ask. Each is Echo's, attributable
to this spec, reversible as stated; Justin's approval of the spec approves them
in bulk, and any answer he gives in topic 141133 replaces the default.

1. **Pilot topic:** the build desk, with the Instar App topic in shadow
   alongside as the worst cost case. Reversible: config.
2. **Rollback visibility:** a successful rollback is a successful self-heal
   (P22): dashboard card plus Home's count, no topic message. A **failed**
   rollback or a breaker trip sends one line to the topic through the ordinary
   outbound gate and quiet-by-default rules, at most once per backoff span.
   Reversible: config.
3. **Insight-derived evolutions:** additive ⇒ mention in the next natural
   reply, confirmed by agreement; narrowing ⇒ explicit yes. Never confirmed by
   action or silence. User-directed entries never revert by timeout.
   Reversible: rule table in 6.1.
4. **Backstop window:** set per machine only where the canary is `healthy` and
   compact-path delivery is intact; default 400K with the dark-window review in
   the Maturation plan; set by whichever lever Phase 0 shows takes precedence
   (the spawn env var or a persisted `autoCompactWindow`). Reversible: one
   setting.
5. **Numbers:** every number in section 12 is a floor with a basis line or a
   judgment input; policy defaults are in the Defaults table below with the
   measurement, if any, that later replaces them.
6. **Fold path:** the three-rung ladder of 9.2, chosen per machine and Claude
   Code version by Phase 0 results; oversize on a fold ⇒ refuse; oversize on
   the compaction path ⇒ declared reduced packet then a respawn fold.
7. **Small models:** the small-model tier of the conversation's own provider
   family, through `LlmQueue`'s background lane under a
   **dedicated fold reserve** (`contextBudget.fold.dailyCents`: a reserved
   share of the background lane for the fold components, not merely a ceiling
   under the shared cap; interim value in the Defaults table, replaced by Phase
   1's measured chunk and tick spend plus Phase 2's measured per-fold cost;
   `maxDailyCents` raised by the same amount in the same migration so no other
   consumer loses headroom), per-component budgets
   (`FoldAudit`, `FoldProbe`, `LayerUpdate`), a per-topic daily fold-token
   ceiling (an `enqueueMetered` extension) that defers rather than skips
   silently, pinned to the conversation's provider family and swap-ineligible,
   and `/metrics/features` rows under those names. No fold without a judge.
8. **Run boundaries and arbiter:** Run A = Phase 0 + Phase 1 + Phase 2. Its
   live effects are: the 9.1 fix on the test and dev agents, sampled handoff
   turns, cadence and chunk spend, backfill confirmations folded into replies.
   Run B = Phase 3 (pilot live), started by Echo **once Phase 2's exit
   criterion is met** (not merely Phase 0's checks), with the evidence posted.
   Run C = Phase 4 (fleet default), started only on a one-tap operator approval
   bound to the section 11 numbers. The run ends there by design.
9. **Backfill:** Anchor and ledger from TopicMemory only, background lane;
   `backfilled-unconfirmed` entries are usable and labelled; confirmation is
   folded into the next reply in active topics, never standalone, never
   blocking; raw-history chunking only for the pilot topic.
10. **Config switches:** `contextBudget.enabled` (layers; Phase 1 on),
    `contextBudget.fold.shadow` (Phase 2 on), `contextBudget.fold.enabled`
    (Phase 3 on for the pilot, Phase 4 default), `contextBudget.fold.dailyCents`,
    `contextBudget.backstopWindowTokens` (null until decision 4's condition
    holds per machine), `contextBudget.compactionRecovery.enabled` (default
    **on**, per 9.1 and decision 11; the switch is for rollback),
    `contextBudget.deltaHook.enabled`
    (per machine, after the shadow comparison). All live-read where the
    component permits, otherwise restart; each has a `migrateConfig` entry and
    the dark-window in the Maturation plan. The hooks read the switches and fall
    back to full-context mode when off; H3 becomes the summary table's writer
    under `contextBudget.enabled`, and the summarizer's writer is disabled at
    the same moment.
11. **The 9.1 fix ships live** (User-Facing Fixes Ship Live, cited by the
    conformance gate): default on once Phase 0's synthetic positive control
    and L7 transcript pass on the test agent; the switch exists for rollback.
    Until then, and wherever the switch is off, post-compaction behaviour is
    exactly today's (9.1).
12. **Engines:** the Codex adapter is built in Phase 1 against the
    harness-adapter contract (9.6); capabilities an engine lacks degrade to the
    rung the contract names and are recorded. No engine is deferred <!-- tracked: CMT-1536 -->.
13. **Shadow handoffs cost real turns:** Phase 2 asks live sessions for
    handoffs at a sampled rate (default one in three clean stops) with the cost
    stated on the card; those turns are tagged and excluded from the Phase 3
    baseline; the shadow probe is answered by a throwaway headless session
    seeded with the staged packet.
14. **Endpoint shapes** (7.6, 7.1) are additive-only after Phase 1 and
    documented in the CLAUDE.md template and reference files in the same PR;
    their write-domain registrations are listed in section 14.
15. **The pending-confirmation primitive is extended, not forked** (6.1): new
    kind, per-kind TTL, priority with requeue, deferred <!-- tracked: CMT-1536 -->-not-dropped, with tests.
16. **Exclusive-session rule:** the fold lock refuses when more than one live
    session serves the topic, when ownership is unverifiable, or when a peer
    that has served the topic cannot answer; a peer presumed dead and named by
    no ownership record counts as no session (the residual twin is bounded by
    the fence). The duplicate-session auto-heal runs first. Rung 2's suspended
    old session is exempt by `foldId` for the lock's lifetime.
17. **Programme registration:** the five phases are one Project Scope entry
    whose rounds are the maturation rungs, with one tracked commitment and
    beacon per rung review, owner Echo.

**Defaults table** (policy choices behind `fold.shadow`/`fold.enabled`, safe to
change; the measurement that may replace each is named):

| Default | Value | Replaced by |
|---|---|---|
| Break-even margin | 1.5× expected remaining turns over break-even | Phase 2 realised vs estimated break-even |
| Ask cap | 2 asks per topic per hour | Phase 2 asks-per-fold |
| Veto / defer backoff | 30 minutes | Phase 2 decline pattern |
| Rollback backoff; breaker window | 6 hours; K = 2 within 24 hours | Phase 3 rollback causes |
| Checkpoint requests before `checkpoint-unreachable` | 3 | Phase 3 |
| Tick base interval; tool names per tick | 10 minutes; 12 | Phase 1 extractor spend |
| H3 debounce | 10 minutes or per fold | Phase 1 |
| Commitment-margin safety factor | 2× measured fold duration | Phase 0 duration distribution |
| Lock TTL base | Phase-0 p99 fold duration, renewed per step | Phase 0 |
| Per-topic daily fold-token ceiling | 300K small-model tokens | Phase 2 spend |
| Shadow sample rate | 1 in 3 clean stops | Phase 2 |
| Pending-confirmation clock | 7 days from surfacing | Phase 1 |
| Protected last-N operator turns; re-reference N | 20; 20 | floor, not replaced |
| Canary positive observations for `healthy` | 3 per machine | Phase 0 |
| Sampler ceilings | 30K (chunk, probe generation); 24K (H3); selection order: floor items, message ids, agent prose, errors, span tail, then file-path results newest-first, dropped count disclosed | `FoldProbe` / `LayerUpdate` budgets |
| Fold reserve | `fold.dailyCents` interim 150 cents/day, reserved share of the background lane | Phase 1 chunk/tick spend + Phase 2 per-fold cost |
| Poller tolerance for the estimator | valid when the ledger offset is within one poll interval plus 64 KB of the live file size | Phase 0 |
| Backfill daily cap | 20 topics per day, topic-recency order | Phase 1 |
| Veto rate limit | 1 per topic per 10 minutes | Phase 2 |
| Lookup ceilings | 64 KB or 200 entries per page | non-gating, paginated |
| Replicated record caps | derived: per-kind applier raise (≤ 64 KB) for H3 and the fold record sidecars; 8 KB default for C and per-entry G; fold record itself a few hundred bytes | journal constants |
| Replace timing | immediately after the handoff (default); replace-at-next-idle measured per machine | Phase 0 and Phase 2 |
| Probe step wall-clock bound | 5 minutes per turn or judge call | Phase 0 |
| Sentinel breaker | 3 same-cause exhaustions in 24 h ⇒ one notice | Phase 3 |
| Folds past the point of no return per machine | 1 | Phase 2 |
| Step hard maximum | 3× the step's bound | Phase 0 |
| Prepared-record bound (replace-later variant) | the cache TTL | Phase 0 |
| Independent probe sample share | 20% of the question budget | Phase 2 |
| Sentinel heartbeat freshness | 2 ticks (10 minutes) | Phase 1 |
| SelfHealGate episode cap | owned topics × causes × 4, pruned of terminal episodes older than 7 days | Phase 0 |
| Sentinel tick | every 5 minutes over the topics this machine owns | Phase 1 |
| Layer freshness target | H1 ≤ 2 user turns behind; H3 ≤ 1 fold or 24 hours behind | Phase 1 |
| Quarantine reconciliation bound | 15 minutes, then force-end and rollback-degraded | Phase 0 |
| Engine checkpoint grace | 24 hours after rollback | Phase 0 |
| Seed-success bound for the report short-circuit | 30 s after the compact-boundary entry | Phase 0 |
| Shadow answerer budget | 50 cents per day | Phase 2 |
| Per-engine shadow minimum before fleet | 20 shadow folds | Phase 2 |
| Milestone / pin control rate limit | 6 per topic per hour | Phase 2 |

No cheap-to-change-after tags are claimed: every item above either ships behind
a named switch (reversible by config) or is a durable interface decided here.

## 14. Multi-machine posture

Default posture is `unified`. Per surface:

| Surface | Posture | How |
|---|---|---|
| Small layers A, G (per entry), C (open and current-phase), C2, H1–H3, U **referent stubs**, fold records and sidecars, backoff and breaker state, fold holds | unified | a new replicated kind registered in both `JOURNAL_KINDS` and `ReplicatedKindRegistry`; the kind's bounds type gains `maxRecordBytes` and `liveSetBudget` fields (a code addition beside today's `retention` and `rateCap`), with caps **derived** from the journal constants (default applier cap 8 KB, per-kind raise to 64 KB, 80 KB wire), enforced as refuse-never-truncate **only on content records** (a fold record is state and pointers and is never size-refusable; lists live in sidecars; G replicates per entry so the never-archive floor is never cut; an oversize H3 is rebuilt under a tighter C2 selection with disclosure), a live-set budget sized in Phase 1 from measured G/C growth (C older than the C2 range is **proxied-on-read**, below), unique record keys per entry with status changes re-emitting the record (HLC-latest compaction), and the **skew rule**: a holder on a version without the kind refuses the fold (`fold-path-unavailable: layers-not-replicated`) and the move is noted on the card. On topic move the new owner has the topic's layer set through replication and its rows through the relay-path carrier before its first fold |
| Older C beyond the C2 range | proxied-on-read | served from the machine that holds it over the archive's carrier; `/chunks` shows `chunk-elsewhere` and `unknown` on an unreachable peer |
| U bodies and the message-row source | re-derived from rows, with a row carrier | U is rebuilt on the owner from TopicMemory by sender row. **Every channel must have a row writer**: today Telegram's poller writes rows on the lease holder, Slack's writer collapses to one row per channel (its message id is cast to 0 under the unique key) and app conversations write none, so Phase 1 adds a channel-neutral row writer (Slack, app conversations, iMessage and WhatsApp through the same path) with a **key rule** every machine derives identically, because A/G/U references `(message id, hash, length)` must match across machines: TopicMemory gains a nullable `channel_message_id TEXT` through its existing migration path and the integer `message_id` is derived deterministically per channel (Telegram: the native id; Slack: `ts × 1e6`; app and other channels: the replicated HLC of the message), so `UNIQUE(message_id, topic_id)` never collapses rows; a topic on a channel without a row source refuses to fold (`fold-skipped: no-row-source`). Rows are written on the machine whose adapter received the message, so the build **carries the row on the relay path** that already forwards each message to the topic's owner (the existing `deliverMessage` forward-to-owner path, which already carries the message to the owner at least once with a durable receipt; landing in the owner's TopicMemory), with a per-topic **contiguous-ack watermark**; the fold's precondition is that the owner's TopicMemory holds the topic's rows up to its last message id, else not clean ⇒ no fold |
| Engine checkpoint (9.3 step 3) | machine-local | `machine-local-justification: hardware-bound-resource` — a byte-exact engine transcript that only resumes on the machine whose transcript directory holds it; never served, never replicated, never backed up; deleted by the sentinel on commit or after the grace period; a crash leaves it to the boot sweep's orphan pass |
| Ledger entry bodies (operator messages, 6.2) | unified via a chunked carrier for non-owners | the owner renders bodies from its TopicMemory rows (above); for machines that are not the owner the ledger record carries bounded references (row id, SHA-256, length, privacy scope) and the body travels in **chunked content-addressed blobs** through the same replicated kind (each chunk under the applier cap; reassembly bounded by the declared length and verified against the hash before render), so a long directive is never refused; blobs referenced by a live ledger entry are **re-emitted** on each retention rotation so they never age out while live; a body whose chunks have not arrived renders as `body-elsewhere` with its hash on a non-owner's view, and the stage verifier on the owner refuses a packet whose protected row is not present locally |
| `ContextBudgetSentinel` | owner-acts, others observe | one instance per machine; it acts only on topics this machine owns and reads replicated records for the rest; its episodes live in the `SelfHealGate` episode store on the owner |
| Transcript archive (raw spans) | proxied-on-read | spans stay on the machine whose session produced them; `GET /topic/:id/transcript` proxies through peer HTTP (`PeerEndpointResolver`, pool-fan-out auth and classified failures); the serving machine scrubs and privacy-filters before bytes leave; an unreachable machine returns explicit `unknown` and the chunk shows `raw-elsewhere`; a snapshot pulled for a respawn lands in the new owner's archive under the same retention class |
| Resume of a checkpointed session | machine-local | `machine-local-justification: hardware-bound-resource` — an engine session resumes only on the machine whose transcript directory holds it; same-machine restore materialises the **engine checkpoint** (not the scrubbed archive) as a new session transcript and resumes it (9.3 step 8); the cross-machine fallback is a rung-2 spawn with the last committed packet plus the verbatim tail pulled from the scrubbed archive by a dedicated streaming pull (recorded `rollback-degraded`), or refusing the fold until the pull completes |
| Fold lock | unified | a keyed fenced lease (`LeaseStore` generalised with a key that is part of the signed `FencedLease` tuple, so a lock for one topic never verifies for another); `local` medium on a single machine needs no transport; CAS push per step on the `git` medium, measured in Phase 0 |
| Fold gate and egress hold | by topic ownership | a fold runs only on the topic's **owner**: the machine hosting its live session, and in a pool also `ownerOf(topic) === self` with the record active (a single machine is trivially the owner), never "the lease holder"; the egress hold is checked **first on the owner's own chokepoint** before any forward, and again at the lease holder from the replicated record as defence in depth |
| Engine adapters, hook scripts, settings matchers, window settings | unified by build | code-level, identical on every machine running the version; an older machine keeps today's behaviour until it updates |

Write-domain registrations (so `WriteDomainRegistry` and this section cannot
diverge): `POST /topic/:id/fold/*` — owner-only, unified via the layer kind;
`POST` PostCompact record route — any machine (arrives from the session's own
machine), unified; backfill confirmation and breaker re-arm — owner-only, PIN
or reply-bound; `GET /topic/:id/transcript` — proxied-on-read.

## 15. Supervision tiers

| Pipeline | Tier | Validator (deterministic, after every step) |
|---|---|---|
| Handoff audit (7.4) | 1 | every "finished" span's artifacts exist (PR state, test result, file presence) before the LLM audit; output is one of send-back / accept; it never writes A or G; prompts fence the handoff and spans as data |
| Probe generation (10) | 1 | questions typed from the enumerated set; count within floor and budget; every question cites a span inside the folded ranges; ledger/H1/still-needed items never `detail` |
| Probe grading (10) | 1 | grades from the enumerated set; protected-class lost ⇒ rollback regardless of grade; byte presence corrects only an "absent" diagnosis, a wrong answer stays lost; `retrievable` requires a logged lookup call |
| Horizon updates H1/H2/H3, chunk and C2 writes (6, 6.5) | 1 | input bounded and scrubbed (6.4, 6.5) with disclosure; output carries `as of`, `author`, `foldId`/`status`; user text in any layer must be a bound row |
| Referent-stub writer (6, row U; 6.2 `kind`) | 1 | runs inside the extractor's per-message call; stub ≤ one line, bracketed, `author: derived`, references a message id preceding the user message, carries an enumerated `kind`; written beside, never into, the quote |
| Decision transition (6.2) | 1 | only `kind` answer/directive may settle; the result is `derived-settled`; promotion to `settled` requires a qualifying user episode, never a model read |
| `ContextBudgetSentinel` (7.8) | 0 (deterministic) | reads symbols with declared corroboration (17); acts only through the enumerated remediation actions with declared brakes; never calls a model to decide an action |
| Evolution cause/effect classification (6.1) | 1 | logged as a signal with evidence ids; write is `tentative`; confirmation only by a qualifying user episode |
| Anchor/ledger backfill (6.1) | 1 | each backfilled entry bound to an operator-authored row; status `backfilled-unconfirmed` |
| Benefit estimator and remaining-turns input (7.2) | 0 (deterministic) | inputs from `TokenLedger` and a count of H1 open threads; `unknown` when the poller lags |

## 16. Rollout as the maturation ladder

Phases map onto the maturation rungs (`feature-maturation-discipline.md`); no
parallel ladder. Owner for every rung: Echo. One tracked commitment with a
beacon per rung review; the programme is one Project Scope entry whose rounds
are the rungs (13.17).

1. **Phase 0 — build and verify (test-agent-live).** Build the `clear` matcher,
   `/clear` control command, the PreCompact steering hook and PostCompact route,
   the keyed fenced lease, the `FoldCoordinator` with its fold record and boot
   sweep, the fold hold on the shared chokepoints, the fold-marker tool policy,
   the layer kind, the engine checkpoint, the `SelfHealGate` extensions and the
   sentinel skeleton (canary with the transcript detection channel, boot sweep,
   quarantine reconciliation), and the **adapter verification suite**, run for
   Claude Code. Verify
   the 9.1 fix with L7 evidence and the standing canary on the test agent;
   delivery capacity, survival, hook ordering and cost of one fold per rung
   (9.2), both handoff orderings (7.2); Codex hook delivery and the framework
   discriminator; both post-compaction paths counted across the fleet's
   transcripts; the topic-intent layer inventory and its brakes; the asymmetry
   measurement by sender; per-turn token measurement for a baseline. Ends when
   every check has a recorded result.
2. **Phase 1 — layers, always on (dev-agent-live).** Layer store with path,
   permissions, scrub, retention; topic-intent layer on everywhere with a
   freshness check and the 6.4 brakes; Anchor and ledger with backfill; chunks
   on span close through the sampler, C2, H3 as the summary table's single
   writer; U with referent stubs; dashboard card; delta hook in shadow
   comparison; the 9.1 fix live; the channel-neutral TopicMemory row writer
   and the relay-path row carrier (14); the `ContextBudgetSentinel`'s remaining
   rows (freshness, hold health, eligible-topic-without-fold); **the Codex adapter**
   against the harness-adapter contract (9.6): the `trackContextUsage` caller,
   the transcript-channel post-compaction producer, `UserPromptSubmit` seed
   delivery, and its verification suite run and recorded. Ends when the Codex
   suite has a recorded result and the card has shown a week
   of layer freshness within target on the dev agent and the delta comparison
   shows no rework rise.
3. **Phase 2 — shadow folding (dev-agent-live).** The dev agent runs the live
   inbound queue (a step 0 precondition). Sampled handoffs at clean stops on
   Claude Code topics and on at least two Codex topics the operator's
   development agent keeps for this purpose (the per-engine shadow minimum is
   earned there); packets staged and verified; probe questions generated and answered
   by a throwaway headless session seeded with the packet; would-be grades and
   costs recorded. Ends on at least 40 shadow folds with the would-be `lost`
   rate and the measured per-fold cost term.
4. **Phase 3 — pilot (dev-agent-live, one topic).** Folding on for the build
   desk, with a live inbound queue on its owner; Instar App topic in shadow;
   backstop window set per machine where the canary is `healthy`. Ends on the
   section 11 bar across at least 40 real folds.
5. **Phase 4 — fleet.** Default on for topic sessions on every engine whose
   adapter has passed its verification suite **and** has at least the
   per-engine shadow minimum of folds recorded, on a one-tap operator approval
   bound to the pilot numbers. Any per-topic override follows as its own
   commitment.

Rollback at every phase: the switches in frontloaded decision 10; a release
revert reinstalls the previous hooks.

## Maturation plan

- **test-agent-live:** Phase 0 on a throwaway agent: every rung of the fold
  ladder exercised with rollback restore verified, the 9.1 fix with L7
  before/after evidence, the canary `healthy` with ≥ 3 synthetic positive
  observations, the fold hold refusing
  sends on Slack, app and single-machine topics, the boot sweep resolving a
  restart at every fold step.
- **dev-agent-live:** Phases 1 to 3 on Echo: layers on with freshness within
  target for a week; ≥ 40 shadow folds with the would-be `lost` rate and cost
  term recorded; then the build-desk pilot meeting the section 11 bar across
  ≥ 40 real folds with no unrecovered rollback and zero user-content folds.
- **fleet:** Phase 4: default on for topic sessions on every engine whose
  adapter passed its verification suite and has the per-engine shadow minimum
  of folds, after a one-tap operator approval bound to the pilot numbers.
- **graduation criterion:** cost-weighted tokens per turn on long topics down by
  at least half against the Phase 0 baseline; probe `lost` under 5% across at
  least 40 folds with no unrecovered rollback; no rise in rework or corrections
  in the 30 turns after a fold; zero user-content folds; canary `healthy` on
  every machine.
- **dark-window:** each switch is reviewed 14 days after its rung's exit
  criterion is met, owner Echo: `compactionRecovery.enabled` ships on once the
  test agent reads `healthy` (no dark window: a user-facing bug fix) and is
  reviewed 14 days later, the fleet keeping today's post-compaction behaviour
  until then; `fold.shadow` 14 days after Phase 1's exit;
  `fold.enabled` 14 days after Phase 2's exit; `backstopWindowTokens` 14 days
  after the first machine lowers it; `deltaHook.enabled` 14 days after the
  shadow comparison completes on a machine. A review that finds no evidence
  retires the switch's feature rather than extending the window.
- **ladder:** contextBudget

## 17. Verify the state, not its symbol

| Detector / metric | Symbol read | State claimed | Corroboration | When unmeasurable |
|---|---|---|---|---|
| Clean stop (7.3) | tmux pane idle pattern | session idle and safe to replace | tmux present; SubagentTracker empty (or child-process check plus attestation where no tracker exists); `hasLiveToolShell` false; transcript background starts each matched by a task-notification completion; handoff attestation consistent; inbound empty; CommitmentTracker next-due | absent/indeterminate/unknown ⇒ not clean; a start without a completion ⇒ unknown; counted toward Cap 1 |
| Benefit estimate (7.2) | `TokenLedger` rows for the session | live context size and cache state | poller offset within tolerance (one poll interval plus 64 KB) of the live transcript size; recent cache-read/write counts | beyond tolerance ⇒ `unknown`; no fold proposed |
| Cap 1 turns-to-wall (7.2) | recent growth rate from the ledger scan vs the effective auto-compact window | the session will hit the window in N turns | live JSONL byte offset vs the poller; the window value actually set at spawn | `unknown` ⇒ no checkpoint request; backstop only |
| Milestone finished (7.4) | handoff's "finished" list | the span's detail is no longer needed | PR state, test result, commitment state, artifact presence | contradicted or unknown ⇒ demoted to tail |
| Exclusive session (9.3) | pool session list | one live session serves the topic | topic ownership record; per-peer classified answers; `isPeerPresumedDead` | ownership unverifiable or a serving peer unreachable ⇒ `peer-unknown` ⇒ lock refused; a presumed-dead non-owner counts as no session |
| Fold record state (9.3) | durable record under 9.7 | the fold reached step S | lock record, epoch and generation; every carrier tagged with the foldId | missing or torn ⇒ treated as `quarantined` ⇒ rollback by the boot sweep; orphan carriers with no record ⇒ cleared loudly |
| Episode store at cap (7.8) | ring eviction count and `create-failed` refusals | the sentinel can still open an episode for a new incident | the per-key ring holds at most four live episodes; refusals are counted on the card | a refusal ⇒ `episode-store-full` degradation record, one notice, never a silent dark sentinel |
| Sentinel rows (7.8): stale layers, eligible topic without a fold, declined checkpoints, non-terminal fold past bound, hold or marker outliving its record, oversize standing packet, unrestored reduced packet | the store and the fold records | the session failed to do owed work, or a carrier leaked | the matching transcript evidence (no handoff turn, no fold record, marker file vs record) | missing evidence ⇒ `unknown`, counted, no action beyond an ask |
| Engine capability (9.6) | the adapter's capability record per (machine, engine, version) | the capability works here now | the verification suite's recorded result for the retained binary **this session runs** | unmeasured or version changed ⇒ `absent` until the suite re-runs for that binary |
| Compaction detected (9.1) | the engine's compact-boundary entry; a context-size drop; a synthetic press; the native event | a compaction happened for this session | the boundary entry alone detects; a size drop needs the entry or a synthetic press and is excluded over a fold record's or seeded clear epoch's range; the native event alone never detects | no boundary entry and no corroborated drop ⇒ not a detection; synthesized-only engines count but never heal |
| Seeded marker / context epoch (7.7) | marker file + epoch | this session's context holds the briefing or packet | SessionStart source that wrote the epoch | absent or mismatched ⇒ full briefing |
| Fold ladder rung (9.2) | Phase 0 result record | the rung works on this machine for this Claude Code version | the installed per-version binary; per-fold delivery check (bytes delivered vs staged) | unmeasured or version changed ⇒ rung 3 until re-verified |
| Probe `retrievable` (10) | grader label | the session can recover the item on demand | the lookup call present in the transcript (allowed by the PreToolUse policy) | missing ⇒ `lost` |
| Probe `lost` (10) | grader label | the item left the context, or the session cannot act on it | deterministic presence search of the packet bytes (delivery) recorded separately from the answer grade (behaviour) | present but wrong answer ⇒ still lost; absent ⇒ lost; search unavailable ⇒ trust the grader |
| `no-judge` / `judge-preempted` (9.3) | `LlmQueue` admission refusal or `LlmAbortedError` | the judge cannot run now | provider health; lane occupancy | before the point of no return ⇒ no fold; after it ⇒ a rollback recorded `judge-preempted`, excluded from the breaker count |
| Compaction recovery ran (9.1) | recovery block in the transcript | the session was re-grounded after compaction | an independent detection (row above) and the seeded marker for the same epoch; delivered bytes vs staged bytes | `n/a: switch-off` where off; `uninitialized` with zero detections; detections without both artifacts ⇒ `diverged` ⇒ heal ladder, then notify |
| Hook `source` (9.1) | stdin JSON field + framework discriminator | the event type | `compact`: the PostCompact record or transcript compact boundary for the session; `clear`: a live fold lock and staged packet for the session; `startup`/`resume`: the spawn or resume record | other engine ⇒ `n/a`; Claude Code missing ⇒ `unknown`: orientation + degradation record |
| Suppression (10) | owner-side fold-hold refusal count and marker-file tool-policy denials per fold | no probe text reached the user or the layers | two independent reads: the owner's outbound log for the topic over the lock window, and the H1/ledger diff over the window | zero refusals with sends attempted ⇒ incident; store unreadable ⇒ refuse only topics with a last-known hold, bounded by the TTL ceiling |
| Rework (11) | repeated tool inputs in the ledger scan | the session had to redo work after a fold | compared with the same session's pre-fold rate | lagging poller ⇒ shown as `pending` |
| Layer freshness (6) | `as of` stamps | the layers reflect the topic | message count delta from TopicMemory | stamp missing ⇒ `stale: unknown` on the card |
| 9.1 verified on a machine (9.5) | canary state `healthy` with ≥ N positives | recovery runs after every compaction on that machine | PostCompact records exist for every detected compaction; delivered bytes match staged | `uninitialized` or any divergence ⇒ window not lowered there |

## 18. Testing

- **Tier 1 (unit):** packet verifier (Anchor identity, row binding and decision
  transition, U rows byte-identical with derived stubs, origin verification and
  relabel, tool-origin rejection in A/G/U, coverage of source ranges, oversize
  refusal, single-use binding); ledger supersedes graph and live-set selection;
  the fold record state machine including a permanently failing seed, TTL
  expiry between steps, renewal during a step, owner-epoch change, user message
  before the point of no return, PreCompact during a lock, restart at every
  step (boot sweep), the consecutive-rollback breaker and the judge-preempted
  exclusion; quarantine handover on lease expiry or a step bound beside a live
  candidate, with verified termination before release; the `shadow-probing`
  child state; an attempted checkpoint read during a probe turn denied and
  counted; the
  materialise-and-resume restore and the `rollback-degraded` path; held-row TTL
  freeze and record-gated release; the fold reserve; the sentinel's rows and
  ladders with sustained failure; the adapter capability table with an
  `absent` capability degrading to the named rung; `FoldCoordinator` CAS
  transitions refusing a second writer; quarantine re-acquisition with a new
  generation and the reconciliation-bound exhaustion path; the engine
  checkpoint restoring a transcript with scrub-triggering and oversize entries
  byte-exactly; the `SelfHealGate` extensions (pool-shared refusal, async remediation, per-incident episode keys with a per-key ring and the sentinel's own store file); the transcript detection channel
  reading `diverged` for a hook that never fires; chunked ledger bodies with
  `body-elsewhere`; the relay-path row carrier with the watermark precondition; keyed fenced lease on
  `local` and `git` media with the key in the signed tuple; break-even
  estimator with `unknown` inputs; probe typing, count floor, the
  protected-class rule and the presence override; `source` parsing with
  Codex discriminator, missing and malformed input; `TopicIntentPendingConfirm`
  extension (kind, TTL, priority with requeue, deferred <!-- tracked: CMT-1536 -->-not-dropped); scrub on
  archive write and read including the live-value pass; Disk Steward category;
  the compaction-path reduced-packet order; canary state machine and heal ladder
  with sustained failure; replicated kind bounds (refuse at cap, skew rule).
- **Tier 2 (integration):** the five `/topic/:id/*` routes with bearer, privacy
  filtering, pagination, literal `q` filter and proxied-read behaviour;
  `/topic/:id/fold/*` controls with place binding and lock-time refusal;
  PostCompact route mapping session → topic and writing under 9.7; the fold
  hold refusing outbound on Telegram, Slack and app topics and on a
  single-machine agent, refusing only last-known-held topics when the store is
  unreadable, and **not** refusing with no fold in flight; the owner-first
  check before a forward; the marker-file tool policy allowing a lookup,
  denying a relay call and a compound command under the same marker, and
  leaving unmarked sessions untouched with the server down; `POST /topic/summary`
  refusing under the switch; a PostCompact record not short-circuiting
  `report` with the switch off and short-circuiting it with the switch on;
  the TopicMemory row pull on topic move; the Codex adapter's capability table
  resolved and recorded on a throwaway Codex topic; the degradation records for
  `no-judge`, `no-hold-queue` and `peer-unknown`.
- **Tier 3 (e2e, production boot path):** the layer store is alive and
  permissioned; the `clear` matcher, PostCompact entry and PreCompact steering
  hook are installed by `init` and by `migrateSettings` on an existing agent
  and survive the reporter migrations; a real `/clear` seeds a staged packet
  and a human `/clear` without one behaves as today; a real compaction on a
  throwaway agent produces a PostCompact record, a chunk, an archive entry and
  a recovery block (the L7 before/after evidence for 9.1); a fold on a
  throwaway topic through each ladder rung, with rollback from the checkpoint
  exercised, including a restart mid-fold.
- **Wiring integrity:** hook stdin `source` reaches the seed branch;
  `injectInternalControlCommand` accepts `/clear` at runtime, not only in the
  type; the fold lock registers the reap-guard veto and the all-tier
  PresenceProxy suppression; every allowlisted consumer skips the lock window;
  H3 is the summary table's only writer when `contextBudget.enabled` is on;
  the seed marker carries the epoch it seeded and the hook sends no full
  briefing for it.
- **Canary tests:** a hook that has never worked reads `diverged` after the
  first detection and the heal ladder runs with its brakes; zero detections
  read `uninitialized`; switch off reads `n/a`; a job session's compaction is
  not counted; sustained failure trips the breaker once.
- **Live-user-channel proof** before Phase 3: a user-role session drives a fold
  on a throwaway agent and demo channels (Telegram and Slack) across happy
  path, user message during the lock, rollback, breaker trip and re-arm, a
  sentinel-caught missed handoff, and a Codex topic through its adapter, with
  the signed scenario matrix.

## 19. Design participation and review

- **Design**: v2 drafted by Echo (a Fable 5.1 session); Fable 5.2 design pass
  (Appendix A); rounds 1 to 3 of `/spec-converge` with six internal reviewers,
  the GPT-6 Astra external pass and a Fable 5.2 clean-door read each round
  (Appendices B to F); Justin's three notes of 2026-11-09 15:59 (engine
  agnostic, general feature, session plus sentinel) folded into v6; round 4
  folded into v7; round 5 into v8.
- **Review**: `/spec-converge`, Tier 2. The Claude clean-door reviewer runs on
  `claude-fable-5-2` (PR #3007 adds the explicit pin; rounds 1 and 2 ran it by
  hand through the same `claude -p` door and are recorded as same-family reads,
  not cross-model opinions). The skill's round cap is a stopping rule for
  review cost; a capped stop is recorded as incomplete, never as convergence.
  Convergence report:
  `docs/specs/reports/context-budget-layered-summaries-convergence.md`.

## 20. Open questions

*(none)*

> Every former question is a frontloaded decision in section 13; Justin's
> answers in topic 141133, if they differ, replace the defaults at approval.

## 21. Out of scope

- Changing how the user-facing Telegram history is stored.
- Any change to the constitution.
- Non-topic job sessions (short-lived; measured first; owner Echo at the Phase
  3 rung review).
- The user-words digest (8.1): measured now, built when a topic needs it.
- Per-topic overrides of floors and estimator inputs.
- Generalising the actor-plus-sentinel pattern to other agent responsibilities
  (a follow-on spec after Phase 3 reports how often the sentinel acted and
  whether each action was right; 7.8).

## Glossary

**Fold**: one replacement of a session's live context by the resume packet.
**Seam**: a point in the work where a stretch's detail is no longer needed.
**Handoff**: the structured note the session writes at a clean stop.
**Packet**: the pre-rendered context a fold or compaction recovery re-seeds; the
**standing packet** is the always-ready variant for unplanned compactions.
**Checkpoint**: the byte-exact engine transcript copy kept beside the scrubbed
archive, the immutable rollback target (never served or replicated).
**Fold hold**: the fail-closed egress refusal for a topic while its fold lock is
held. **Sentinel**: the `ContextBudgetSentinel`, the watcher that catches work
the session fails to do (7.8). **Harness adapter**: an engine's implementation
of the capability contract in 9.6. **Anchor**: the user's framing messages plus the derived current-purpose
line. **Ledger**: decisions and evolutions as bound operator rows, statused, with
supersedes links. **Chunk (C) / range summary (C2)**: summaries of closed spans
and of closed ranges of chunks. **U**: the protected user corpus. **L0**: full
history, topic messages plus the transcript archive. In outside terms, this is
checkpoint-plus-log-compaction over a tiered memory, built rather than adopted
because the harness owns the context.

## Appendix A — Fable 5.2 design pass: disposition

Full text: `docs/specs/reports/context-budget-layered-summaries-fable52-design-pass.md`.

| # | Finding (short) | Disposition (v3, carried forward) |
|---|---|---|
| 1 | Folded tool output not retrievable | Adopted: transcript archive, entry-id pointers, `/topic/:id/transcript` (6 L0, 7.6, 9.7) |
| 2 | Readback tests recitation | Adopted: deterministic pre-fold verification + typed held-out probe (9.3, 10) |
| 3 | No path can remove a middle span | Adopted: full rebuild stated; fold defined by what stays verbatim (7.5) |
| 4 | No rollback mechanism | Adopted: fold transaction (9.3) |
| 5 | Seam judge sees too little | Adopted: session-authored handoff, audit as signal (7.1, 7.4) |
| 6 | Per-prompt hook keeps stacking | Adopted: delta hook with epoch and seeded marker (7.7) |
| 7 | U lacks referents and supersession | Adopted (6, 8) |
| 8 | U undefined at the edges | Adopted: by sender row (8) |
| 9 | Cache economics absent | Adopted: break-even, floor, stable-first, cost-weighted metric (7.2, 7.5, 11) |
| 10 | "Never a cap" was false | Adopted: two caps named (5, 7.2) |
| 11 | Anchor edge cases | Adopted (6.1) |
| 12 | Summary-of-summary decay | Adopted: C from raw, H3 from bounded C/C2 (6, 6.5) |
| 13 | In-session state lost on clear | Adopted (7.3, 9.4) |
| Req./missing/simplify/positions/Phase 0 | all | Adopted; positions carried into section 13 |

## Appendix B — spec-converge round 1: disposition

Reviewers: security, scalability, adversarial, integration, decision-completeness,
lessons-aware (Fable 5.1 subagents); GPT-6 Astra (codex-cli, external);
Fable 5.2 (claude-code clean door, same family); Standards-Conformance Gate
(97 standards, 2 possible violations). Round 2 confirmed every row below as
resolved except where Appendix C names a residual.

| Theme | Raised by | Disposition |
|---|---|---|
| `clear` matcher not installed; `/clear` not injectable; seed must cat a staged file in 5 s | integration, lessons F1, DC 4, Fable 3 | Adopted: 9.2 rung 1 builds both; respawn rung 2; no-fold rung 3; Phase 0 builds and verifies |
| Rollback restores the session, not the store | adversarial 2 | Adopted: staged writes by foldId, commit on probe pass (9.3) |
| Dead or indeterminate session passes the clean stop | adversarial 3, integration P20 | Adopted: affirmatively live idle (7.3, 17) |
| Lock before snapshot; complete snapshot; durable queue; replay | GPT 1, scalability 3, DC 7, integration 8 | Adopted: 9.3 order, hold reason, TTL; made durable in round 2 |
| Unfinished work between retained spans | GPT 2 | Adopted: coverage verification, unclassified ranges retained (7.4, 7.5) |
| H3 has no fresh input without folds; backfill of C | GPT 3, scalability 5 | Adopted: chunks on span close, watermark, pre-layer chunk (6.5) |
| Explicit user redirection delayed | GPT 4 | Adopted: instruction followed at once; purpose record tentative and hedged (6.1) |
| Break-even dimensionally incomplete | GPT 5, Fable 11 | Adopted: definition with remaining-turns estimator (7.2) |
| Never-clean sessions get only the generic path | Fable 1 | Adopted: bounded checkpoint requests, pause-and-handoff, `checkpoint-unreachable` (7.2, 7.3) |
| Unplanned compaction leaves a hole in the layers | Fable 2 | Adopted: PostCompact archives, chunks, rebuilds before reseed; gap pointer (9.5) |
| `retrievable` hides loss | Fable 4 | Adopted: typed items; retrievable for detail only with logged lookup (10) |
| Evolutions confirmed with nothing shown; silence as consent; LLM label as authority | Fable 5, lessons F4, adversarial 10, DC 1, gate | Adopted (6.1) |
| Fold lock at the moment the user replies; unbounded; presence/stall collisions | Fable 6, scalability 3 | Adopted (7.2, 7.3, 9.3); seam preference corrected in round 2 |
| Delta hook needs reset rule and dependency gate | Fable 7, DC 8, lessons F11, integration 3 | Adopted (7.7) |
| Transcript archive controls | Fable 8, security 1, scalability 4, integration 7, DC 9 | Adopted (9.7, 7.6, 14) |
| Shadow mode touches the live session | Fable 9 | Adopted: sampled, costed, excluded from baseline; answerer named in round 2 (13.13) |
| Grader holds rollback authority without logging | Fable 10, lessons F5 | Adopted (10, 15) |
| Handoff-minted quotes bound to text, not sender; forwarded rows inherit authority | adversarial 1, 7, security 7 | Adopted (6.2, 8) |
| One-directional milestone audit | adversarial 4 | Adopted (7.1, 7.4) |
| Unbounded rollback loop | adversarial 5 | Adopted: breaker to shadow mode (9.3) |
| "Own history" marker false for shared-authored layers; twin sessions | adversarial 6 | Adopted: author on every entry; exclusive-session rule (6, 13) |
| Suppression names no mechanism | security 5, adversarial 8, lessons F3, DC 12 | Adopted in v4; carriers corrected in round 2 (10) |
| Tool-origin text re-injected as trusted history | security 2 | Adopted (7.4, 7.5) |
| New routes vs privacy scope and team roles | security 3 | Adopted (7.6) |
| No epoch fence; `/clear` outside the control-command union | security 4, lessons F1/H | Adopted (9.2, 9.3) |
| Per-fold LLM overhead unbounded, unlaned | scalability 2, DC 5 | Adopted (7.2, 10, 13.7) |
| H3 rebuild O(folds) | scalability 1, lessons F17 | Adopted: C2 tier and bounded selection (6.5) |
| Ask rate unbounded; cadence load | scalability 6, 7, lessons F17 | Adopted (6.4, 7.2) |
| No multi-machine posture section | integration 1, lessons F14 | Adopted (14); carriers corrected in round 2 |
| Codex receives the changed hooks | integration 3 | Adopted (7.7, 9.1, 9.6) |
| Rollback "one switch" conflicts | integration 4, DC 10 | Adopted: named switches (13.10) |
| PreCompact/PostCompact wiring absent | integration 5 | Adopted (9.1) |
| P20 table missing | integration 6 | Adopted (17) |
| Backfill confirmation floods topics | integration 8, DC 3 | Adopted (6.1) |
| Rollback notice flapping | integration 9, lessons F18 | Adopted (13.2) |
| Required sections missing | DC 1, 2, 6; lessons F5, F7, F8, F10, F2 | Adopted (12, 13, 15, 16, 18, 20, frontmatter) |
| Two post-compaction injectors | lessons F2 | Adopted (3.2, 9.1); third injector removed in round 2 (7.7) |
| Hook fix swaps one unverified parse for another | lessons F9 | Adopted (9.1, 17); canary made honest in round 2 |
| Pending-confirm primitive contradicted | lessons F6 | Adopted (6.1, 13.15) |
| Staged rollout with no dated rungs | lessons F7, DC 6 | Adopted (16); Maturation plan added in round 2 |
| Idle-prompt killer reaps mid-fold | lessons F16 | Adopted (9.3) |
| Oversize packet; inherited truncations | lessons F15, gate | Adopted (3.2 item 8, 6, 9.2) |
| Fixed limits without basis | DC table, lessons table, gate | Adopted (12); relabelled in round 2 |
| Documentation promising a recovery that never ran | lessons F19 | Adopted (9.1) |
| Agent controls and routes without awareness entry | lessons F13 | Adopted (7.1, 13.14) |

## Appendix C — spec-converge round 2: disposition

Same reviewer set as round 1 plus the Standards-Conformance Gate (97 standards,
1 possible violation: the review-plan's round cap, answered in section 19).
Round-1 resolutions were checked by each reviewer; the residuals and the new
findings are below. Nothing was rejected.

| Theme | Raised by | Disposition |
|---|---|---|
| The "topic muzzle" is the stand-down registry: Telegram-only, dark, dry-run, releases on the owner, fail-open hook that blocks the lookups the probe needs | security 1, lessons N1 N2, adversarial N1 | Adopted: fold hold on the shared chokepoint for every channel, fail-closed, replicated; fold-marker PreToolUse policy with a lookup allowlist; lock-window suppression unit (10) |
| Fold lock cannot ride the single-lease store; fold gate conflated lease with ownership | integration N1, lessons N7 N13 | Adopted: keyed fenced lease; gate by topic ownership; hold readable at the lease holder (9.3, 14) |
| Durable inbound queue ships dark with a 90 s hold max | scalability 1 | Adopted: live queue is a lock-time precondition (`no-hold-queue`); `hold: fold` reason and TTL-bound max in the same PR (9.3) |
| No recovery owner after a restart mid-fold; inject store redelivers | lessons N3, adversarial N4 | Adopted: durable fold record state machine, boot sweep, foldId-tagged injects never redelivered (9.3) |
| Rollback has no immutable target; `--resume` may resume the cleared continuation | GPT 2, integration N3 | Adopted: archived checkpoint pointer; resume only when the last entry id matches; `--resume` declared machine-local (9.3, 14) |
| Epoch loss authorizes competing recovery | GPT 3 | Adopted: fencing paragraph; old owner stops; new owner reconciles (9.3) |
| Quote provenance is not a decision | GPT 1, adversarial N2 N3 | Adopted: decision transition on the bound row; entry is the row; origin `user` verified against rows (6.2, 7.4) |
| Compaction-path packet unspecified; oversize cannot refuse | GPT 4, Fable 2 | Adopted: standing packet; reduced packet with disclosure then a respawn fold; per-machine window gating on delivered bytes (9.5) |
| Handoff should be written while the cache is warm; handoff cost omitted | Fable 1 | Adopted: split seam, cost in break-even, both orderings measured (7.2) |
| Shadow probing has no answerer; Run A "no live effect" false | Fable 3, DC N4 | Adopted: throwaway headless answerer; Run A effects listed; Run B gated on Phase 2 exit (10, 13.8, 13.13) |
| Probe corrections not durable or legal | Fable 4 | Adopted: corrections land in the staged chunk/H1 before commit; ledger patches pending (10) |
| Expired user-directed evolution reverts the purpose | Fable 5 | Adopted: `unconfirmed` stays in force; only insight-derived lapse (6.1) |
| Staged window double view; per-prompt hook stacks after compaction seed | adversarial N1, lessons N11 | Adopted: staged view by foldId; hook suppressed during the lock; seed marker carries its epoch (7.7) |
| Unplanned compaction inside a held lock undefined | adversarial N4 | Adopted: PreCompact during a lock aborts the fold; PostCompact writes staged under the foldId (9.3) |
| Breaker re-arm gameable | adversarial N5 | Adopted: PIN-gated tap or once-daily on an operator-bound settled entry post-dating the trip (9.3) |
| Fold controls without provenance or state handling | adversarial N6, security 5 | Adopted: place binding, refused during a lock, rate-limited veto (7.1) |
| Non-fold chunk builds unbounded; LlmQueue cap starves folds; preemption trips the breaker; quadratic archive copy | scalability 2 3 4 | Adopted: sampler on all chunk paths; dedicated fold cap; judge-preempted deferral <!-- tracked: CMT-1536 --> excluded from the breaker; archive deduplicated by entry id (6.5, 9.3, 13.7) |
| Replicated kind bounds; U bodies must not replicate; skew; TopicMemory dependency | integration N2, lessons N12 | Adopted (14) |
| Rung 2 keeps two sessions alive against the auto-heal | integration N4 | Adopted: suspended old session with a foldId exemption named (9.2, 13.16) |
| Canary and breaker lack Standard B fields; canary reads zero as verified; one-remedy heal loops | integration N5, lessons N4 | Adopted: `uninitialized` state with positive control; heal ladder by cause with brakes and breaker; all Standard B fields (9.1) |
| Codex boots would write degradation records | integration N6, lessons N5 | Adopted: framework discriminator ⇒ `n/a: codex` (9.1) |
| P20 table incomplete | integration N7 | Adopted (17) |
| Write-domain registrations; backup posture contradiction | integration N8 N9 | Adopted (14, 9.7) |
| `compact_summary`, probe records and tick fragments escape the scrubbed store; fold components swap-eligible | security 2 3 4 | Adopted (6.4, 9.1, 9.7) |
| Referent-stub writer untiered; remaining-turns input undeclared | lessons N6 | Adopted (6.4, 15) |
| 9.1 fix labelled both test-agent-live and fleet-wide | lessons N8 | Adopted: behind its switch, default off, through the ladder (9.1, 13.11) |
| Clean-stop domain names a registry that does not exist | lessons N9, DC/lessons fixed-limits row 1 | Adopted: honest domain with `hasLiveToolShell`, hook evidence and attestation; unknown ⇒ not clean (7.3, 12) |
| Retiring the summarizer freezes the extractor's input | lessons N10 | Adopted: H3 as the single writer; readers listed (6) |
| Lock TTL expiry beside a live seeded session; TTL basis mislabelled | lessons N15 and fixed-limits row 6, DC re-contest | Adopted: renewable lease, expiry only between steps, p95 floor (9.3, 12) |
| Four basis lines mislabelled external-constraint | DC re-contest, lessons rows 4 10 11 | Adopted: relabelled as cost defaults with floors (12) |
| `## Maturation plan` missing; dark-window undated; format refusals | DC N1 N2 | Adopted: section added in the tag writer's format; dark-windows dated relative to rung exits; `*(none)*` bare; lead line as blockquote |
| Second deficient handoff undecided; policy defaults unnumbered; lever fallbacks unstated | DC N3 N5 N6 | Adopted (7.4, 13 Defaults table, 9.2) |
| Project Scope entry missing | lessons N14 | Adopted (13.17, 16) |
| Precision items (version residue, scratch text, `fork`/`unknown` epochs, digest trigger vs delivery limit, single-use packet, q filter, scrub name, relay origin column, person-key mapping, detail-typing floor, hook timeout ownership, tick disclosure, debounce, PresenceProxy tiers, sentinel early return, backfill lane, reap guard) | several | Adopted in passing |

## Appendix D — spec-converge round 3 and the operator's notes: disposition

Same reviewer set; conformance gate flagged one standard (User-Facing Fixes
Ship Live), adopted. Five of six internal reviewers reported "minor issues";
the lessons-aware reviewer, GPT-6 Astra and Fable 5.2 reported remaining
design seams. Justin's three notes (2026-11-09 15:59) are included. Nothing was
rejected.

| Theme | Raised by | Disposition |
|---|---|---|
| Engine-agnostic; Codex not a deferral <!-- tracked: CMT-1536 --> | Justin note 1 | Adopted: harness-adapter contract with a per-engine capability table; Codex adapter in Phase 1; principal-deferral <!-- tracked: CMT-1536 --> request withdrawn (5.10, 9.6, 13.12, 16) |
| A general Instar feature, not an Echo one | Justin note 2 | Adopted: principle 5.10; engine- and channel-neutral wording throughout; Echo named only as operator agent and author |
| A sentinel that catches what the session fails to do; a reusable paradigm | Justin note 3 | Adopted: `ContextBudgetSentinel` (7.8) with Standard B fields, the never-list, and 12/15/17/18 rows; the actor-plus-sentinel pattern named with its `SelfHealGate` extraction as a follow-on after Phase 3 numbers |
| Warm-cache stage vs the single lock; "on the next inbound message" impossible | Fable 1, adversarial F1 | Adopted: `prepared` state; default replace-immediately; replace-at-idle measured; inbound always invalidates a stage (7.2, 9.3) |
| A step that never reports progress; lease expiry beside a live candidate; hold and lease lifetimes differ | adversarial F2, GPT 4 | Adopted: per-step wall-clock bounds; `quarantined` state; holds released only by reconciliation; generation fencing (9.3) |
| Stub semantics as authority | GPT 1, adversarial F3, Fable 5 | Adopted: transition is a judgment-candidate; enumerated stub `kind`; `derived-settled`; no breaker re-arm from it (6.2, 12, 15) |
| Fail-closed unscoped: store fault mutes the fleet; holder-side check rides replication; tool-policy fail direction mutes every session | security N1 N2 N3, scalability 3, adversarial F4 F5, lessons R3-5 | Adopted: owner-first check with known-holds set; sticky-last-known refusal bounded by the TTL ceiling; per-session marker file; strict command-shape allowlist, deny by default (10) |
| Scrub oversize fail-safe redacts whole spans | security N4 | Adopted: per entry per field (9.7) |
| Corrections never reach the answerer; presence overrides behaviour | GPT 2 3, Fable 6 | Adopted: corrected packet delivered as a lock-window turn or candidate restart; delivery and behaviour tracked separately (10) |
| Canary cannot see a never-working hook; dark window kills today's injector; job sessions produce false divergences | lessons R3-1 R3-2, integration R4 | Adopted: states on detections; synthetic positive control; heal injector named with compensation; everything keyed on PostCompact conditioned on the switch; topic-bound scope (9.1) |
| 9.1 fix through the ladder vs User-Facing Fixes Ship Live | conformance gate, lessons N8 (round 2) | Adopted: ships live once the test agent proves it; switch for rollback (9.1, 13.11) |
| `POST /topic/summary` is a second writer; readers incomplete | lessons R3-3 | Adopted (6) |
| Boot sweep ordering; release by ordering not data; orphan carriers | lessons R3-4, adversarial F6 | Adopted: fold sweep before the inbound sweep; record-gated release; every carrier keyed by foldId; orphans cleared loudly (9.3) |
| Queue entry TTL vs fold hold; validator | scalability 1 | Adopted: frozen row TTL; validator exemption by reason (9.3) |
| Fold cap is a ceiling not a reserve; judge-preempted has no terminal state | scalability 2, DC R3-1 | Adopted: reserved share with interim value; rollback as the terminal state excluded from the breaker (9.3, 13.7) |
| Poller lag makes Cap 1 inert | scalability 4 | Adopted: tolerance (7.2, 17, Defaults) |
| Sleeping peer blocks every fold | scalability 5, adversarial F7, Fable 4 | Adopted: `isPeerPresumedDead` rule; `peer-unknown` counter (9.3, 12, 17) |
| Rollback restore is not a mechanism; rung pass criteria | Fable 2 | Adopted: materialise-and-resume; `rollback-degraded`; restore verified per rung (9.2, 9.3) |
| Shadow answerer unspecified | Fable 3 | Adopted: live model, same tool policy, read-only topic-scoped lookup token, own budget line (10) |
| Reduced packet's restore needs folding | adversarial F8 | Adopted: delta hook carries dropped protected items (9.5) |
| Per-record caps collide with state writes and the never-archive floor; bounds field does not exist | lessons R3-6, DC R3-2 | Adopted: state-and-pointers record, sidecars, G per entry, caps derived from journal constants, honest field addition (14, 12, Defaults) |
| Clean-stop background evidence shows starts only | lessons R3-7 | Adopted: transcript start/completion carrier (7.3, 17) |
| U re-derivation names a carrier that does not exist | integration R1 | Adopted: TopicMemory row pull on topic move (14) |
| Backup cannot exclude a subdirectory | integration R2 | Adopted: sibling archive root (9.7) |
| Hook `source` corroboration unobservable | integration R3 | Adopted (17) |
| Older C is an undeclared machine-local tier | integration R5 | Adopted: proxied-on-read (14) |
| Maturation plan `ladder` format; undefined spend; unnumbered defaults; lever precedence; deferral <!-- tracked: CMT-1536 -->-withheld clause | DC R3-1..4 | Adopted (Maturation plan, 13, Defaults); the deferral <!-- tracked: CMT-1536 --> clause is moot since Codex is in scope |
| Precision items (Standard B breaker fields, lessons-engaged additions, ownerOf status, key in signed tuple, step-8 ordering, synthetic positives, hold validator, sampler order, incremental standing-packet render, non-funnel sends, pending-confirm status mapping, whole-row origin match) | several | Adopted in passing where one line sufficed; the rest in the convergence report's Left behind |

## Appendix E — spec-converge round 4: disposition

Same reviewer set; conformance gate flagged one standard (Judgment Within
Floors, on the review-plan's round cap; answered in section 19 and the
frontmatter). Five of six internal reviewers reported "minor issues"; the
tag-writer preflight refused nothing. Nothing was rejected.

| Theme | Raised by | Disposition |
|---|---|---|
| Handoff turn runs before its hold and tool policy exist | Fable 1, adversarial N4 | Adopted: default path locks before the handoff; `prepared` writes hold and marker first (7.2, 9.3) |
| Quarantine has no owner, no exclusion, no exit; marker/hold expiry vs quarantine | Fable 2, GPT 1 | Adopted: owner's sentinel re-acquires with a new generation; non-terminal-record and sentinel-heartbeat preconditions; numbered bound; exhaustion path; holds in force until terminal (9.3) |
| Fold record has two hands and one fence; third machine can act; sentinel actions not owner-scoped | adversarial N1, scalability 2, integration N4 | Adopted: `FoldCoordinator` with CAS transitions; every fold and sentinel action owner-only (9.3, 7.8, 12, 14) |
| Presence overrides behavioural failure in the tables | GPT 2 | Adopted: delivery and behaviour tracked separately throughout (10, 12, 15, 17) |
| Scrubbed archive is a lossy rollback target | GPT 3 | Adopted: separate lossless engine checkpoint, never served or replicated, deleted on commit or after grace (9.3) |
| Whole-row ledger entries vs the replication cap | GPT 4, DC R4-1 | Adopted: chunked content-addressed bodies with hashes; `body-elsewhere` never omitted (14) |
| Codex column factually wrong (synthesized pre-compact, no post-compact producer, trigger throws, SessionStart never fires on compact) | adversarial N2, integration N2, lessons R4-2, DC R4-2 | Adopted: `synthesized` capability value; honest Codex column; `UserPromptSubmit` as the real seed carrier; Phase 1 builds the producers; records keyed per (machine, engine, version) (9.6, 16) |
| `SelfHealGate` already exists; prose brakes re-implement Standard B | lessons R4-1 | Adopted: sentinel ladders are `SelfHealSpec` declarations; three named gate extensions; pattern paragraph corrected (7.8) |
| `report` short-circuit keyed on the hook family under test; canary's only channel is that family | lessons R4-3 R4-4 | Adopted: short-circuit on seed success with a server-side fallback; independent transcript detection channel; synthetic press as an input (9.1, 17) |
| Phases: adapter built in Phase 1 but verified in Phase 0; sentinel skeleton needed in Phase 0; no per-engine evidence before fleet | Fable 3 | Adopted: re-runnable verification suite; sentinel skeleton in Phase 0; Codex suite in Phase 1 exit; per-engine shadow minimum (9.6, 16) |
| Capability table missing rows; `partial` undefined; absent tool policy | Fable 4, adversarial N3, security D3 | Adopted: four new rows; per-row outcomes; absent tool policy ⇒ no fold (9.6) |
| "Has served the topic" unbounded | Fable 5 | Adopted: defined by ownership records and unconfirmed sessions (9.3) |
| Hold must sit before the relay fork; marker must key on the Instar session id; read tools enumerated; malformed marker | security D1 D2 | Adopted (10) |
| Quarantine notice to a held topic | security D4 | Adopted: exempt fixed-template path plus Attention (7.8) |
| U row carrier: a one-shot pull from the previous owner cannot work on the real topology | integration N1 | Adopted: continuous lease-holder-to-owner row replication with a watermark precondition (14) |
| Backup glob shape unsupported; restored non-terminal records | integration N3 | Adopted (9.7, 9.3) |
| Judge waiters past the point of no return preemptible by slot | scalability 1 | Adopted: non-preemptible slot (9.3) |
| Rung re-verification has no trigger, runner or transfer | scalability 3 | Adopted: the verification suite (9.6) |
| Lookup used on a constraint question | adversarial N5 | Adopted (10) |
| Precision items (FD10 default, verifier wording, derived-settled wording, rung-2 un-suspend, shadow budget, small-model wording, topic muzzle references, freshness target, sentinel cadence, control rate limit, known-holds rebuild, Disk Steward member name, PostCompact body cap, topic-intent store posture) | several | Adopted in passing where one line sufficed; the rest in the convergence report's Left behind |

## Appendix F — spec-converge round 5: disposition

Same reviewer set; conformance gate flagged nothing. Every reviewer confirmed
the round-4 resolutions; five of six internal reviewers reported "minor
issues"; the lessons-aware reviewer reported "blocking, narrowly" and named v8
confirmed in round 6 as its stopping point. Nothing was rejected.

| Theme | Raised by | Disposition |
|---|---|---|
| Owner gate never true on a single-machine agent | integration N1 | Adopted: owner = hosts the live session, plus the pool record only in a pool (5.10, 9.3, 14) |
| Protected class has a row source on Telegram only | integration N2 | Adopted: channel-neutral row writer in Phase 1; `no-row-source` refusal; relay-path row carrier (9.3, 14, 16) |
| Hold and marker lifetimes contradict; stale marker allows; shadow handoffs leave a hold; prepared blocks itself | Fable 1, security D2 residual, GPT 1 | Adopted: record-driven lifetimes everywhere; own markers for candidate and answerer; stale marker denies while the record is open; shadow transition releases at turn end; "no other" record (9.3, 10) |
| Codex can never fold (cost model, restore row) | Fable 2, adversarial N4, DC residual | Adopted: cache-blind conservative estimator; restore row affects rung 1 only; synthesized events do not abort (7.2, 9.3, 9.6) |
| Canary detection defined two ways; a fold's size drop looks like a compaction; seed fallback bypasses the mid-turn guard; epoch not deterministic | Fable 3, adversarial N1 N2, lessons R5-2 R5-3 | Adopted: one rule with the boundary entry alone; exclusion over fold ranges; idle-gated inject path; deterministic epoch key; bound anchored on completion (9.1, 17) |
| Prepared window does not hold inbound | Fable 4 | Adopted (9.3 step 0) |
| Non-preemptible slots unbounded | scalability a | Adopted: one fold past the point of no return per machine (9.3, 12, Defaults) |
| `SelfHealGate` episode store cap and no pruning | scalability b, lessons R5-1, integration, DC | Adopted: fourth extension, per-incident keys, bounded pruning, one notice at cap (7.8, Defaults) |
| Row stream couples to replication latency; rows written on the adapter's machine | scalability c, DC | Adopted: carry the row on the relay path (14) |
| Candidate and shadow answerer unmarked | security D2 residual | Adopted (9.3, 10) |
| Section 14 resume row describes the lossy path; checkpoint missing from carriers and posture | security, adversarial N5 | Adopted: resume row corrected; checkpoint as a tracked carrier with its own posture row and the sentinel as grace actor (9.3, 14) |
| Quarantine re-acquire refused by the lease store; a progress-reporting step never bounded | adversarial N3 | Adopted: coordinator handover; step hard maximum (9.3) |
| Ledger blobs age out; stage verdict on body-elsewhere | adversarial N6, security | Adopted: re-emit while live; hash verification; owner refuses a packet with a missing protected row (14) |
| Verification suite runner and store; independent sample consequences and share | DC | Adopted (9.6, 10, Defaults) |
| Exempt notice path is a tone-gate flag, not a hold exemption | integration | Adopted: Attention and dashboard first; one sentinel-origin fixed-template bypass (7.8) |
| `topic-memory.db` not backed up while layers reference its rows; fold records restorable | integration | Adopted (9.7) |
| Milestone/pin rate limit semantics | lessons | Adopted: coalesce, never refuse (12) |
| Precision items (17 judge-preempted wording, rung keyed on the session's binary, fencing wording, clean-stop row wording, Codex suite phase wording, glossary checkpoint, frontmatter version) | several | Adopted in passing |

## Appendix G — spec-converge round 6 (the cap): disposition

Six is the Tier-2 round cap. The round's internal reviewers' verdicts are in
the convergence report. The external reads found the items below; none is
structural, none is a safety, security or data-loss item left open, and each
was folded into v9 **after the cap without a further review round**, which the
convergence report states plainly so the approver can weigh it.

| Theme | Raised by | Disposition |
|---|---|---|
| Probe turns could read the on-disk checkpoint or archive | GPT 1 | Adopted: no file-reading tools during a probe turn; attempted read denied and counted (10) |
| Canary health cumulative and unrecoverable after a fix | GPT 2 | Adopted: verification epoch restarts after remediation (9.1) |
| Quarantine exhaustion releases containment without verified termination | GPT 3 | Adopted: verified termination or containment stays and the operator is told (9.3) |
| Residual "verifiably present ⇒ not lost" wording | GPT P | Adopted (10) |
| Shadow fold's record terminal before its probe | Fable 1 | Adopted: `shadow-probing` child state (9.3) |
| Cache-blind estimator optimistic on the cost side | Fable 2 | Adopted: costs at the uncached rate (7.2) |
| Wording residue (short expiry, stale-marker row, superseded names in 18, seed-success anchor, Phase 2 queue, step 0 preconditions, hung coordinator, Codex shadow source, cache counters row, layer-set pull) | Fable left-behind | Adopted in passing |
| Owner test never true when the session pool is dark on a multi-machine agent | integration D1 | Adopted: host is owner by default when placement is dark; `owner-unknown` when live and missing (9.3) |
| Backup entry needs the WAL glob; unused hold bypass | integration D2 D3 | Adopted (9.7, 7.8) |
| Inject-store redelivery is not idle-gated by the working predicate | adversarial 1 | Adopted: `isSessionActivelyWorking()` false plus a ready prompt, re-checked per tick (9.1) |
| Shadow answerer's read-only token has no buildable place; candidate marker cannot precede the first tool call | security N1 N2 | Adopted: synthetic non-channel place with `omitAuthEnv`; coordinator-supplied session id at spawn (10, 9.3) |
| Episode store refuses at the derived cap and darkens the sentinel | scalability 1 | Adopted: per-key ring with eviction, own store file (7.8, 17) |
| Stale per-topic keys in three places; synthetic press absent from the action list and canary scope | lessons R6-1 R6-2 | Adopted (7.8, 9.1, 18) |
| Channel-neutral row writer has no cross-machine key rule | DC R6-1 | Adopted: `channel_message_id` plus a deterministic `message_id` derivation per channel (14) |
| Second fold at the point of no return; basis wording; relay verb and contiguous ack | scalability, integration left-behind | Adopted (9.3, 12, 14) |
