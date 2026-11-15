# Convergence Report — Never-Silent Conversation

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran in all six rounds (Codex CLI, `gpt-6-astra`, via the installed
instar 1.3.1756 reviewer module). Note: the agent-home checkout's built module still resolves the
`capable` tier to `gpt-5.5`, which ChatGPT-account Codex now refuses ("model is not supported"),
so that path degraded with reason `error` in round 1; the installed module was used instead. The
Anthropic clean-door reviewer degraded (`override-not-frontier`). Gemini was not authed.

**Disclosure — internal reviewers.** This convergence ran inside a forked worker that may not spawn
subagents. The six internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) were applied by the authoring session itself (Opus 5.5)
rather than by independent subagents, so they are not independent of the author. The two
independent reads were the Codex external pass and the code-backed Standards-Conformance Gate,
which ran every round.

## ELI10 Overview

On 13 November Inspec stopped answering Justin for over four hours. Its only Claude sign-in had
run out. Claude Code showed a reworded message that Instar's word list didn't recognise, so
nothing was noticed, nothing was switched, and nobody was told.

This spec stops relying on word lists. Every message a person sends is tracked until it is
answered. If it isn't answered, a judge running on a different engine (Jev, then Codex) works out
why from the screen, the engine's own sign-in status and the account state. Instar then moves the
conversation to an account or engine that works, answers a safe startup question, or starts the
sign-in repair, which Codex can drive too. Whatever happens, the person is told in that
conversation, and the operator is told if self-repair runs out. The account list also stops
calling a signed-out account "active".

Tradeoffs: more moving parts (a ledger of owed answers, a judge, a lease so only one recovery runs
at a time), and some judge spend. Automatic actions stay off until the judge has been measured on
real past failure screens with zero wrong actions.

## Original vs Converged

- **Trigger.** Originally: "turn ended in a few seconds with no tool calls". Now: every inbound
  message is a durable obligation with a notice deadline set on arrival, swept independently of
  the session (catches idle sessions that never start a turn, and restarts).
- **What counts as answered.** Originally: any later reply. Now: a delivered reply from the turn
  that actually took that message in.
- **Telling.** Originally: one notice after judgment. Now: a waiting notice at the deadline even if
  the judge never returns, plus a status notice at each material change, batched per conversation.
- **Replays.** Added a single replay policy for every recovery path: no automatic re-run if the
  stuck turn did anything with side effects (or the record is unreadable); an execution fence
  stops the old session before the switch; one recovery owner per conversation.
- **Judge.** Verdicts are bound to the exact session state and discarded if stale; account
  evidence is shared but each session gets its own verdict; judgments are only re-run when
  evidence changes; truncated input is disclosed and cannot drive an action.
- **Acting.** Originally on at a 0.8 confidence floor. Now off per class until a held-out real-model
  measurement shows zero false actions; the floor is recalibrated from that.
- **Operator escalation.** Now only after self-heal is exhausted (or the registry latency ceiling
  passes), with "repair reported success but the login failed again" escalating as critical.
- Added multi-machine posture, maturation path (test agent first), CLAUDE.md migration, provenance
  storage, and Slack/app live proof.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | gate (7 flags), codex (4), internal lenses (security: dialog-answer injection; scale: fleet-wide expiry; adversarial: fallback flapping) | 12 | 0 | trigger, judge inputs, notices, self-heal gate, provenance, maturation, migration |
| 2 | codex (4), gate (warming — not run) | 4 | 0 | obligation-at-acceptance + overdue sweep, turn-consumed answers, replay boundary, grading split |
| 3 | gate (4), codex (4) | 7 | 0 | all-path replay policy, stale-verdict discard, durable escalation deadline, standby = waiting notice, batching |
| 4 | gate (4), codex (3 + 1 precision) | 6 | 1 | execution fence, per-session verdicts, notice coverage, test-agent rung |
| 5 | gate (2), codex (3) | 3 | 2 | two notice kinds, evidence-gated judging, replay carve-out removed |
| 6 (cap) | gate (2), codex (3 + 1 precision) | 3 | 4 | applied at cap, not re-reviewed: cache key, status-notice dedupe, shared recovery lease, notice timing |

Standards-Conformance Gate: ran rounds 1, 3, 4, 5, 6 (7, 4, 4, 2, 2 flags); round 2 unavailable:
server warming (`status: warming`).

## Proportion

Tier 2 (multi-subsystem, user-visible actions); spec ~380 lines; 6 of 6 rounds used. Design
findings fell 12 → 4 → 7 → 6 → 3 → 3 and narrowed from architecture to lifecycle contracts; the
round-6 findings were applied without a seventh review.

## Left behind

- Gate (Judgment Within Floors): the 0.8 starting floor lacks derivation — accepted: it is a
  starting value recalibrated per class from the held-out measurement, and actions are off until
  then.
- Gate (Judgment Within Floors): truncated input can never drive an action, even when the omitted
  part is irrelevant — accepted as a conservative floor; revisit with measurement data.
- Gate (Self-Heal Before Notify): escalation at the latency ceiling while self-heal still runs —
  contested: Standard B's own text requires exactly this backstop.
- Durable cross-session operation identity (so a replacement session can safely reuse a completed
  external operation) — out of scope; until it exists, replay after side effects asks the person.
- Round-6 fixes (cache key, status dedupe, shared recovery lease, timing) were not re-reviewed —
  accepted at cap; none concerns data loss or security.
- Codex precision (round 4): §7 cited the unverified watcher hypothesis as evidence — fixed in
  passing.

## Full Findings Catalog

Round 1 — gate: Judgment Within Floors (fixed caps), Never Silently Cut the Data (40-line tail),
Near-Silent Notifications (notice for every silence), Self-Heal Before Notify (attention item on
first detection), Decision Provenance (content-free log), Live-User-Channel Proof (Telegram only),
Migration Parity (CLAUDE.md only for new agents). Codex: single judge run per message ends
monitoring early; conversation activity ≠ message acknowledgment; notification depends on
judgment; generalisation test uses a stub. Internal: startup-dialog keypress steerable by user
text on screen (→ startup-only, fixed action space); fleet-wide expiry multiplies judge calls
(→ account-shared evidence); fallback could ping-pong between dead engines (→ breaker).
Resolutions: §3.1–§3.7, §4, §6 rewritten.

Round 2 — codex: notice deadline depended on a transition (input-not-draining missed); temporal
ordering ≠ answered; replay side-effect boundary missing; outcome grading conflates sequence with
correctness. Resolved: obligation at acceptance + overdue sweep; turn-consumed ids; replay
boundary; split recovery outcome from graded correctness.

Round 3 — gate: fixed thresholds (two state changes, 3 in 24 h), blanket exclusion of stuck
engine, per-message notice flood, working-slow notice conflict. Codex: replay protection missed
crash/re-inject; stale verdicts; escalation unreachable for idle undiagnosable sessions;
slow-work notice conflict. Resolved: one replay policy; generation-bound verdicts; exhaustion as a
recorded evaluation + durable ceiling; standby = waiting notice; batched notices; probe rung when
no other route; flapping = re-entry after claimed repair success.

Round 4 — gate: 0.8 floor; blanket truncation/side-effect prohibitions; ceiling escalation;
missing test-agent rung. Codex: replay concurrency (tool starting mid-recovery); dedupe vs later
messages; shared diagnosis applicability; (precision) hypothesis cited as evidence. Resolved:
execution fence; per-obligation notice coverage; account evidence shared, verdicts per session;
maturation path; §7 wording.

Round 5 — gate: 0.8 floor; ceiling escalation. Codex: standby could suppress the failure notice;
unbounded judgment scheduling; completed-op records don't make replay safe. Resolved: two notice
kinds; evidence-revision caching, one in-flight judgment per session; carve-out removed.

Round 6 — gate: ceiling escalation; truncation floor. Codex: cache key missing activity/turn ids;
status dedupe blocked later changes; recovery producers not coordinated; (precision) notice timing.
Applied at cap (see Left behind).

## Convergence verdict

Stopped at the round cap (6). The final round's design findings were lifecycle-contract
refinements, none about safety, security or data loss; they were applied and recorded as not
re-reviewed. Remaining gate flags are recorded above as accepted or contested. Spec is ready for
operator review and approval.
