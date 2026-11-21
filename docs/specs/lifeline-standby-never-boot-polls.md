---
title: "A standby cannot poll at boot, and a Telegram conflict cannot restart the lead server"
slug: "lifeline-standby-never-boot-polls"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
parent-spec: "docs/specs/multimachine-lease-poll-robustness.md"
eli16-overview: "docs/specs/lifeline-standby-never-boot-polls.eli16.md"
tier: 1
approved: true
approved-by: "echo; independent review and narrowed third-round corrections read, reversible bug repair"
review-convergence: "2026-11-21T22:32:39.052Z"
review-iterations: 3
review-completed-at: "2026-11-21T22:32:39.052Z"
review-report: "docs/specs/reports/lifeline-standby-never-boot-polls-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# A standby cannot poll at boot, and a Telegram conflict cannot restart the lead server

## Problem statement

N72, feedback fb-fd5640ae-058, follows the Studio restart at 20:11Z on 21 November 2026. A slow Laptop boot expired the 180-second lifeline poll hold and briefly polled the shared Telegram token despite its observe-only lease role. The Studio's lifeline later reached the five-minute conflict watchdog threshold and exited, taking its healthy agent server down too. Laptop boot polls are proven; attributing the entire Studio conflict window to them remains a hypothesis. The restart ledger did not name the lifeline exit.

The first design added indefinite holder conflict handling, reclaim counters and a new timed notice. Reviews found nine material questions in that added machinery. This revision removes it. Existing bounded watchdog recovery is sufficient if its restart does not stop the healthy lead server. The defect is addressed at its two causes, with observed restart attribution.

## Proposed design

1. Add pure `resolvePollOverride` in `pollDecision.ts`. An explicit force-poll retains its existing precedence. Otherwise force-mute, telegramPolling false or leaseRole observe-only resolves force-mute. The boot path AND reconciliation use this resolver; boot cannot flush or poll under force-mute, including when poll-follows-lease is disabled. Contradictory force-poll plus observe-only remains the operator's explicit override and is named in the boot log.
2. Lease-following is supported only with canonical MachineIdentityManager.hasIdentity() and coordinationMode other than independent, matching the coordinator startup paths. Leftover live flags without identity or in independent mode keep existing immediate single-machine polling; the stale multiMachine.enabled boolean is not used. In supported live poll-follows-lease mode, expiration of the boot hold never grants polling authority. Unknown intent continues to hold, logging once at the old bound that the server has not supplied ownership. A fresh positive server intent releases it through the existing debounce and 409 checks; false remains standby. This means a multi-machine server that never becomes ready cannot collect Telegram on its own: the ready peer owns the inbox, and server recovery is the supervisor's existing responsibility. A single-machine agent without live lease-following keeps its current boot polling. Explicit force-poll remains available, including during recovery. Recheck positive intent after the asynchronous flush: unknown or false cancels the start, unless force-poll. No new lease reader or second ownership authority is added.
3. A watchdog restart for conflict409Stuck or noForwardStuck passes keepServer true. The existing RestartOrchestrator detaches the server supervisor and the successor adopts the running server. The fenced lead remains in its running server, so no lead outage follows a Telegram conflict. For consecutiveFailures, keepServer remains false: this signal can mean a healthy-looking server that rejects forwards, and retaining its existing recovery prevents a delivery regression. If multiple signals trip, any consecutiveFailures wins the stop policy even when the primary is conflict409Stuck. External signal shutdown keeps its existing stop behavior. Existing restart daily cap, bounded flush retries, reclaim cadence and exhaustion degradation remain unchanged. There is no new alert, indefinite suppression, or recovery loop.
4. Clear conflict409StartedAt whenever a poll OR reclaim succeeds, alongside its consecutive count. A successful reclaim must not leave the five-minute watchdog window armed.
5. RestartOrchestrator's recordExit receives `{reason, bucket, serverOutcome, overrideReason}`. Outcome is kept only when quiesce completed with keepServer and no later stop override; stopped only when the stop-containing quiesce or explicit override stop completed AND an independent bounded tmux list-sessions observation succeeds and contains no server session; otherwise unknown. The supervisor exposes this read with a 1000 ms subprocess timeout; a command failure or missing tmux remains unknown. Track promise completion separately from budget expiration. A late external stop overrides a lifeline-only restart. Unknown is retained as unknown, never certified as a completed server restart.
6. Append every actual lifeline exit through recordRestartRequest with consumer lifeline and serverOutcome. Legacy rows without an outcome still represent consumed server restart requests. readLastRestartRequest skips lifeline kept and unknown rows when answering what restarted the server; all outcomes remain in the metadata-only bounded ledger. Read the bounded 256-KiB tail so a run of kept-server rows cannot hide the last confirmed server restart. findRestartRequestRecord explicitly excludes lifeline rows, so they cannot acknowledge an unattributed server restart request. No reader may infer that an unknown outcome proves a restart. Correct the restart-awareness text and add an awareness entry naming the standby mute and server-preserving conflict restart.

## Decision points touched

| Decision | Classification | Reason |
|---|---|---|
| Explicit operator poll override and observe-only mute | invariant; basis: enumerable-domain; evidence: resolved operator role and the three enumerated watchdog signals | Existing operator configuration selects this machine's poll role; no message-content inference. |
| A live lease-following start needs positive current server intent before and after flush | invariant; basis: enumerable-domain; evidence: resolved operator role and the three enumerated watchdog signals | The fenced lease owns poll authority; timeout and a successful Telegram request cannot create it. Unknown stays unknown. |
| Restart server only for forward-failure or an explicit stop request | invariant; basis: enumerable-domain; evidence: resolved operator role and the three enumerated watchdog signals | Three enumerated watchdog signals have separate recovery targets; noForward requires server health, and Telegram conflict is upstream of the server. |
| Outcome attribution | invariant; basis: enumerable-domain; evidence: resolved operator role and the three enumerated watchdog signals | Promise completion records what the operation observed, timeout records unknown; no heuristic certifies a restart. |
| Existing bounded watchdog recovery and notices | invariant; basis: enumerable-domain; evidence: resolved operator role and the three enumerated watchdog signals | No cadence, cap, authority or notice is added. |

## Signal vs authority and evidence

Poll intent is the server's authoritative statement derived from the fenced lease, with the existing live-writer and 90-second freshness requirements. It can be briefly stale after transfer; immediate standby reconciliation and the post-flush check preserve the existing bound. This change does not claim that a successful Telegram request proves lease ownership. An unavailable intent means hold, not permission. Local config is an operator floor. Watchdog signals retain their existing authority and bounded rate limits; only their server-preservation option changes. Restart outcomes are backed by actual completion of the stop/quiesce promise plus independent session-absence observation; an error or timeout remains unknown and does not trigger the recent-server-restart refusal.

## Multi-machine posture

The agent's shared inbox remains unified through the existing fenced lease and server poll-intent writer. No conversation state is added. Each lifeline's config and restart ledger describe that machine's bot binding and processes, so they remain local; they are not a second global lease.

machine-local-justification: physical-credential-locality

There is no new notice or URL. Existing alerts and their one-voice policy remain unchanged. A standby still starts its supervisor and joins the pool. A force-poll override can still conflict by operator choice; the boot log names the contradiction rather than silently overriding it.

## Testing

Unit: resolver precedence, observe-only with each gate mode, unknown intent at and beyond the boot deadline, fresh true and false, existing single-machine startup; orchestrator kept/stopped/unknown and late overrides, including timeout; ledger filtering and more than 8 KiB of kept rows. Test reclaimed success clearing the watchdog window.

Integration: a real RestartOrchestrator with controlled process boundaries exercises conflict restart, adopts a detached real ServerSupervisor without sending Ctrl-C, and preserves consecutiveFailures stop behavior. Real temporary ledger writes feed all outcome reader cases.

E2E lifecycle: startup composition proves observe-only cannot call flush/getUpdates, live lease-following boot waits past 180 seconds and starts only from a fresh positive intent, and a conflict watchdog restart leaves the supervised server alive. No real Telegram API or running agent is used. Full test suite is required before reporting the build ready; the shared Local Verify line remains the release authority.

## Frontloaded Decisions

This is a narrow reversible bug repair with no new config, public API, durable external side effect, credential or lease format. Existing single-machine behavior is preserved. A revert restores prior behavior; ledger additions are optional and old readers tolerate them. On downgrade, an old reader can treat a kept lifeline row as a recent server restart and briefly refuse an explicit restart for two minutes; the log format is otherwise readable. This bounded downgrade effect is documented, not hidden.

## Rollback and rollout

A revert undoes code and awareness changes without a data migration. Existing agents get code on update and awareness through the registry; no manual hook migration. Lifeline code loads on its next drift-promoter or planned-upgrade restart. No live machine is restarted by this build. After release, the parent repair run checks a standby boot for suppression and the Studio's health, lead and restart ledger. Published-tag inclusion and machine install must be checked separately before claiming it is live.

## Open questions

None.

## Maturation plan

- **ladder:** not applicable (narrow reversible live bug repair)
- **dark-window:** none; no new authority, migration or config is introduced
- **test-agent-live:** unit, isolated integration and lifecycle tests cover muted startup, legitimate ownership and restart outcomes
- **dev-agent-live:** parent outage run checks standby suppression, same Studio server process through conflict recovery, and ledger outcomes after released install
- **fleet:** automatic update ships code; awareness registry refreshes existing agents; running lifelines load through drift promotion or planned upgrade
- **graduation criterion:** two weeks after rollout, no muted boot logs starting poll and no conflict-only lifeline restart stops the server; reopen this repair if either occurs
