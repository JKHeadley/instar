# Tone-gate advisory migration

## What Changed

The outbound tone gate's representation rules (B1–B14, B20–B21) now return an
overridable **nudge** instead of a terminal block: the message comes back to the
agent with the rule, a `decisionRef`, and both ways forward. The agent either
revises, or re-sends unchanged with a **mandatory** written reason. Both
reactions are recorded as self-report-rung decision-quality evidence — the tone
gate's first real evidence source, closing the gap that left 1,440 recorded
decisions graded `unknown`.

The self-stop family (B15–B19) deliberately stays a hard wall, and a new
**deterministic live-credential guard** runs ahead of the LLM authority with no
override path, so it holds during a provider outage, under capacity pressure,
and on installs with no gate configured at all.

An evidence-capturability invariant keeps the trade honest: a verdict only
resolves advisory when the reaction could actually be recorded. If the quality
seam is dark or the decision cannot be traced, the gate keeps its authority and
says so (`advisoryUnavailable`) rather than loosening for nothing.

## What to Tell Your User

⚗️ **Experimental, and off unless you turn it on.** Most outbound checks become
suggestions your agent can overrule — provided it writes down why, which is the
whole point: those written reasons are what finally make it possible to measure
whether the checks are any good.

Two things still stop a message outright: an actual credential or password, and
the guards that keep your agent from talking itself out of work mid-task. The
first is now a plain pattern check rather than a judgment call, so it keeps
working even when the AI check is offline.

Nothing changes for you unless the flag is on — and if it is, the loosening
switches itself off whenever the reasons can't be recorded, so you never get the
looser behaviour without the accountability that justifies it.

## Summary of New Capabilities

- Representation rules resolve as overridable nudges carrying a `decisionRef`,
  with the override reason required and recorded.
- Compliance is credited **server-side** when a revised message follows a nudge —
  no agent bookkeeping, so the sample isn't skewed toward disagreements. Each
  credit records whether it was `declared` or `inferred`.
- Deterministic live-credential guard (provider-prefixed value shapes only),
  unoverridable, ahead of the LLM authority, never echoing what it caught.
- Evidence-capturability invariant: no recordable reaction ⇒ the verdict stays a
  block, named rather than silent.
- `/decision-quality` marks `selfReportShare` / `selfReportOnly` so a self-report
  grade can't be read as measured truth.
- `telegram-reply.sh` gains `--tone-ack`, `--tone-reason`, `--tone-complied`,
  `--tone-decision-ref`, and renders a nudge as a nudge instead of "BLOCKED".
- Rollback: `toneGate.advisoryMigration: false`, read live — no restart.

## Evidence

- Three test tiers plus two ratchets: 24 unit (disposition, exemption, degraded
  floor, credential detection, false-positive corpus, oversize refusal), 3
  channel-parity, 5 relay-refusal, 11 integration, 9 e2e.
- The false-positive corpus is pinned from strings reviewers proved would have
  been unsendable — "Disable password authentication in the sshd config" — so
  re-widening the wall fails the build with those sentences in the output.
- Live-channel proof: the real `telegram-reply.sh` driven against stub servers
  renders the nudge with both next steps, puts the reaction metadata on the wire
  correctly formed, and explains the credential wall instead of printing
  "Issue: unknown".
- Convergence: 6 internal reviewers + the standards-conformance gate +
  codex-cli:gpt-5.5 external, SERIOUS ISSUES → MINOR ISSUES over two rounds.
  Report: `docs/specs/reports/tone-gate-advisory-migration-convergence.md`.
