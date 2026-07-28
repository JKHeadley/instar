# Side-Effects Review — Mandates-tab user floor-action grant form (#1080)

**Version / slug:** `mandate-grant-form`
**Date:** `2026-06-12`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `reviewer subagent (PIN-gated authority surface — see appended response)`

## Summary of the change

Adds the missing operator surface for the existing PIN-gated `POST /mandate/:id/grants` route: a phone-first grant form on every active mandate card in the dashboard Mandates tab (`dashboard/mandates.js` renderers + controller, CSS in `dashboard/index.html`), plus a new read-only `GET /permissions/users` route (`src/server/routes.ts`) feeding the person picker, `CapabilityIndex` entries, the CLAUDE.md template bullet (`src/scaffold/templates.ts`), and a Migration Parity patch (`src/core/PostUpdateMigrator.ts`) inserting that bullet into existing agents. Born from the 2026-06-12 Mobile-Complete Operator Actions lesson (scenario 8/8 of the Slack live test was laptop-bound). The change adds NO new authority and NO new decision logic — the server-side gate, PIN check, signing, clamping, and audit are all pre-existing and untouched.

## Decision-point inventory

- `POST /mandate/:id/grants` (PIN gate + MandateStore.addGrants validation) — **pass-through** — the form is a client of the existing gate; its checks are unchanged.
- `GET /permissions/users` (new route) — **add, but not a decision point** — read-only projection of `users.json` (slackUserId/name/orgRole only); gates nothing, filters nothing inbound, holds no authority.
- Client-side validation in `wireGrantButtons` (PIN present, grantee present) — **add** — UX-layer pre-flight only; the server re-validates everything. Refusing to POST without a PIN is convenience, not authority (the server would 403 identically).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The form refuses to submit without a grantee or PIN (both server-required — no legitimate request is lost). The person picker constrains the grantee to registered users; an operator legitimately wanting to grant an UNREGISTERED Slack id would be over-blocked by a dropdown-only design — mitigated: when the registry is empty the field degrades to free text, and the API accepts any id directly. Residual: with a non-empty registry the dropdown offers no "type someone else" escape; accepted for now (a grant to an unregistered principal can't be resolved by the permission gate anyway — `SlackPrincipalResolver` won't produce a registered principal for them, so such a grant would be inert; the dropdown reflects the set for which a grant is meaningful).

## 2. Under-block

**What failure modes does this still miss?**

- The form cannot stop an operator from granting the WRONG person a floor action — by design; the PIN holder's judgment is the authority. The plain-language confirmation + the per-card grant list are the mitigations.
- `GET /permissions/users` lists ALL registered Slack users regardless of role; it does not advise "this person already holds this authority by role" (a redundant grant is valid and harmless — the gate checks role first).
- The duration presets cap at 24h; longer grants require re-granting (deliberate friction, matches the spec's time-boxed intent).

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The gap was purely presentational — the authority/validation/signing layer (`MandateStore.addGrants`, `checkMandatePin`) is correct and untouched. The expiry clamp is duplicated client-side ONLY to convert a server rejection into a success-with-shorter-window (better operator experience); the server remains the enforcing layer. The person picker's data comes from a server route rather than embedding registry reads in the dashboard — consistent with every other tab.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic?**

No blocking authority anywhere in the change. The form's pre-flight checks mirror server requirements 1:1 and cannot diverge into wrongly-blocking territory without the server having the same requirement. The floor-action dropdown is the one brittle mirror (a hand-copied enum) — made non-brittle by the dedicated drift test pinning the dashboard list against the `FLOOR_ACTIONS` source enum. Reference reviewed: `docs/signal-vs-authority.md`.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race with adjacent cleanup?**

- `renderMandates` gained an optional second parameter (default `[]`) — all existing callers and the 24 pre-existing tab tests pass unchanged.
- `wireGrantButtons()` follows the exact `wireRevokeButtons()` pattern (re-wired on every refresh; `onclick` assignment is idempotent).
- The new `/permissions/users` fetch joins the refresh `Promise.all`; its failure is caught per-call and degrades the picker to free text — a registry outage can no longer take down the tab (tested).
- The 30s auto-refresh re-renders the list, which RESETS in-progress form input (pre-existing behavior for the revoke row's PIN field too). Mitigation considered and deferred as pre-existing scope: the grant form lives in a collapsed `<details>`, so accidental loss requires the refresh to land mid-typing; the revoke row has shipped with this behavior since the tab existed. <!-- tracked: JKHeadley/instar#1080 -->

## 6. External surfaces

**Anything visible to other agents/users/systems? Timing/state dependencies?**

- New Bearer-gated route `GET /permissions/users` exposes slackUserId + name + orgRole of registered users — strictly less than `users.json` already holds, no channel identifiers/preferences/permissions leak (tested). Visible to any Bearer holder (same trust domain as the full mandate list).
- CLAUDE.md template + migration change agent guidance fleet-wide on update (the behavioral half of the fix). Migration is idempotent, anchored, with append fallback (tested all three paths).
- No config, no message formats, no timing dependencies beyond the existing dashboard refresh cycle.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Revert the PR, release a patch. The dashboard is stateless; the route is read-only; grants created through the form are ordinary signed mandate grants (rollback does not orphan them — they expire or die with their mandate). The CLAUDE.md migration leaves one extra guidance bullet in updated agents' files; it references the Mandates tab generically and stays harmless even if the form were reverted (the tab still exists). Cheap rollback.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (id adc039b9f0dd4b8dc), 2026-06-12
**Verdict (verbatim):** "Concur with the review." — after verifying: the auth-middleware allowlist does NOT skip `/permissions` (Bearer applies; e2e pins the 401); PIN never in module state and cleared on success + refusal paths; every new render interpolation goes through `esc()` (attribute positions included); the expiry clamp compares ms epochs on both sides and equality passes the server's strict check; the grant form is gated on the same `state === 'active'` condition as the revoke row; the migration guard phrase is contained in its own inserted bullet (idempotent).

Observations (all non-blocking), and disposition:
1. The floor-action drift pin was one-directional (subset, not equality) — a stale dashboard-only extra after an enum removal would mint inert-but-recorded grants. **Disposition: fixed — the test now asserts set-equality in both directions.**
2. A THROWN fetch (network failure) skipped the PIN clear and failed silently (matching the pre-existing issue/revoke pattern). **Disposition: fixed beyond the pre-existing pattern — PIN clear moved to `finally` (clears on every path) and a catch surfaces the failure as a persistent error note; new test pins both.**
3. `MandateStore.addGrants` refuses revoked but not EXPIRED mandates — protection on expired ones is by clamp-inheritance (the grant's effective expiry can never exceed the mandate's, so a grant signed into an expired mandate is born dead), not an explicit check; pre-existing behavior, not introduced here. **Disposition: noted here for the record; the UI additionally hides the form on expired mandates.**
