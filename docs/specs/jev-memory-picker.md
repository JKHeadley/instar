---
title: "Jev memory picker — rank the memory index at session start (shadow first)"
slug: "jev-memory-picker"
author: "echo"
parent-principle: "Signal vs. Authority"
parent-spec: "docs/specs/jev-signal-layer-shadow.md"
eli16-overview: "docs/specs/jev-memory-picker.eli16.md"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-09-30T20:00:00Z"
approved-via: "Operator approval 2026-09-30, Jev topic 95267: explore idea B2 (Jev picks which memories load at session start) and then build it, shadow first, dev-gated, dark on the fleet. Relayed in the build brief. Revocable: set intelligence.jevMemoryPicker.enabled false (read live) or revert."
review-convergence: "2026-09-30T21:30:00Z"
review-iterations: 1
review-completed-at: "2026-09-30T21:30:00Z"
review-report: "docs/specs/reports/jev-memory-picker-convergence.md"
cross-model-review: "not-run (one 80/20 round per the build brief; Codex quota kept for Astra)"
single-run-completable: true
frontloaded-decisions: 8
---

# Jev memory picker — rank the memory index at session start (shadow first)

## Problem statement

Claude Code's auto-memory index (`MEMORY.md` in the per-project memory folder, one
line per memory) is loaded into every session **by position**: the first ~25,000
characters (and at most 200 lines) are loaded, the rest is dropped. On Echo's index
(287 lines) the cut falls at line 117. The index is roughly newest-first, so what
gets dropped is whatever is oldest, not whatever is irrelevant.

The offline experiment (`docs/research/jev/field-notes/2026-09-30-idea2-memory-selection.md`,
30 real session openings, two independent labellers) measured:

- 44% of relevant entries sit beyond the cut; every case lost at least one.
- Ranking the lines with one batched Jev call (~240 ms p50, 430 ms max) and keeping the
  top 117 raised recall of relevant entries from **0.56 to 0.89** (0.91 under the second
  labeller). At 40 lines Jev recalled ~0.65.
- Jev's probabilities are low and bunched (6% of pairs reach 0.5), so a confidence
  cutoff is a poor selector — use a **fixed top-N by rank**.
- Jev over-ranks generic lessons and cannot connect our internal names (Sol, Fable,
  Mama PC) to the memories about them without a glossary.

## Proposed design

One module, `src/core/JevMemoryPicker.ts`, one route, one hook step.

### Inputs

- **The index.** `<configDir>/projects/<sanitized projectDir>/memory/MEMORY.md`, where
  `configDir` is the session's `CLAUDE_CONFIG_DIR` (default `~/.claude`) and the
  project key is Claude Code's own sanitisation (every non-alphanumeric character →
  `-`). The hook sends `configDir` and `projectDir`; the server only ever reads a file
  named `MEMORY.md` at that derived path, and only if `configDir` is an absolute path
  inside the user's home whose last segment starts with `.claude`. The checks run
  twice: on the given path, then on its `realpath` (a config dir linked out of home is
  refused), and an index file that is itself a symlink is refused (`lstat`). The
  project key contains no `/`, so no traversal is possible. Read async, capped at
  256 KB. The hook sends the **git root** as `projectDir` (from
  `git rev-parse --git-common-dir`), because Claude Code keys worktree sessions on the
  repository root; outside git it sends `CLAUDE_PROJECT_DIR`. A missing index is a
  `no-index` skip, not an error.
- **The opening context.** When the hook has a Telegram topic: the topic name plus the
  last 3 messages from TopicMemory (each clamped to 600 chars). Optionally an explicit
  `context` string in the body (clamped to 4,000 chars) for other callers. No context
  → skip with reason `no-context`.

### Entries and the pinned marker

Every line that starts with `- ` is an entry, identified by its 1-based line number plus
the first 8 hex of its sha256. A line that contains the marker `<!-- pinned -->` is a
**standing rule**: always added when it sits past the cut, never sent to Jev for ranking, and the marker is
stripped from the text. Nothing is pinned automatically; the operator (or the agent,
on the operator's word) adds the marker by hand. The note recommends keeping the
pinned set to 10–15 lines.

### Ranking

Claude Code still loads the positional prefix itself, and the picker cannot unload
it. So the picker ranks only the **candidates**: non-pinned entries beyond the cut.
Ranking the loaded lines would buy nothing. If there are no candidates, the whole
file already loads and the picker skips with `fits` (no call). Otherwise, one POST to TypeSafe
`/v1/systemone`, pinned model `jev-1.13.0`. The state is the scrubbed opening context,
preceded by the optional glossary. Two `noul` questions per non-pinned entry, in the
same call:

- **B (same subject):** the note concerns the same subject, system, account, machine or
  kind of work as the current request.
- **C (specific, principles excluded):** the note is about a specific system, account,
  machine, tool or piece of work the current request involves; a general working
  principle that would apply to any request does not count.

Score = mean of the two answers (a missing answer counts as the other one alone; an
entry with neither is not added). Averaging with C is what demotes the generic
lessons Jev over-ranks under B alone. Both wordings are frozen code constants.

### Composition

`inject` = the pinned entries beyond the cut (file order), then the candidates by
score (ties by file position), stopping at `injectLines` entries (default 40) or
`injectMaxChars` characters (default 10,000), whichever comes first. This is added
**on top of** today's load; it never reorders it. The note's recall figure for the
top 40 lines (0.65) and for 117 lines (0.89) bracket what "today's 117 plus 40 ranked"
should reach. The real number comes from the shadow rows, not from this estimate.

On any Jev failure (no key, timeout, HTTP error, model mismatch, no usable answers,
scrub error, daily cap, busy) no ranked line is added. Only the pinned entries beyond
the cut are added, because they need no ranking. With nothing pinned, which is the
state on ship, a failure is exactly today's load. The skips `no-context` and `fits`
behave the same way.

### Modes

- **shadow** (the default): the route answers `202` at once, the ranking runs detached,
  and one row is appended to `logs/jev-memory-picker.jsonl` (size-bounded with
  rotation): outcome, reason, the triggering event (`startup` / `resume` / `clear` /
  `other`), entry / prefix / pinned / candidate counts, the would-inject ids with
  scores, latency, model, and a sha256 + length of the context. No memory text and no message
  text is logged. Nothing is injected.
- **inject**: the route awaits the ranking (bounded — see below) and returns a block
  headed `--- MEMORY INDEX: RANKED ENTRIES BEYOND THE LOAD CUT ---` holding the
  would-inject lines in rank order; the hook prints it. The same row is logged.

The hook step runs on every session-start event that reaches it (startup, resume,
clear; compact is handed to the compaction-recovery hook before this step). Each is a
fresh load of `MEMORY.md`, so each is ranked. The event is logged on the row.

### Config (`intelligence.jevMemoryPicker`, read live per request)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | omitted → dev gate | live on a development agent, dark on the fleet; `false` is the kill switch |
| `mode` | `"shadow"` | `"inject"` prints the block |
| `model` | `"jev-1.13.0"` | pinned, never an alias |
| `timeoutMs` | 1500 | fetch abort, clamped 100–3000 |
| `injectLines` | 40 | ranked entries added past the cut, clamped 0–200 |
| `injectMaxChars` | 10000 | character cap on the added entries, clamped 0–50,000 |
| `glossary` | `[]` | up to 20 lines × 200 chars of "Sol = a Codex model"-style notes |
| `dailyCallCap` | 300 | Jev calls per UTC day (in-memory, per process) |

No ConfigDefaults entry is needed: every default is the code default, and the dev gate
decides an omitted `enabled`.

### Bounds and floors

- **Latency.** Shadow adds nothing to session start (202 + detached). Inject waits at
  most `timeoutMs` + 250 ms; the hook's `curl --max-time 4` is the outer bound. Any
  failure prints nothing and the session starts as today.
- **Spend.** One call per session start, only when the file overflows and there is a
  context, under the daily cap. The cap is kept in memory per process, so a restart
  resets it; this is accepted because only topic sessions call Jev at all and each
  call is small. At most 2 calls in flight; a third is `busy` (nothing added).
- **Data leaving the machine.** Two kinds go to TypeSafe: the opening context (topic
  name and last 3 messages, as the tone-gate signals already send message text) and,
  new here, the **memory index lines beyond the cut**. Those lines name accounts,
  machines and known weaknesses of our own systems. Scrubbing removes secrets, not that
  content. The operator's approval of this build covers sending them. Pinned lines are
  never sent.
- **Secrets.** The state (glossary + context) and every entry line are scrubbed with
  `scrubForStore` before egress; a scrub error or truncation aborts the call. The key
  is the vault `typesafe_api_key`, read at construction and re-read at most every
  10 minutes when missing or rejected. A vendor error body is never recorded.
- **Metering.** Every call goes into the feature-metrics funnel as feature
  `jev-memory-picker`, framework `typesafe-api`, beside every other LLM feature.
- **Stop.** The kill switch is read live; a disabled picker answers `503` and the hook
  prints nothing.

## Decision points touched

None with authority. The picker only chooses which already-saved memory lines are
offered to a session's context. It cannot block, filter, send, or change anything;
in shadow mode it changes nothing at all. Fail-open everywhere: every failure is
today's behaviour.

## Multi-machine posture

Machine-local by design. The index file is per login and per machine (Claude Code
owns it); the shadow log is a machine-local research record. No replication is needed
because each machine ranks its own index for its own sessions.

## Rollback

`intelligence.jevMemoryPicker.enabled: false` (read live) stops it immediately. The
hook step is a fail-silent curl; a revert removes it on the next update (built-in hooks
are always overwritten).

## Tests

- **Unit** (`tests/unit/JevMemoryPicker.test.ts`): parsing and the pinned marker; the
  positional cut at 25,000 chars / 200 lines; `fits` skip; ranking + composition
  (pinned always kept, top-N by mean score, ties by position); every fallback reason
  adds nothing ranked (only pinned-beyond-cut); timeout via an injected never-settling fetch; scrub of
  context and lines; path derivation and its refusals; daily cap and busy; metering;
  the shadow row carries no text.
- **Integration** (`tests/integration/jev-memory-picker-route.test.ts`): the route over
  real HTTP — 503 disabled, 202 shadow with a row written, 200 inject with the block,
  400 on a bad configDir, positional fallback on a vendor error.
- **E2E** (`tests/e2e/jev-memory-picker-lifecycle.test.ts`): the production factory
  with the same config resolution server.ts uses; the route is alive (not 503) on a dev
  agent and dark on a fleet config; a live flip to `enabled:false` needs no restart; the
  migrated session-start hook contains the step.
- **Real-shape replay** (observer #106): the real Echo `MEMORY.md` and real topic
  openings through the real Jev endpoint, recorded in the side-effects artifact. It
  includes the note's hard case (c17, "change this model to gpt-5.6-sol") with and
  without a two-line glossary, because B+C without a glossary was never measured.

## Open questions

None for the operator. Moving to `inject` mode is a later, separate decision taken on
the shadow rows.
