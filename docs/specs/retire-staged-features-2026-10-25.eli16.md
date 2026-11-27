# Retiring five unused experimental features — plain-English overview

## What this change is

Instar ships a lot of features "dark": built, but switched off (or only
watching and logging) until there is evidence they help. On 2026-10-25 we ran a
maturation review: for every such feature, two different AI model families were
asked "graduate it, keep testing it, or retire it?" Five got a clear "retire"
from both. This change removes them. Retiring is one of the review's three
normal outcomes — nothing here skips a promotion step, because nothing is being
promoted.

## The five

1. **Two cartographer switches** (an LLM "enrichment" step for the standards
   audit, and an LLM "re-ranking" step for code-map search). The switches exist
   in the settings file, but no code ever reads them. The one helper component
   written for the enrichment step has no caller either, so it goes too.
2. **The review-flag experiment.** It asked an outside model whether each of the
   agent's replies needed the operator's eyes. It flagged 68% of replies; to be
   useful it needed to be around 25% or lower. It was already turned off.
3. **Proactive compaction for long autonomous runs.** It would have compacted a
   session's memory early. Nobody ever turned it on, and the existing
   "context is full" recovery already tries compaction first.
4. **A stray `quotaLimits` setting.** Instar never defined it; it drifted into
   one agent's settings file and nothing reads it.
5. **Two "did the user just ask me to do X?" recognizers** — one for "move this
   conversation to my other machine", one for "use a different model here".
   They have run in watch-only mode since July. They failed (timed out or
   errored) on more than half the messages they looked at, and across almost
   three thousand logged decisions they never once found a message they would
   have acted on. Meanwhile the agent itself already handles those requests by
   calling the proper routes (the transfer route, the topic-profile propose
   route, the dashboard controls).

## What already exists and stays

The machine-transfer route and planner, the topic-profile settings, the propose
route and the `/topic` command, the dashboard Machine and Door+model pickers, the
threadline hub recognizer, the topic pin store, and the normal context-full
recovery all stay exactly as they are.

## What users will notice

Nothing, on almost every agent: all five were off or watch-only. On a
development agent, two background LLM calls per matching message stop happening,
so those messages reach the session a little sooner. Settings files get a little
shorter. The agent's instruction file loses the review-flag paragraph and gets
two small wording fixes: the transfer card no longer says the server "catches"
a natural-language move (the agent calls the route), and the topic-profile card
now names the route the agent uses to propose a change for the operator's yes.

## Safeguards

- The update step only removes the specific settings named above, and is safe to
  run repeatedly.
- If an operator had deliberately switched one of these on, the update output
  says so in a line starting with `REVIEW:` (including the value that was
  removed) instead of removing it silently.
- The instruction-file paragraph is removed only when it is exactly the
  generated review-flag paragraph. Anything hand-edited is left alone and the
  agent is told to tidy it itself — never the operator.
- The same cleanup runs on the Codex and Gemini copies of the instruction file,
  so a mirror cannot re-introduce the paragraph.
- Old log files from the experiments are left where they are.

## Undo

Revert the change. The code comes back, the default settings are re-added on
the next update, and the instruction-file paragraph is re-added too. One honest
limit: a value an operator had set by hand is not restored automatically — it
is recorded in the `REVIEW:` line of the update output.

## What needs deciding

Nothing new: the retire decision was made by the review, and no constitution
file is touched.
