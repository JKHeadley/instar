# Convergence Report — Resume Follows the Account

**Spec:** [docs/specs/resume-follows-account.md](../resume-follows-account.md)
**Slug:** `resume-follows-account`
**Converged at:** 2026-09-16 (round 4, abbreviated under operator directive)
**Iterations:** 4
**Final-round material findings:** 0 (critical/high filter)

## Cross-model review: codex-cli:gpt-6-astra

GPT reviewed every round through the agent's Codex CLI (the default Codex login was at its usage limit until
2026-09-21, so the pass ran under the `codex-sagemind-dawn` login). Gemini could not run in any round: its
Google Workspace login requires a `GOOGLE_CLOUD_PROJECT` setting that is not configured
(`ProjectIdRequiredError`). The Standards-Conformance Gate degraded in every round because this agent routes
it to the same Codex login that was at its limit; it produced no flags.

> **Review deviation.** The operator directed, after round 3: "proceed with the permanent fix, but make sure it
> follows the 80/20 principle. We've been spending way too many tokens and time on reviews for minor issues."
> Round 4 therefore ran one internal reviewer (lessons-aware plus adversarial, critical/high findings only) and
> the GPT pass, instead of six reviewers until two quiet rounds.

## ELI10 Overview

Luna's "GCI MCP servers" topic stopped answering because its conversation was saved under one Claude login,
the restart used another login that couldn't see it, and two more bugs turned that single failure into a loop.
This spec fixes the three root defects: copy the conversation into the login a restart uses, notice when
Claude has actually exited so the existing fresh retry runs, and stop the background job from guessing which
conversation belongs to a topic.

For users, a topic keeps its memory when the agent switches subscriptions, and a crashed restart recovers in
seconds instead of leaving the topic silent. The design deliberately leaves out broader hardening that rounds
1-3 explored (a crash breaker, a formal pointer-admission system, agent-to-agent thread resume); those are
tracked as separate items.

## Original vs Converged

- **Originally** the design copied the newest transcript over whatever the target had. **After review** it never
  deletes a copy: it replaces only a copy that is provably an earlier part of the newer one, and sets aside a
  copy that split off. Reviewers measured a real forked conversation on Luna that the original would have lost.
- **Originally** a crash was detected by whether the tmux window existed. **After review** it reads the pane's
  exit flag, and the heartbeat treats an empty answer as a missing session (measured on real tmux).
- **Rounds 2-3** grew the design with an admission system, a crash breaker and per-lane policies; those rounds
  kept finding problems inside the new layers, including one that would have broken Codex resume. **Round 4**
  removed them: the only source of poisoned pointers was the timestamp guess, so removing the guess and refusing
  internal one-shot transcripts closes the defect without the extra machinery.
- **Scope** narrowed to Telegram and Slack topic sessions. Agent-to-agent thread resume is coupled to a pending
  anti-hijack fix (ACT-1278) and stays out of scope.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|-----------|-----------------------|-----------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, GPT | ~58 (heavy overlap) | never-delete placement, async, scoped homes, per-lane policy, dead-pane probe, admission |
| 2 | all six + GPT | ~60 | scope narrowed to topic sessions; restart-race, sync-writer and Threadline coupling fixes |
| 3 | all six + GPT | ~45, concentrated in v2/v3 additions | decision to simplify |
| 4 | lessons-aware + adversarial (high-only): CLEAN; GPT: 3 | 0 at critical/high | pre-replace re-check added; rationale recorded below |

Standards-Conformance Gate, every round: `unavailable: degraded (fit judgment errored; routed to codex-cli at usage limit)`.

## Full Findings Catalog

Rounds 1-3 findings are preserved in the session scratchpad review logs; their dispositions are reflected in the
converged spec (§2 scope and tracked residuals ACT-1275, ACT-1278, ACT-1280, ACT-1282, ACT-1283, ACT-1284,
ACT-1285).

Round 4:

- **Internal (lessons-aware + adversarial, critical/high filter): CLEAN.** One medium note: the fresh retry did
  not carry a caller-pinned login. Resolved in implementation (the retry passes `configHome` and
  `subscriptionAccountId`).
- **GPT 1 — concurrent write between compare and replace.** Accepted: the target's size and mtime are re-checked
  immediately before the rename; any change leaves the copy alone.
- **GPT 2 — `sdk-cli` is a correlation, not identity.** Not adopted as a design change: placement only runs for
  topic sessions, which instar always launches as interactive (`cli`) sessions, so an `sdk-cli` transcript
  cannot be the topic's conversation. Rationale added to §3.1.
- **GPT 3 — a failed resume still reports its requested id through hooks.** Not adopted: that echo was harmful
  only because the requested id was already a wrong guess. With the guess removed, one-shot ids refused, and the
  transcript placed before launch, the echoed id is the topic's real conversation. Gating every writer on
  readiness was the admission system rounds 2-3 showed to be costly and fragile.

## Convergence verdict

Converged at iteration 4 under the operator's 80/20 directive: no critical or high design findings in the final
round, and every GPT finding either adopted or answered with a recorded rationale.
