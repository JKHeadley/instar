# WS5.2 Step 6 — census consumer re-routing (the live ledger read-path wiring for credential re-pointing)

<!-- bump: patch -->

<!--
  NOTE: dark/additive + internal. A new exported class src/core/CredentialLocationGate.ts
  re-routes the spec §2.2 consumer census through the merged CredentialLocationLedger,
  gated by the EXISTING subscriptionPool.credentialRepointing flag (enabled:false +
  dryRun:true, already a DARK_GATE_EXCLUSIONS destructive entry) — NO new config flag, so
  the dark-gate line-map is UNCHANGED (no recompute; lint clean, dark-gate test green
  as-is). No new credential write path (Step 6 is read re-routing + two ownership-refusal
  surfaces); lint-no-unfunneled-credential-write clean. Routes/audit-scrub are Step 7.
-->

## What Changed

Wires the merged credential-location ledger into the live read paths (spec §2.2 — the 12-row consumer census). Every place that today treats a subscription account's enrollment config home as the live LOCATION of its credential now resolves through one chokepoint, the new `CredentialLocationGate`, when the feature is enabled — so once a credential is moved between homes, a poll/spawn/badge reads the home the credential ACTUALLY lives in now, instead of being silently invalidated.

- **One re-route chokepoint** — `CredentialLocationGate` (src/core/CredentialLocationGate.ts) reads the ledger via sync in-memory `slotForAccount`/`tenantForSlot`. Flag-gated: with the feature OFF (the only shipped state) every read returns today's enrollment-home value. Back-compat: a never-seeded ledger ALSO returns today's value. Fail-open-loud: an UNKNOWN-mode (corrupt) ledger returns the fallback AND raises ONE HIGH attention item — it never throws into a poll or spawn.
- **QuotaPoller (census #1–#4)** — the per-account token read, the 401-refresh exchange, and the needs-reauth attribution all target the account's LIVE slot; the email auto-patch is SUPPRESSED while enabled (it would otherwise cross-contaminate pool emails after a move).
- **Spawn placement (census #5/#6)** — a pinned pool account's session launches under its CURRENT slot, not its stale enrollment home. An explicit caller-supplied home (the account-swap path) still wins unchanged.
- **In-use badge (census #8, the lying-oracle fix)** — the dashboard "which account am I on" badge reads the ledger's default-home tenant instead of re-probing the client status command, which lags during the post-move window and would re-cache the wrong account. The badge cache is busted the moment a default-home move commits.
- **Competing-writer refusal (census #9)** — a manual account switch / auto-migrate that would write a moved home is refused at the MANAGER (the single credential-write funnel), not just on a route, with a plain-English message pointing at the correct replacement. The refusal is non-destructive — nothing is written.
- **Config-home edit lock (census #10/#11)** — editing an account's config-home field via the pool API is refused (409) while enabled — that field is enrollment metadata, not the live location.
- **Dark** — gated by the existing `subscriptionPool.credentialRepointing` flag (`enabled:false`). With the feature off (the fleet + dev default) every consumer is byte-for-byte today's behavior; the refusal surfaces refuse nothing; the config-home lock never fires.

The HTTP routes and the audit-scrub chokepoint that expose this to the operator are Step 7 (a later increment).

## What to Tell Your User

This is internal plumbing that ships turned off, so day to day nothing changes for you. What it builds toward: when I hold more than one of your subscription accounts and move a credential between them under the hood, all the parts of me that read your accounts now agree on where each one actually lives — the quota poller checks the right account, a new session launches on the right account, the dashboard badge shows the right account, and a stale background process can no longer silently overwrite a moved account and resurrect an old one. Before this, those readers each trusted a separate, easily-outdated note about where an account lived, so a move could quietly make them disagree. It is off by default and does nothing until it is deliberately turned on after a review window. If something does go wrong while it is on, it fails toward today's behavior and tells me loudly, rather than guessing.

## Summary of New Capabilities

New exported `CredentialLocationGate` (src/core/CredentialLocationGate.ts) — the spec §2.2 census re-routing chokepoint of live credential re-pointing. Gated by the existing `subscriptionPool.credentialRepointing` flag; no new config flag, no new HTTP route (routes are Step 7). Re-routes QuotaPoller, SessionManager spawn placement, InUseAccountResolver, the credential-write funnel (manager-level competing-writer refusal), and the pool config-home PATCH through the merged Step 2 location ledger.

## Evidence

- `tests/unit/credential-location-gate.test.ts` (19) — the gate (flag-off/on-known/on-unknown, fail-open-loud, dedup attention, throwing-emitter safety); QuotaPoller census #1/#2 slot re-route + #3 email-suppress (both sides); InUseAccountResolver census #8 (E4a-liar: never re-probes when enabled, ledger-known short-circuit, never-seeded fall-through, bustCache); competing-writer refusal #9 (manager refuse + non-owned write-through + no-gate inertness).
- `tests/unit/credential-swap-executor.test.ts` (+2) — census #8 `onSlotsChanged` fires at commit with both swapped slots; a throwing cache-bust never rolls back the committed swap.
- `tests/unit/interactive-session-pin.test.ts` (+3) — census #6 spawn re-route (flag-on-known → live slot; flag-off → enrollment home; never-seeded → enrollment home).
- `tests/unit/account-switcher-provider.test.ts` (+2) — census #9 AccountSwitcher manager-refusal (refused switch, no write, active account unchanged) + no-gate proceeds.
- `tests/integration/credential-repointing-census-routes.test.ts` (3) — PATCH config-home → 409 when enabled, 200 when off, non-config-home field still PATCHes when enabled.
- `tests/e2e/credential-repointing-census-lifecycle.test.ts` (2) — feature-alive: flag-OFF strict no-op end-to-end (badge re-probes, poll reads enrollment home, PATCH allowed) + flag-ON ledger short-circuit (badge no re-probe, PATCH 409).
- tsc clean; full `npm run lint` clean; dark-gate unchanged (no ConfigDefaults touched); docs-coverage green.
