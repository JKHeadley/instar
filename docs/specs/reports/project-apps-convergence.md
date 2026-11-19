# Convergence Report — Project apps (part 1: builtin apps, offers, owner answers, summaries, surfaces)

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (through the agent's own Codex login) reviewed rounds 1 (second attempt), 2, 3, 4, 5 and 6. The first round-1 attempt from the agent home degraded (`error`: the agent-home build still asked for the retired `gpt-5.5`); it was re-run from a freshly built worktree. The Anthropic clean-door reviewer degraded in round 1 (`override-not-frontier`) and was not re-run; it is not a cross-model pass.

## ELI10 Overview

Some projects are much easier to follow as a page than as chat messages. The Feature maturation board already shows 275 features at a glance, but nothing links it from its project or its conversation, so Justin gets walls of numbers instead. This spec gives every project a place for "apps": an Open button and a one-line summary on its row in Work, a strip at the top of its conversation, and a pinned link in Telegram or Slack.

The agent can suggest an app once per project. Only the owner's tap attaches it, a "no" is remembered on every machine, and the owner can still add it later. For now the only apps are pages Instar itself ships; apps the agent writes for a project come in a second spec with a much stricter safety design (a sealed frame, a narrow key, and the owner's phone approving every version of the code).

The main trade-offs: the dashboard unlock is honest about what it proves (on an agent that knows its own PIN, it is not proof against a hijacked agent, which is acceptable here because attaching an Instar page gives such an agent nothing new); and the pinned link is deliberately simple: a new message is only ever sent because of a deliberate act, so at worst a crash mid-send asks the owner to check before posting again.

## Original vs Converged

- **Originally** one spec covered both builtin and custom apps, stored custom app code in Instar Documents, and let the agent attach an app with a pointer to an owner message. **After review** it was split: this part covers builtin apps; custom apps moved to a companion spec, because Documents could not hold app code safely (no kind field, shared-conversation editors) and the custom-app security surface would have held up the first step.
- **Originally** the agent could attach apps (with an "owner yes" reference) and records used the Chief of Staff's record type. **After review** the agent can only offer, the owner's tap attaches, and the records ride their own new journal kind — because new record types on the Chief of Staff kind would have frozen all Chief of Staff syncing on any machine still on an older build.
- **Originally** the builtin summary was written as a replicated record on each Work read. **After review** it is computed, never stored, from the board's pool-scope read, so machines cannot fight over it.
- **Originally** pins were made inline by the attach route, then (round 2) by a background reconciler with retries. **After review** (round 4 cut) there is no background loop: a new message is only sent for a deliberate act; steps that send nothing new (pin a posted message by id, unpin, edit the link in place) run on their own; acts are fenced by the lease epoch.
- **Originally** a Bearer `decline` could detach an owner's app. **After review** the agent's only answer is `withdraw`, valid only while the offer is open.
- Added: an on/off switch, rollback, observability measures, a fleet graduation criterion, and a user-role live proof on a throwaway agent before Justin is asked.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | all six internal, GPT-6 Astra, gate (9 flags) | ~20 grouped | 6 | split into two specs; offer/answer model; new journal kind |
| 2 | security, adversarial, integration, scalability, lessons, GPT, gate (6) | 11 | 8 | owner-proof honesty; lease-holder offers; pool-scope derived summary; reconciler |
| 3 | adversarial, integration, lessons, GPT, gate (7) | 6 | 8 | withdraw-only agent answer; posted step; edit in place; replicated retry |
| 4 | integration, adversarial, GPT, gate (4) | 5 | 6 | CUT the reconciler to deliberate acts; CoS routing rule |
| 5 | GPT, gate (3); internal all-lens 0 DESIGN | 2 | 9 | act steps with answerRef; per-pair serial queue; automatic no-new-message steps |
| 6 (cap) | GPT, gate (4) | 3 | 3 | lease-epoch fencing with automatic re-issue; request ids and no-op attach; one link-repair table |

Standards-Conformance Gate: ran every round (9, 6, 7, 4, 3, 4 flags). Internal reviewers ran as Claude Opus 5.5 subagents (six separate agents in round 1; three paired agents in rounds 2-3; one six-lens agent in rounds 4-5).

## Proportion

Tier 2 (security-relevant, replicated state, outward messages); ~210 spec lines; 6 of 6 rounds. ⚠ The pin mechanism (a convenience next to the Work row) absorbed most of rounds 3-6; it was cut to the simplest safe form in round 4 and its last three findings were fixed at the cap without a seventh round.

## Left behind

- **Fixed at the cap without a further review round (round 6 DESIGN, reliability not safety):** reassigned acts could run on two machines → lease-epoch fencing checked before every platform call, automatic re-issue under the new epoch; retried attach could repeat a send → client `requestId`, answer + act in one batch, attach on an attached pair writes no act; contradictory link-repair rules → one table (`message-missing` is the only path to a replacement).
- **Accepted (Know Your Principal, gate rounds 3-6):** the operator session is not human proof on an agent that holds its PIN, and replicated answers are shape-validated only. Accepted for builtin apps (no new power); the companion spec uses a Face ID phone approval verified by every reader. Signing owner answers for `binding` and this kind is queued as feedback.
- **Accepted (Judgment Within Floors, gate):** the 8 KiB offer-record budget is a conservative bound under the 80 KiB journal entry; the reason text is long enough for any real explanation.
- **Accepted (Team):** owner-only follows Work's existing audience rule (`work-front-doors.md` §4.4).
- Precision items fixed in passing: wording of answers by `by`; refresh on stale read; cache `invalidate()`; address order from real config; supervision tier0; night rule; opened route; Bearer-readable stats; quick-tunnel staleness noted for the fleet review.

## Full Findings Catalog

Per-round grouped findings and resolutions: `.instar/lanes/project-apps-spec/round1-findings.md` … `round5-findings.md` (agent home), with each round's spec snapshot (`spec-r1.md` … `spec-r6.md`), the gate reports (`conformance-r1.json` … `conformance-r6.json`) and the GPT results (`ext-codex-r1b.json`, `ext-codex-r2.json` … `ext-codex-r6.json`).

## Convergence verdict

Converged at the round cap (6). The final round's design findings were reliability details of the pin convenience (duplicate-message avoidance), not safety, security or data loss; they were fixed in the spec as listed above. Spec is ready to build; approval is Justin's "go!" (topic 141385, 2026-11-16 16:34 PST) on the recommendation this spec implements.
