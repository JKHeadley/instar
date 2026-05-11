---
name: instar-project
description: Register and inspect multi-spec projects via the instar /projects API. Phase 1a ships read-only commands (create, status, next); advance / drift / run-round / halt / ack / resume / abandon ship in Phase 1b.
user_invocable: true
---

# /project — Multi-Spec Project Surface (Phase 1a, read-only + create)

> Spec: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.7.
> A project bundles many feature initiatives into rounds. The dashboard
> Projects tab + session-start digest line keep them visible; this skill
> is the user-invocable surface for inspecting and registering them.

**Phase 1a scope:** `create`, `status`, `next`. Mutating commands
(`advance`, `drift`, `run-round`, `halt`, `ack`, `resume`, `abandon`,
`accept-partial`, `claim-ownership`, `resolve-conflict`) ship in Phase 1b
once the round-runner and drift checker land.

---

## Setup — read the auth token once

```bash
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
PORT=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null)
```

Use `Authorization: Bearer $AUTH` on every call. The `/health` endpoint
is the only one that doesn't require auth.

---

## `/project create <plan-doc-path>`

Register a new project from a plan-doc markdown file. The plan-doc
schema is `PlanDocParser`'s contract (PR 2 spec § Phase 1.6 — frontmatter
+ roster tables under `### Tier N` headers).

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"planDocPath\": \"$(realpath PLAN_DOC.md)\"}" \
  "http://localhost:${PORT}/projects"
```

**Responses:**
- `201` — project + children created. Body: `{project, children}`.
- `400` — plan-doc validation failed. Body: `{error, errors[]}` —
  surface each error to the user; the parser names the offending field.
- `409` — slug already exists. Surface "project `<id>` already
  registered" to the user; they can pick a new slug.
- `429` — rate-limited (5 creates/hour per auth token). Body includes
  `windowEnds`. Tell the user the next window.

**Pre-flight check (recommended for long plan docs):** dry-run the parse
first so you can show errors without consuming the rate-limit budget.

```bash
curl -sS -X POST -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"planDocPath\": \"$(realpath PLAN_DOC.md)\"}" \
  "http://localhost:${PORT}/projects/validate"
```

`POST /projects/validate` always returns `200` with `{ok, project,
children, errors}`. Iterate on the plan doc until `ok:true`, then
`create`.

---

## `/project status [id]`

**No id:** list all active projects with per-project round progress.

```bash
curl -sS -H "Authorization: Bearer $AUTH" "http://localhost:${PORT}/projects"
```

Response: `{ items: [...], count: N }`. Each item is a full `Initiative`
record with `kind:'project'`. Render a short table to the user — `id`,
`title`, `rounds[].status` summary (e.g. `0/4 complete, 1 in-progress,
3 pending`).

**With id:** fetch the project + its children (the per-feature tasks
attached via `parentProjectId`).

```bash
curl -sS -H "Authorization: Bearer $AUTH" "http://localhost:${PORT}/projects/<id>"
```

Response: `{project, children}`. Render to the user as:
- Title, status, `version`
- Round-by-round breakdown: round name, member item titles, item
  `pipelineStage`
- Any `blockers` or `needsUser` reasons

**Common errors:**
- `404 project not found` — id is wrong or the record is a `kind:'task'`
  initiative. Suggest `/project status` (no id) to list valid ids.

---

## `/project next [id]`

Phase 1a placeholder. The endpoint returns `501` until Phase 1b's
`ProjectRoundRunner` lands.

```bash
curl -sS -H "Authorization: Bearer $AUTH" \
  "http://localhost:${PORT}/projects/<id>/next"
```

Expected response right now: `501 { action: "not-implemented", message:
"next-action computation lands in Phase 1b" }`. Surface to the user:
"`/project next` is a placeholder until Phase 1b lands the round
runner. Use `/project status` for current state."

---

## Session-start integration

Active projects (top 5 by `lastTouchedAt`) show up automatically at
session start and after context compaction. The data comes from
`.instar/projects-digest.cache`, written by the server every time a
project mutates. You don't need to invoke `/project status` to see what
projects are open — the digest is already in your context.

If the cache is missing the hook emits:

> Active projects: state unavailable — run /project status when ready.

That's the cue to call `/project status` (no id) once and let the
agent re-render its mental model.

---

## What's coming in Phase 1b

The mutating commands ship next. Skill body will grow to cover:

- `/project advance <id> <stage>` — manual stage transition (uses
  `POST /projects/:id/advance`).
- `/project drift <id>` — run drift check now (signal-only).
- `/project run-round <id> [roundIndex]` — start a round
  (`ProjectRoundRunner` dispatch).
- `/project halt <id>` — immediate cancel.
- `/project ack <id> [roundIndex]` — record user ack to allow auto-advance.
- `/project resume <id>` / `/project resume --force <id>` — resume halted/failed rounds.
- `/project abandon <id>` — archive halted round; children stay where they are.
- `/project accept-partial <id> <roundIndex> <reason>` — close partially-complete round.
- `/project claim-ownership <id>` — multi-machine ownership transfer.

Until those land, treat this skill as read-only for projects already
in flight, plus a create entry point.
