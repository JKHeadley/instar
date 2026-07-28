# Convergence Report — HumanAsDetectorLog

## ELI10 Overview

We're adding a way for the agent to learn from the moments *you* catch its mistakes. Today,
when you say "that's wrong" or "that's out of date," the agent just fixes it and forgets it.
But your catching it is itself a clue: it means one of the agent's own automated safety
checks should have caught the problem and didn't. This feature quietly logs each correction
and tags it with which safety check probably failed, building a "heat map" of where the
agent's guardrails are weakest — so we can strengthen the right ones instead of guessing.

It's deliberately a thermometer, not a gate: it only watches and records, it never blocks
anything, and it can never slow down or break a message getting to the agent. It uses no AI
and no internet — just a careful list of correction phrases, tuned to under-react so it
doesn't cry wolf.

The main tradeoffs: it's biased toward missing some corrections rather than logging false
ones (a missed one loses a data point; a false one pollutes the map). It can be skewed by
someone spamming correction phrases — but since it controls nothing, that only makes a chart
noisy, not the agent unsafe. This version watches Telegram; the other channels are an easy
planned follow-up.

## Original vs Converged

The original spec described a correct, working module (ported from Dawn's reference) but the
review round caught two real problems that the converged version fixes:

1. **Privacy leak fixed.** Originally the on-disk log stored a 220-character preview of your
   actual message. If you ever typed a password or private detail while correcting the agent,
   it would have sat in a log file forever. After review, the raw words are kept only in
   short-lived memory and **never written to disk** — the log keeps only the category and
   which guardrail failed. The file is also locked down to owner-only permissions.

2. **The heat map no longer empties on restart.** Originally the summary you'd view read only
   from in-memory data, so every time the agent restarted (which it does often, for updates),
   the heat map silently reset to zero even though the history was safe on disk. After review,
   it reloads its history from disk on startup.

The review also made the **Telegram-only scope explicit** (Slack/WhatsApp/iMessage are a
tracked follow-up, not a silent gap) and added a **structured side-effects section** to the
spec.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec/code changes |
|-----------|-----------------------|-------------------|-------------------|
| 1 | security, scalability, lessons-aware | 4 | metadata-only persistence + 0600/0700; restart hydration from JSONL; explicit Telegram-first scope note; structured side-effects section; +3 unit tests |
| 2 | (converged) | 0 | none — all material findings addressed; remaining items (kill-switch, dashboard tab, source/topicId in summary) documented as deliberate v1 choices / future rungs |

Abbreviated convergence (sanctioned for a small, Dawn-pre-reviewed pattern-instance that
mirrors `DegradationReporter`): internal reviewers only (security, scalability/integration,
lessons-aware — the mandatory pass), external cross-model reviewers skipped. One review round
plus an addressing round.

## Full Findings Catalog

**Iteration 1**

- **[Security · MEDIUM] World-readable JSONL persisting `messagePreview` (raw user text).**
  Resolution: persist metadata only (drop `messagePreview` before write); create file `0600`,
  dir `0700`. The preview survives only in the in-memory ring for the live session.
- **[Scalability/Integration · MEDIUM] Summary endpoint reads only the volatile in-memory
  ring → heat map silently empties on every restart.** Resolution: `configure()` hydrates the
  ring from the last 200 persisted records (best-effort).
- **[Lessons-aware · MEDIUM] Adapter-coverage gap — only Telegram inbound observed; Slack/etc.
  corrections silently skew the map (multi-entry-point trap).** Resolution: explicit, tracked
  "Telegram-first" scope section + follow-up task; the gate (`observeInboundMessage`) is
  adapter-agnostic so extension is mechanical. (No-Deferrals satisfied: tracked, not orphaned.)
- **[Lessons-aware · LOW] Spec lacked a structured side-effects artifact section.** Resolution:
  added a Side-effects review section (over/under-block, poisoning, abstraction-fit,
  interactions, privacy, no-kill-switch rationale, rollback).

**Non-material (noted, not blocking):**
- Callback chaining verified sound (preserves TopicMemory/PresenceProxy/keep-watching) — no change.
- Migration parity claim verified correct (server-side code only) — no change.
- Multi-machine JSONL isolation verified (per-agent stateDir) — no change.
- ReDoS: regex set is linear, no catastrophic backtracking — no change.
- Authority: confirmed pure-signal, gates nothing — the most important property, holds.
- Kill-switch flag: deliberately omitted for a never-throws, signal-only v1 (documented).
- `messagePreview` → future-LLM-consumer injection: one-line caveat added for that future rung.
- Optional classify input-length cap: noted, not adopted (linear cost, low value).

## Convergence verdict

Converged at iteration 2. No material findings remain in the addressing round. All four
material findings from iteration 1 are resolved in code (privacy + hydration, with 3 new unit
tests) and in the spec (scope note + side-effects section). The feature ships all three test
tiers green (22 unit + 3 integration + 2 e2e) with `tsc` and `lint` clean. Spec is ready for
user review and approval.
