<!-- bump: patch -->
## What Changed

The third piece of the Chief of Staff (docs/specs/chief-of-staff-topic.md §2–§5): the check-in loop. On the lease holder, every fifteen minutes by default, it reads the replicated store, works out whether the owner's check-in lease is live (a signed renewal younger than 72 hours), and for every bound project that is due it gathers deterministic evidence (merged PRs and net diff on linked branches, run state, the Liveness Reconciler's condition, live session, overdue commitments, conversation timestamps plus a byte-bounded untrusted tail), applies the deterministic floors, asks the metered LLM judge only when a question remains, records the check-event and waits for it to be on disk, and then acts through the action protocol — a bounded restart for a stalled project, a redirect for a drifting one, a verification for one that claims done — within the per-tick, per-project and weekly caps. Notes go out once per cadence at the owner's note time; immediate messages are capped per day. `GET /chief-of-staff` and `GET /chief-of-staff/projects/:key` expose the loop's health, the protocol's status, and one row (or the detail) per bound project. The owner-tunable settings (`chiefOfStaff.tickMinutes`, `defaultCadenceHours`, `maxRunHours`, `operatorLeaseHours`, `noteCadenceHours`, `noteTime`, `maxRestartsWithoutProgress`, `breakerRestartsPerWeek`, `immediateMessagesPerDay`, `judgeDailyCents`) are migrated in with their defaults.

Dev-gated: the loop is constructed only where `chiefOfStaff.enabled` resolves on (development agents); elsewhere the routes answer 503 and nothing changes. Even on a development agent the loop observes only until the owner speaks in the Chief of Staff conversation, which the next release creates.

Hardened by the independent second-pass review before merge: a checklist whose judgment items are marked for agent certification still waits for the owner (no un-judged auto-close); the progress baseline lives on the check-event record (`doneItems`), so restart caps survive a process restart or a holder change; an unreadable group member count sends the note to the owner's DM, never the forum; a run whose session fails to start is marked ended at once (`AutonomousRunStore.findByRunId`); the first tick after a holder change checks but does not act; a routed restart counts only when the owning machine actually started it, and its refusals reach the note.

## What to Tell Your User

Nothing yet on a normal agent. On a development agent: the Chief of Staff is now watching bound projects and writing its check records; it will not restart or redirect anything until you check in with it, and the conversation to check in from arrives next release.

## Summary of New Capabilities

- `ChiefOfStaffLoop`: tick / markDirty / immediate / recordRenewal / actionGate / projectsSummary / projectDetail; clamped config; verdict floors; note composition.
- `ChiefOfStaffEvidence`: deterministic gather (shared per-repo PR cache per tick) and the metered judge (`chief-of-staff` LlmQueue component, `DP_COS_PROJECT_VERDICT` provenance).
- Routes `GET /chief-of-staff`, `GET /chief-of-staff/projects/:key`.
- `/autonomous/register` accepts `cosNoRespawn` + `idempotencyKey`; `spawnSessionForTopic` offers `unlocked` for callers already under the conversation lock.
- Owner renewals captured from the inbound Telegram hook (signed by the receiving machine).

## Evidence

- `tests/unit/ChiefOfStaffLoop.test.ts` (27): config clamps, evidence hash/progress, every floor, due planning, note composition, lease derivation, tick paths (paused, stalled→claim, parked, breaker, done-verified, claims-done refuted, waiting, unknown streak, note cadence, immediate cap, non-holder, disabled).
- `tests/unit/ChiefOfStaffEvidence.test.ts` (10): gather with unknowns-not-zeros, shared PR cache, generated-file exclusion, timeouts, bounded tail; judge prompt bound disclosure, closed-set parser, budget/provider failure ⇒ null.
- `tests/unit/chief-of-staff-loop-wiring.test.ts` (6): real seams in server.ts, protocol deps now derived from the loop, register route fields, unlocked spawn path, renewal hook, routes + ctx, migration + provenance.
- `tests/integration/chief-of-staff-loop.test.ts`: two real journals, real protocol, real Ed25519 renewals — paused ⇒ no claim; renewal ⇒ live; stalled ⇒ claim ⇒ started; cross-apply ⇒ identical folds on the second machine; non-holder tick writes nothing; cadence respected.
- `tests/e2e/chief-of-staff-alive.test.ts`: real AgentServer — 503 without the loop; 200 with the real shape, a bound project listed and detailed, 404 for an unknown key, 401 without auth.
