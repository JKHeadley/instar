# Convergence Report — A single session's expired-login screen must not bench a working login

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI on all six rounds (status `ok` every round). Gemini was not authed (`gemini-not-authed`); the Anthropic clean-door family was available but not used.

## ELI10 Overview

The agent keeps several subscription logins, and many sessions can share one login. Sometimes one long-running session shows "Login expired" even though the saved login is fine (most likely it holds an old copy of the sign-in in memory). Until now the agent believed that one screen and benched the whole account for up to 12 hours, and an automatic re-sign-in then restarted itself every few minutes, forever. That happened for real on the Mac Studio on 20 November 2026.

The fix: before benching, the agent makes one tiny, sealed-off test call with the saved login: no tools, no plugins, no settings and no other credentials. If the call works, the account stays usable and only the stuck session is restarted on that same login. If the call fails, or can't run, the agent does exactly what it does today. Strict limits keep the test calls rare and bounded, and they are recorded in the cost ledger.

## Original vs Converged

- **The probe could cause the problem it detects.** Starting a fresh process on a login whose token is near expiry refreshes and rotates that token, which can strand the other sessions. Converged: probe only with at least 15 minutes left on the stored token. A credential change during a probe has one outcome: the result is discarded. The spec also says plainly that a probe is no riskier than placing one more session on the login.
- **The probe could be fooled.** Originally it inherited the server's environment and the login folder's settings, so an API key or a third-party provider could make a dead login look alive. Converged: credential and provider env is stripped, there are no settings sources, MCP servers or hooks, and the output must show `apiKeySource: none` and `served_by_anthropic: true`.
- **Success was judged by the reply's words.** Converged: success comes from the CLI's structured result fields, and only the result line is passed to the existing auth and usage-limit readers (they cannot parse the multi-line stream). Pinned against real captured CLI output.
- **The stuck session was moved to another account.** That burns another account's quota and can raise a false "every account is at its limit" notice. Converged: it is refreshed in place on its own login, with its own folder and account passed explicitly, the identity, screen and ownership rechecked at dispatch, and a separate outcome when the refresh itself fails.
- **The first sighting still took the old path.** Converged: the recovery and the rerouted sink wait up to 20 s for the probe. NeverSilent starts or joins a probe but never marks or moves while it is pending. A late `ok` releases its own hold.
- **Unbounded or reset-able spawning.** Converged: at most 6 spawns per account per 12 h, persisted and reserved inside the host spawn cap's admitted callback, through a serial atomic write. Conclusive verdicts are final per credential (with a 12 h expiry). Backoff and a 24 h breaker apply to inconclusive results, including usage-limit answers.
- **Release could restore an account benched for another reason.** Converged: the cause of each account's latest mark is recorded, and a pane mark never weakens a stronger existing bench.
- **The rollout started as a dev gate** and now ships live with a live off switch, because this narrows an existing operator-visible false positive and every failure path is today's behaviour.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, scalability, integration, decision, lessons, codex, gate | ~20 (deduplicated) | several | Probe containment, expiry gate, refresh in place, scheduling and brakes, metering, awareness migration |
| 2 | all three internal pairs, codex, gate | 9 | 10 | Stream-json readers, no setting sources, served_by_anthropic, routed folder, persistence, first sighting waits |
| 3 | one combined internal reviewer, codex, gate | 5 | 6 | validate-then-cache with `lastContraryAt` (replaced the generation counter), dispositions, verdict expiry |
| 4 | internal, codex, gate | 5 | 5 | Three callers named, ownership and identity recheck, separate account/session outcomes, serialized persistence |
| 5 | internal, codex, gate | 5 | 4 | NeverSilent can swap or fall back (now it holds off), latest-mark cause, reservation inside spawn-cap admission, usage-limit rule |
| 6 | internal, codex, gate | 4 (3 codex, 1 internal, labelled safety) | see Left behind | Per-caller marking rules, a pane mark never weakens a stronger bench, `refresh-failed` outcome; NeverSilent hold-off bounded by an actual refresh or 3 minutes |
| post-cap check | targeted safety verifier (3 passes) | 1 → 0 | — | Pass 1: open (the hold-off was bounded by refresh budgets, not time). Pass 2: open (no bound after a refresh started). Fix: an absolute 3-minute cap per persisted NeverSilent incident. Pass 3: **closed** (incidents are persisted and close only on a real reply, so the clock cannot be reset; the first-wait time is stored on the incident record) |

Internal reviewers: rounds 1 and 2 ran as three Claude subagents covering two lenses each; rounds 3–6 ran as one Claude subagent covering all six lenses (proportion: smaller remaining surface). All ran on the session model (Opus 5.5). The Standards-Conformance Gate ran every round (6 runs). From round 5 on, it reported that its copy of the spec was truncated (the spec grew past its input budget), so its later verdicts covered only part of the spec.

## Proportion

⚠ Out of line with the size. A Tier-2 change used all 6 rounds, and the spec grew from ~110 lines to ~38 KB. Each round found real design issues, several of them plan-invalidating (the probe causing the stranding it detects; the first sighting still swapping; NeverSilent's own swap path), so the rounds were earned. But the spec's length is now a reviewability problem in itself: the conformance gate could not read all of it after round 4.

## Left behind

Round 6's three codex design findings were fixed in the spec after the final round, without a full re-review (cap reached): per-caller marking rules for NeverSilent vs recovery; a pane mark never weakens a stronger bench; a `refresh-failed` outcome. None is a safety, security or data-loss issue; each makes the conservative path more conservative.

Round 6's one SAFETY-labelled finding (NeverSilent could stay silent for up to 12 h on a cached `ok`) was NOT accepted at the cap. It was fixed, and the fix was checked by a dedicated verifier in three passes, ending in "safety fix: closed", because the skill does not allow a safety finding to be waved through at the cap.

Accepted at the cap (not safety, security or data loss), with reasons:
- **Fixed limits** (15 min expiry margin, 20 s wait, 30 s timeout, 6 spawns per 12 h, 30→240 backoff, breaker 4 / 24 h, 5 min shed retry, 12 h verdict life, 3 refreshes per account per 10 min). The gate contests each exact boundary. Each is a bound on physical work or a margin away from an irreversible rotation, with failure going to today's behaviour. Exact values are tunable later from the feature-metrics rows; none can cause a wrong `ok`.
- **CMT-1008 stays the floor.** When no probe verdict exists, one pane screen still benches the account (Signal vs Authority flagged this every round). This is pre-existing behaviour, deliberately kept, because routing sessions onto a truly dead login is worse; the window is now seconds, or loud via the breaker.
- **apiKeySource / served_by_anthropic do not name the specific account.** True. The probe runs with only the routed folder's credential available (env stripped, no settings sources), so the folder's own stored login is the only credential that can authenticate.
- **The renewable rate ceiling is a rate bound, not a total.** At most 12 tiny calls per account per day, only while sightings persist.
- **Precision items** from every round, mostly wording, the diagnosis phrased as a hypothesis (done), and test-list alignment (done in the final edit).

## Full Findings Catalog

The per-round raw findings (internal reviewer outputs, codex JSON, gate JSON) are retained in the session scratchpad. The headline design findings and their resolutions are listed under Original vs Converged and in the Iteration Summary above.

## Convergence verdict

Converged at the round cap (6). The last round's design findings were folded in after it, and none concerns safety, security or data loss. The remaining contested items are accepted risks with stated reasons. The spec is ready to approve and build.
