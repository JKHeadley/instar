# Side-Effects Review — Standby boot and conflict recovery

**Version / slug:** lifeline-standby-never-boot-polls
**Date:** 2026-11-21
**Author:** echo
**Second-pass reviewer:** independent Codex reviewer /root/finish_n72/n72_review

## Summary of the change

Tier 1 reversible fix for N72. One poll override resolver applies observe-only and mute settings at boot and reconciliation. Canonical machine identity and coordinated mode determine whether the lease can publish poll intent; single-machine and independent starts stay immediate. Ordinary coordinated starts need positive intent. The old bounded emergency boot fallback remains available only to unmuted roles; it does not claim sole ownership. Telegram conflict/no-forward watchdog recovery preserves the server; consecutive forward failures retain stop recovery. Every actual lifeline exit records kept/stopped/unknown, with independent bounded session-absence corroboration for stopped. Three design rounds, one final correction pass, no commit attempt yet. Exact size is recorded with the final diff.

## Decision-point inventory

- Poll override — modified: explicit force-poll wins; observe-only is a mute floor.
- Boot deadline — preserved for unmuted emergency recovery; explicit observe-only/mute excludes it. Ordinary starts retain positive-intent validation.
- Watchdog restart server policy — modified: lifeline-local faults preserve server, forward-failure faults retain stop.
- Restart attribution — modified: only observed stopped outcomes count as server restart evidence.
- Pending request lookup — modified: lifeline exits never acknowledge server requests.

## 1. Over-block

An identified coordinated machine without a bootable server retains the old three-minute emergency fallback, so /restart does not become permanently unreachable. Observe-only/mute never uses it, and fresh false or a mute during flush cancels it. No identity and independent mode bypass the hold, so a leftover live flag cannot silence a single-machine agent. Explicit force-poll remains available.

## 2. Under-block

An operator force-poll can still contend with another machine by explicit choice. Multiple unmuted machines without server intent may still contend during emergency fallback; this is the pre-existing availability tradeoff, not a new ownership claim. A fresh poll intent can briefly lag a lease transfer; the existing 90-second freshness/live-pid checks, immediate stop reconciliation and new positive post-flush requirement bound the existing gap. No new epoch or lease authority is added.

## 3. Level-of-abstraction fit

The fenced server lease remains the sole ownership authority. Lifeline config is a local operator floor. No Telegram success or time limit becomes a lease detector. RestartOrchestrator owns restart policy and outcome; ServerSupervisor supplies an independent bounded observation rather than exporting its internal running boolean as evidence.

## 4. Signal vs authority compliance

Reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). These are enumerable transport invariants: operator overrides, positive ownership before start, and the three existing fault types. No message content or user intent is inferred. Existing watchdog signals feed the existing orchestrator authority; no additional competing blocker is created.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Unknown intent remains unknown. A simultaneous consecutiveFailures signal retains server recovery even when the higher-priority conflict signal is primary. Unknown observation cannot certify a stop.

## 5. Interactions

Boot and reconciliation use the same resolver. In-flight flush still has its existing generation cancellation and now needs positive intent at completion. Stop override changes kept to unknown immediately, so a hard exit during persistence cannot misreport kept. The observer uses a 1000 ms subprocess timeout. Existing caps, backoff, reclaim cadence, drift restart, planned upgrades and explicit shutdown remain. Successful reclaim clears the stale watchdog window. No new repeating loop or alert is introduced.

## 6. External surfaces

No new API or config. Existing restart ledger rows gain an optional serverOutcome and consumer lifeline. Existing HTTP restart refusal and health attribution filter kept and unknown rows. Unit and actual AgentServer HTTP tests cover both sides. No secrets or user text are logged.

## 7. Multi-machine posture

Unified shared inbox through the existing fenced lease and poll intent. Per-machine config/ledger describes that bot binding and local processes, machine-local-justification: physical-credential-locality. No conversation state, notice or generated URL is added. Awareness registry updates existing agents automatically.

## 8. Rollback cost

Code revert, no migration. Old readers tolerate optional fields but may briefly treat a kept lifeline row as a recent server restart on downgrade, causing the existing two-minute refusal. The repair does not mutate live machines. Actual release and installed version are verified by the parent run before rollout claims.

## Second-pass review

Concur with the implementation and side-effects review. Independent reviewer verified single-machine/independent startup, fresh-positive coordinated failover, mute floor, bounded observation and late-override handling. No material defect found. The suggested hard-kill-after-late-override regression test was added.

## Validation evidence

- Unit: 71 tests in 6 files passed, including existing poll decisions and orchestrator tests plus the hard-exit-after-override race.
- HTTP integration: all 10 server-restart-route tests passed through real AgentServer, including health boot snapshot and restart refusal for each outcome.
- E2E: 13 tests in 2 files passed. A real tmux server kept its identical pane PID through the actual production watchdog and initiator, orchestrator detach, and successor adoption. Startup tests cover missing identity with leftover live flags, independent mode, observe-only with the gate off/on, deadline expiry, positive failover, and false/unknown ownership after flush.
- Source typecheck and git diff whitespace check passed.
- Full test:all is pending the shared Local Verify line. This commit is a reviewable candidate, not a claim that the repair is released or live.

The first HTTP run had one test failure because the test wrote the ledger after boot but expected the boot snapshot to refresh itself. The test now explicitly performs the next boot's ledger initialization before reading health; production behavior was unchanged by that test correction.

## Approved emergency availability correction

Read-only review found the initial indefinite-hold change disabled the independent /restart recovery path whenever an identified coordinated server could not boot. The Chief of Staff approved restoring the old bounded fallback for unmuted roles, while preserving explicit mute floors and server-preserving conflict recovery (message cc8267e2, 2026-11-21 15:43 PST). No new lease authority, timer, recent-409 loop or election is introduced. Emergency fallback is an explicit separate argument, permits unknown after the old bound, and still rejects fresh false/mute after the connection flush. Ordinary starts reject unknown after flush. The inherited risk that several broken unmuted machines contend remains stated; the repair never claims one emergency collector.

The full-suite attempt on the earlier candidate was stopped and is not a passing result. The corrected candidate requires a fresh full-suite slot. Updated targeted validation and focused independent review are appended below after running.

### Correction validation and focused review

Node 24.14.1 with the private dependency tree: 46 unit tests in the poll-decision, poll-floor and startup-wiring files passed. All 19 E2E tests in the startup and real-server-adoption files passed. The new recovery test uses actual production poll, processUpdate, /restart interception and lifeline command handling while the server remains unable to start; Telegram networking and physical supervisor operations are substituted. Fresh standby and mute during emergency flush cancel it, ordinary unknown-after-flush remains refused, and all mute settings remain excluded. Source typecheck and whitespace check passed. The unchanged HTTP restart-outcome tests previously passed all 10 cases; this correction does not change those routes or ledger semantics.

Focused independent reviewer /root/finish_n72/n72_review concurs with this correction: separate emergency flag, mute/fresh-false cancellation, strict ordinary starts and actual command path verified; no new material concern. This was a focused code review, not a new full spec round. Multiple unmuted emergency collectors remain an explicitly documented inherited tradeoff. Full suite still pending for the corrected candidate.

An initial correction-test run exposed fixture object reuse: the late-mute test mutated a shared config object and incorrectly muted subsequent cases. Each fixture now clones its own config, and the clean rerun passed all 19 tests.
