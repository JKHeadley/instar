# Upgrade Guide — vNEXT (Initiative Tracker for long-running work)

<!-- bump: minor -->

## What Changed

Adds a persisted **Initiative Tracker** — a structural surface for multi-week, multi-phase work that was previously drifting out of sight between Telegram messages, handoff notes, and ad-hoc checklists. The core gap it closes: after a user approves a phased effort (PR-hardening, context-death hardening, etc.), the next phase would stall silently because nothing in the agent's state said "this is phase N of M, last touched D, awaiting user decision X."

**What ships:**

- `InitiativeTracker` class (`src/core/InitiativeTracker.ts`) persists `.instar/initiatives.json`. CRUD, phase transitions, and a digest scan that emits four signal types: `stale` (>7d no movement), `awaiting-user` (blocked on user input), `next-check-due` (explicit next-check date reached), `ready-to-advance` (phase exit criteria met).
- 7 HTTP endpoints under `/initiatives`, auth-gated like `/jobs`:
  - `GET /initiatives` — list
  - `GET /initiatives/:id` — fetch
  - `POST /initiatives` — create
  - `PATCH /initiatives/:id` — update
  - `POST /initiatives/:id/transition` — move to next phase
  - `DELETE /initiatives/:id` — remove
  - `GET /initiatives/digest` — signal scan for currently-actionable items
- Dashboard "Initiatives" tab — read-only, XSS-safe (uses `textContent`). Renders current phase, last-touched, blockers, what-needs-you.
- 52 new tests (28 core + 15 route + 9 dashboard smoke). `tsc --noEmit` clean.
- Spec: `docs/specs/INITIATIVE-TRACKER-SPEC.md` (approved by Justin in Telegram topic 2317 on 2026-04-17; recovered via PR #68 after the original commit was orphaned during a main-branch reset).

**What is not in this release (deferred):**
- Daily digest job that posts `awaiting-user` cards to Telegram (Phase 2 — separate commit).
- Editable initiatives from the dashboard (read-only only for now).

## What to Tell Your User

Long-running work on instar used to drift: you'd approve "Phase A first, then we'll flip to Phase B shadow mode," and then nothing automatic existed to remind either of us that Phase B was waiting. Agents had to re-scan Telegram history or re-read handoff notes to notice blocked work. The Initiative Tracker is the fix — a single place where multi-phase efforts are recorded with current phase, last-touched, and what (if anything) is blocking progress.

After updating, your dashboard gets a new **Initiatives** tab. Until we (or an agent) actually seed it with entries, it'll be empty — that's expected. Tell me to populate it with the long-running work I'm tracking and it'll fill in.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Initiative Tracker (persisted multi-phase state) | API: `GET /initiatives`, `POST /initiatives`, `PATCH /initiatives/:id`, `POST /initiatives/:id/transition`, `GET /initiatives/digest` |
| Dashboard Initiatives tab (read-only view) | Open the dashboard, click **Initiatives** |
| Digest scan for actionable items | `GET /initiatives/digest` returns items tagged `stale`, `awaiting-user`, `next-check-due`, `ready-to-advance` |

## Evidence

**Tests:** 52 new tests added in this release, all green. Existing suites unaffected: `BackupManager` 42/42, `PostUpdateMigrator` 24/24, route coverage unchanged. Full CI green on the landing PR (#68): Type Check ✓, verify ✓, Unit Tests on Node 20 ✓, Unit Tests on Node 22 ✓, Build ✓, Integration Tests ✓, E2E Tests ✓.

**Recovery context:** The original commit (`f237d55` in reflog) landed on main locally during a prior session but was lost when main was reset to match origin during an unrelated conflict resolution. Files were recovered from the reflog, conflicts were surgically resolved in three files (`src/commands/server.ts` added InitiativeTracker construction alongside parallel-dev wiring; `src/server/AgentServer.ts` added option alongside `unjustifiedStopGate`; `src/data/builtin-manifest.json` regenerated). Merged cleanly with CI verification as the safety net.

## Deployment Notes

- No operator action required on update. The tracker is available as soon as the new code is running.
- `.instar/initiatives.json` is created lazily on first write — no migration step needed.
- `/initiatives/*` routes are auth-gated like `/jobs` — requires `Authorization: Bearer <authToken>`.
- Dashboard Initiatives tab appears automatically once the server is on the new version.
- Existing initiatives elsewhere (handoff notes, Telegram threads) are not auto-imported — seed manually via `POST /initiatives` or ask your agent to populate from context.
