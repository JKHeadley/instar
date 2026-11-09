---
title: "Context Budget: Layered Summaries"
slug: "context-budget-layered-summaries"
author: "echo"
created: "2026-11-09"
revised: "2026-11-09 (v4 — spec-converge round 1: six internal reviewers, GPT-6 Astra external pass, Fable 5.2 clean-door read, Standards-Conformance Gate)"
status: "draft v4 (in review)"
approved: false
commitment: "CMT-1536"
requested-by: "Justin, topic 130742, 2026-11-09 14:01 PST; refined in topic 141133, 2026-11-09 14:12 PST"
parent-principle: "Structure beats Willpower; Harness built-ins before our own; intelligent assessment, not hard caps"
supersedes: "compaction-resume-payload (payload shape; its preamble rules are kept), compaction-preamble-tone-and-intent (carried into the reseed packet), the TopicSummarizer rolling summary (retired into H3 through the retirement path)"
design-participants: "Echo (Fable 5.1 session), Fable 5.2 (design pass + round-1 clean-door read), GPT-6 Astra (round-1 external pass)"
review-plan: "/spec-converge, Tier 2 (6-round cap); Claude clean-door reviewer pinned to claude-fable-5-2 once PR #3007 ships (round 1 ran it by hand through the same door)"
principal-deferral-approval: "requested — Codex topic sessions keep today's behaviour until the Codex adapter (section 16, CMT to be opened at Phase 1 start)"
lessons-engaged:
  - "P1 Structure > Willpower — every 'internal' or 'suppressed' property names its carrier (topic muzzle, probe marker allowlist, PreToolUse read-only rule), never agent discipline"
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
  - "memory: no-static-caps-on-agent-growth — every number is a floor with a named irreversible consequence or a judgment input; the two caps are named as caps"
  - "memory: prove-no-quality-loss-before-adopting — the delta-only hook and every fold are measured in shadow before they reduce what a session loads"
  - "memory: dark-by-default-needs-a-dated-owner — section 16 maps phases to maturation rungs with owner, commitment and re-arm dates"
  - "memory: compaction-recovery-never-runs — the fix is Phase 0 and the canary is permanent"
  - "memory: the-autonomous-maturation-design-already-exists — the phase ladder is the maturation ladder, not a parallel one"
  - "declined: per-topic pressure-band overrides (dropped), the user-words digest (measured, deferred with owner), a new workflow engine for the fold transaction (reuses Durable Inbound Message Queue, PendingInjectStore, LlmQueue, the topic muzzle and the recovery veto)"
review-convergence: null
---

# Context Budget: Layered Summaries (v4)

Status: **draft v4, in review (round 1 findings folded in).** No code yet. Needs `/spec-converge` (with Fable
5.2 as a reviewer) and Justin's read before any build.

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
effort, the mid-size perspective and the long-term perspective. v2 extends
them; it does not build a second set.

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
   ones.** Claude Code's hooks and window do the harness part. The fold reuses
   the Durable Inbound Message Queue, PendingInjectStore, LlmQueue, the topic
   muzzle, the recovery veto and the maturation ladder rather than adding a
   workflow engine.

## 6. The layers

| # | Layer | Content | Size (targets for writers, never truncation gates) | Updated |
|---|---|---|---|---|
| A | **Anchor** | The user's framing message(s), **whole**, with message ids and times; above them a derived, non-authoritative one-line "current purpose, as of `<time>`" | Framing messages: whole, however long | Once; the derived line whenever the ledger changes |
| H1 | **Recent effort** | What was just done, what is in flight, the next step, what the session still needs verbatim | ~200 tokens target | Every user turn, every milestone, and on bounded transcript-growth ticks (6.4) |
| H2 | **Mid-size perspective** | The current phase: what it is for, what it has produced, what remains. **Present only when a phase exists** (6.3) | ~300 tokens target | Every arc change |
| H3 | **Long-term holistic view** | The whole topic's story, rebuilt from a **bounded selection** of chunks: open chunks, chunks referenced by the current phase, and the C2 range summaries for everything older (6.5) | ~2 to 4K tokens target | Every fold and every chunk creation |
| G | **Ledger** | One attributed, quoted, statused record for **decisions and evolutions** (`type: decision \| evolution`), newest first, with `supersedes` links; **live** entries are selected by status and reference, not age (6.2) | Live set ~3K tokens target; archive unbounded, quotes intact | Every decision or evolution |
| C | **Chunk summaries** | One per span of work, created at folds **and** independently when a span closes without a fold (6.5), always from the raw span; what was attempted, outcome, artifacts, open threads; pointers to message ids and transcript entry ranges; `author` and `foldId`/`status` | ~300 to 600 tokens target each | Every closed span |
| C2 | **Range summaries** | One per closed range of ~20 chunks or ~8K chunk tokens, built from the C entries and their artifact lists; what H3 reads for old history | ~500 tokens target | When a range closes |
| U | **Protected user corpus** | The operator's own typed messages, verbatim and timestamped, each with a one-line bracketed **referent stub** written at the time ("[answering: should the gate block or warn?]"); forwarded, relayed and third-party rows are kept and labelled but carry no authority (8) | Governed by section 8 | Live |
| L0 | **Full history** | Topic messages (TopicMemory, searchable) **and a per-topic transcript archive**: the session JSONL spans that folds or compactions removed, compressed, indexed by entry id and message id, scrubbed, retained under Disk Steward (9.7) | Bounded by retention policy, never loaded whole | Live |

Every rendered layer line states `as of <time>, <n> messages behind`, so the
1,516-message staleness of 3.2 can never be invisible again. Every H/C/C2/G
entry carries `author` (session id, machine, model, `derived | handoff | user`)
so a reseeded session can tell its own handoff from a twin's or the extractor's.

Mapping to what exists: A extends the PURPOSE line (`TopicSummarizer`) and the
topic-level awareness; H1/H2/H3 are the awareness projection's three levels
(`TopicIntentExtractor`), with H3 given one definition and the old rolling
summary retired into it **through the retirement path** (old summaries
archived, the summarizer kept wired behind the switch until Phase 4 has its
evidence); G is rendered from existing decision refs by `sourceMessageId` and
absorbs the evolutions; C, C2, U and the transcript archive are new.

### 6.1 The Anchor and evolutions

The Anchor's framing message(s) are the first substantive operator-authored
message(s) stating what the topic is for (an opening "hey" is skipped), bound
to message rows with `from_user=1`, `forwarded=0` and the operator's person
key. A topic with no such message (a shared topic opened by someone else, the
Threadline hub, a topic opened by an agent message) has `status: no-anchor`:
H3 carries the purpose, and no evolution can be recorded until an operator
message frames it.

Every change to the purpose is a ledger entry of `type: evolution`, routed
through the **TopicIntent evidence model** (`topic-intent-layer.md` v14), not a
separate authority:

- `cause`: `user-directed` (bound quote required, same binding as above) or
  `insight-derived` (evidence message ids required);
- `effect`: `additive` or `narrowing` (narrows, replaces or contradicts the
  original purpose or a settled decision); the classification is an LLM read
  and is **logged as a signal** with its evidence, never acted on alone;
- `status`: `tentative`, `confirmed`, `withdrawn`, `expired`; `supersedes`.

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
  evolution`, a per-kind TTL, priority over ref confirmations, and queue
  overflow becomes `deferred` with telemetry rather than a silent drop. A
  `tentative` entry expires only after it has been surfaced once **and** the
  user has sent at least one message since; the clock (default 7 days) counts
  from surfacing. Expired entries are listed, not deleted.
- The probe (section 10) treats a `tentative` evolution as in force but
  unconfirmed: a readback that follows it is not a mismatch; one that treats it
  as settled authority is.
- Existing topics are **backfilled** from TopicMemory only (Anchor + ledger;
  cheap): entries are `status: backfilled-unconfirmed`, fully usable and so
  labelled in the packet; confirmation is requested only when the agent next
  replies in a topic with user activity since the backfill, folded into that
  reply, never as a standalone message, and never blocking any phase. Pending
  backfill confirmations appear on the dashboard card and in Home's count.

### 6.2 Decisions in the same ledger

A `type: decision` entry carries the user's exact words bound to an
operator-authored message row (`from_user=1`, `forwarded=0`, operator person
key), time, `supersedes`, and `status` (`settled` / `superseded` / `pending`).
A decision the session or extractor asserts without such a binding is written
`pending`, agent-proposed, and never renders as settled. **This binding is the
sole write path to settled entries in G and to A**; the handoff audit and the
extractor are signals.

Live-set selection (what the packet carries): `superseded`, `withdrawn` and
`expired` entries archive first; a `settled` or `confirmed` entry referenced by
the current phase's H2, or re-referenced by the user within the last N user
turns, never archives; age is the last rung. Archived entries stay retrievable
with their quotes.

### 6.3 "When relevant": when H2 exists

H2 is present when the extractor identifies a phase: a stretch of work with its
own goal, part of the topic's purpose, spanning more than one milestone. The
rule is deterministic on the extractor's arc structure (`TopicIntent.ts` arc
records). A topic that is a stream of unrelated small requests has no H2, and
the packet says so.

### 6.4 Cadence and its brakes

Horizons update on user turns and milestones, and on **bounded transcript-growth
ticks** so a tool-heavy session with no messages still keeps H1 current. A tick
feeds the extractor at most the last K tool names and the first and last 500
characters of each result (≤ 4K tokens), runs no more often than a per-session
minimum interval that grows with the number of recent updates, skips while the
session is mid-turn, and is counted on the dashboard card (extractor calls and
tokens per day, by trigger). This gives the topic-intent layer the brakes its
approved spec described but never carried.

### 6.5 Chunks independent of folds; H3 bounded

A chunk is created when a span **closes**, whether or not a fold follows: a
milestone the session declares, a deterministic signal the session confirms, or
a coverage watermark the server keeps per topic (the first unchunked entry).
Chunks are always built from the raw span. The active span is represented in H1
until it closes. So in Phase 1, before any folding, H3 already updates from
fresh chunks, and the first fold on an old topic does not have to summarize its
whole past: the pre-existing history becomes one `pre-layer` chunk pointing at
the archive, and raw-history chunking of old spans is done only for the pilot
topic, through the background lane.

H3 is rebuilt from a bounded selection: open chunks + chunks referenced by the
current phase + C2 range summaries for everything older. The rebuild input has
a named ceiling (default 24K tokens; consequence: beyond it, older ranges are
read through C2 only), and the packet states in-band which ranges are read
through C2.

## 7. Milestone-driven folding

### 7.1 Who declares a milestone

1. **The session itself**, through three agent-side controls carried by the
   handoff schema and also exposed as `POST /topic/:id/fold/{milestone,pin,veto}`
   (bearer-only; listed in the CLAUDE.md template and reference files in the
   same PR): declare a milestone and the span it closes; pin a span as still
   needed; veto or defer a proposed fold.
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

> break-even turns = (packet cache-write cost + audit + probe generation + probe
> turns + grading, measured in Phase 0 as the fixed per-fold term) ÷ (per-turn
> saving after the fold), compared with the **expected remaining turns**,
> estimated from the trailing turn rate and the phase's open threads. The
> estimator is an input, named as such; a fold is worth asking for when expected
> remaining turns exceed break-even by a margin.

Break-even is **recomputed on the staged packet** (a session can pin most of its
context), and the fold is declined and recorded when the saving falls below the
floor.

- **No-fold floor**: below break-even the system does not ask. Consequence
  named: below it, folding costs more tokens than it saves.
- **Asking eagerness**: above the floor, the better the benefit and the stronger
  the milestone evidence, the more readily the system asks at the next clean
  stop. An expired cache is the cheapest seam and is preferred.
- **Ask brakes** (P19): a veto, defer or `not-yet` applies a per-topic backoff
  (shorter than the rollback backoff); asks are capped per hour; an ask is
  coalesced into the session's next natural turn when a user turn is expected
  within the backoff, rather than injected standalone.
- **Cap 1, the critical checkpoint**: when the session's estimated
  **turns-to-wall** (from recent growth rate, floor: headroom for one handoff
  turn plus one packet write) falls to the floor, the system asks the session
  to **bring its work to a checkpoint**: pause background work, write the
  handoff. After a bounded number of declined or missed checkpoint requests
  (default 3), the request names the consequence and the session is asked once
  more to pause everything it can; if a clean stop still cannot be reached, the
  accepted outcome is the backstop compaction with our keep-instructions, and
  the event is recorded as `checkpoint-unreachable`. Consequence named: Claude
  Code's generic compaction runs.
- **Cap 2, the backstop**: Claude Code's own auto-compact window (9.5).

Per-topic overrides of these numbers are not built; data from Phase 3 decides
whether they are ever needed.

### 7.3 Clean stopping point

A fold runs only when the server can **affirmatively** show: the tmux session is
present and its pane shows the idle prompt (absent or `indeterminate` is not
clean); no tool call is in flight; the SubagentTracker has no live helpers for
the session; no background shell or scheduled wakeup is registered for it; no
user message is waiting; and the next commitment check-in (read from
`CommitmentTracker`, not a constant) is further away than the Phase-0-measured
fold duration times a safety factor. The session has just sent its reply, or has
been idle past the cache TTL (the preferred seam). Background state that cannot
be paused is a reason to decline, recorded, and counted toward Cap 1's bounded
requests.

### 7.4 The session-authored handoff

At the clean stop the session is asked, through an internal turn whose carrier is
defined in section 10, to write one structured handoff from its full context:

- **finished**: each completed stretch, by message id range and wall-clock
  bounds (the server resolves transcript entry ranges; the model never sees
  entry ids), outcome and artifacts;
- **still needed verbatim**: anything from those stretches to keep word for word,
  each item with its **origin** (`user | agent | tool:<entryId>`);
- **open threads** and the next step; background work paused or still live;
- **decisions or evolutions** it believes settled in the span, quoted.

A small model **audits** the handoff (tier 1, section 15): against A and G (does
it drop a decision, contradict the purpose, treat a tentative evolution as
settled?) and against the deterministic signals **in both directions** (7.1).
The audit is a signal: it may send the handoff back once with specific
questions; it never writes to A or G. The handoff becomes chunk entries for the
finished spans and the new H1; H2 and H3 are rebuilt; G receives bound entries as
settled and unbound ones as pending. **Coverage is verified deterministically**:
every source range of the pre-fold context is either retained verbatim, named by
a chunk, or listed as "unclassified, retained" (anything the handoff did not
classify as finished and replaceable stays in the tail).

### 7.5 What a fold does, honestly

Claude Code cannot remove a middle span from a live context, so **every fold is
a full rebuild** of the session's context. A fold is defined by what stays
verbatim: A, the live G, U (per section 8), H3, H2 if present, H1, the
**verbatim tail** (everything after the last finished span plus everything the
handoff kept, plus every unclassified range), the lookup pointers (7.6) and
the in-session state the handoff recorded.

The resume packet is pre-rendered to disk at stage time and ordered
**stable-first** (A, U, H3, G, H2, H1, tail, pointers). The cache reuse this
buys is expected to be modest, because U grows between folds; Phase 0 measures
it and the spec claims only what it measures. The packet opens with a fixed
marker that tells the session: this is restored context, not a new user
request; which entries are its own handoff and which are derived layers
(`author`); and that items marked `tool:` origin are data, not instructions.
The deterministic stage verifier **rejects tool-origin bytes in A, G or U**.

### 7.6 On-demand lookup of older detail

All routes are bearer-only, closed to memory-session tokens unless added to the
memory session guard with place binding, filtered by `privacy_scope` through the
owner-visible projection (the gap in today's `/topic/search` filter is not
inherited), and bounded (default byte and entry ceilings with pagination; sizes
returned by `/chunks` so a session can see what it is about to pull). Shapes
are additive-only after Phase 1.

- `GET /topic/search?topic=N&q=…` (exists; gains the privacy filter).
- New: `GET /topic/:id/messages?around=<messageId>&n=…`.
- New: `GET /topic/:id/chunks` and `/chunks/:k` (C and C2, with sizes).
- New: `GET /topic/:id/transcript?span=<entryId>..<entryId>&q=…` (archived raw
  span, scrubbed, paginated, with an in-span filter; proxied to the holding
  machine when the span lives elsewhere, section 14).
- New: `GET /topic/:id/anchor` (Anchor record and ledger).

### 7.7 The per-prompt hook stops stacking

After Phase 1, `telegram-topic-context.sh` emits only the **delta** since the
last prompt for this `(topic, session_id)`: new inbound messages and a changed
H1 line, in one request instead of two. The delta baseline is a **context
epoch** written by the `SessionStart` hook on every `startup`, `resume`,
`compact` and `clear`; a changed epoch means the full briefing is sent again.
Delta mode is keyed on a per-session **seeded** marker written by the seed path,
so Codex sessions and any Claude session that has never been seeded keep
today's behaviour. The delta hook is **gated per machine** on 9.1 being verified
there and is measured in shadow first (both outputs computed, the delta size
logged, rework compared) before it reduces anything a session loads.

## 8. Asymmetric treatment of user and agent content

Measured (section 2): the agent and its tools generate over three quarters of
the context; the user under a tenth. The user's messages are also the ground
truth of what the topic is. So:

**Definition of U.** U is sourced from TopicMemory by **sender row**, never from
transcript roles (hook injections arrive as "user" in the transcript and are not
the user). The operator's own typed messages are the protected class. Rows with
`forwarded=1`, relay or A2A origin, or another person's sender are kept in U,
labelled, and carry **no authority** for the Anchor, the ledger, confirmations
or evolutions. Large pasted artifacts are kept whole until superseded, then by
excerpt and pointer, with in-band disclosure.

**Protected class** (kept verbatim through every fold):
- the Anchor's framing messages and every ledger quote;
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

### 8.1 When the user corpus itself grows large (measured, deferred)

Justin's condition: "unless it grows very significantly." The measured share of
real operator text is under 7.7%, so U alone will not reach a working size that
matters for a very long time on most topics. v4 **measures** U per topic (tokens
and messages, on the dashboard card) and **defers** building the user-words
digest until a topic's U exceeds a stated trigger (default 100K tokens of
operator text). Owner of the trigger: Echo, reviewed at each maturation rung
review (section 16). When built, it folds the oldest operator messages into a
list of quotes with message ids grouped by phase, never a paraphrase; the ledger
and the last N turns are never folded; every such fold is counted and visible.

### 8.2 Agent content that is protected anyway

Whatever the handoff lists as still needed verbatim stays verbatim past the
fold, labelled with origin: the current build's failing output, the plan being
executed, the last reply sent to the user, review comments still being
addressed.

## 9. Mechanics with Claude Code

### 9.1 Fix first, regardless of the rest

Make the installed `session-start.sh` (the `getSessionStartHook()` literal)
read `source` from its stdin JSON. A missing or unparseable `source` resolves to
`unknown`: emit the startup orientation **and** write a degradation record,
never silently `startup`. Codex sessions, which receive the same hook, have no
`source` and keep today's behaviour. Add a dedicated `PreCompact` steering hook
(a separate script, so the reporter stays silent for the other events) and a
`PostCompact` hook plus settings entry and server route (session → topic) that
stores `compact_summary` per topic. All ship through `PostUpdateMigrator`
(settings, always-overwritten hook scripts, config defaults) in the same PR as
`init`. Correct the CLAUDE.md "Compaction Survival" sentence through
`migrateClaudeMd`. Ship with L7 evidence: a reproduced before/after transcript
showing a recovery block after a real compaction. The fix is intended to change
every agent's post-compaction context fleet-wide; its switch is
`contextBudget.compactionRecovery.enabled` (default on, re-arm review dated in
section 16).

**Standing canary** (P20): per session, `CompactionSentinel` detections vs
PostCompact records vs recovery blocks in the transcript; a divergence
self-heals (re-run the migration, re-verify the hook) and only then notifies.
This is the artifact that proves recovery ran, in Phase 0 and forever.

**One carrier of post-compaction context**: the `SessionStart` (`compact`) hook,
reading the staged packet for the topic. `recoverCompactedSession`'s payload is
retired into it (its calm-resume preamble rules are kept in the packet marker),
and the sentinel's recover step becomes a no-op when a PostCompact record exists
for the session, so no second block arrives on top.

### 9.2 The fold ladder

Phase 0 **builds and verifies** both rungs below; the fold uses the first rung
that passes on the machine, recorded per fold:

1. **Clear-and-seed**: inject `/clear` through `injectInternalControlCommand`
   (its closed union and runtime check widened to `/compact | /clear`, same
   change, same test; never `rawInject`), and the `SessionStart` hook with
   `source: "clear"` (a `clear` matcher added in `init` and `migrateSettings`)
   `cat`s the pre-staged packet file within the hook's 5 s timeout. The hook
   seeds **only** when a staged, verified packet exists for that session;
   otherwise a human-typed `/clear` behaves as today.
2. **Kill-and-respawn with the packet**: end the session and spawn a fresh one
   through the existing spawn path with the packet as the initial context (the
   `formatContextForSession` injection point). Avoids the empty-session window
   and the hook-output dependency; rollback is resuming the untouched old
   session. Phase 0 compares the two rungs on delivery fidelity and cost.
3. **No fold**: backstop only (9.5), recorded `fold-path-unavailable`.

When a verified packet exceeds the measured delivery limit of the rung in use,
the fold is **refused** (P24), never truncated; the refusal is audited and
counted. Phase 0 measures delivery capacity (truncation, the role the model sees
the seed in, intact arrival at 50K to 150K tokens, emit latency), what survives
`/clear` and `/compact` (background shells, subagents, wakeups, todo state,
read-file tracking, session id and transcript path continuity that `TokenLedger`
and topic mapping depend on), and the cost of one fold at the cache TTL in use.

### 9.3 The fold transaction

1. **Lock first**: take the per-topic fold lock (pool-wide through the lease
   medium; exclusive against any second live session on the topic as well as
   other machines); record the owner epoch; register the session with the
   idle-prompt killer's veto (`activeFoldChecker`, sibling of the compaction
   recovery veto) and a suppression with PresenceProxy and the stall sentinels
   for the lock's lifetime; hold outbound for the topic (the topic muzzle). The
   lock has a **TTL** = Phase-0-measured fold duration × 3 with a deterministic
   floor; on expiry the transaction aborts to step 8.
2. **Re-check quiescence** (7.3) under the lock; abort if a user message has
   arrived.
3. **Snapshot**: record session id and transcript path; copy the **complete
   pre-clear transcript** (not only the folded spans) into the per-topic archive
   as a compressed stream off the request loop.
4. **Stage**: build the packet on disk; run the deterministic verifier: Anchor
   bytes identical to the store, every ledger quote bound to its message row,
   U count and last-N floor satisfied, every "still needed" item present with
   origin, no tool-origin bytes in A/G/U, every source range retained or
   chunked, size within the rung's delivery limit, break-even recomputed on the
   real packet. Any failure ends the transaction before anything is replaced.
   **Store writes are staged** with `foldId` and `status: staged`; only
   committed entries render, feed hooks or feed H3.
5. **Point of no return check**: a user message that arrived during steps 2 to 4
   aborts the fold (queued messages are delivered, nothing was replaced).
6. **Replace** by the ladder rung in use (9.2).
7. **Probe** (section 10). On pass, **commit** the staged store writes, release
   the lock, deliver queued inbound.
8. **Rollback**: resume the snapshotted session (`--resume` where the session id
   still exists on this machine; otherwise respawn from the archived
   snapshot); **discard** the staged store entries and list them in the fold
   record; deliver queued inbound; apply the per-topic backoff. After K
   consecutive rollbacks (default 2 within the backoff span) the topic **drops
   to shadow mode** (Phase 2 behaviour) and the breaker raises one notice
   (section 13); re-arm needs an operator tap or a changed Anchor/ledger.

Queued inbound lives in the **Durable Inbound Message Queue** with a `hold:
fold` reason (not a second queue), so a server restart mid-fold replays it;
in-flight injects live in `PendingInjectStore`. An owner-epoch change at any step
aborts to rollback. If the audit or probe model is unavailable (provider down,
`LlmQueue` admission refused) **no fold runs**, recorded as `fold-skipped:
no-judge` in the degradation records; a day with zero folds on an eligible topic
surfaces in the degradation digest, so a quiet failure cannot look like
patience.

### 9.4 What survives a clear

Background shells, subagents, scheduled wakeups, todo state and read-file
tracking may not survive `/clear` (and do not survive a respawn). Their absence
is a 7.3 precondition; the handoff records any that were paused so the reseeded
session can re-arm them; Phase 0 measures exactly what is lost per rung.

### 9.5 Backstop for unplanned compaction

Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for topic sessions at spawn time (running
sessions keep their window until respawn; Phase 0 records precedence against an
`autoCompactWindow` persisted in settings) to a generous default (400K; `basis:
external-constraint; evidence: Claude Code compacts at ≤ 1M regardless`; the
value is a config default with a dated review). The PreCompact steering hook
adds instructions to every compaction: keep the Anchor, the ledger quotes, the
in-flight work. The **PostCompact** hook then archives the pre-compaction span,
enqueues a chunk built from that raw span, rebuilds H1 and H3, and only then the
`SessionStart` (`compact`) hook re-seeds the full packet, which is the only
thing that restores U. If the chunk is not ready in time, the packet carries an
explicit "unsummarized gap: entries X..Y, chunk pending" pointer rather than
silence. The window is lowered **only after 9.1 is verified fleet-wide** by the
canary; lowering it first would route more compactions into the broken path.

### 9.6 Codex sessions

Codex has its own compaction lifecycle
(`src/providers/adapters/openai-codex/control/compactionLifecycle.ts`) and
receives the same `session-start.sh` and `telegram-topic-context.sh`. v4 keeps
Codex topics on today's hook behaviour (no `source`, no seeded marker, no delta
mode). This is a recurrence-risking deferral by P10's definition: the Codex
adapter gets its own commitment, opened at Phase 1 start with Echo as owner, and
`principal-deferral-approval` is requested in the frontmatter.

### 9.7 The layer store and transcript archive

Path `.instar/state/context-layers/<topic>/` (mode 0o700, files 0o600, as
`IdentityKeyFile` does), containing the small layers (A, G, C, C2, U, H1–H3,
fold records) and `archive/` (compressed per-span transcript files). The
directory is added to `.instar/.gitignore` and the FileClassifier never-sync
set, to the File Viewer's `NEVER_SERVED_PREFIXES`, and is excluded from backup
`includeFiles` (the small layers are reconstructable from TopicMemory plus the
archive; the archive is declared reconstructable-or-lost). The existing
credential scrub runs on archive write **and** on every `/topic/:id/transcript`
read. Dashboard team members and guests never reach it. Retention is a named
Disk Steward class: raw spans are kept while any chunk points at them; evictable
oldest-superseded-first under the steward's forecast, never the current phase's
spans; an evicted span leaves its chunk marked `raw-evicted`; archive bytes per
topic appear on the dashboard card.

## 10. Verifying retention: the held-out probe

A readback ("state the goal and next step") tests recitation of a packet the
session was just handed. So:

1. **Before the fold** (9.3 step 4): deterministic verification against the
   store.
2. **Question generation at stage time**, from the **folded spans the handoff
   named**, sampled to a ceiling (default 30K tokens: each span's tail plus every
   tool result containing an error or a file path), never from the whole
   pre-fold context. Questions are typed: `constraint`, `rejected-approach`,
   `open-thread`, `detail`. Count: at least one per finished span and per open
   thread (floor 1), with a deterministic ceiling set by the probe token budget;
   not a fixed three to five.
3. **After the seed**: the reseeded session answers them using the packet and
   the lookups. Grades are constrained to `retained`, `retrievable`, `lost`.
   **`retrievable` passes only for `detail` items**, and only when the lookup
   call actually appears in the transcript (the corroboration); constraints,
   rejected approaches and open threads must be `retained` or they are patched
   into the packet or ledger and re-probed once.
4. A `lost` **protected-class item** (an Anchor quote, a ledger quote, a U
   message) rolls back immediately (`basis: irreversible-consequence; evidence:
   the user's words left the live context`). Any other `lost` gets one specific
   correction and a second probe on that item; the grader may grant one more
   correction for a `detail` item; a second `lost` rolls back (9.3 step 8).

The probe grader is **tier 1** (section 15): grades are an enumerated set, every
decision logs question, answer, reference span and grade, and a deterministic
rule (protected-class lost ⇒ rollback) sits above the model's grade.

**Suppression carrier.** The handoff turn and the probe turns are internal. The
carrier is: the topic muzzle held by the fold lock (the outbound route refuses
sends for the topic with a named, audited reason); a marker-gated PreToolUse
rule that makes those turns read-only and blocks the relay script and
message-sending tools (the stand-down hook shape); and a single `probe` marker
on the injected turns honoured by an **enumerated allowlist** of consumers
(TopicMemory ingestion, the intent extractor, H1 updates, the ledger, attribution
trace, correction learning, `TokenLedger` tagging, the per-prompt hook). The
audited refusal count per fold is the artifact that proves suppression ran.

## 11. Measurement

Recorded per session and per topic, shown on one dashboard card (console
Settings → Context, with rolled-back folds, pending Anchor confirmations and
`checkpoint-unreachable` events joining Home's count through
`dashboard/console/needs-model.js`):

- tokens per turn, **cost-weighted** (cache read, cache write, uncached input at
  their relative prices), before vs after rollout, **including the fold's own
  calls** (audit, probe generation, probe turns, grading, cadence ticks);
- live context size over time; folds per day by who declared the milestone
  (session, signal, critical checkpoint), estimated vs realised break-even,
  asks per fold, declines, `fold-skipped: no-judge`, `fold-path-unavailable`,
  `checkpoint-unreachable`;
- probe results by item type: retained / retrievable / lost / rolled back;
- **rework**: files re-read and commands re-run in the 30 turns after a fold vs
  baseline, computed in the `TokenLedger` scan (eventually consistent);
- lookups used after a fold, by route; archive bytes per topic;
- **user-content retention**: share of operator messages verbatim in context;
  U size per topic; count ever folded (expected zero);
- **Anchor stability**: evolutions by cause and effect; tentative, confirmed,
  withdrawn, expired; backfilled-unconfirmed count;
- extractor calls and tokens per day by trigger; LlmQueue component spend per
  feature (`FoldAudit`, `FoldProbe`, `LayerUpdate`);
- user corrections in the 30 turns after a fold vs baseline.

These are evidence for the rung-review judgment in section 16, not trip-wires.
The bar the pilot must show before the fleet rung: cost-weighted tokens per turn
on long topics down by at least half; `lost` under 5% across at least 40 folds
with no unrecovered rollback; no rise in rework or corrections; zero
user-content folds.

## 12. Decision points touched

Each row: classification; basis or floor + arbiter; evidence.

| Decision point | Classification | Floor / basis | Arbiter |
|---|---|---|---|
| Fold / no fold (7.2) | judgment-candidate | floor: no-fold below break-even (`basis: irreversible-consequence`? no: economic; consequence named: costs more than it saves); affirmatively live idle (7.3); no judge ⇒ no fold | benefit estimator + session veto; last rung deterministic (no fold) |
| Clean stop (7.3) | invariant | `basis: enumerable-domain; evidence: tmux presence, pane idle pattern, SubagentTracker, background-shell registry, inbound queue, CommitmentTracker next-due are all enumerable states`; absent/indeterminate ⇒ not clean | deterministic |
| Milestone accepted as finished (7.1, 7.4) | judgment-candidate | floor: contradicted by a deterministic signal (open PR, red test, open commitment) ⇒ demoted to tail | handoff audit model (signal); deterministic demotion rule |
| Handoff audit send-back (7.4) | judgment-candidate | ceiling: one send-back per fold (`basis: external-constraint; evidence: each send-back is a full-context turn`) | audit model |
| Evolution cause/effect classification (6.1) | judgment-candidate | floor: tentative on write; authority only by qualifying user episode (v14 weights); narrowing always surfaced; silence never confirms | TopicIntent evidence model; user |
| Settled decision / confirmed evolution write (6.2) | invariant | `basis: enumerable-domain; evidence: bound to a message row with from_user=1, forwarded=0, operator personKey` | deterministic binding |
| Ledger live-set selection (6.2) | judgment-candidate | floor: superseded/withdrawn/expired archive first; settled entries referenced by the current phase or the last N user turns never archive; age last | handoff audit model |
| Pending evolution expiry (6.1) | judgment-candidate | floor: never before surfaced once and ≥ 1 user message since; default 7 days from surfacing | deterministic clock above the floor |
| H2 presence (6.3) | invariant | `basis: enumerable-domain; evidence: the extractor's arc records` | deterministic |
| Probe grade (10) | judgment-candidate | floor: enumerated grades; protected-class lost ⇒ rollback regardless of grade; retrievable only for detail with a logged lookup | grader model (tier 1) |
| Probe count (10) | judgment-candidate | floor: ≥ 1 per finished span and open thread; ceiling: probe token budget | generator |
| Rollback (9.3 step 8) | invariant | `basis: irreversible-consequence; evidence: a lost protected-class item means the user's words left the live context`; second lost on any item | deterministic |
| Consecutive-rollback breaker (9.3) | judgment-candidate | floor: K = 2 within backoff ⇒ shadow mode; re-arm by operator tap or ledger change | deterministic trip, operator re-arm |
| Fold lock TTL (9.3) | invariant | `basis: external-constraint; evidence: measured fold duration (Phase 0) × 3, floor 120 s`; on expiry rollback and release queued messages | deterministic |
| Inbound hold during fold (9.3) | invariant | `basis: irreversible-consequence; evidence: a message delivered into a half-replaced context is answered from the wrong state`; bounded by the TTL; abort on arrival before the point of no return | deterministic |
| Critical checkpoint distance (7.2) | judgment-candidate | floor: turns-to-wall ≥ one handoff turn + one packet write; bounded requests (3) then `checkpoint-unreachable` | benefit estimator; last rung Claude Code's window |
| Backstop window (9.5) | invariant (cap, named) | `basis: external-constraint; evidence: Claude Code compacts at ≤ 1M regardless; range 100K–1M`; default 400K, dated review | deterministic |
| Protected last-N user turns (8) | invariant (floor) | `basis: irreversible-consequence; evidence: a folded user turn cannot be re-asked`; N = 20 | deterministic |
| U digest trigger (8.1) | judgment-candidate | floor: never below the last N; trigger 100K operator tokens; measured, deferred | Echo at rung review |
| Cadence tick (6.4) | judgment-candidate | floor: ≤ 4K tokens input; minimum interval growing with recent updates; skip mid-turn | deterministic brakes above the extractor |
| Ask rate (7.2) | judgment-candidate | floor: per-topic backoff after veto; hourly cap; coalesce with next natural turn | deterministic brakes |
| H3 rebuild input (6.5) | invariant (ceiling) | `basis: external-constraint; evidence: the small model's usable context`; default 24K, in-band disclosure of C2-only ranges | deterministic |
| Probe generation input (10) | invariant (ceiling) | `basis: external-constraint; evidence: cost and context of the generator`; default 30K from the folded spans only | deterministic sampling |
| Packet oversize (9.2) | invariant | `basis: irreversible-consequence; evidence: a truncated protected class is a silent cut (P24)`; refuse, never truncate | deterministic |
| Fold ladder rung (9.2) | invariant | `basis: enumerable-domain; evidence: Phase 0 pass/fail per rung per machine` | deterministic |
| Probe/handoff suppression (10) | invariant | `basis: irreversible-consequence; evidence: a leaked probe is a user-facing incident`; carriers enumerated | deterministic |
| Archive retention (9.7) | judgment-candidate | floor: never evict a span a chunk points at while the phase is current; chunk marked raw-evicted on eviction | Disk Steward |
| Rollback notice (13) | invariant | `basis: enumerable-domain; evidence: failed rollback or breaker trip ⇒ one line in the topic through the outbound gate; successful rollback ⇒ dashboard + Home count` | deterministic |
| Phase / rung advance (16) | judgment-candidate | floor: the section 11 bar; Run C gated on a one-tap operator approval | Echo (rungs 1–2), operator (fleet) |

## 13. Frontloaded Decisions

Decisions the build would otherwise stop to ask. Each is Echo's, attributable
to this spec, reversible as stated; Justin's approval of the spec approves them
in bulk, and any answer he gives in topic 141133 replaces the default.

1. **Pilot topic (was open question 1):** the build desk, with the Instar App
   topic in shadow alongside as the worst cost case. Reversible: config.
2. **Rollback visibility (was open question 2):** a successful rollback is a
   successful self-heal (P22): dashboard card plus Home's count, no topic
   message. A **failed** rollback or a breaker trip sends one line to the topic
   through the ordinary outbound gate and quiet-by-default rules. Reversible:
   config.
3. **Insight-derived evolutions (was open question 3):** additive ⇒ mention in
   the next natural reply, confirmed by agreement; narrowing ⇒ explicit yes.
   Never confirmed by action or silence. Reversible: rule table in 6.1.
4. **Backstop early (was open question 4):** yes, but only after 9.1 is verified
   fleet-wide by the canary; the window is a config default (400K) with a dated
   review. Reversible: one setting.
5. **Starting numbers (was open question 5):** every number in section 12 is a
   floor with a basis line or a judgment input; the values come from Phase 0 and
   Phase 2 measurements and are config defaults until then.
6. **Fold path:** the three-rung ladder of 9.2, chosen per machine by Phase 0
   results; oversize ⇒ refuse.
7. **Small models:** Haiku-tier through `LlmQueue`'s background lane with
   per-component budgets (`FoldAudit`, `FoldProbe`, `LayerUpdate`), a per-topic
   daily fold-token ceiling that defers rather than skips silently, and
   `/metrics/features` rows under those names. No fold without a judge.
8. **Run boundaries and arbiter:** Run A = Phase 0 + Phase 1 + Phase 2 (shadow;
   no live effect beyond the 9.1 fix); Run B = Phase 3 (pilot live), started by
   Echo once every Phase 0 check passes, with the evidence posted; Run C =
   Phase 4 (fleet default), started only on a one-tap operator approval bound
   to the section 11 numbers. The run ends there by design.
9. **Backfill:** Anchor and ledger from TopicMemory only; `backfilled-unconfirmed`
   entries are usable and labelled; confirmation is folded into the next reply
   in active topics, never standalone, never blocking; raw-history chunking only
   for the pilot topic through the background lane.
10. **Config switches:** `contextBudget.enabled` (layers; Phase 1 on),
    `contextBudget.fold.enabled` (Phase 3 on for the pilot, Phase 4 default),
    `contextBudget.fold.shadow` (Phase 2 on), `contextBudget.backstopWindowTokens`
    (null until frontloaded decision 4's condition holds),
    `contextBudget.compactionRecovery.enabled` (Phase 0 on),
    `contextBudget.deltaHook.enabled` (per machine, after the shadow comparison).
    All live-read where the component permits, otherwise restart; each has a
    `migrateConfig` entry and a re-arm review date (section 16). The hooks read
    the switches and fall back to full-context mode when off; `TopicSummarizer`
    stays wired behind `contextBudget.enabled` until Phase 4 has its evidence.
11. **The 9.1 fix is fleet-wide on the next update**, intended; its switch is
    named above.
12. **Codex:** today's behaviour, with the adapter as a separately owned
    commitment (9.6).
13. **Shadow handoffs cost real turns:** Phase 2 asks live sessions for
    handoffs at a sampled rate (default one in three clean stops) with the cost
    stated on the card; those turns are tagged and excluded from the Phase 3
    baseline. Forked-copy shadowing is not built.
14. **Endpoint shapes** (7.6) are additive-only after Phase 1 and documented in
    the CLAUDE.md template and reference files in the same PR.
15. **The pending-confirmation primitive is extended, not forked** (6.1): new
    kind, per-kind TTL, priority, deferred-not-dropped, with tests.
16. **Exclusive-session rule:** the fold lock refuses when more than one live
    session serves the topic anywhere in the pool; the duplicate-session
    auto-heal runs first.

No cheap-to-change-after tags are claimed: every item above either ships behind
a named switch (reversible by config) or is a durable interface decided here.

## 14. Multi-machine posture

Default posture is `unified`. Per surface:

| Surface | Posture | How |
|---|---|---|
| Small layers A, G, C, C2, U, H1–H3, fold records | unified | a new replicated kind in the state-sync layer with per-entry bounds sized for these records (the existing working-set artifact kind caps entries at 8 KB and `topic-memory.db` is a per-machine exclusion, so neither carries them); on topic move the new holder pulls the topic's layer set before its first fold; a fold never runs on a machine that does not hold the topic's lease |
| Transcript archive (raw spans) | proxied-on-read | spans stay on the machine whose session produced them (that is where the JSONL exists); `GET /topic/:id/transcript` proxies to that machine through the mesh; an unreachable machine returns explicit `unknown` and the chunk shows `raw-elsewhere`; no raw span is ever copied by the working-set handoff |
| Rollback snapshot and `--resume` | proxied-on-read with a named fallback | a session id resumes only where it exists; after a topic move the fallback is respawn-from-archived-snapshot on the new holder, through the proxied read |
| Fold lock and backoff state | unified | the lease medium (same carrier as the Telegram lease); exclusive across machines and across twin sessions |
| PostCompact records, probe and metric records | unified | existing replicated journal kinds (small, append-only) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, hook scripts, settings matchers | unified by build | code-level, identical on every machine running the version; an older machine keeps today's behaviour until it updates |

No surface is declared machine-local, so no `machine-local-justification`
marker is needed. The reviewer's bidirectional check: nothing here is
credential- or hardware-bound; the raw transcript's locality is handled by the
proxied read, not by replication.

## 15. Supervision tiers

| Pipeline | Tier | Validator (deterministic, after every step) |
|---|---|---|
| Handoff audit (7.4) | 1 | every "finished" span's artifacts exist (PR state, test result, file presence) before the LLM audit; audit output must be one of send-back / accept; it never writes A or G |
| Probe generation (10) | 1 | questions typed from the enumerated set; count within floor and budget; every question cites a span inside the folded ranges |
| Probe grading (10) | 1 | grades from the enumerated set; protected-class lost ⇒ rollback regardless of grade; `retrievable` requires a logged lookup call |
| Horizon updates H1/H2/H3 and chunk/C2 writes (6) | 1 | input bounded (6.4, 6.5); output carries `as of`, `author`, `foldId`/`status`; user text in any layer must be a bound quote |
| Evolution cause/effect classification (6.1) | 1 | logged as a signal with evidence ids; write is `tentative`; confirmation only by a qualifying user episode |
| Anchor/ledger backfill (6.1) | 1 | each backfilled entry bound to an operator-authored row; status `backfilled-unconfirmed` |
| Benefit estimator (7.2) | 0 (deterministic) | inputs from `TokenLedger`; `unknown` when the poller lags |

## 16. Rollout as the maturation ladder

Phases map onto the maturation rungs (`feature-maturation-discipline.md`); no
parallel ladder. Owner for every rung: Echo. One tracked commitment with a
beacon per rung review; every switch has a re-arm review date set when it ships.

1. **Phase 0 — verify and fix (test-agent-live for the fix; no behaviour change
   on the fleet except 9.1).** Build and verify: the `clear` matcher and
   `/clear` control command; the PreCompact steering hook and PostCompact route;
   the 9.1 fix with L7 evidence and the standing canary; delivery capacity,
   survival and cost of one fold per rung (9.2); both post-compaction paths
   counted across the fleet's transcripts; the topic-intent layer inventory
   and its brakes; the asymmetry measurement by sender; per-turn token
   measurement for a baseline. Ends when every check has a recorded result.
2. **Phase 1 — layers, always on (dev-agent-live).** Layer store with path,
   permissions, scrub, retention; topic-intent layer on everywhere with a
   freshness check and the 6.4 brakes; Anchor and ledger with backfill;
   chunks on span close, C2, H3 from the bounded selection; U with referent
   stubs; TopicSummarizer behind the switch; dashboard card; delta hook in
   shadow comparison. No folding. Ends when the card has shown a week of
   layer freshness within target on the dev agent and the delta comparison
   shows no rework rise.
3. **Phase 2 — shadow folding (dev-agent-live).** Sampled handoffs at clean
   stops; packets staged and verified; probe questions generated and answered
   against a copy; would-be grades and costs recorded. Ends on at least 40
   shadow folds with the would-be `lost` rate and cost term measured.
4. **Phase 3 — pilot (dev-agent-live, one topic).** Folding on for the build
   desk; Instar App topic in shadow; backstop window set once 9.1 is verified
   fleet-wide. Ends on the section 11 bar across at least 40 real folds.
5. **Phase 4 — fleet.** Default on for Claude Code topic sessions on a one-tap
   operator approval bound to the pilot numbers. Codex adapter and any
   per-topic override follow as their own commitments.

Rollback at every phase: the switches in frontloaded decision 10; the 9.1 fix
is a separate switch; a release revert reinstalls the previous hooks.

## 17. Verify the state, not its symbol

| Detector / metric | Symbol read | State claimed | Corroboration | When unmeasurable |
|---|---|---|---|---|
| Clean stop (7.3) | tmux pane idle pattern | session idle and safe to replace | tmux session present; SubagentTracker empty; background-shell registry empty; inbound queue empty; CommitmentTracker next-due | absent/indeterminate ⇒ not clean; no fold |
| Benefit estimate (7.2) | `TokenLedger` rows for the session | live context size and cache state | poller offset at the live JSONL's end; recent cache-read/write counts | `unknown`; no fold proposed |
| Milestone finished (7.4) | handoff's "finished" list | the span's detail is no longer needed | PR state, test result, commitment state, artifact presence | contradicted or unknown ⇒ demoted to tail |
| Probe `retrievable` (10) | grader label | the session can recover the item on demand | the lookup call present in the transcript | missing ⇒ `lost` |
| Compaction recovery ran (9.1) | recovery block in the transcript | the session was re-grounded after compaction | CompactionSentinel detection and PostCompact record for the same session | divergence ⇒ self-heal, then notify |
| Hook `source` (9.1) | stdin JSON field | the event type | the matcher that fired (settings) | missing ⇒ `unknown`: orientation + degradation record |
| Suppression (10) | audited refusal count per fold | no probe text reached the user or the layers | outbound log for the topic during the lock; H1/ledger diff | zero refusals with sends attempted ⇒ incident |
| Rework (11) | repeated tool inputs in the ledger scan | the session had to redo work after a fold | compared with the same session's pre-fold rate | lagging poller ⇒ shown as `pending` |
| Layer freshness (6) | `as of` stamps | the layers reflect the topic | message count delta from TopicMemory | stamp missing ⇒ `stale: unknown` on the card |
| 9.1 verified fleet-wide (9.5) | canary divergence = 0 per machine over a window | recovery runs after every compaction on every machine | PostCompact records exist for every detected compaction | any machine unmeasured ⇒ window not lowered |

## 18. Testing

- **Tier 1 (unit):** packet verifier (Anchor identity, quote binding, U floor,
  origin labels, tool-origin rejection in A/G/U, coverage of source ranges,
  oversize refusal); ledger supersedes graph and live-set selection; fold
  transaction state machine including a permanently failing seed, TTL expiry,
  owner-epoch change, user message before the point of no return, and the
  consecutive-rollback breaker; break-even estimator with `unknown` inputs;
  probe typing, count floor and the protected-class rule; `source` parsing with
  missing and malformed input ⇒ `unknown`; `TopicIntentPendingConfirm`
  extension (kind, TTL, priority, deferred-not-dropped); scrub on archive write
  and read; Disk Steward retention class.
- **Tier 2 (integration):** the five `/topic/:id/*` routes with bearer, privacy
  filtering, pagination and proxied-read behaviour; `/topic/:id/fold/*`
  controls; PostCompact route mapping session → topic; the muzzle refusing
  outbound during a fold lock; the degradation record for `no-judge`.
- **Tier 3 (e2e, production boot path):** the layer store is alive and
  permissioned; the `clear` matcher and PostCompact entry are installed by
  `init` and by `migrateSettings` on an existing agent; a real `/clear` seeds a
  staged packet and a human `/clear` without one behaves as today; a real
  compaction on a throwaway agent produces a PostCompact record, a chunk, an
  archive entry and a recovery block (the L7 before/after evidence for 9.1);
  a fold on a throwaway topic through each ladder rung, with rollback exercised.
- **Wiring integrity:** hook stdin `source` reaches the seed branch;
  `injectInternalControlCommand` accepts `/clear` at runtime, not only in the
  type; the fold lock registers the recovery-veto sibling and the PresenceProxy
  suppression; probe-marked turns are skipped by every consumer on the allowlist.
- **Live-user-channel proof** before Phase 3: a user-role session drives a fold
  on a throwaway agent and a demo channel across happy path, user message
  during the lock, rollback, breaker trip and the Codex-unchanged scenario,
  with the signed scenario matrix.

## 19. Design participation and review

- **Design**: v2 drafted by Echo (a Fable 5.1 session); Fable 5.2 design pass
  (Appendix A); round 1 of `/spec-converge` with six internal reviewers, the
  GPT-6 Astra external pass and a Fable 5.2 clean-door read (Appendix B).
- **Review**: `/spec-converge`, Tier 2. The Claude clean-door reviewer runs on
  `claude-fable-5-2` (PR #3007 adds the explicit pin; round 1 ran it by hand
  through the same `claude -p` door and is recorded as a same-family read, not
  a cross-model opinion). Convergence report:
  `docs/specs/reports/context-budget-layered-summaries-convergence.md`.

## 20. Open questions

*(none)* — every former question is a frontloaded decision in section 13;
Justin's answers in topic 141133, if they differ, replace the defaults at
approval.

## 21. Out of scope

- Changing how the user-facing Telegram history is stored.
- Any change to the constitution.
- Non-topic job sessions (short-lived; measured first; owner Echo at the Phase
  3 rung review).
- The user-words digest (8.1): measured now, built when a topic needs it.
- Per-topic overrides of floors and estimator inputs.

## Glossary

**Fold**: one replacement of a session's live context by the resume packet.
**Seam**: a point in the work where a stretch's detail is no longer needed.
**Handoff**: the structured note the session writes at a clean stop.
**Packet**: the pre-rendered context a fold or compaction recovery re-seeds.
**Reseed**: delivering the packet into a fresh or compacted context.
**Anchor**: the user's framing messages plus the derived current-purpose line.
**Ledger**: decisions and evolutions, quoted and statused, with supersedes links.
**Chunk (C) / range summary (C2)**: summaries of closed spans and of closed
ranges of chunks. **U**: the protected user corpus. **L0**: full history, topic
messages plus the transcript archive. In outside terms, this is
checkpoint-plus-log-compaction over a tiered memory, built rather than adopted
because the harness owns the context.

## Appendix A — Fable 5.2 design pass: disposition

Full text: `docs/specs/reports/context-budget-layered-summaries-fable52-design-pass.md`.

| # | Finding (short) | Disposition (v3, carried into v4) |
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
(97 standards, 2 possible violations). Full reports in the convergence report.

| Theme | Raised by | Disposition |
|---|---|---|
| `clear` matcher not installed; `/clear` not injectable; seed must cat a staged file in 5 s | integration, lessons F1, DC 4, Fable 3 | Adopted: 9.2 rung 1 builds both; respawn rung 2; no-fold rung 3; Phase 0 builds and verifies |
| Rollback restores the session, not the store | adversarial 2 | Adopted: staged writes by foldId, commit on probe pass (9.3) |
| Dead or indeterminate session passes the clean stop | adversarial 3, integration P20 | Adopted: affirmatively live idle (7.3, 17) |
| Lock before snapshot; complete pre-clear snapshot; durable queue; replay | GPT 1, scalability 3, DC 7, integration 8 | Adopted: 9.3 order, Durable Inbound Message Queue hold, PendingInjectStore, TTL |
| Unfinished work between retained spans | GPT 2 | Adopted: coverage verification, unclassified ranges retained (7.4, 7.5) |
| H3 has no fresh input without folds; backfill of C | GPT 3, scalability 5 | Adopted: chunks on span close, watermark, pre-layer chunk (6.5) |
| Explicit user redirection delayed | GPT 4 | Adopted: instruction followed at once; purpose record tentative and hedged (6.1) |
| Break-even dimensionally incomplete | GPT 5, Fable 11 | Adopted: definition with remaining-turns estimator (7.2) |
| Never-clean sessions get only the generic path | Fable 1 | Adopted: bounded checkpoint requests, pause-and-handoff, `checkpoint-unreachable` (7.2, 7.3) |
| Unplanned compaction leaves a hole in the layers | Fable 2 | Adopted: PostCompact archives, chunks, rebuilds before reseed; gap pointer (9.5) |
| `retrievable` hides loss | Fable 4 | Adopted: typed items; retrievable for detail only with logged lookup (10) |
| User-directed evolutions confirmed with nothing shown; silence as consent; LLM label as authority | Fable 5, lessons F4, adversarial 10, DC 1, gate (Judgment Within Floors) | Adopted: tentative on write, v14 evidence model, narrowing always surfaced, no silence confirmation, expiry from surfacing (6.1) |
| Fold lock at the moment the user replies; unbounded; presence/stall collisions | Fable 6, scalability 3 | Adopted: idle/cache-expired seam preferred, abort before point of no return, TTL, suppression registration (7.3, 9.3) |
| Delta hook needs reset rule and dependency gate; shrinks context before measurement | Fable 7, DC 8, lessons F11, integration 3 | Adopted: context epoch, seeded marker, per-machine gate, shadow comparison (7.7) |
| Transcript archive: no path, scrub, retention, auth, compression, non-blocking copy, backup posture | Fable 8, security 1, scalability 4, integration 7, DC 9 | Adopted (9.7, 7.6, 14) |
| Shadow mode touches the live session | Fable 9 | Adopted: sampled, costed, excluded from baseline (13.13) |
| Grader holds rollback authority without logging | Fable 10, lessons F5 | Adopted: tier table, enumerated grades, logged decisions, deterministic rule above the grade (10, 15) |
| Handoff-minted quotes bound to text, not sender; forwarded rows inherit authority | adversarial 1, 7, security 7 | Adopted: row binding is the sole write path; forwarded/relay excluded (6.2, 8) |
| One-directional milestone audit | adversarial 4 | Adopted (7.1, 7.4) |
| Unbounded rollback loop | adversarial 5 | Adopted: breaker to shadow mode (9.3) |
| "Own history" marker false for shared-authored layers; twin sessions | adversarial 6, 13.16 | Adopted: author on every entry; exclusive-session rule (6, 13) |
| Suppression names no mechanism | security 5, adversarial 8, lessons F3, DC 12 | Adopted: muzzle + PreToolUse read-only + probe marker allowlist; audited refusal count (10) |
| Tool-origin text re-injected as trusted history | security 2 | Adopted: origin labels, data fence, verifier rejection (7.4, 7.5) |
| New routes vs privacy scope and team roles | security 3 | Adopted (7.6) |
| No epoch fence; `/clear` outside the control-command union | security 4, lessons F1/H | Adopted (9.2, 9.3) |
| Per-fold LLM overhead unbounded, unlaned | scalability 2, DC 5 | Adopted: generation from folded spans ≤ 30K, LlmQueue lanes and budgets, cost in break-even (7.2, 10, 13.7) |
| H3 rebuild O(folds) | scalability 1, lessons F17 | Adopted: C2 tier and bounded selection (6.5) |
| Ask rate unbounded; cadence load | scalability 6, 7, lessons F17 | Adopted: ask brakes, bounded ticks (6.4, 7.2) |
| No multi-machine posture section; infeasible unified via working-set handoff | integration 1, lessons F14 | Adopted: section 14 with a new replicated kind for small layers and proxied-on-read for the archive |
| Codex receives the changed hooks | integration 3 | Adopted: no `source` ⇒ today's behaviour; delta keyed on seeded marker (7.7, 9.1, 9.6) |
| Rollback "one switch" conflicts with retiring the summarizer and overwritten hooks | integration 4, DC 10 | Adopted: named switches, summarizer kept behind the switch (13.10) |
| PreCompact/PostCompact wiring absent | integration 5 | Adopted (9.1) |
| P20 table missing | integration 6 | Adopted (17) |
| Backfill confirmation floods topics | integration 8, DC 3 | Adopted: folded into next reply, never standalone, never blocking (6.1) |
| Rollback notice flapping | integration 9, lessons F18 | Adopted: breaker-bounded; P22 routing (13.2) |
| Decision points / Frontloaded Decisions / open questions / lessons-engaged / supervision / testing / supersedes missing | DC 1, 2, 6; lessons F5, F7, F8, F10, F2 | Adopted: sections 12, 13, 15, 16, 18, 20 and the frontmatter |
| Two post-compaction injectors; one carrier | lessons F2 | Adopted (3.2, 9.1) |
| Hook fix swaps one unverified parse for another; absence ⇒ startup | lessons F9 | Adopted: `unknown` + degradation record + standing canary (9.1, 17) |
| Pending-confirm primitive contradicted | lessons F6 | Adopted: extended with kind/TTL/priority/deferred (6.1, 13.15) |
| Staged rollout with no dated rungs or owner | lessons F7, DC 6 | Adopted: section 16 maps to the maturation ladder; runs A/B/C (13.8) |
| Idle-prompt killer reaps mid-fold | lessons F16 | Adopted: recovery-veto sibling (9.3) |
| Oversize packet; inherited truncations | lessons F15, gate (Never Silently Cut) | Adopted: refuse never truncate; Anchor whole; inherited cuts replaced (3.2 item 8, 6, 9.2) |
| Fixed limits without basis (Anchor ≤ 300, G ≤ 3K by age, 20%, 3–5 questions, one-correction rule, 1-minute margin, 7 days) | DC table, lessons table, gate | Adopted: Anchor whole; G by status/reference; turns-to-wall floor; proportional questions; protected-class rule; CommitmentTracker next-due; expiry from surfacing (12) |
| Documentation promising a recovery that never ran | lessons F19 | Adopted: template correction via migrateClaudeMd (9.1) |
| Agent controls and routes without awareness entry | lessons F13 | Adopted (7.1, 13.14) |
| Precision items (DoS caps, age stamps, cursor, entry ids, fail-closed judge, response shapes, version refs, glossary, success sample size) | several | Adopted in passing where one line sufficed; the rest listed in the convergence report's Left behind |

Nothing from round 1 was rejected. One item was adopted in a narrower form: the
critical cap remains, as a bounded checkpoint request rather than a span pick.
