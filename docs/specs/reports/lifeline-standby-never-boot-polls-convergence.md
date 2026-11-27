# Convergence Report — Standby startup and conflict recovery

## Cross-model review: codex-cli:gpt-6.2-astra

Prior rounds received genuine GPT review through the installed CLI. The final narrowed round ran a separate Codex reviewer in this task; it is an independent read in the same model family, not a new claim of cross-family diversity. Claude reviews are disabled by the operator's token-pacing instruction. The final conformance attempt could not accept an external worktree path (400 specPath escapes specsDir); a markdown retry was not made because the server's LLM routing is outside this task's no-Claude constraint. Reduced assurance is explicit.

## ELI10 Overview

A standby must never collect messages just because its own server is slow. A Telegram conflict should restart the Telegram supervisor without stopping a healthy lead server. This repair makes those two rules true and records honest outcomes for supervisor restarts.

Ordinary single-machine startup remains immediate, even with a leftover live lease-following flag, because only a machine with canonical identity in coordinated mode waits for the lease. A real failover starts from a fresh positive lease intent through the existing debounce.

## Original vs Converged

The original proposal added indefinite special treatment for the holder, new conflict windows and a new fifteen-minute alert. Nine review findings showed that machinery complicated recovery. The final version retains the existing bounded recovery and only preserves the healthy server during it. Forward-failure recovery retains its server restart.

## Iteration Summary

| Round | Review | Design findings | Disposition |
|---|---|---|---|
| 1 | Prior Claude and GPT plus standards | 7 standards flags plus GPT findings | Corrected force-poll and ledger races; next round still found expansion problems. |
| 2 | Prior standards check | 9 | Removed the indefinite holder/reclaim/alert expansion. |
| 3 | Independent Codex reviewer | 2 | Added independent session-absence observation; gate lease-following on canonical identity and non-independent mode. Reviewer said no further material blocker after those corrections. |

Standards-Conformance Gate: round 1 ran; round 2 ran (9 flags); final round attempted, unavailable for external worktree path and no-Claude routing constraint. No skip is presented as a pass.

## Experience fit

The parent repair goal is reliable reachability across machines, supported by topic 145840's actual outage and current observe-only stopgap. A single-machine agent without an intent producer must remain reachable. A coordinated standby must not steal messages from a live peer. The independent review explicitly compared both cases and legitimate failover. No new user ask, sign-in or alert channel is introduced.

## Full Findings Catalog

Prior full reports are retained in the original run scratchpad under conf1.json, codex-r1.json and lsnbp-conf2.json. The nine second-round findings concerned unfenced boot start, arbitrary wait, premature notice, unbounded reclaim, inaccurate capacity claim, false stop attribution, lost forward recovery and incorrect notice destination. Removing the expansion, requiring lease authority, preserving forward recovery and using observed outcome resolves them. Final reviewer findings: completed promise is not proof of stop (fixed by independent bounded session read); live config is not proof of intent producer (fixed by canonical identity and coordination mode). No security or data-loss issue is accepted unresolved.

## Left behind

A manually forced poll may contend by operator choice; existing behavior and explicit override precedence remain. A failed stop observation stays unknown. Existing generic persistent-409 reclaim behavior is unchanged, not expanded by this repair.

## Proportion

Tier 1, three design rounds at the cap. Earlier reviews were disproportionate because the design grew new recovery machinery; narrowing removes that cost from implementation. No commit attempt yet.

## Convergence verdict

Converged after the third round's two concrete corrections, with no remaining material design issue identified. Ready for the small reversible implementation; live rollout proof remains the parent repair run's responsibility.

## Post-implementation availability correction

A later emergency-reachability check found an omission in the narrowed implementation: indefinitely waiting for positive intent disables /restart when the server cannot boot. The Chief of Staff approved retaining the original bounded fallback for unmuted roles in message cc8267e2 at 15:43 PST. This does not add a new ownership authority. Explicit mute/observe-only and fresh false still prevent fallback, ordinary starts keep strict positive-intent checks, and the old multi-unmuted-machine contention limit is stated honestly. This focused correction does not claim an extra full convergence round or a passing full-suite run.

## Poll Boot Hold Wiring Follow-up — 2026-11-21

Normal M5 Local Verify of candidate `97877269beb31ea0f250869e499f7d6d248ab9c4` against main `68834ded85b88d2516533d76cd3d0f0dcaa0cf89` failed two source-wiring E2E assertions in `poll-boot-hold-wiring.test.ts` (attempt `c5530caee29bc9ca264e14e3b04935c8`, local run `efa4a7bd10f707322d173616ecffbbfa`). Fail-fast stopped unit and integration before completed reports. Neither stopped tier is a pass. The earlier manual unit result remains separate evidence; its manual integration was deliberately interrupted and E2E was unrun.

The exact one-file reproducer returned two failures and one pass. Both failing assertions expected obsolete source spellings: the emergency helper call without its explicit fallback arguments, and the development gate without the new supported-coordinator identity predicate. A focused read-only reviewer confirmed that the production logic matches the approved semantics; no production correction was required.

The test correction retains the waiting assertion and requires the exact emergency fallback call after the expired-hold and force-mute guards. It also verifies that real startup delegates to the polling helper after starting the supervisor and that both startup and reconciliation require the canonical coordination predicate and development gate. It does not accept an arbitrary poll-start call or weaken the mute/identity boundaries. All three tests now pass together under pinned Node24/private dependencies. The coordinator explicitly approved normal installed host posture for this three-test source-only check; the earlier voluntarily enforced waiting process alone was stopped. No host controls or semaphore paths changed.

Existing production-path lifecycle checks cover emergency `/restart` when the coordinated server cannot boot, muted roles, fresh standby intent during flush, ordinary unknown-intent refusal and single-machine/independent compatibility. This follow-up changes only test expectations and this report. Full normal Local Verify remains the single full-suite completion gate; the PR stays draft and no release or rotation is claimed.
