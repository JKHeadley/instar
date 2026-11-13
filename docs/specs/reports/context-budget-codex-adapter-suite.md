# Context Budget — Codex adapter verification suite: recorded result

**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.6 (the harness-adapter contract, Codex column), §16 Phase 1 ("Ends when the Codex suite has a recorded result").
**Slice:** Phase 1 S17 (`cb-codex-seed`).
**Raw result:** `docs/specs/reports/context-budget-codex-adapter-suite.result.json` (the exact file the suite wrote, schema `adapter-suite/1`).

## The run

| Field | Value |
|---|---|
| Machine | `m_e8c9b243c449b1337713bc29d47a6f3a` (MamaPC, linux-x64) |
| Engine | `codex-cli` |
| Version | `0.167.1` (from `codex --version`) |
| Ran at | 2026-11-11T05:09:08Z (the recorded run; an earlier run at 04:41:50Z, before the second-pass fixes to the evaluator's wording and checks, gave the same 16 states) |
| Duration | 47.7 s |
| Inconclusive | no (zero engine errors) |
| Account home | the default `~/.codex` (ChatGPT Pro, 41% of the weekly window left before the run) |
| Session | one throwaway headless thread (`codex exec`, then `codex exec resume` on that thread), in a fresh git project under `/tmp`, never a channel topic |

**Reading "in the model's input".** Codex records every hook output it passes to the model as a developer message in the rollout. The rows that say "in the model's input" are judged from that record. Model recall is collected as corroboration only, because a model asked to list tokens does not reliably list developer notes.

How it was run: `adapterSuiteCli.ts <stateDir> <machine> --engine=codex-cli --codex-bin=/usr/bin/codex`. The suite's own guard refused the first attempt, because the launching shell belonged to topic 141133 (`refused: the target is bound to a channel topic (INSTAR_TELEGRAM_TOPIC is set)`). That was the guard's positive control. The recorded run was launched with the topic variables removed, which is how the server's sentinel spawns it.

What it costs: six engine calls on one thread (first prompt, tool-policy prompt, `/compact`, a forced compaction, and one resume of a restored copy). The one throwaway project trust entry Codex writes to `config.toml` is removed after the run.

## Counts

**8 supported, 3 partial, 0 synthesized, 5 absent.** Four of the five absent rows are rows this suite does not measure. They are recorded `absent` per §17 ("unmeasured ⇒ absent until the suite re-runs").

## Per-row verdicts

| Capability | Spec §9.6 expected | Measured | Evidence |
|---|---|---|---|
| Transcript read | supported (cache counters absent) | **supported** | The rollout is at a known path, with entries and the session id. `token_count` carries `cached_input_tokens`. |
| Control-command inject (`/compact`) | absent | **absent** | `/compact` as a headless prompt did not produce a `compacted` entry. The model treated it as text. |
| Control-command inject (`/clear`) | absent | **absent** (unmeasured) | `codex exec` has no clear command. |
| Compaction detection | synthesized + transcript channel | **supported** | The rollout's `compacted` entry, with its `window_id`, AND a native `PreCompact` hook (trigger `auto`). A fork's inherited copies, the case S16 guards, were not exercised. |
| Pre-compaction steering | absent | **partial** | The `PreCompact` hook runs, but its output reaches nothing. The steering token appears nowhere in the rollout. |
| Post-compaction event with the summary | absent | **partial** | A `PostCompact` hook fires after compaction, with no summary. The rollout's `compacted.message` is empty too. |
| Fresh-context seed after compaction | absent (UserPromptSubmit is the carrier) | **supported** | `SessionStart(source=compact)` fired, and its seed is in the model's input after the compaction: a developer message in the rollout. The `UserPromptSubmit` next-prompt carrier is in the input after it too. Asked to list every token in its context, the model did not echo either one. So this row rests on the recorded input, not on recall. |
| Fresh-context seed after clear | absent | **absent** (unmeasured) | No headless clear command. |
| Spawn with initial context | supported | **absent** (unmeasured) | Rung 2 uses Instar's own spawn path (`formatContextForSession`), which is covered by its own tests. Same treatment as the Claude Code suite. |
| Materialise-and-resume restore | partial until verified | **supported** | A pre-compaction copy of the rollout, under a new thread id, resumed and recalled the codeword. |
| Compaction window setting | absent | **supported** | `-c model_auto_compact_token_limit=<n>` pressed a real auto compaction at the configured size. |
| Per-prompt delta injection | supported | **supported** | `UserPromptSubmit` output is in the model's input as a developer message, byte-whole at 7,000 characters (the full probe text matched). That is larger than a delivered standing packet (6,000). |
| Per-session tool policy | supported | **supported** | A `PreToolUse(.*)` deny refused the shell call. Its reason reached the model as the tool's output, and the command never ran. |
| Clean-stop signals | supported / partial | **absent** (unmeasured) | Instar-side signals, not engine capabilities. |
| Cost model | partial | **partial** | Cache-read counters are exposed. The engine gives no cache pricing or TTL. |
| Framework discriminator | supported | **supported** | `INSTAR_FRAMEWORK` reached the hook environment. |

## What differs from the spec's Codex column, and what it means

Codex 0.167.1 measures **better** than the spec's "as the code stands today" column on six rows:
- compaction detection;
- pre-compaction steering;
- the post-compaction event;
- the compaction seed;
- materialise-and-resume;
- the compaction window setting.

The spec wrote that column from an older Codex. It says itself that the suite "then records the table above as measured", so the measured states above are the record. Three consequences are left for the spec owner. They are not acted on in S17, because the approved spec is not edited here:

1. **A closer seed carrier exists on 0.167.1.** `SessionStart(source=compact)` fires and reaches the model. Instar's installed `session-start.sh` already runs on it: for a non-Claude engine it execs the legacy recovery block. S17 builds the spec's carrier, the `UserPromptSubmit` next-prompt seed, which works on every Codex version. A later slice could move the packet onto the compact seed for versions where the suite records it `supported`, keeping next-prompt delivery as the fallback.
2. **A synthetic positive control is possible on Codex.** Lowering `model_auto_compact_token_limit` for one resume pressed a real compaction on a throwaway thread. That is the §9.1 press the Codex canary group lacks today. Until it is built, the group stops at `accruing`.
3. **The §9.5 backstop window is available on Codex** (`model_auto_compact_token_limit`). The spec had recorded it as `absent`, so no backstop.

## Where the result is stored

The suite writes `state/context-budget/adapter-suite/codex-cli-0.167.1.json` in the state directory it is given. For this run that was a scratch state directory. This slice's builder works only in its worktree and does not write the live agent's state, so the result is preserved here instead, together with the raw JSON. On the live agent the sentinel's trigger records the same file on its first tick, once this build is deployed and both switches are on: `contextBudget.adapterSuite.enabled` (default off, because the suite spends model calls) and the `contextBudget.enabled` dev gate. That is one run per unrecorded `(machine, engine, version)`, with at most 3 attempts and a 24-hour retry floor.
