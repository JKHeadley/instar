<!-- bump: minor -->

## What Changed

Your ORG-INTENT.md is now a machine-readable **MTP Protocol** in the sense Salim
Ismail's EXO 3.0 defines it — a Massive Transformative Purpose that agents can
actually act on, not a poster on a wall. It has three layers:

- **Constraint layer** (`## Constraints`) — what agents must never do.
- **Decision layer** (`## Tradeoff Hierarchy`) — how trade-offs resolve.
- **Identity layer** (new — `## Identity` with `### Why People Stay` /
  `### What We're Not For`) — why high-judgment humans stay, so the purpose
  binds people, not just gates agents.

A new endpoint runs Salim's two tests against a proposed action:

- `POST /intent/org/test-action` `{ "action": "..." }` →
  `{ refusal:{refused,matchedConstraint,reason}, endorsement:{endorsed,alignedWith,reason}, canGovern }`.
- **Refusal test** ("can your MTP make an agent say no?") checks the constraint
  layer; **endorsement test** ("would leadership endorse this?") checks goals and
  values. Both are deterministic + advisory — they answer a question, never block.

`instar intent validate` now also reports the protocol's layer status and whether
your intent **governs** (has constraint teeth) or merely **cheers** — Salim's line:
"if your MTP can't cause an agent to refuse, it's cheering, not governing."

## Evidence

Full three-tier coverage, all green, `tsc --noEmit` clean (0 errors):

- Unit — `OrgIntentIdentityLayer.test.ts` (10), `IntentTestHarness.test.ts` (9):
  identity-layer parsing (both sides of present/absent/template-only) and the
  refusal/endorsement/canGovern logic.
- Integration — `org-intent-routes.test.ts` (+4): the route over the real HTTP
  pipeline (400 on missing action, present:false with no intent, refuses
  constraint violations, endorses goal-aligned actions).
- E2E — `mtp-protocol-test-action-lifecycle.test.ts` (4): boots a real server on
  a real port with a real ORG-INTENT.md on disk and confirms the feature is alive
  (200, not 404/503) end-to-end.

Migration parity: `PostUpdateMigrator.migrateClaudeMd()` injects the MTP Protocol
section into existing agents' CLAUDE.md (content-sniffed, idempotent). New agents
get it via the scaffold template.
