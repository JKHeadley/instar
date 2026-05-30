# Side-Effects Review — jsonlExists resolves codex rollout files

**Version / slug:** `codex-resume-jsonl-exists`
**Date:** `2026-05-30`
**Author:** `instar-echo`
**Second-pass reviewer:** `instar-echo second-pass checklist`

## Summary of the change

`ThreadResumeMap.jsonlExists` and `TopicResumeMap.jsonlExists` decided a saved
session UUID was missing unless a Claude flat-layout transcript
(`~/.claude/projects/<encoded>/<uuid>.jsonl`) existed. Codex writes rollout files
at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, so both
predicates returned `false` for every codex session — `get()` returned null and
resume broke fleet-wide for codex agents (~9 consumers).

The change adds `findRolloutFileSync` to the openai-codex `sessionPaths` helper
(a synchronous sibling of the existing async `findRolloutFile`, since the resume
guards are synchronous) and makes both `jsonlExists` predicates check the Claude
layout first (unchanged, early-return on hit) then fall back to the codex layout.
Returns true if either exists. Reuses the codex session-path seam `TokenLedger`
already uses.

## Decision-point inventory

- `findRolloutFileSync` — add — sync codex rollout lookup; chooses whether a
  codex thread has an on-disk rollout.
- `ThreadResumeMap.jsonlExists` — modify — now resolves codex rollouts in
  addition to the Claude layout.
- `TopicResumeMap.jsonlExists` — modify — same codex fallback.

---

## 1. Over-block

A false "missing" would now require BOTH the Claude layout and the codex layout
to lack the uuid. The change can only make `jsonlExists` return true in MORE
cases than before (it adds a second place to look, never removes the first), so
it cannot newly over-block a session that previously resolved. The only residual
over-block is the pre-existing one: a genuinely-deleted transcript correctly
reads as missing in both layouts.

## 2. Under-block

The codex fallback could in principle resolve a uuid collision — a rollout file
whose name contains the uuid substring but belongs to a different session. This
mirrors the existing async `findRolloutFile` matching (`rollout-*-<uuid>.jsonl`)
and uuids are effectively unique, so the risk is the same as the established
codex path. The match also requires the `rollout-` prefix and `.jsonl` suffix, so
an unrelated file merely containing the uuid is not matched (covered by test).

## 3. Level-of-abstraction fit

The sync lookup lives in the openai-codex `sessionPaths` module, alongside the
async `findRolloutFile` it mirrors — the one place that owns the codex on-disk
session layout. The resume predicates consume it rather than reimplementing the
walk, so the codex layout knowledge stays in exactly one module. No framework
state is threaded into the predicate; it simply consults both layouts.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No LLM judgment. This is a deterministic filesystem existence check feeding
  an existing guard. It exercises no new authority — it only makes the existing
  "does this transcript exist" predicate correct for codex agents. Its single
  effect is to let a codex session resume that previously could not; it never
  blocks, kills, or messages.
