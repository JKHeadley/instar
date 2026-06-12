# Upgrade Guide — Mandates tab: phone-first user floor-action grants

<!-- bump: patch -->

## What Changed

The PIN-gated user→agent floor-grant route (`POST /mandate/:id/grants`) finally has its operator surface (JKHeadley/instar#1080): every ACTIVE mandate card on the dashboard Mandates tab now carries a "Grant a user a floor action" form — person picker (fed by the new read-only `GET /permissions/users`, which serves registered users carrying a Slack identity), floor-action dropdown (test-pinned against the `FLOOR_ACTIONS` enum in `RolePolicy.ts` so the UI can never drift from enforcement), duration presets clamped client-side to the mandate's own expiry (the server enforces the same bound by rejection — the form makes the operator's pick succeed instead), and the PIN — typed once, sent once, never retained. Cards also list carried grants in plain language with expired ones marked. Born from the 2026-06-12 lesson: scenario 8/8 of the Slack live test needed exactly this grant and the only available path was a terminal command at a laptop (Mobile-Complete Operator Actions).

Agent awareness ships both ways: the CLAUDE.md template gains a "User floor-action grants are phone-first" bullet (send the operator the dashboard link, NEVER a terminal command), and a `PostUpdateMigrator` migration inserts the same bullet into existing agents' Coordination Mandate section (anchored insertion, append fallback, idempotent). `CapabilityIndex` entries updated for both routes.

## What to Tell Your User

- "You can now grant a teammate a time-boxed floor action (like a 1-hour prod-deploy) straight from the dashboard on your phone — pick the person, the action, and the duration, type your PIN, tap Grant. No terminal, no laptop."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Phone-first floor-action grants | Dashboard → Mandates tab → any active mandate → "Grant a user a floor action" |
| Registered-user person picker | Automatic (`GET /permissions/users` feeds it) |

## Evidence

- Unit: `tests/unit/dashboard-mandateGrantForm.test.ts` (12 tests — pick-don't-type rendering, PIN discipline incl. never-retained, expiry clamp, enum-drift pin, XSS, registry-failure degradation) + `tests/unit/PostUpdateMigrator-floorGrantPhoneFirst.test.ts` (4 tests — fresh install, anchored insertion, hand-edited fallback, idempotency).
- Integration: `tests/integration/permissions-routes.test.ts` (+3 — Slack-only filtering, empty list, missing orgRole; no channel/permission leakage).
- E2E: `tests/e2e/coordination-mandate-lifecycle.test.ts` (+3 — route alive + Bearer-gated on the production boot path; the form's EXACT payload signs a grant end-to-end; Bearer-without-PIN structurally refused).
- All 24 pre-existing Mandates-tab tests + the full mandate-area suite (109 tests) green.
- Side-effects artifact: `upgrades/side-effects/mandate-grant-form.md`.
