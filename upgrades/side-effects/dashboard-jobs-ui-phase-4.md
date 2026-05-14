# Side-effects review — Dashboard Jobs UI (Phase 4)

## What changed

Ships the Dashboard Jobs tab rewrite from INSTAR-JOBS-AS-AGENTMD spec §Dashboard UX and §Operator Experience. Existing Jobs tab is extended with the spec's named surfaces; no breaking change to the existing flow.

### Frontend (`dashboard/index.html`)

- **Migration banner** above the jobs list. Reads `GET /jobs/migration-status` and renders one of four states: ready-to-confirm (shows Confirm + Roll-back buttons), already-confirmed (✓), abandoned, or partial. Confirm/abandon buttons POST to `/jobs/migration-confirm` and `/jobs/migration-abandon`.
- **Issues card** below the migration banner. Reads `GET /jobs/reconcile` and surfaces orphan-manifest / shadow-md / missing-from-jobs-json / staged-new / case-collision findings. Sorted by severity. Per-class filter dropdown. Per-item dismiss button (auto-undismiss on next reload — recurrence-surfaces).
- **Two new filter chips**: "Instar defaults" and "Your jobs" alongside the existing All/Running/Failing/Disabled.
- **Namespace badges** on each row: `instar` (blue) for shipped defaults, `user` (green) for your jobs, `fork` (yellow) when a user-namespace fork shadows an instar slug.
- **Lock-trust warning indicator** on rows whose `lockTrust` is in a real-tamper state.
- **Action buttons in the detail panel**: Override (instar-origin only), Edit (user-origin only), Unfork (user-origin where `hasUserFork` is true). All include the spec's ELI16 copy on the confirmation prompt.
- **Editor modal**: frontmatter form (name, description, schedule, priority) + body textarea + `manifestVersion` OCC token surfaced as a footer line. Save POSTs to `/jobs/:slug/save`; on 409 stale-version the operator gets a "reload and lose changes?" modal per spec §Dashboard Error Surfaces.

### Backend (`src/server/routes.ts`)

- **`GET /jobs`** extended with `hasUserFork` so the UI can render the fork badge in one round-trip (spec §Dashboard UX "no N+1 round-trips").
- **`POST /jobs/:slug/save`** — atomic two-rename commit via `AgentMdAtomicSave`. Refuses saves into `instar/` namespace (Override flow only). 409 on stale `manifestVersion`.
- **`POST /jobs/:slug/disable`** — stamps `disabledAtBodyHash` + flips `enabled:false`.
- **`POST /jobs/:slug/enable`** — clears `disabledAtBodyHash` + flips `enabled:true`.
- **`POST /jobs/:slug/override`** — copies `instar/<slug>.md` to `user/<slug>.md`, updates manifest `origin:user`, bumps `manifestVersion`. Idempotent on re-invocation.
- **`POST /jobs/:slug/unfork`** — archives `user/<slug>.md` to `.unfork-backups/<slug>-<ts>.md` (with 80-char slug cap for Windows MAX_PATH safety), removes the user fork, sets manifest `origin:instar`, bumps version, runs opportunistic prune (30-day OR last-10 retention per spec).
- **`GET /jobs/:slug/unfork-backups`** — list newest-first for the "Restore unforked copy" UI action.
- **`pruneUnforkBackups(backupsDir, safeSlug)`** helper at end-of-file implements the spec's retention rule.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** `POST /jobs/:slug/save` refuses to write into `instar/` namespace, forcing the operator through the Override flow. This is the spec's design — direct edits to instar-managed files would be overwritten on next update AND break body-hash verification.
- **Under-block:** the save endpoint enforces `manifestVersion` OCC only when the request carries it. A request without the field still saves (legacy CLI use). The Dashboard always carries the token; the OCC protection is specifically for the multi-tab/multi-editor case.

### 2. Level-of-abstraction fit

The backend endpoints are HTTP wrappers around already-tested primitives:
- `atomicSaveAgentMdJob` (PR #211)
- `stampDisabledAtBodyHash` + `clearDisabledAtBodyHash` (PR #215)
- Direct file ops for override/unfork (spec is explicit on the two-rename + backup sequence)

The frontend is markup + ~250 lines of JavaScript layered onto the existing Jobs tab. No new framework, no new build step.

### 3. Signal-vs-authority compliance

- The Dashboard is the operator's signal layer.
- `atomicSaveAgentMdJob` is the authority for body+manifest durability.
- `stampDisabledAtBodyHash` / `clearDisabledAtBodyHash` are the authorities for the disable-time hash field.
- The release-cut gate (future) is the authority for "can `jobs.json` be deleted" — Dashboard's `/migration-confirm` button writes the marker the gate consumes.

### 4. Interactions

- **Phase 1c-runtime lockTrust** — surfaced in the row via the `!` warning badge for tamper states.
- **Phase 2 installBuiltinJobs** — Override flow's idempotency check uses the spec's expected file layout.
- **Phase 3 jobsMigrate** — `migration-abandon` button delegates to the same one-button-rollback path.
- **Phase 5 auto-migrate** — `migration-confirm` writes the marker that silences the auto-runner per spec.
- **Phase 6 deprecation warning** — `migration-confirm` also silences the per-boot deprecation warning.

### 5. Rollback cost

- Frontend: revert the dashboard/index.html edits (additive — no existing UI behavior changed).
- Backend: revert the routes.ts edits (additive — endpoints have no existing callers outside the Dashboard).
- Helper: `pruneUnforkBackups` is gated on existing backups directories, no-op when none.

### 6. Spec coverage

The Phase 4 spec rollout step §4 lists these items:
- ✅ Jobs tab rewrite (extended in-place; no rewrite was needed since the existing structure already supported the new surfaces)
- ✅ Issues card with sort/filter/dismiss
- ⚠️ Drift digest — depends on the drift classifier (#216) populating `significantChanges`; the UI hook is in place via the migration banner but a dedicated drift-digest surface is deferred until `significantChanges` is being populated in CI
- ✅ Unfork action with backup
- ✅ Override flow with ELI16 copy
- ⚠️ CLI ops-gate parity — the unrestricted-tools widening UI is NOT in this PR (no Dashboard endpoint mutates `unrestrictedTools` or `toolAllowlist: "*"`); operators who want unrestricted tools edit the body via Override + Edit, and the resolver's two-flag guard already enforces the requirement
- ✅ File Viewer never-editable list extended (shipped earlier in #206)

## Test coverage

`tests/integration/jobs-phase4-mutation-endpoints.test.ts` — 5 cases:

1. `atomicSaveAgentMdJob` writes md + manifest atomically
2. `stampDisabledAtBodyHash` + `clearDisabledAtBodyHash` roundtrip
3. Override copies instar→user and updates origin
4. Unfork archives the user copy before removal
5. Unfork-backup prune keeps newest 10 even when all are older than 30 days

All 5 pass locally. Lint + type-check pass. Build passes including the signer step.

End-to-end smoke (start dev server + interact with Jobs tab) — not automated in this PR; verified manually that the new buttons render and call the new endpoints. Full e2e coverage is a follow-up.

## What is NOT in this PR

- Drift digest visual surface (depends on the classifier shipping in production CI with `ANTHROPIC_API_KEY` configured).
- Unrestricted-tools four-screen confirmation UI (operators currently can't widen via the Dashboard; the Edit modal saves `origin:user` jobs which default to minimal `[Read]`).
- CLI parity for the new Dashboard actions (`instar job override <slug>`, `instar job unfork <slug>`). The endpoints exist; a future CLI PR can call them.
- Full e2e test against a running server. Tests exercise the underlying primitives.
