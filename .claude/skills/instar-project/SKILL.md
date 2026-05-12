---
name: instar-project
description: Register, inspect, and drive multi-spec projects via the instar /projects API. Twelve subcommands cover the full Phase 1 surface — create / status / next / advance / drift / run-round / halt / ack / resume / abandon / accept-partial / claim-ownership.
user_invocable: true
---

# /project — Multi-Spec Project Surface

> Spec: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.7.
> A project bundles many feature initiatives into rounds. The dashboard
> Projects tab, the session-start digest, and the compaction-recovery
> hook keep them visible. This skill is the user-invocable surface for
> inspecting and driving them.

---

## Setup — read auth + port once

```bash
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
PORT=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null)
```

Every endpoint except `/health` requires `Authorization: Bearer $AUTH`.

---

## `/project create <plan-doc-path>`

Register a new project from a plan-doc markdown file. The plan-doc
schema is `PlanDocParser`'s contract (spec § Phase 1.6).

**Pre-flight first** (no rate-limit cost):

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"planDocPath\": \"$(realpath PLAN_DOC.md)\"}" \
  "http://localhost:${PORT}/projects/validate"
```

Returns `200 {ok, project, children, errors}`. Iterate until `ok:true`.

**Then create:**

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"planDocPath\": \"$(realpath PLAN_DOC.md)\"}" \
  "http://localhost:${PORT}/projects"
```

- `201` — `{project, children}`.
- `400` — validation failed; surface each error.
- `409` — slug already exists.
- `429` — rate-limited (5 creates/hour per auth token); body includes `windowEnds`.

---

## `/project status [id]`

**No id** — list all projects:

```bash
curl -sS -H "Authorization: Bearer $AUTH" "http://localhost:${PORT}/projects"
```

Render to user: id, title, per-round status summary (e.g. `2/4 complete, 1 in-progress, 1 pending`).

**With id** — fetch the project plus its child items:

```bash
curl -sS -H "Authorization: Bearer $AUTH" "http://localhost:${PORT}/projects/<id>"
```

Returns `{project, children}`. Render: title, status, version, round-by-round breakdown with each item's `pipelineStage`, plus any `blockers` or `awaitingUser` reason.

The GET also runs a lazy merged-state reconciler — children at `pipelineStage: 'building'` with a `mergeCommitOid` are re-verified against `origin/main` (debounced 6h, capped at 3 per call). Pass `?reconcile=false` to skip.

---

## `/project next [id]`

Returns the next action the agent should take on this project.

```bash
curl -sS -H "Authorization: Bearer $AUTH" \
  "http://localhost:${PORT}/projects/<id>/next"
```

- `200 {action, params, skillCommand}` — `action` is one of
  `await-user-approval`, `ack-required`, `resolve-conflict`,
  `accept-partial`, `run-spec-converge`, `run-drift-check`,
  `start-round`. `skillCommand` is a suggested `/project ...` (or
  `/spec-converge`) invocation. `params.roundIndex`, `params.itemIds`,
  `params.status` are the round context.
- `204` — every round is complete.
- `404` — id is not a project.

Surface the suggested `skillCommand` to the user. Do NOT auto-run a
mutating skill (`run-round`, `ack`) without explicit user consent —
read-only suggestions (`run-spec-converge`, `run-drift-check`) are
fine to act on.

---

## `/project advance <id> <itemId> <targetStage>`

Manually transition one child item between pipeline stages. The
server-side validator (`StageTransitionValidator`) checks the artifact
behind each transition — `outline → spec-drafted` requires a markdown
spec file at `docs/specs/`, `spec-converged → approved` requires
`approved: true` in frontmatter, `approved → building` needs a
TaskFlow record id, `building → merged` confirms the PR is MERGED
and its `mergeCommit.oid` is reachable from `origin/main`.

```bash
PROJECT_ID=...
ITEM_ID=...
TARGET_STAGE=spec-drafted   # or spec-converged, approved, building, merged, regressed, skipped
PROJECT_VERSION=...   # read from /projects/<id>

curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -H "If-Match: ${PROJECT_VERSION}" \
  -d "{\"itemId\": \"${ITEM_ID}\", \"targetStage\": \"${TARGET_STAGE}\", \"artifact\": {\"specPath\": \"docs/specs/foo.md\"}}" \
  "http://localhost:${PORT}/projects/${PROJECT_ID}/advance"
```

- `200 {item, project}` — transition applied.
- `409` — version mismatch (re-GET the project, retry) OR artifact validation failed (body includes `code` + `reason`).
- `404` — item not under this project.
- `428` — `If-Match` header missing.

The `artifact` body shape depends on the target stage; surface the
validator's `reason` field on rejection so the user knows what's missing.

---

## `/project drift <id> <roundIndex> <specPath>`

Run the drift checker for one round. The verdict is a *signal*, not an
authority — it tells the agent whether the spec premise still holds
against the current state of referenced files.

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"roundIndex\": 0, \"specPath\": \"docs/specs/foo.md\", \"referencedFiles\": [\"src/foo.ts\", \"src/bar.ts\"]}" \
  "http://localhost:${PORT}/projects/<id>/drift-check"
```

- `200 {verdict, projectId, roundIndex}` — `verdict.status` is
  `no-drift`, `minor-drift`, `premise-violated`, or
  `manual-review-required`. On `premise-violated`, the verdict
  carries byte-range citations — surface them to the user.
- `409` — another drift-check for this project is already in flight
  (mutex-guarded; protects the spend ledger and LLM bill).
- `503` — no `IntelligenceProvider` configured (no LLM available).
  The verdict is unavailable; the round can still proceed but is
  flying blind on drift.

---

## `/project run-round <id> [roundIndex]`

Manual trigger to start a round. Calls `ProjectRoundRunner.preflight`
(lock, drift, owner, ack-gap) and, on accept, sets `autoAdvanceAt = now`
so the poller fires the executor on its next tick (≤60s). Does NOT
spawn the autonomous child directly — that path goes through the poller
to keep one fire path through one lock.

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"roundIndex\": 0}" \
  "http://localhost:${PORT}/projects/<id>/run-round"
```

- `200 {id, roundIndex, scheduledAt, version}` — preflight passed,
  round scheduled. The autonomous child will start within ~60s.
- `409 {error, code, reason}` — preflight rejected; the `reason`
  text says what's missing (drift verdict, ack, owner, lock).
  Surface the reason verbatim to the user — these are actionable.
- `404` — round index out of range.
- `503` — `ProjectRoundRunner` not wired (server has no intelligence
  provider, or the runner failed to start at boot).

---

## `/project halt <id> [reason]`

Immediately cancel the active round. Writes `haltedAt` to the round,
sets `project.status = 'halted'`, signals the autonomous child via
SIGTERM (5s grace, then SIGKILL), releases the round-runner lock.
Worktrees are retained for inspection.

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"reason\": \"spec drift detected upstream\"}" \
  "http://localhost:${PORT}/projects/<id>/halt"
```

- `200 {id, roundIndex, version}` — round halted.
- `409` — no halt-able round (project has no in-progress round).
- `503` — `ProjectRoundRunner` not wired.

Halt is idempotent; repeated calls return 200 against the same round.

---

## `/project ack <id> [roundIndex]`

Record the user's acknowledgment for the first auto-advance of a
project (`firstLaunchAckAt`) and reset the unacknowledged-advance
counter. Required by the runner's preflight: a project's first round
cannot fire without `firstLaunchAckAt`; after two unacknowledged
auto-advances the project is paused until acked.

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"forRoundIndex\": 0}" \
  "http://localhost:${PORT}/projects/<id>/ack"
```

- `200 {id, firstLaunchAckAt, lastAckedRoundIndex, unacknowledgedAdvanceCount, version}`.
- `404` — project not found.
- `503` — `ProjectRoundRunner` not wired.

Ack is also accepted via Telegram reply OR the dashboard Ack button
— this route is the explicit-API path. `/project approve <id>` is
documented as an alias because the structured `/projects/:id/next`
payload returns `skillCommand: "/project approve ..."` for the
`await-user-approval` action; both invocations call the same ack endpoint.

---

## `/project resume <id> [roundIndex] [--force]`

Resume a halted round. Clears `haltedAt`/`haltReason` and schedules
the round for the poller. For rounds at status `failed` with
`resumeAttempts >= 3` (spec's 3-attempt cap), `--force` is required
and the attempt counter is reset.

```bash
# Normal resume
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"roundIndex\": 0}" \
  "http://localhost:${PORT}/projects/<id>/resume"

# Force-resume a failed round at the cap
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"roundIndex\": 0, \"force\": true}" \
  "http://localhost:${PORT}/projects/<id>/resume"
```

- `200 {id, roundIndex, scheduledAt, forced, version}` — round
  scheduled to re-fire.
- `409` — round is neither halted nor failed; or it's at the
  resume cap and `force` was not set.
- `404` — round index out of range.

Resume restores `project.status` from `halted`/`abandoned` back to
`active` so the poller considers it again.

---

## `/project abandon <id>`

Archive a halted project. Sets `project.status = 'abandoned'`, clears
any future `autoAdvanceAt` on remaining rounds, leaves each child's
`pipelineStage` untouched. Idempotent. Refuses (409) if any round is
currently `in-progress` — halt first.

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  "http://localhost:${PORT}/projects/<id>/abandon"
```

- `200 {id, status, version}` — project abandoned. Body includes
  `alreadyAbandoned: true` on idempotent repeat.
- `409` — there's an in-progress round; halt it first.

---

## `/project accept-partial <id> <roundIndex> <reason> <skippedBy>`

Close a `partially-complete` round (some items merged, others skipped).
Records the skip reason in the project's audit log and advances
`lastAckedRoundIndex` so the next round can fire. The skipped items
get `pipelineStage = 'skipped'`.

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"roundIndex\": 0, \"reason\": \"upstream dependency blocked\", \"skippedBy\": \"justin\"}" \
  "http://localhost:${PORT}/projects/<id>/accept-partial"
```

- `200 {id, skippedItemIds, version}`.
- `400` — `reason` or `skippedBy` missing.
- `404` — project or round not found.
- `503` — `ProjectRoundRunner` not wired.

---

## `/project claim-ownership <id>`

Multi-machine ownership transfer. The current machine writes its
`machineId` as `ownerMachineId` on the project record. The auto-advance
poller only fires rounds whose owner matches the running machine, so
this is the gate for moving a project between machines.

```bash
PROJECT_VERSION=...   # read from /projects/<id>

curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -H "If-Match: ${PROJECT_VERSION}" \
  -d "{}" \
  "http://localhost:${PORT}/projects/<id>/claim-ownership"
```

Pass `{"force": true}` to override a current owner whose heartbeat is
still fresh — by default the claim is refused with `409` in that case.

- `200 {id, ownerMachineId, previousOwner, version}` — claim recorded.
  Body includes `alreadyOwned: true` if the caller already owns it.
- `409` — current owner is alive (heartbeat fresh) and `force` was
  not set; OR If-Match version mismatch.
- `428` — `If-Match` header missing.
- `503` — machine heartbeat not configured.

Per spec § Phase 1.12: after claim, the caller must commit-and-push
the claim before acting on it, then wait 60s for git-sync to converge.
This route only records the change; the wait-and-converge is the
caller's responsibility.

---

## Session-start integration

Active projects (top 5 by `lastTouchedAt`) show up automatically at
session start and after context compaction. The data comes from
`.instar/projects-digest.cache`, written by the server every time a
project mutates. No need to invoke `/project status` to see what's
open — the digest is already in your context.

If the cache is missing the hook emits:

> Active projects: state unavailable — run /project status when ready.

That's the cue to call `/project status` (no id) once.

---

## Conversational rendering — talk, don't dump

These commands return JSON. Render results to the user as narrative,
not raw output. For `/project status`: a sentence per project with
round progress. For `/project next`: state what the next action is
and why, then offer to take it. For errors: surface the `reason` text
verbatim — those are written for users, not developers.

Never paste a curl command in a user-facing reply.
