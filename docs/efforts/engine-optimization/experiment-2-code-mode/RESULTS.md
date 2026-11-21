# Experiment 2 — Does Code Mode save anything on our conversations?

**Verdict: REJECT (do not adopt as a trial).** Code Mode cost **4.0% less per successful task** than normal tool calling. The bar was **≥20% lower cost with no drop in completion**. Completion was 100% in both arms, so the completion half of the bar was met; the saving half was missed by a wide margin.

Run 2026-11-20 20:17–20:29 PST on the Studio, by the echo-topic-146486 session. Authority: Justin, topic 141868, 2026-11-20 20:09 PST, "Run all three". Plan: Engine Optimization findings doc, section "The first three experiments", item 2.

## The numbers

| | Code Mode off | Code Mode on |
| --- | --- | --- |
| Runs | 36 | 36 |
| Successful | 36 (100%) | 36 (100%) |
| Total cost (all runs) | $1.358 | $1.304 |
| **Cost per successful task** | **$0.0377** | **$0.0362** |
| Saving | | **4.0%** |
| Turns per run (mean) | 4.3 | 4.0 |
| Output tokens per run (mean) | 648 | 621 |
| Cache-read tokens per run (mean) | 39,021 | 42,432 |
| Wall time per run (mean) | 11.0 s | 10.1 s |

Paired by task and repetition (36 pairs), the on arm was cheaper in 24 pairs, by a mean of $0.0015 per pair. Nine of twelve tasks were cheaper on; three were cheaper off. No task reached a 20% saving on its own (best: T10 at 16.2%).

### Per-task table (3 runs per arm per task)

| Task | Off: done | On: done | Off: $/success | On: $/success | Saving |
| --- | --- | --- | --- | --- | --- |
| T01-log-triage | 3/3 | 3/3 | 0.037 | 0.039 | -6.0% |
| T02-rename | 3/3 | 3/3 | 0.047 | 0.049 | -3.6% |
| T03-fix-bug | 3/3 | 3/3 | 0.045 | 0.041 | 8.9% |
| T04-usage-rollup | 3/3 | 3/3 | 0.029 | 0.028 | 2.3% |
| T05-job-audit | 3/3 | 3/3 | 0.036 | 0.035 | 4.1% |
| T06-todo-index | 3/3 | 3/3 | 0.030 | 0.028 | 6.9% |
| T07-bulk-config | 3/3 | 3/3 | 0.035 | 0.033 | 4.0% |
| T08-git-forensics | 3/3 | 3/3 | 0.030 | 0.027 | 10.4% |
| T09-dead-exports | 3/3 | 3/3 | 0.043 | 0.045 | -3.6% |
| T10-add-feature | 3/3 | 3/3 | 0.050 | 0.042 | 16.2% |
| T11-incident | 3/3 | 3/3 | 0.036 | 0.035 | 3.1% |
| T12-doc-sync | 3/3 | 3/3 | 0.034 | 0.032 | 5.0% |

### Early-stop gate (first 4 tasks)

Rule, fixed in `harness/analyze.mjs` before any result was read: stop if the on arm's cost per successful task is not lower than the off arm's over T01–T04. Result: 0.5% saving, 100% completion both arms, 2 tasks cheaper on and 2 cheaper off. By the rule that is a continue; it was a near miss and is recorded as such in `gate-record.md`. I continued because the remaining 48 runs cost about $1.50 of ordinary subscription usage and four tasks were too few to settle the question. The full run confirmed the gate's reading.

## What it means

- On tool-heavy, conversation-sized tasks, Code Mode is roughly a wash: a few percent cheaper, a few percent faster, same results. It is not the 20%+ lever the plan asked for, so it does not earn a trial on our conversations.
- The saving that exists comes from slightly fewer model turns (4.0 vs 4.3) and slightly fewer output tokens; Code Mode's scripts did many more nested tool calls (about 30 per run vs 3) without those calls costing model tokens, which is the mechanism working as advertised, just on tasks too short for it to matter.
- This does not rule out a saving on much longer conversations with larger contexts, where each avoided turn re-reads a far bigger prompt. That is a different experiment (long-session, large-context) and would need its own bar; this one measured what the plan asked for.
- Experiment 1 (guard coverage inside Code Mode) is independent of this result and still decides whether Code Mode may be on at all.

## Method

- **Where:** a throwaway Instar agent at `/private/tmp/claude-501/e2cm/agent` (port 4196, expires 2026-11-21T16:16Z, auto-start and updates off). Nothing touched the live Echo agent or any real topic. Each run worked in a fresh copy of a generated fixture repo, deleted after its check.
- **Engine:** Claude Code 2.1.330 (the pinned copy Echo's sessions use), driven headless through `@anthropic-ai/claude-agent-sdk` 0.3.330, model `claude-sonnet-5-5` in both arms, `bypassPermissions`, max 40 turns and $3 per run, $60 total cap (actual total: $2.66 across all 72 valid runs; $1.02 of that was the first gate batch before the T02 correction). Outbound and scheduling tools (web, cron, messaging, subagents) were disallowed in both arms so the agent could only work on the files.
- **The switch:** `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` (on) or `=0` (off), set both in the child's environment and via `--settings`. The rollout flag for Code Mode is on for every login in Echo's pool, and the headless path does not need the interactive caveat acceptance.
- **Proof the arms differ:** in the off arm, every direct tool-call block carries the SDK's `caller` field; in the on arm, tool calls come from the script and carry none. Every run's blocks were checked against its arm (`armOk`): 72 of 72 correct, 0 wrong-arm runs. In a probe the on-arm model also announced "I'm about to call the tool named REPL". The smoke test that found this also found that the Homebrew `claude.exe` became unlaunchable (EACCES) mid-session; the harness uses Echo's pinned copy instead.
- **Cost:** the SDK's `total_cost_usd` per run (API-equivalent dollars; the runs were billed to the subscription, not an API key). Cost per successful task = all spend in the arm, failed runs included, divided by successful runs.
- **Tasks:** 12 tool-heavy maintenance tasks typical of our conversations — log triage, a safe rename, a bug fix from a failing test, a JSONL rollup with malformed lines, a job-registry audit, a TODO index, a bulk config edit, git forensics, dead-export detection, adding a function with tests, an incident reconstruction across two files, and syncing an API doc to the routes. Each has a deterministic check against a truth file the agent never sees (`harness/truth.json`); every check was shown to reject the untouched repo and accept a reference solution (`harness/validate.mjs`, `harness/validate2.mjs`).
- **Order:** 3 repetitions per task per arm, arm order alternated per task and repetition, 3 runs in parallel.
- **One correction:** the first 6 runs of T02-rename were invalidated and rerun because the check demanded the whole test suite pass while the fixture carries a deliberate failing test for T03; a perfect rename could never pass. Those 6 rows are archived in `harness/results.invalid-t02.jsonl` and counted nowhere.

## Files

- `harness/results.jsonl` — the 72 valid runs, one row each (task, arm, rep, success, armOk, cost, turns, tokens, time).
- `harness/results.invalid-t02.jsonl` — the 6 invalidated T02 rows.
- `harness/gen.mjs` (fixture + truth), `harness/tasks.mjs` (prompts + checks), `harness/runner.mjs`, `harness/analyze.mjs` (the fixed verdict rule), `harness/validate.mjs`, `harness/validate2.mjs`, `harness/smoke.mjs`, `harness/probe4.mjs` (arm-difference proof).
- `gate-record.md` — the early-stop decision as written at the time.

To reproduce: install the SDK next to the harness, run `gen.mjs`, then `runner.mjs 0 12`, then `analyze.mjs`.
