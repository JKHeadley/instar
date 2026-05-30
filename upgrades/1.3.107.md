---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "yes lets start with pipeline" + "Yes please!" on the A+C proposal)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Two pipeline backstops from the 2026-05-29 fix-shape post-mortem.**

- **Failure-Learning Loop: unimplemented-source warning + wiring-integrity test.**
  `monitoring.failureLearning.sources.regression` and
  `monitoring.failureLearning.sources.degradation` are config flags that exist
  in defaults but have **no implementation** yet — setting them on did
  absolutely nothing. The loop reported them as "configured" without ever
  capturing a single corresponding event. Per the "specced but not wired"
  bug class named in the post-mortem (PR #530 was the worst recent instance),
  this PR makes the unimplemented sources surface their gap at boot via a
  clear `console.warn` and adds a unit-tier wiring-integrity test that pins
  the gating logic — the existing `ci` and `revert` sources must construct
  their poller/detector when their flag is on, must stay null when it's off,
  and the unimplemented sources must produce a warning when on but stay
  quiet when off. The substrate for `ci` and `revert` was already shipped;
  this PR adds the missing tests around it.

- **Migration parity: a static assertion that fresh-init hook installs match
  auto-update hook installs.** Per the "Migration parity skip" class — the
  telegram-reply.sh 403 (PR-of-record never shipped a migrator), the
  autonomous-stop-hook broken path, the slack-channel-context.sh divergence
  we found mid-build during PR #542. The new test reads
  `installHooks()` (src/commands/init.ts) and `migrateHooks()`
  (src/core/PostUpdateMigrator.ts), extracts the set of hook files each
  writes, and asserts the sets agree — except for a small documented
  allowlist of migrator-only deferred-install hooks. The allowlist's soft
  cap (10) catches the gap widening, and current contents document the
  followups.

This is the first of several pipeline hardenings the post-mortem
recommended. Levers B (real-world-state fixture tests), D (silent-failure
ban lint), and E (pre-merge `gh pr checks` enforcement) come in
follow-up PRs.

## What to Tell Your User

Nothing visible in normal operation. If you previously turned on the
regression or degradation failure-learning sources expecting them to do
something, you'll now see a warning at startup telling you they are
silent no-ops; you can set them back off. Otherwise no behavior change.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unimplemented failure-learning sources warn loudly | Automatic at boot. If `sources.regression` or `sources.degradation` is set the agent logs a one-line warning. |
| Wiring-integrity test for failure-learning sources | Automatic (CI). Any future regression in the source-construction gating fails the unit suite. |
| Migration-parity assertion for hooks | Automatic (CI). Any new install-only or migrator-only hook fails the unit suite unless it is explicitly added to `INSTALL_VS_MIGRATE_KNOWN_GAPS` with a rationale. |

## Evidence

- 14 new unit tests; 5 existing related tests (CiFailurePoller, RevertDetector,
  PostUpdateMigrator-time-injection) remain green.
- `tsc --noEmit` clean.
- Side-effects review:
  `upgrades/side-effects/failure-learning-sources-wiring-and-migration-parity.md`.
- Both new tests verified by destructive-negative test (introduce a fake
  install-only or migrator-only-without-allowlist hook → migration-parity
  test fails as expected; remove the warning block → wiring test fails as
  expected).

---

## What Changed — session recovery no longer "restarts" a session that's actually working

**If you message your agent while it's mid-thought, your message no longer gets
buried under a false "Session restarting…" loop.** When the agent's working
memory is compacted, a watchdog re-orients the session and then waits for it to
write new output. A long extended-think on a big conversation writes nothing to
its transcript until the thought lands — so a perfectly-alive, hard-working
session looked "stuck," and the watchdog re-injected another recovery prompt on
top of your real message, again and again. Your message got buried and you saw
"Session respawned / starting up" instead of an answer (the dashboard worked
because it talks to the session directly). Caught firing 3× in ~52s against a
live session on Echo.

Now the watchdog checks whether the session is actively working — the
`esc to interrupt` / `tokens · esc` mid-turn footer, or a live tool process —
before it re-injects. If the session is working, it waits instead of re-poking;
if the turn lands and the session emits on its own, that counts as recovered with
zero injects. An idle or wedged session recovers exactly as before.

## What to Tell Your User

This is automatic, no configuration. If you ever messaged an agent and got
"Session restarting…" with your message vanishing (forcing you to the dashboard),
that's one of the triggers fixed: a busy session now answers when its current
turn finishes instead of trampling your message with recovery prompts.

## Summary of New Capabilities

- `SessionManager.isSessionActivelyWorking(session)` + `paneShowsActiveWork(pane)`
  — canonical "is this session mid-turn?" signal (shared `CLAUDE_WORKING_INDICATORS`).
- `CompactionSentinel` now defers re-injection while a session is actively working
  (new `isActivelyWorking` dep + `maxWorkingDefers` config, default 10; emits
  `compaction:deferred`). `verifyInjection` likewise skips its recovery Enter on a
  working pane (ends the noisy `Injection stuck — Auto-recovering` spam). Escape
  hatch: `maxWorkingDefers: 0` restores the old behavior.

## Evidence

- Unit: `tests/unit/CompactionSentinel.test.ts` (+6 busy-defer cases),
  `tests/unit/claudeActivityIndicators.test.ts` (new),
  `tests/unit/session-active-work.test.ts` (new) — 125 pass across the related set.
- Integration: `tests/integration/compaction-busy-defer-wiring.test.ts` (4) —
  REAL `CompactionSentinel` × REAL `SessionManager.isSessionActivelyWorking`.
- E2E: `tests/e2e/compaction-busy-defer-lifecycle.test.ts` (4) — real-disk
  lifecycle (recovers with zero injects while working) + WIRED-into-server.ts guard.
- Spec: `docs/specs/compaction-busy-session-defer.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/compaction-busy-session-defer.md`.

---

## What Changed — the supervisor no longer restart-loops a server that's just overloaded

**If your machine is running a lot of agents at once, your messages won't get
dropped by a pointless server restart loop anymore.** Each agent's supervisor
pings its server every 10s; when the box is CPU-starved (load well above the core
count), the live server can't answer in time, so after ~60s the supervisor used
to declare it "unresponsive" and restart it. But restarting a starved server
doesn't cure the starvation — the new one is starved too — so it looped, and
every message you sent during a restart got dropped/misrouted (the "Session
restarting, message never lands" symptom). On Echo this was 6 restarts in ~35min
during a load spike.

Now the supervisor checks system load first: while the box is CPU-starved it
**defers** the restart (up to a 5-minute hard cap) instead of bouncing a server
that would recover on its own once load eases. A genuinely-dead server still
restarts instantly; a normal hiccup still restarts after ~60s.

## What to Tell Your User

Automatic, no config. If you run several agents on one machine and have seen
"Session restarting" with messages vanishing during busy periods, that's the
fix. The durable cure for an over-capacity machine is still moving to dedicated
hosting — this just stops the laptop from making overload worse.

## Summary of New Capabilities

- `src/core/cpuStarvation.ts` — shared `cpuLoadRatio` / `isCpuStarved`
  (`loadavg[0]/cpuCount > 1.5`), the canonical "machine oversubscribed" signal.
- `ServerSupervisor` now defers restarting an alive-but-unresponsive server while
  CPU-starved (hard cap `starvationRestartThreshold` ≈ 5min). The two duplicated
  health-failure branches are unified into `evaluateUnhealthyServer()`.

## Evidence

- Unit: `tests/unit/cpu-starvation.test.ts`,
  `tests/unit/supervisor-cpu-starvation-defer.test.ts` (drives the REAL
  `evaluateUnhealthyServer()` with injected load + a wiring guard) — 19 pass with
  the existing `supervisor-health-check` suite.
- Spec: `docs/specs/supervisor-cpu-starvation-restart-guard.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/supervisor-cpu-starvation-restart-guard.md`.
