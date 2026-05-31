# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

**Foundation for agent hard-sleep: the SleepController decision layer (dark).** The
deepest lever of the Responsible Resource Usage work is letting a deeply-idle agent
drop its server to near-zero footprint and wake instantly on the next message. That
mechanism is risky, so this change ships the SAFE half first: the part that decides
"is it actually safe for this idle agent to sleep right now?" — and nothing else.

The new SleepController returns one of four verdicts — awake, idle-shallow,
keep-awake, or would-sleep — and applies every safety guard before it will ever say
would-sleep: it refuses if this machine currently holds the multi-machine serving
lease, if there is work in flight, or if a scheduled job is about to fire. Each
guard names itself in the reason. It ships OFF by default and, even when enabled,
runs in dry-run: it only records its decision to a log and serves it at a status
endpoint. It has no power to stop a server — that mechanism is a separate slice,
built only once this decision layer has been watched behaving correctly on a real
idle agent.

**Self-Violation Signal: a stored preference that gets violated becomes a learning
signal (dark).** This extends the Correction & Preference Learning Sentinel. A
learned preference (for example, "don't defer work to a fresh session" or "never
ask the user to edit files") can now carry an optional self-violation pattern. When
the agent sends an outbound message that contradicts that pattern, the contradiction
is recorded as a self-violation in the correction ledger, which reinforces that
preference's recurrence so it surfaces more prominently the next session.

The detector is strictly OBSERVE-ONLY. It runs after the message text is finalized,
as a fire-and-forget branch that is structurally independent of the outbound message
gate. It cannot block, delay, rewrite, or alter the message in any way, and on any
internal error it silently no-ops and the message sends normally. It ships dark
behind both the master correction-learning flag and a new self-violation sub-flag,
and a preference without a self-violation pattern is never checked (fully backward
compatible with existing preference files).

## What to Tell Your User

Nothing to configure, and nothing changes in how your agent behaves. This is the
groundwork for a future ability where a completely idle agent can quiet down to save
your machine's resources and wake the instant you message it. For now it only
watches and decides — it never actually sleeps anything — so it is safe and
invisible. You can see what it would decide at the sleep status endpoint.

Separately, your agent can now learn from its own slips. When you teach it a
preference and it later contradicts that preference in a message to you, it quietly
notes that slip so the preference comes back stronger next time, instead of the
lesson silently fading. This only ever observes and records — it never changes,
delays, or holds back a message to you, and it is turned off by default until you
opt in.

## Summary of New Capabilities

- New SleepController decides whether a deeply-idle agent may hard-sleep, with
  safety guards for held multi-machine lease, in-flight work, and imminent
  scheduled jobs. Pure, exhaustively unit-tested on both sides of every boundary.
- New shared AgentActivityState idle signal, bumped at the inbound-message
  chokepoint so a genuinely-messaged agent never sleeps.
- GET /sleep exposes the live verdict, reason, thresholds, and whether sleep is
  armed. Read-only, Bearer-auth, 503-stub when disabled.
- Decision transitions audited to logs/agent-sleep-events.jsonl (low-noise).
- Config monitoring.agentSleep — OFF + dry-run by default.
- New SelfViolationDetector: a pure, deterministic, precision-biased, never-throwing
  check that returns which stored preferences an outbound message contradicts. A
  lone/weak match never fires; an unparseable pattern is a no-check.
- PreferenceEntry now carries an optional violationPattern field (regex or keyword
  set). Absent ≡ never self-violation-checked — fully back-compatible.
- The outbound message seam records a matched self-violation in the CorrectionLedger
  as a recurrence-reinforcing user-preference occurrence. OBSERVE-ONLY: it never
  blocks, delays, or alters the message, and fails open on any error.
- Config monitoring.correctionLearning.selfViolationSignal — OFF by default; gated
  behind the master correctionLearning.enabled flag.

## Evidence

- `tests/unit/SleepController.test.ts` — both sides of every guard boundary
  (grace, deep-idle, lease, in-flight, scheduled-job), exact-threshold boundaries,
  most-recent-of-inbound-vs-activity, dry-run-never-acts, once-per-episode latching,
  transition-only audit, plus AgentActivityState.
- `tests/integration/sleep-controller-routes.test.ts` — GET /sleep returns 503
  unwired and 200 with the live verdict + thresholds when wired (feature is alive),
  and surfaces the blocking guard reason.
- Side-effects: `upgrades/side-effects/agent-hard-sleep-controller.md`.
- `tests/unit/SelfViolationDetector.test.ts` — 17 tests: violating→detected,
  clean→not, lone-weak-never-fires, absent-pattern→skip, never-throws (bad regex /
  null args / malformed list), regex + keyword grammars, and PreferencesManager
  violationPattern round-trip + legacy-file back-compat.
- `tests/unit/self-violation-wiring-integrity.test.ts` — 5 tests: the outbound
  seam delivers the message UNCHANGED (byte-for-byte) whether or not a violation is
  detected, dark when the sub-flag is off, fail-open with no preferences, and 503
  when the feature is fully off.
- `tests/integration/self-violation-signal.test.ts` — 5 tests: the recording path
  (a self-violation lands as a user-preference correction; a repeat collapses to one
  record with occurrenceCount incremented), gated on both sides, and raw
  preference text never serves over HTTP.
- `tests/e2e/self-violation-signal-lifecycle.test.ts` — 3 tests: feature alive on
  the production boot path (contradicting message delivers AND records), dark by
  default, raw preference text never persists to the wire.
- Side-effects: `upgrades/side-effects/correction-self-violation-signal.md`.
