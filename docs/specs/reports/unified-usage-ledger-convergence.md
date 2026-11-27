# Convergence Report — Unified Usage Ledger

## Cross-model review: codex-cli:gpt-6-astra

Codex (GPT-6 Astra, through the agent's own Codex login) reviewed every one of the six rounds. Gemini CLI is not installed on this machine, so Codex was the only external family.

## ⚠ Status: stopped at the round cap — accepted by the operator

Six rounds is the cap for a change this size. Round 6 still raised design findings. All are narrow, and fixes for each are written into the spec, but those last fixes have **not** been through a review round. Some of them concern whether usage history survives a restore, which the process treats as data loss, so convergence is not self-declared. The operator was offered the choice — approve with the round-6 fixes as they stand, or run one more review round — and approved the spec as it stands (Justin, Telegram topic 141063 "Token Usage Tracking", 2026-11-09), keeping the FD1 and FD2 defaults. The convergence tag records that operator acceptance at the cap.

## ELI10 Overview

Every time an agent thinks, it uses tokens. Today four separate notebooks record that usage, they disagree, almost nothing is priced, and the main one reads the wrong folder, so it counts other agents and misses most of Echo's own work.

This spec builds one notebook. Every model call from every engine (Claude Code, Codex, pi, Grok, Gemini, and the agent's internal checks) becomes one line saying who made it, why, on which machine and login, and how many tokens of each kind. Totals are kept by hour, by day and by conversation, so they add up from a single call to a conversation or job, then to a machine, then to the whole agent, and all of an agent's machines combine into one view. Usage is priced at the published API price that applied on the day it happened, so it is always "cost at the time", and a corrected price automatically fixes all history. The dashboard gets charts over time, a drill-down wheel, the most expensive topics and jobs, cache efficiency, and an honest strip showing how much of the usage is fully labeled and priced.

The tradeoffs: it is a sizable build (five slices), it ships switched off everywhere except the development agent until a live check passes, and it deliberately leaves the old usage pages and the runaway-usage alerts untouched so nothing changes under operators.

## Original vs Converged

- **One meaning for "tokens".** The first draft just said "keep columns separate". Reviewers showed that Claude, Codex and the internal-call recorder each count cached input differently, so the dollar figures would have been wrong. Now every source is mapped to one set of non-overlapping counts with a fixture test per source, and the cost formula is written out.
- **Counting the same call once.** Originally duplicates were matched on an id the two sources never share. Now they match on the provider's conversation id, are only settled once both sides are fully read, can re-open if a late line arrives, and never throw usage away on a mismatch.
- **Codex.** The draft summed per-turn numbers, which the existing code deliberately avoids because it double-counts. Now per-call rows are differences of the running total, checked against the final total.
- **Leaving the old system alone.** The draft fixed the old counter's folder bug in passing, which would have changed burn alerts underneath operators. That fix now gets its own small spec.
- **Who belongs to this agent.** Membership moved from folder-name guessing to "sessions this agent started" (recorded when they start, including builds in other folders and internal calls), with the session's own working directory as a fallback.
- **Pricing on read.** Prices used to be stamped on each row when written, with a re-pricing job for corrections. Now usage is priced when it is shown, at that day's price, so corrections and newly added prices apply to all history, even after the detail rows age out.
- **One database file and a slim backup.** Two files couldn't be updated together safely, and backing up part of a file isn't possible. Now everything lives in one file, updated in single transactions; a small hourly snapshot is the only thing backed up, and it's used only if the live file is lost. Per-file read positions stop anything being counted twice after a restore, a prune or a resumed conversation.
- **Across machines.** The lease holder pulls each machine's totals with a sequence number that can't skip rows, detects a restored machine and re-pulls it, validates what peers send, and shows "warming" or "not reached" instead of silently low totals.
- **Who can see it.** Usage data stays bearer-only; phones get a trimmed, owner-only summary, trimmed by the machine that receives the request.
- **Not committed to git.** Both files live in the server-data folder that git-sync already excludes.
- **Bounded growth.** Raw detail kept 90 days (or 4 million rows per machine), hourly and per-conversation totals 400 days, daily totals forever; internal one-shot calls stay out of per-conversation totals.

## Iteration Summary

| Round | Reviewers who raised design findings | Design findings | Left behind (precision) | Spec changes |
|---|---|---|---|---|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex | ~45 | ~12 | Rewrite: token arithmetic, ids and dedupe, Codex deltas, legacy untouched, separate store, retention, auth, P20 table |
| 2 | all six + codex | ~20 | ~10 | Bindings from the session hook, two-file store, sealing, change sequence, session-day rollup |
| 3 | all six + codex | ~14 | ~8 | Single file, checkpoints, pricing on read, generation id, funnel spawn records |
| 4 | scalability, adversarial, integration, decision-completeness, lessons-aware, codex | 8 | ~10 | server-data placement, pairs in snapshot, internal one-shots out of session-day, reported-dollar split |
| 5 | scalability, adversarial, integration, decision-completeness, codex | 6 | ~8 | Held totals in pairs, session kind on bindings, slim snapshot, foreign-snapshot rules, run id |
| 6 | security, scalability, adversarial, integration, lessons-aware, codex | 6 | 6 | Fixes applied, not re-reviewed (see below) |

Standards-Conformance Gate: **unavailable every round** — the endpoint answered but reported `degraded: no-intelligence` (its model judgment was not available), so it produced no findings. The lessons-aware reviewer covered the principles and lessons catalog each round.

Internal reviewers ran on the authoring session's model (Claude Opus 5.5) every round.

## Proportion

Tier 2 (multi-slice, new durable store, cross-machine replication). Six rounds used of a cap of six. The spec grew from about 150 to about 290 lines. Effort is high but in line with a new durable, replicated store; most findings were real defects that would have cost far more to find in code.

## Round-6 findings (fixed in the spec, not re-reviewed)

1. **Imported history vs the pool pull** (five reviewers): a restored machine's predecessor-id or replaced-machine rows would be refused by the holder, and a refused row could stall a peer. Fix: predecessor rows re-keyed to the current id; replaced-machine history kept as a local, non-replicated slice only when no pool holder has it; invalid rows are skipped and listed so the cursor always advances.
2. **Agent identity in the snapshot** (security): another agent's backup could be imported. Fix: the snapshot carries the agent id and a mismatch is always refused.
3. **Restore drops pre-snapshot hour and session detail** (codex): fix: on a peer's generation change, the holder keeps its pooled rows older than the peer's snapshot time; locally, settlement deltas aimed at missing hour rows are skipped and listed while day totals stay exact.
4. **Late row after a disputed pair** (codex): fix: after a successful settlement late rows are simply counted; in a disputed pair the excess is shown as disputed usage, never dropped silently.
5. **Snapshot size estimate and `run` in the day key** (scalability): fix: `run` only in hour keys; estimate redone with an explicit row size; snapshot size and copy time shown in coverage, flagged above 500 MB.
6. **Rebuild rule for reported dollars and call counts** (adversarial, decision-completeness): fix: stated explicitly.

## Left behind

- TokenLedger's hard-coded scan root (the old counter's bug) — its own spec, filed as feedback fb-71b3c6a2-25f.
- Resolving sessions two agents could both claim by working directory — listed in coverage rather than resolved.
- Snapshot registry posture wording (machine-local vs internal ingest state) — cosmetic, to be aligned at build time.
- Per-row character caps on transcript-derived strings at ingest.
- Holder re-pull rate limit per peer (only an authenticated pool machine can trigger repeated re-pulls).
- Time bound value for the snapshot copy — set at build time.

## Full Findings Catalog

The per-round reviewer outputs (all six internal lenses plus Codex) are kept in the authoring session's scratchpad and summarised above; every design finding from rounds 1–5 was resolved in the next revision and confirmed resolved by the same lens in the following round.

## Convergence verdict

Stopped at the round cap (6 of 6). Rounds 1–5 resolved every design finding raised. Round 6 raised six narrow design findings; fixes for all six are in the spec but were not re-reviewed. Decision-completeness: 7 frontloaded decisions, 1 cheap-to-change tag (contested each round and cleared), 0 open user decisions. The operator approved the spec with the round-6 fixes as they stand (2026-11-09).
