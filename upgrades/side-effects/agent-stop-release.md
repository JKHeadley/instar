# Side-Effects Review — an agent's own green-PR stop is the agent's to release

**Version / slug:** `agent-stop-release`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (below)`

## Summary of the change

Tier 2. A rollback stop now records its class when minted. No claim means operator-class and PIN-only, including every existing latch. A valid `agentStop` claim means agent-class. New `POST /green-pr-automerge/release` (Bearer) clears one named agent-class stop only after the server verifies that a PR citing the stop's marker merged after the stop and is in the running version's release tag. New `AgentStopSurfacer` keeps a commitment open, wakes the owning topic, and raises Attention. Files: `src/monitoring/agentStopRelease.ts` (new), `GuardLatchStore.ts`, `greenPrAutomergeWiring.ts`, `src/server/routes.ts`, `AgentServer.ts`, `stopGate.ts`, `CapabilityIndex.ts`, `src/commands/server.ts`, `PostUpdateMigrator.ts`, the console's `development-model.js`. Spec review: 3 rounds, stopped at 80/20.

## Decision-point inventory

- Stop (`/rollback`) — modify — still always mints; a claim only sets class.
- Stop class — add — absent or invalid is operator.
- Release (`/release`) — add — stored class plus verified real state, fail closed.
- `/enable` — pass-through — PIN unchanged; also closes the stop's loop.
- Surfacing pass — add — signal only.
- Stop-gate `disarmed` copy — modify — wording only.

---

## 1. Over-block

A real fix merged outside the PR flow (a direct push to main) cites no PR, so its stop stays until a PIN or a later PR. A running version with no matching tag, such as a local dev build, refuses as unverifiable. A cause no PR can fix is not agent-releasable by design. Clock skew between this machine and GitHub could refuse a merge within seconds of the stop. All of these fail toward the PIN.

## 2. Under-block

Stated in the spec's §4 and left as residuals: a session that labels an operator-requested stop as its own; a marker cited on a PR that does not really fix the cause; a later revert (the ancestry stays). `safe-merge` has no latch check, so the manual-merge rule is text only, as it was before. A stop on one machine does not bind the lease holder on another, because the peer reader is empty. Both older gaps go to the feedback queue.

## 3. Level-of-abstraction fit

Extends the existing store and routes instead of adding a parallel latch. The class lives on the latch's own transition, so it cannot drift from it. The surfacer is its own pass with its own state file, deliberately apart from `tick()`, whose latched save would otherwise race `disarmAllArmed` across an await.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No brittle authority. `/release` holds authority, on deterministic reads of enumerable facts (stored class, GitHub state, tag ancestry), not on text matching of intent. The marker match only nominates a PR, and it can only ever refuse or admit on top of the merge-time and tag checks. An LLM would add nothing to binary facts. The surfacer is signal only.

## 5. Interactions

- **Absorbing stop:** unchanged. Each stop has a fresh id; a release names one and cannot open another. A test pins an operator stop surviving an agent release.
- **`disarmAllArmed`:** still runs in-line on every stop. The surfacer does not touch the watcher's state file.
- **`/enable`:** clears both classes as before.
- **Hub filter:** items are raised with `sourceContext:'agent'`, the admitted path, instead of the held aggregate.
- **Commitments:** `externalKey` dedupes route and pass. Beacon output stays internal by default.
- **Sessions:** the wake uses the same spawn and respawn functions as other topic work, and claims topic ownership first, refusing a topic a peer owns. It does not take the routing path's `spawningTopics` guard, which is scoped to that function; a wake racing an inbound message on a dead topic is bounded by the spawn path's duplicate-session guards and by the wake's rare firing. The surfacer starts after the server listens, because its brief sends a session straight to a route.

## 6. External surfaces

One new route, new optional fields on `/rollback` responses, and a new `gate.rollbackStops`; `gate.rollback` is unchanged. Telegram: one Attention item per stop, refreshed daily at most. On first run after update, the existing plain stop `:212` produces one notice saying it needs the PIN. It is read, never changed. New GitHub reads while an agent stop is active: one search per pass, plus one compare per qualifying PR.

## 6b. Operator-surface quality

The only change is one status line in the console's watcher card, shown when every active stop is the agent's own. (1) Primary action: unchanged, the existing turn-back-on button stays below it, and the line tells the operator nothing is needed. (2) Raw internals: none; no ids or fields appear. (3) Destructive actions: none added. (4) Plain language at phone width: a plain sentence in the same line slot the current text uses.

## 7. Multi-machine posture

Machine-local by design. Origin lives in the local latch file and never reaches the journal, so a peer reads a replicated latch as operator-class. A release sent to another machine gets 404. The surfacer's state file is machine-local. Single-voice: the pass runs only on the machine holding the stop, so a stop has one notice and one wake.

## 8. Rollback cost

Revert the PR. Origins become ignored fields and those stops become PIN-only. Any open commitment is withdrawn by hand. No data repair and no release fix needed.

---

## Second-pass review

**Reviewer:** independent general-purpose subagent, run for this build with no prior context beyond this artifact and the spec
**Independent read of the artifact: concur**

Independent subagent, reading the code and verifying at file:line, with no prior context beyond this artifact and the spec. No blockers: a Bearer caller cannot release or downgrade an operator or legacy stop, stopping is no harder or slower, and the compare direction was checked live. Five minor findings in the surfacer's notify and wake path, all fixed before this commit with tests: first pass ran before the server listened; the spawn path retitled the topic and skipped the ownership claim; a failed met wake retried every 10 minutes; a transient GitHub failure counted as unmet; and a release during a pass could reopen a closed notice.

**Concur with the review.**

After the review, one comment-only line was added to `src/monitoring/agentStopRelease.ts`: the `@silent-fallback-ok` exemption on the evaluate catch. No behaviour changed, so the concurrence stands.
