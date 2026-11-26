---
title: "Green-PR auto-merge: an agent's own stop is the agent's to release"
slug: "green-pr-agent-stop-release"
author: "echo"
parent-principle: "No Manual Work (user *or* agent)"
eli16-overview: green-pr-agent-stop-release.eli16.md
topic: 136706
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P3-migration-parity, P4-testing-integrity, P5-agent-awareness, P17-bounded-notification-surface, P19-no-unbounded-loops, P20-verify-state-not-symbol, B10-verify-landed-before-claiming, close-the-loop, cross-machine-coherence]
extends: [green-pr-automerge-enforcement, mergerunner-auto-arm-handoff]
approved: true
approved-by: "Justin, topic 136706, 2026-11-03: \"Please fix this yourself!\"; build brief for this change, and his standing rule that only constitution changes need him (2026-10-22)"
review-convergence: "2026-11-04T00:03:04.864Z"
review-iterations: 3
review-completed-at: "2026-11-04T00:03:04.864Z"
review-report: "docs/specs/reports/green-pr-agent-stop-release-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Green-PR auto-merge: an agent's own stop is the agent's to release

## Problem statement

On 2026-11-03 at 10:34Z an autonomous session of mine (topic 18330) set the green-PR auto-merge rollback latch, because the old watcher had merged PR 2648 before its checks finished. The fix was installed soon after. That run had ended, and nothing re-armed the watcher. `POST /green-pr-automerge/enable` needs the operator's dashboard PIN (R9 of `green-pr-automerge-enforcement`), so only Justin could release a stop he never pulled. His words, topic 136706: "Why am I being forced to do this? Please fix this yourself!"

R9 reasoned that re-arming merge authority is the operator's. That holds when the operator pulled the stop. When an agent pulled it for its own stated reason, the PIN turns the agent's caution into the operator's chore, and it teaches agents that pulling a stop is expensive. That is the wrong lesson for a kill switch.

**Goal.** A stop an agent session pulls is that agent's to release once its stated cause is resolved. A stop the operator pulls keeps needing the PIN.

## What exists today

- `GuardLatchStore.set('rollback', reason)` mints a fresh `<machineId>:<seq>` latch id. Every stop is its own id, so a stop can never be pre-cleared and releasing one never opens another. `reason` is cut to 80 characters in both the local file and the journal.
- `POST /green-pr-automerge/rollback` (Bearer) sets the latch, then disarms armed PRs in-line. `POST /green-pr-automerge/enable` (PIN through `checkMandatePin`) clears named ids, or all active ids.
- **The dashboard and agent sessions present the same Bearer token** (`dashboard/console/development.js` `send()`). The server cannot tell them apart by credential.
- `src/commands/server.ts` wires `readPeerLatches: () => []` with a comment saying the peer-latch merge is still to come. In production, today, a machine reads only its own latches. The journal `guard-latch` row is written but no reader gates on it.
- The journal's `guard-latch` schema is deliberately content-free (`known = [latchKind, latchId, action, epoch, seq, reason]`).
- `GreenPrAutoMerger.tick()` returns early on the lease gate and the latch gate; the watcher's aggregate Attention item has no `sourceContext`, so the hub filter holds it back as automated status (`logs/attention-hub-held.jsonl`).

## Proposed design

### 1. Stop class is recorded when the stop is minted, and the default is operator

`POST /green-pr-automerge/rollback` keeps its current shape and gains one optional field:

```json
{
  "reason": "short slug",
  "agentStop": {
    "topicId": 18330,
    "sessionId": "optional-session-id",
    "cause": "the full reason, up to 4000 characters",
    "release": { "kind": "fix-pr-released" }
  }
}
```

- **No `agentStop` field means operator-class.** That covers every dashboard stop (the console never sends it, and this spec does not change that), every plain Bearer call, and every older caller. The dashboard stop is operator-class by construction, and the server does not need to tell callers apart to get this right. A session that forgets the claim gets the stricter class.
- **A valid `agentStop` claim means agent-class.** The origin is written into that latch's own transition in the durable local file, as `origin: { class: 'agent', topicId, sessionId?, cause, release, stoppedAt }`.
- **A latch with no origin, or an origin that is not exactly the valid shape, is operator-class.** Every existing latch is in this group, including `m_03b30f5b32c6ef3eb0afd3ca7054e252:212`. Nothing migrates them and nothing touches them.
- **An invalid claim never refuses the stop.** The route mints the latch first as operator-class and reports `originClass: 'operator'` plus `agentClaimRejected: [reasons]` with a 200. Stopping stays exactly as easy and as fast: claim parsing is synchronous and pure, it adds no network call before the latch is durable, and it runs inside a `try` so a parser fault still produces a stop.
- **Set-once, own stop only.** Origin exists only as an argument to the `set()` that mints the fresh id. There is no route or method that writes an origin onto an existing latch, so no caller can downgrade anyone's stop, including its own earlier operator-class stop. A fresh id means a claim can only ever describe the stop it creates.

The journal row is unchanged. `origin` is never emitted. A future peer reader therefore sees no origin and treats a replicated latch as operator-class: stricter, never looser.

### 2. The release condition is checked by the server, against reality

The condition is chosen when the stop is pulled, from a closed list. Free-text conditions are not accepted, because a condition the server cannot check would leave the release resting on the session's word, and the session's word is what we are guarding against.

The list has one kind:

| `release.kind` | Valid at mint when | Met at release when |
|---|---|---|
| `fix-pr-released` | always | a pull request in the watcher's repo whose body contains this stop's marker is `MERGED` into `main`, **and** its `mergedAt` is later than `stoppedAt`, **and** its merge commit is contained in the release tag of the version this server is running: `gh api repos/<repo>/compare/<mergeCommit>...v<running>` reads `ahead` or `identical` |

The stop's **marker** is `agent-stop-<machineId>-<seq>`, derived from the latch id and returned by `/rollback`. It is a plain token, because the colon in a latch id does not search reliably. The body match is exact, so `-21` never matches `-212`. Candidates come from `gh pr list --state merged --search "<marker> in:body"` (at most 5), and each is read directly, so the search only nominates.

Why this is the one kind:

- **A stop is pulled before the fix exists.** The session that spots a fault has no PR number and must not have to delay stopping to get one. So the fix PR points at the stop. The condition is fixed at mint and nothing about the stop is edited later, so there is no second route that could change a condition. A fix PR that is closed and replaced needs nothing special: the next PR cites the same marker.
- **A merged fix is not a running fix.** "PR merged" would reopen the watcher while the old code is still loaded, which is the incident's own failure. A version threshold is no better: a stop has no way to know which future version carries the fix, and four unrelated releases landed on the day of the incident. Containment in the running version's tag reads "that PR is included in what is running here". It does not prove the fix still works: a later revert leaves the ancestry in place. That is why the wake brief tells the session to confirm the cause is fixed, and why the release records a note. It relies on the release invariant that a published version is never reused and its tag never moved (npm refuses a republish, and `publish.yml` tags the commit it built).
- **It cannot already be true at the moment of the stop**, because the merge must come after the stop. Citing the marker on a PR merged earlier does nothing.
- **The running version comes from `ProcessIntegrity.runningVersion`** (falling back to `ctx.config.version`, frozen at boot), never from the checkout or `package.json` on disk. An unreadable version, tag, search or compare means not met.

A cause no PR can fix (a GitHub outage, say) is simply not agent-releasable: the session pulls a plain operator-class stop. The list is closed by choice; adding a kind is a code change that gets its own review.

### 3. `POST /green-pr-automerge/release` (Bearer)

```json
{ "latchId": "<machine>:<seq>", "releasedBy": { "topicId": 136706, "sessionId": "..." }, "note": "why this is resolved" }
```

Checks, in order, with no way past them:

1. **400** unless `latchId` is a single string, `releasedBy.topicId` is a positive integer, and `note` is non-empty. There is no release-all form. Any `pin` field in the body is ignored.
2. **503** `latch-view-unreadable` if the merged view throws (fail closed).
3. **404** `unknown-latch` if the id is not in this machine's view. **409** `not-active` if it is already cleared. The second of two racing releases lands here.
4. **403** `operator-stop` if the recorded class is not agent, whether by no origin, malformed origin, a peer's row, or an id minted by another machine. This is how a Bearer caller is prevented from releasing an operator stop: the route reads the class from the store and never from the request. The error says the stop needs the operator's PIN and names nothing else to try.
5. **409** `condition-not-met` with the evidence the server read (for example `{candidates:0}` or `{pr:2700, running:'1.3.1640', compare:'diverged'}`).
6. **503** `condition-unverifiable` if GitHub or the version read fails. It never counts as met.
7. Re-read that the id is still active, since the condition read awaited the network and a racing release or `/enable` may have landed (409 `not-active`).
8. Clear that one id with the slug reason `agent-release`, recording `release: { topicId, sessionId?, note, evidence, at }` on the transition. The origin stays on the record after the clear, so the history keeps who stopped and who released.

The response is `{ ok, released, evidence, stillStopped: [...ids], mergeAllowed }`. `stillStopped` matters: other active stops, in particular an operator's, keep the gate shut, and the caller is told so instead of inferring success. The release does not re-arm anything by itself. The watcher acts on its next tick through all of its normal gates. `emergency-pause` and `pool-armed` are out of reach: the route is hard-wired to the `rollback` family.

`POST /green-pr-automerge/enable` is unchanged. The PIN still clears any stop of either class, so the operator's authority over the whole switch does not shrink.

**Ownership is the agent's, not the session's.** The goal is that the stop outlives the session that pulled it, so `/release` does not compare `releasedBy.topicId` with the stop's topic. Any session of this agent can release, and the record says which one did.

### 4. What stops a confused session releasing a stop it should not?

An easy release would be a hole in the kill switch, so here is what each kind of mistake runs into.

| Confused session does this | What happens |
|---|---|
| Tries to release the operator's stop, or any older stop | 403. Class comes from the store. No request field can change it. |
| "Releases everything" to get merges moving | Not expressible. One named id per call, and agent-class ids only. |
| Believes the cause is fixed when it is not | The server checks the stop's own condition, set before the confusion began. Conviction is not an input. |
| Releases a stop right after pulling it | The condition cannot be true yet by the mint rule. Refused. |
| Cites the marker on an already-merged PR | A merge before the stop never counts. |
| Labels an operator's stop request as its own (the operator says "stop auto-merging" and the session adds the claim) | **Residual, stated plainly.** The server cannot see who asked. Bounds: awareness text says a stop asked for by a person never carries the claim; the stop still only releases on its verifiable condition; the next surfacing pass (§5, within 10 minutes) raises an Attention item labelled as an agent-class stop, so the operator can see it and pull their own stop, whose fresh id no agent can touch. |
| Cites the marker on a PR that does not really fix the cause, then it merges | **Residual, stated plainly.** The stop releases once that PR is in the running release. Bounds: citing a stop is a deliberate edit in a PR that went through the whole dev process, the response names the PR it relied on, and any session or the operator that wants the stop to hold pulls its own. |
| Edits `state/green-pr-automerge-latches.json` directly | Out of the threat model. This guards against a confused session, not a hostile one: a hostile session holding the operator's `gh` credential has shorter routes than forging a latch file. The file stays `0600` and malformed origins read as operator-class. |

No release budget or counter is added. Each release needs a fresh stop and a fresh condition that only reality can make true, so flapping has nothing to run on. A count-based gate would also be the kind of mechanical limit this project keeps retiring.

The machinery never auto-releases. A stop is released by a session acting and answering for it. A self-clearing kill switch would reopen merging with nobody looking, on the strength of a condition written while something was going wrong. That is a heavier change than the one asked for and is deliberately not made.

### 5. An unreleased agent stop cannot be orphaned

Run state lives apart from the watcher. A new `AgentStopSurfacer` runs its own 10-minute pass with its own small state file (`state/green-pr-agent-stops.json`), non-awaited and single-flight, with a 20-second bound on the whole pass. It does not touch `tick()` or the watcher's state file: an await before the tick's latched save would let `disarmAllArmed` save first and have the stale tick state restore `armedAt`. A pass that hangs or throws cannot affect a tick, and a hung pass only skips the next one. The pass runs on whichever machine holds the stop, lease or not. For each active agent-class stop it does the following, and when a stop goes inactive it closes what it opened.

- **Commitment (the agent's loop).** Ensures an open commitment exists: `type:'one-time-action'`, `source:'sentinel'`, `owner:'agent'`, `blockedOn:'none'`, `verificationMethod:'manual'`, `topicId` from the claim, `beaconEnabled:true`, 6-hour `cadenceMs`, `externalKey: green-pr-agent-stop:<latchId>`. The route also records it right after minting, so the pass is the repair path if the route crashed or the record failed: the durable latch is the source of truth and `externalKey` makes both idempotent. Release delivers it, a PIN `/enable` withdraws it, both looked up with `getActive().find(externalKey)`.
- **Condition read.** Every pass while the stop is active, so `conditionMet` in status is at most about 10 minutes old.
- **Operator-class stops.** A plain stop gets one Attention item on first sight only, saying what stopped and that turning it back on needs the PIN on the dashboard, with no commitment, wake or cadence. It exists because a forgotten claim or a job with no topic produces a plain stop, and nothing would otherwise tell anyone (the watcher's aggregate is held back). The console's own stop is skipped, read from its fixed `reason` text, since the operator just pressed it. That text only suppresses this one notice and grants nothing; a caller who copies it just goes unannounced, and the stop is still PIN-only. This posts about existing stops too; it reads them and does not change them.
- **Wake.** Beacon revival is dry-run on the dev agent, so a commitment alone would leave a stop waiting for someone to notice, which is the incident again. So when a stop's condition reads as met, or it has stood 6 hours unmet, the pass wakes the owning topic: it injects into the live session on that topic, or starts one, with a fixed-text brief naming the latch id, the marker, the release route, and whether the condition reads as met (release it) or not (land a fix PR that cites the marker). The cause text is not in the brief; it is data, read from status. At most once per stop per 24 hours, except that the condition turning met always wakes once. The session still acts and answers for the release through §3's checks, so this is not an auto-release.
- **Attention (the operator's floor).** One item per stop, id `green-pr-agent-stop:<latchId>`, through `upsertAttentionItem` with `sourceContext:'agent'`, which the hub filter admits (the watcher's aggregate is held back by that filter as automated status, and sits behind stale lines). Posted once on first sight, at `NORMAL`, naming the stop as the agent's, its cause (capped at 400 characters, with the full text in status), and its condition. Refreshed at most every 24 hours while the stop stands, with its age and whether a fix PR has been seen. Raised to `HIGH` only if the condition has read as met for over an hour with the stop still on, meaning the wake did not close it; the throttle does not delay a raised priority. Closed silently with `clearAttentionCondition` when the stop goes inactive, on the next pass, and at once from the release and `/enable` routes.

What the line asks for: nothing from the operator. If it has stood past the wake, one word to any chat is enough, and no PIN is involved.

On an install with no Telegram there is no wake or Attention; the commitment and `GET /green-pr-automerge` remain. The watcher does not run without a config flip on such an install anyway.

`GET /green-pr-automerge` gains a non-optional `gate.rollbackStops: [{ latchId, class, reason, since, topicId?, sessionId?, cause?, release?, conditionMet?, conditionCheckedAt?, conditionEvidence? }]` (operator rows carry only the first four). `gate.rollback` stays as it is, so existing consumers do not move. `conditionMet` is the last value the pass read; GET makes no network call.

### 6. How the fix lands while its own stop stands, and text that misleads

Every watcher merge is gated by the latch, and `fix-pr-released` needs a merge, so without a rule a session following the current "do not merge manually" text is stuck and the problem goes back to the operator. **The rule:** a session may merge a PR by hand, through `scripts/safe-merge.mjs` (which re-verifies checks), only when every active stop is agent-class and that PR's body cites every one of those markers. Two unrelated stops therefore do not let each other's fixes through, and any operator-class stop (including any stop with no recorded origin) means no manual merges. This is stated in the awareness text and the stop-gate copy; `safe-merge` already has no latch check and is not changed here.

**This PR's own landing** is outside that rule: the active stop today is the older `:212`, which reads as operator-class and stays untouched. It merges through safe-merge on the operator's explicit instruction in the build brief for this change (topic 136706). After it lands, `:212` still needs the operator's PIN once; nothing here can or will clear it.

- `src/server/stopGate.ts`, the `disarmed` variant, says "disabled by operator rollback … confirm with the operator". That is false for an agent stop and sends the session straight to Justin. It becomes: the watcher is stopped, do not merge manually; if the stop is the agent's own, the watcher status names its marker and release condition; if it is the operator's, confirm with the operator. It still carries no runnable command. It shows only for about 20 minutes after a stop (the snapshot goes stale), so the awareness section is the pointer agents really read.
- `dashboard/console/development-model.js` `watcherLine` reads `gate.rollbackStops` when present. All agent-class: "Auto-merging is stopped by the agent for its own reason. It releases this itself when its condition is met; you can also turn it back on below." Any operator-class stop, or no field: today's wording. The enable button is unchanged.

### Multi-machine posture

Origin is **machine-local by design**, matching where latches actually bind today (`readPeerLatches: () => []`): a stop binds the machine that pulled it, and that machine is the only one that can read its origin and serve its release. A release sent to another machine gets 404 from that machine's view. The commitment's `ownerMachineId`, the surfacing pass and its state file all stay on the owning machine. If peer-latch reading is wired later, peers see no origin and treat the latch as operator-class, which fails strict. The empty peer reader itself contradicts R9's "pool-visible" claim, and that gap is older than this work. It goes to the feedback queue from this run and is not part of this change.

### Migration parity

- **State:** no migration. Existing latch files load unchanged and read as operator-class. A unit test proves this on a fixture shaped like the real file.
- **Config:** no new config. The cadences are constants. The surfacer is built only where the watcher is (`monitoring.greenPrAutoMerge.enabled`).
- **Journal:** no schema change. A test pins that `origin` never reaches `emitGuardLatch`.
- **CLAUDE.md:** the Green-PR section in `PostUpdateMigrator` gains the new lever and the "a stop a person asked for carries no claim" rule. The migration's existing replace-on-missing-marker path gets a new marker (`/green-pr-automerge/release`), so already-installed agents receive it. The section lives only in the migrator; `src/scaffold/templates.ts` does not carry it.
- **Discoverability:** `CapabilityIndex` route list and description, `tests/fixtures/write-surface-inventory.json`.

### Testing

- **Unit (`guard-latch-store`, new `agent-stop-release`):** class from origin on both sides; legacy file fixture reads operator; malformed origins read operator; peer rows read operator; origin never in journal emit; origin kept after clear; `set` remains absorbing with a claim; claim parser both sides for every field; invalid claim still mints; condition evaluator both sides, including marker near-miss (`-21` vs `-212`), merged-before-stop, merged into another base, compare `behind` or `diverged`, unreadable facts; surfacer: runs while latched and when not lease holder, repairs a missing commitment, wake on met and on age and once per 24 hours, operator stop posted once and the console stop not at all, Attention first-sight and cadence and raise-after-an-hour, closes on inactive, a never-resolving read does not hang the pass and does not stack; `stopGate` disarmed copy has no command; console `watcherLine` for agent, operator, mixed and absent.
- **Integration (`green-pr-automerge-routes`):** full route pipeline: stop with and without a claim, and an invalid claim still stops with 200; release of an operator stop 403, of a legacy-shaped latch 403, no id 400, unknown 404, double release 409, condition unmet 409, unverifiable 503, happy path 200 with `stillStopped` naming a surviving operator stop and `mergeAllowed:false`; a `pin` in a release body does nothing; `/enable` still 403 without PIN and clears agent stops with PIN; response carries the marker; two agent stops keep each other's gate shut; commitment recorded, delivered on release, withdrawn on enable; commitment failure does not block the stop.
- **E2E (`green-pr-agent-stop-release-lifecycle`):** production wiring through `buildGuardLatchStore` + `buildGreenPrDeps` with a fake gh exec, on a real `AgentServer` route stack: an agent stop on a PR, gate shut, release refused while the PR is open, refused while merged but not in the running tag, then the fake gh reads it contained: release 200, gate open; server rebuilt from disk keeps origin and still refuses an operator stop; wiring integrity for the new merge-facts dep (real, not a no-op).

## Decision points touched

- **Stop (`/rollback`)** — `invariant`. Always mints. No new precondition. Justification: the kill switch must never gain a way to refuse.
- **Stop class** — `invariant`. Absent or invalid means operator. Justification: fail toward the stricter side; a wrong "operator" costs a PIN, a wrong "agent" costs the operator's authority.
- **Release authority (`/release`)** — `invariant`. Deterministic reads of the stored class and of real GitHub or running-version state. There is no judgment here for an LLM to add: the facts are binary, and they fail closed when unreadable. This is authority resting on verified state rather than on a brittle text match, so it fits `docs/signal-vs-authority.md`: the decision reads the state, not a symbol of it.
- **`/enable`** — `invariant`, unchanged. The PIN clears any stop.
- **Surfacing pass** — `invariant`, signal only. It posts and wakes a session; it decides nothing and blocks nothing.

## Verify the state, not its symbol (P20)

| Check | Symbol read | Real state | Corroboration |
|---|---|---|---|
| Stop class | `origin` on the latch's own transition | who pulled the stop | Set-once at mint on a fresh id; absent means operator |
| `fix-pr-released` | PR body marker, gh `state`, `mergedAt`, `baseRefName`, compare status against tag `v<running>` | the fix is loaded in this server | Merge must follow the stop; running version comes from the process, not the disk |

## Constitution

**No constitution change.** `docs/STANDARDS-REGISTRY.md` does not pin re-arm to the operator; the PIN requirement lives in R9 of the `green-pr-automerge-enforcement` spec, which this spec amends with a pointer. No CODEOWNERS file is touched, so nothing here waits on the operator. `GuardLatchStore.ts` and `greenPrAutomergeWiring.ts` are protected paths for the watcher, so the PR carries a recorded independent second-pass review.

## Frontloaded decisions

1. **Default-operator claim instead of telling callers apart.** Dashboard and sessions share a credential. Giving the dashboard its own marker would be a claim anyone could send, so it would add nothing. Absence is the strict side and needs no trust.
2. **Machine-checkable conditions only.** A rejected free-text condition costs the rare stop a PIN. An accepted one makes the release a promise.
3. **`topicId` is required in the claim.** A commitment needs a home, and a stop with no owner is exactly the orphan this exists to prevent. A job with no topic pulls an operator-class stop.
4. **No auto-release** (§4).
5. **No count-based release limit** (§4).
6. **The surfacer wakes a session and never releases by itself.** A scheduled job would need a new job definition and migration for the same effect; the pass already reads the condition.
7. **`stoppedAt` versus GitHub's `mergedAt` uses wall-clock across two systems.** Skew fails in one of two ways: a refusal (a PIN or a new stop) or a merge within seconds of the stop counting as after it. Both are acceptable at this scale, and the PR was still merged after the session decided it was the fix.

## Maturation plan

- **test-agent-live:** the E2E above runs the whole lifecycle on the production wiring with a fake gh, and the condition's compare read was checked against the real repository. A real agent stop is never pulled on the live pool to prove this: it would stop live merging.
- **dev-agent-live:** live on the development agent from the release that carries it. No flag. A stop with no claim behaves exactly as it does today, so the only new behaviour appears when a session chooses to make the claim.
- **fleet:** the same release. The feature is reachable only where the watcher runs (`monitoring.greenPrAutoMerge.enabled`, off by default for the fleet), so it follows the watcher's own rollout.
- **graduation criterion:** the first real agent stop on the development agent is released by a session without the operator's PIN, and its record shows the citing PR and the release tag it relied on.
- **dark-window:** none. It does not ship dark: the safe default (operator-class) is the behaviour of every existing caller.

## Rollback

Revert the PR. Stops pulled by the new code keep an `origin` field that old code ignores, so they become PIN-only: the stricter side. Any open commitment for such a stop gets withdrawn by hand; nothing else needs repair.

## Left behind

Older gaps found during review that this change does not make worse. Each goes to the feedback queue from this run.

- `scripts/safe-merge.mjs` has no latch check, so §6's manual-merge rule is text only. A confused session can merge by hand under any stop today, with or without this change. Enforcing it means changing a protected merge path and needs its own review.
- `readPeerLatches: () => []`: a stop on one machine does not bind the lease holder on another, contrary to R9's "pool-visible".

## Open questions

*(none)*
