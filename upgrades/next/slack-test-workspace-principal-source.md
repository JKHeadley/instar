# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fixes the roadmap-0.3 blocker found in the Slack permission-gate false-positive
review (`docs/audits/slack-permission-fp-review-2026-07.md`, row 29): after the
2026-07-01 silent-loss registry rebuild, the Slack live-test scenario cast could no
longer resolve, so every Slack sender — including the workspace owner — resolved as an
unregistered guest. Root cause: the gate derives roles from the production user registry
(`users.json`), the rebuild removed the five Slack test-cast principals, and the
fixture-identity guard (correctly) refuses to let test identities back into the
production registry.

The fix is a SEPARATE, test-workspace-scoped principal source rather than a registry
edit:

- **New `TestWorkspacePrincipalSource` + `ChainedUserLookup`** (`src/permissions/`).
  The gate's `SlackPrincipalResolver` now reads production-registry-FIRST, then the
  cast as a fallback. A production-registered user can never be shadowed or
  role-escalated by a cast entry.
- **Config-carried cast** — `permissionGate.testCast` in the Slack messaging config
  (`{ testWorkspace, workspaceId, principals[] }`). It lives beside the workspace
  tokens, so a `users.json` rebuild can never silently drop it again.
- **Code-enforced workspace scoping** — the cast resolves ONLY while the adapter's
  VERIFIED connected team id (captured from Slack's own `auth.test` at start, exposed
  via `SlackAdapter.getConnectedTeamId()`) EXACTLY equals `workspaceId`. Any other
  workspace → the source is structurally invisible (production behavior byte-identical
  to no cast). An unlisted uid in the test workspace → today's unregistered-guest default.
- **Partition invariant** — every cast `slackUserId` must match the SAME fixture-marker
  matcher (`users/testIdentityMarkers.ts`) the production guard uses to refuse fixtures;
  a non-fixture id is refused at load. One identity, two disjoint homes.
- **Fail-closed self-declaration** — the block must set `testWorkspace: true`; without
  it the whole cast is ignored (zero principals, one loud log line, no production
  effect). A cast can never be activated by accident.
- **Authority scope (KYP)** — the source feeds permission-gate role resolution ONLY. It
  takes no state dir and has no write surface, so it cannot create user-registry
  entries, cannot feed operator binding, and cannot affect message authorization /
  sender validation.

The runbook (`docs/specs/SLACK-ORG-TEST-WORKSPACE-RUNBOOK.md`) is patched: the old
"seed the cast in users.json" step is replaced with the `testCast` config block plus a
re-provision checklist so a registry rebuild can't silently lose principal resolution
again. Dark by default — nothing activates without an explicit `testCast` block.

## What to Tell Your User

- **Slack permission demo is more robust**: the test harness that proves the Slack
  "who's allowed to do what" feature now keeps its demo cast in a safe place that a
  routine cleanup of your real people-list can't wipe out. This is behind-the-scenes
  test infrastructure — nothing changes in how I work for you day to day, and the
  pretend demo roles are locked to the throwaway test workspace so they can never leak
  into a real one.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Test-workspace-scoped Slack principal cast | Add a `testCast` block (with `testWorkspace: true`, `workspaceId`, `principals`) under the Slack `permissionGate` config — dark unless configured |

## Evidence

Root cause is a live datapoint captured in `docs/audits/slack-permission-fp-review-2026-07.md`:
row 29 (2026-07-02 18:15:19, the only organic decision row) shows the workspace OWNER
seat's Slack UID resolving as `role: guest, registered: false` — the same UID that
resolved as `role: owner, registered: true` in every June scenario row, because the
2026-07-01 rebuild removed the cast from `users.json`.

The fix is verified by `tests/unit/slack-test-workspace-principal-source.test.ts` (22
tests, all passing), which exercises BOTH sides of every boundary:

- matching workspace + listed uid → registered role; matching workspace + unlisted uid
  → guest.
- non-matching workspace + listed uid → source invisible, and the resolved principal is
  asserted EQUAL to the no-cast baseline (the scoping proof that roles can't leak into a
  production workspace).
- missing `testWorkspace: true` → source disabled, zero seats, loud log line, and
  byte-identical to no cast.
- non-fixture uid refused at load; cast cap enforced; production-registry-first
  precedence; a throwing source skipped.
- authority-scope assertions: the source exposes only the read contract (no
  write/registry/operator methods) and takes no state dir.

`tests/integration/slack-testcast-principal-pipeline.test.ts` (5 tests, all passing)
additionally drives the EXACT server.ts composition through the real inbound chokepoint
(`SlackAdapter._handleMessage`) and asserts the durable decision-ledger rows: the owner
seat resolves `owner, registered:true` through the live path (the row-29 regression),
the same seat is an unregistered guest when connected to any other workspace or before
`auth.test` verifies the connection, an unlisted uid stays a guest, and a production
record beats the cast for the same uid.

`npx tsc --noEmit` exits 0.
