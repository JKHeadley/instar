---
title: "Context Budget: Layered Summaries"
slug: "context-budget-layered-summaries"
author: "echo"
created: "2026-11-09"
status: "draft"
approved: false
commitment: "CMT-1536"
requested-by: "Justin, topic 130742, 2026-11-09 14:01 PST"
parent-principle: "Structure beats Willpower; Harness built-ins before our own"
review-convergence: null
---

# Context Budget: Layered Summaries

Status: **first draft, unreviewed.** No code yet. Needs `/spec-converge` and
Justin's read before any build.

## 1. What Justin asked for

Justin, topic 130742, 2026-11-09 14:01 (his words):

> "Ideally, I would like our infrastructure to be as highly optimized as
> possible, which includes the ability to reference longer context as needed to
> fill in details, but also to leverage highly optimized summaries on different
> levels ... we should already have infrastructure that's attempting to do
> this, but it seems to be failing ... we should be having some sort of rolling
> summary on multiple fractal levels as conversations grow."

He is also worried that shrinking context has caused drift before. So the bar
is two-sided: **use far fewer tokens per turn, and do not lose the thread.**

## 2. What is happening today (measured 2026-11-09)

- Long topic sessions run until Claude Code's own auto-compact fires at
  roughly **968K tokens**. The build desk compacted 4 times in 2,714 turns;
  the Instar App topic 22 times in 8,097 turns. Between compactions almost
  every turn re-reads hundreds of thousands of tokens.
- Opus 5.5 used about **4.4B tokens on the Mac Studio in 24 hours**, mostly
  cache reads — the cost of re-reading a huge context every turn.
- Our summaries exist but are **added on top** of the conversation; they never
  replace it. Nothing ever makes the live context smaller except Claude Code's
  generic compaction near the wall.

## 3. What already exists, and where it fails

All line numbers are against `origin/main` at `d855bad39a` (2026-11-09).

### 3.1 Layers we already have

| Layer | What it is | Where | Fresh? |
|---|---|---|---|
| Full history (verbatim) | Every topic message in SQLite with full-text search | `src/memory/TopicMemory.ts` (search at `:605`), `GET /topic/search` (`src/server/routes.ts:30954`) | Yes, written live |
| Rolling topic summary | One LLM summary + PURPOSE line, updated incrementally | `src/memory/TopicSummarizer.ts` (threshold 20 msgs, `:45-49`), stored by `TopicMemory.saveTopicSummary` (`:671`) | **No — see 3.2** |
| Topic / recent arc / current work | Three-level "awareness" projection written by the intent extractor | `src/core/TopicIntentExtractor.ts` (prompt `:255-276`), `src/core/TopicAwareness.ts`, rendered by `src/core/TopicIntentBriefing.ts` | Yes, per message |
| Decisions / facts / goals | Evidence-scored propositions; each piece of evidence keeps `sourceMessageId` and `userAuthored` | `src/core/TopicIntent.ts:60-85` | Yes |
| Draft-vs-arc check | Signal-only check of a draft reply against settled items | `src/core/TopicIntentArcCheck.ts` | Yes (signal only) |

### 3.2 Where it fails

1. **The rolling summary only updates when a session ends.** It is wired to
   `sessionManager.on('sessionComplete')` (`src/commands/server.ts:13571-13585`).
   Long topic sessions rarely end, so the summary goes stale exactly where it
   matters most. Live check on this agent's database, 2026-11-09: one topic's
   summary is **1,516 messages behind** (last updated 2026-10-26); Justin's
   topic 130742 is 42 messages / two days behind.
2. **Summaries are added, never substituted.** At spawn, `formatContextForSession`
   (`src/memory/TopicMemory.ts:1005`, called from `src/commands/server.ts:1551`)
   prepends summary + last 50 messages. On every prompt,
   `telegram-topic-context.sh` (`src/templates/hooks/telegram-topic-context.sh:76-102`)
   prepends the intent briefing and the last 30 messages. All of it sits on top
   of the full live conversation, so total context only grows.
3. **The compaction-recovery hook does not run after compaction.** Settings wire
   `SessionStart` matcher `compact` to `session-start.sh` (`src/commands/init.ts:5456-5459`),
   which decides whether this is a compaction from `CLAUDE_HOOK_MATCHER`
   (generated at `src/core/PostUpdateMigrator.ts:19408`, defaulting to `startup`)
   and only then `exec`s `compaction-recovery.sh`. **The installed Claude Code
   (2.1.321) never sets `CLAUDE_HOOK_MATCHER`** (zero occurrences in the
   binary); it passes `source: "compact"` in the hook's stdin JSON instead. One
   checked transcript on this machine had 12 compaction summaries, 60 ordinary
   session-start blocks, and **zero** compaction-recovery blocks. So after every
   compaction the agent gets the startup orientation, not the topic briefing +
   recent messages that `compaction-recovery.sh:378-412` was written to restore.
   This is plausibly part of the drift Justin has seen. (Needs a wider sample —
   see Phase 0.)
4. **The one "compact before the wall" feature was retired unused.**
   `ProactiveCompactionSentinel` (spec `docs/specs/proactive-autonomous-compaction.md`)
   was opt-in, never enabled anywhere, and removed on 2026-10-28
   (`docs/specs/retire-staged-features-2026-10-25.md:38`, PR #2363). Today the
   only server-pressed `/compact` is the context-wall recovery rung
   (`src/monitoring/ContextCompactionControl.ts:21-47`), which fires only after
   the wall is hit.
5. **The pre-compaction hook only reports.** `PreCompact` runs
   `hook-event-reporter.js` (`src/data/http-hook-templates.ts:56`) feeding
   `CompactionSentinel` (`src/monitoring/CompactionSentinel.ts:226`) and the
   optional, default-off `PreCompactionFlush` (`src/core/PreCompactionFlush.ts`).
   It never shapes what the compaction keeps.
6. **Instar never sets any Claude Code compaction setting.** No source file sets
   the auto-compact window, so every session uses the model's full ~1M window.

## 4. What Claude Code lets us control (verified, not guessed)

Verified by reading the strings of the installed binary,
`/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
version **2.1.321**, on 2026-11-09. These are internal behaviours of a
fast-moving program; Phase 0 re-verifies each one live before anything relies
on it.

| Lever | What it does | Evidence |
|---|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var | Sets the auto-compact window in tokens, **100,000 to 1,000,000** (e.g. `250k`). Out-of-range values warn. | `pI=1e5`, `dW=1e6`; warning text "Set it to a size from 100k to 1M" |
| `autoCompactWindow` setting (top-level or per model) and `/autocompact [auto\|<tokens>]` | Same window, from settings.json or a slash command (saved per model). | settings schema description; command "Set how full the context gets before auto-summarizing" |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Lowers the threshold by percent — **but only when `CLAUDE_CODE_REMOTE` is set**. Not usable for our local sessions. | condition in `vre()` |
| `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, `autoCompactEnabled` | Turn auto-compact (or all compaction) off. | env/setting names present |
| `/compact [instructions]` typed into the session | Manual compaction with our own instructions. We already inject `/compact` (`src/core/SessionManager.ts:9395`). | existing code |
| **`PreCompact` hook** | Receives `trigger` (`manual`/`auto`) and `custom_instructions`. It can **block** the compaction ("Compaction blocked by PreCompact hook") or **add instructions** that are merged into the summary prompt (`newCustomInstructions`). Applies to auto, reactive and precomputed compaction. | hook schema; `XMt(…, newCustomInstructions)`; `blockedBy` handling |
| **`PostCompact` hook** | Receives `compact_summary`, the summary Claude wrote. We can store and check it. | hook schema |
| `SessionStart` hook, `source: "compact"` / `"clear"` | Runs after compaction or `/clear`; its output is injected into the fresh context. | hook schema `source: ["startup","resume","clear","compact","fork"]` |
| Idle compaction (`idleCompaction` setting, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`) | Claude Code may compact an idle session on its own, with internal gates (≥200K tokens by default, one-hour cache mode, warm cache). We have no evidence it fires for us. | `Vkr()` gate reasons |

Still to verify in Phase 0: the exact hook output format that sets
`newCustomInstructions` and that blocks (stdout vs JSON field vs exit code);
whether `/clear` can be injected the same way as `/compact`; whether the window
setting is honoured for Opus 5.5 at 1M.

## 5. The design

### 5.1 The layers ("fractal" summaries)

Every topic gets five layers. Each lower layer is more detailed and less often
loaded:

| # | Layer | Size target | Updated |
|---|---|---|---|
| L4 | **Topic**: what this topic is for, standing goals | ~150 tokens | When it changes |
| L3 | **Recent arc**: the current stretch of work and why | ~300 tokens | Every arc change |
| L2 | **Current work + next step** | ~200 tokens | Every user turn |
| D | **Decisions ledger**: each settled decision with the **user's exact words** and time | ≤ 3K tokens, newest first | Every decision |
| L1 | **Rolling summary** of everything since the topic began, stitched from per-chunk summaries (summary of summaries) | ~2–4K tokens | Every 20 messages *while the session runs* |
| L0 | **Full history**, verbatim, searchable | unbounded, never loaded whole | Live |

L4/L3/L2 already exist (the awareness projection). D is built from existing
decision refs: the packet renders the user's original message by
`sourceMessageId` from L0, not the extractor's paraphrase — so decisions stay in
Justin's words. L1 exists but must be fixed to update on a message cadence, not
on session end, and to summarise in chunks (each chunk summary kept, then
re-summarised) so it scales to topics with thousands of messages.

### 5.2 Per-session working-context budget

- Each topic session gets a **budget**, default 200K tokens of live context
  (configurable per topic; desks doing heavy code reading may get more).
- The server reads live context size from the session transcript (the same
  JSONL the `TokenLedger` already scans) — the last turn's input + cache tokens.
- At **80% of budget** the session is marked *due for a shrink*. Nothing
  happens mid-turn.

### 5.3 The shrink, at the next clean stopping point

A **clean stopping point** = the session is idle
(`SessionManager.checkSessionWorkState === 'idle'`), it has just sent its reply,
no tool call or build step is in flight, and no user message is waiting.

The shrink replaces the context, it does not add to it:

1. Server builds the **resume packet**: L4 + L3 + L2 + D (verbatim) + L1 + the
   **last 10–20 turns verbatim** (by token cap, ~20K) + a pointer to the
   on-demand lookup (5.4) + any open in-session state (files being edited,
   branch, running jobs) captured from the transcript.
2. Server clears the conversation and starts it fresh with that packet. Two
   routes, chosen in Phase 0 by which one Claude Code supports cleanly:
   - **(a) Clear-and-seed**: inject `/clear`; the `SessionStart` hook with
     `source: "clear"` prints the packet. Context becomes exactly the packet.
   - **(b) Steered compaction**: inject `/compact`; the `PreCompact` hook
     supplies instructions that tell Claude to keep the packet's content and
     the verbatim decisions; the `SessionStart` (`compact`) hook re-injects the
     packet. Less control, but stays inside Claude Code's normal path.
3. **Backstop**: set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for our sessions to
   ~1.5× the budget (e.g. 300K), and have the `PreCompact` hook add our
   packet's instructions to *every* compaction, including unplanned ones. So
   even if our shrink never fires, no session climbs to 968K again, and every
   compaction keeps our layers and Justin's words.

Fix first, regardless of the rest: make `session-start.sh` read `source` from
its stdin JSON instead of `CLAUDE_HOOK_MATCHER`, so compaction recovery runs at
all (3.2 item 3). That ships through `PostUpdateMigrator` so existing agents get
it.

### 5.4 On-demand lookup of older detail

The packet tells the session how to fetch detail instead of carrying it:

- `GET /topic/search?topic=N&q=…` (exists) — full-text over L0.
- New: `GET /topic/:id/messages?around=<messageId>&n=…` — the verbatim
  neighbourhood of a hit.
- New: `GET /topic/:id/summary-chunk/:k` — one L1 chunk summary, to zoom in a
  level before reading raw messages.

This is what lets the budget be small: the agent zooms in only when it needs to.

### 5.5 The anti-drift gate (post-shrink readback)

Right after a shrink, before the session continues any work:

1. The session is asked one fixed question: *"In two lines: what is the goal of
   this topic right now, and what is your next step?"*
2. A small model compares that readback against L2 + L3 + the last three
   decisions in D. Verdict: `match`, `minor` (wording differs, same goal/step),
   or `mismatch` (different goal, a decision dropped, or a next step that
   contradicts a decision).
3. `match`/`minor` → continue. `mismatch` → the session gets the specific
   correction ("You said X; the last decision, in Justin's words, is: '…'") and
   reads back once more. A second mismatch → the shrink is rolled back to the
   pre-shrink transcript (resume the old session) and the event is recorded
   for review.

This is the measurable answer to "shrinking caused drift": every shrink gets
checked, and failures are counted, not guessed at. The readback is internal —
it is never sent to the user.

### 5.6 Measurement

Recorded per session and per topic, shown on one dashboard card:

- tokens per turn (input + cache read + cache write), before vs after rollout;
- live context size over time, and shrinks per day;
- readback results: match / minor / mismatch / rolled back;
- lookups used after a shrink (are sessions zooming in when they need to?);
- user corrections in the 10 turns after a shrink vs baseline (from the
  existing correction-learning records) — the drift signal Justin would feel.

Success: tokens per turn on long topics down by at least half, with readback
mismatch under 5% and no rise in post-shrink corrections.

### 5.7 Rollout

1. **Phase 0 — verify and fix (no behaviour change except the bug fix).**
   Re-verify every lever in section 4 live on a throwaway agent. Fix the
   `CLAUDE_HOOK_MATCHER` bug. Sample more transcripts to size it. Turn on
   per-turn token measurement so we have a baseline.
2. **Phase 1 — dark.** Build the layers (L1 cadence fix, D ledger, chunked L1),
   the packet builder, and the readback checker. Run it in **shadow**: on each
   long session, compute what the packet would have been and run the readback
   check against a copy, without touching the live session. Record sizes and
   would-be verdicts.
3. **Phase 2 — one session.** Turn it on for one busy topic Justin picks (the
   build desk is the obvious candidate), with the backstop window set. Watch
   one week of numbers.
4. **Phase 3 — fleet.** Default on for all Claude Code topic sessions, budget
   per topic overridable. Codex sessions get the same layers and packet through
   their own compaction lifecycle (`src/providers/adapters/openai-codex/control/compactionLifecycle.ts`)
   in a follow-up.

Rollback at every phase: one config switch returns to today's behaviour; the
backstop window is a separate switch.

## 6. Open questions (for Justin)

1. **Budget size.** Start at 200K live tokens per topic session (about a fifth
   of today's peak)? Lower saves more but shrinks more often.
2. **Clear-and-seed vs steered compaction.** Clear-and-seed gives us full
   control of what the session keeps; steered compaction is safer because it
   stays inside Claude Code's normal path. Proposal: try both in shadow, pick
   by readback results.
3. **Readback visibility.** The readback is internal. Should a mismatch that
   forces a rollback also be told to you in the topic, or only shown on the
   dashboard? (Note: in April you pushed back on telling a resumed session the
   intent explicitly — the readback asks the session to state it, it does not
   dictate it.)
4. **Which topic goes first** in Phase 2 — build desk?
5. **Unplanned compaction.** OK to lower Claude Code's own auto-compact point
   for all our sessions (to ~300K) as an early, separate step? It is the
   single biggest saving and is reversible with one setting.

## 7. Out of scope

- Changing how the user-facing Telegram history is stored.
- Any change to the constitution.
- Non-topic job sessions (they are short-lived; revisit with numbers).
