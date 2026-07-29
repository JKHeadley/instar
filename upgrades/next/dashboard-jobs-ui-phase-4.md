## What Changed

The Dashboard Jobs tab now surfaces the full operator experience described in the jobs-as-agentmd
spec: a migration banner with Confirm-complete and Roll-back buttons; an Issues card aggregating
reconcile findings (orphan-manifest, shadow-md, missing-from-jobs-json, staged-new, case-collision)
with severity-sorted display, per-class filter and per-item dismiss; namespace badges
(instar / user / fork) on every row; a lock-trust warning when an instar default is in a tamper
state; Override and Unfork actions on the row detail panel with plain-English confirmation copy; and
an Edit modal with a frontmatter form, body textarea and a `manifestVersion` optimistic-concurrency
token (a stale save returns 409 and offers a reload rather than overwriting).

`GET /jobs` now returns `hasUserFork`, so the UI renders fork badges in a single round-trip instead of
one request per row.

Unfork backups are retained for 30 days OR the last 10 per slug, whichever is more generous, and are
pruned opportunistically inside the unfork call.

## Summary of New Capabilities

- `POST /jobs/:slug/save` — atomic two-rename commit via `AgentMdAtomicSave`
- `POST /jobs/:slug/disable` — stamps `disabledAtBodyHash`
- `POST /jobs/:slug/enable` — re-enables a disabled job
- `POST /jobs/:slug/override` — forks an instar default into the user namespace (idempotent)
- `POST /jobs/:slug/unfork` — archives the user copy to `.unfork-backups/<slug>-<ts>.md`, then
  restores the instar default
- `GET /jobs/:slug/unfork-backups` — lists retained backups for a slug

## What to Tell Your User

Your Jobs tab can now edit, disable, enable, override and un-override a job without leaving the
dashboard. If a job you customised started life as an instar default, the tab shows that clearly and
lets you return to the default in one action — your customised copy is archived first, never deleted.
If two people edit the same job at once, the second save is refused with an explanation instead of
silently overwriting the first.

## Evidence

Five integration cases covering the mutation endpoints pass
(`tests/integration/jobs-phase4-mutation-endpoints.test.ts`). Lint, type-check and build pass.

Scope of this change, stated so reviewers can see its edges: the drift-digest visual surface is
outside it, because that surface requires the drift classifier to be populating `significantChanges`
in CI first — the migration banner already carries the hook it will attach to. Widening unrestricted
tools from the dashboard is intentionally absent: no endpoint here mutates `unrestrictedTools` or
`toolAllowlist`, and an operator who wants that edits the job body through Override plus Edit, where
the resolver's existing two-flag guard applies. Override and unfork are dashboard-only actions in
this change and have no CLI equivalent.
