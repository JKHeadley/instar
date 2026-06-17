# Side-Effects Review — WS5.2 Account Follow-Me, R12 revocation data-plane WIRING

**Version / slug:** `ws52-account-follow-me-revocation-wiring`
**Date:** `2026-06-17`
**Author:** Echo (autonomous)
**Second-pass reviewer:** pending (high-risk: credentials, destructive local wipe, revocation honesty)
**Spec:** `docs/specs/ws52-account-follow-me-security.md` — R12 (revocation), OQ6 (per-server model), gap 9 (offline give-up deadline)
**Status:** wiring built + tested (46 tests across unit/wiring/Tier-2; tsc clean). This PR makes the already-merged PURE executor (`AccountFollowMeRevocation`) FUNCTIONAL by constructing it in the server with real deps, firing it from `/mandate/:id/revoke`, scheduling its deadline sweep, and adding the config default + migration.

## Summary of the change

The pure executor (`src/core/AccountFollowMeRevocation.ts`) was merged but nothing called it. This PR is the server-shell wiring, implemented per the spec's PER-SERVER model (OQ6): the operator revokes the `account-follow-me` mandate on the TARGET machine's OWN dashboard, so the target runs its OWN local revocation — LOCAL, never a cross-machine wipe-instruction.

Files added (logic + tests, dark behind `multiMachine.accountFollowMe`):
- `src/core/accountFollowMeCooperativeWipe.ts` — `buildCooperativeWipe(deps)` builds the REAL synchronous three-step local wipe (framework logout against the account's `CLAUDE_CONFIG_DIR` + delete the per-account config-home dir via SafeFsExecutor + `SubscriptionPool.remove`), fail-closed per step. Side-effecting primitives (logout, slot delete) are injected seams so it is unit-testable without spawning a CLI.
- `src/core/AccountFollowMeRevocationStore.ts` — `DurablePendingWipeStore`, a crash-safe JSON ledger under the state dir (SafeFsExecutor atomic write) implementing the executor's `PendingWipeStore` seam. NOT in-memory.
- `tests/unit/account-followme-revocation-wiring.test.ts` (10) — cooperative-wipe + durable store + composed end-to-end.
- `tests/unit/account-followme-revocation-server-wiring.test.ts` (17) — source-touchpoint integrity + migration unit.
- `tests/integration/account-followme-revocation-route.test.ts` (4) — Tier-2 route trigger + dark no-op.

Files modified (shared/sensitive — flagged for careful review):
- `src/commands/server.ts` — construct `AccountFollowMeRevocation` with real deps; schedule the deadline sweep timer (unref'd); thread into `AgentServer`.
- `src/server/routes.ts` — RouteContext member; `/mandate/:id/revoke` detects an `account-follow-me` authority and fires `revoke(...)` with `cooperative-online` posture; surfaces the honest outcome on the response.
- `src/server/AgentServer.ts` — options member + RouteContext threading.
- `src/config/ConfigDefaults.ts` — `multiMachine.accountFollowMe.revocationReconnectDeadlineMs` default (6h).
- `src/core/PostUpdateMigrator.ts` — `migrateConfigAccountFollowMeRevocationDeadline` (existence-checked, idempotent) + dispatch.

## Decision-point inventory

- `/mandate/:id/revoke` route — **modified** — after the existing PIN-gated control-plane revoke succeeds, if the revoked mandate carried an `account-follow-me` authority, fire the LOCAL data-plane wipe. Non-account-follow-me mandates are byte-for-byte unaffected.
- `buildCooperativeWipe(...)` — **add** — the real wipe; deny-by-default for "done" (every step fail-closed to false on throw).
- deadline sweep timer (server.ts) — **add** — drives `sweepDeadlines()` on a 5-min cadence; strict no-op while dark.

---

## 1. Over-block

Not a block/allow gate. The closest surface is the cooperative-wipe fail-closed path: a partial/throwing wipe is reported `revocation-pending` (never `removed`), which can later escalate to `revocation-failed` ("rotate at provider") for a wipe that partially succeeded. SAFE direction — the worst outcome is the operator is told to rotate when they technically needn't have. We never claim `removed` we can't fully confirm.

## 2. Under-block

The per-server trigger only runs the LOCAL wipe (`cooperative-online` posture) — by design (OQ6). A de-paired/offline holder is reached on the cross-machine path, which the per-server model does not use; this is the honest scope. The remaining real-world gap is operator inaction after a `revocation-failed` item — outside any code's reach, which is why the item is HIGH priority.

## 3. Level-of-abstraction fit

Correct layer. The route is the trigger point (mirrors how PR2's scan route / EnrollmentWizard were wired); the wipe + durable store are injectable-deps modules (mirrors the executor's own style). The executor owns NO authority — the control-plane revoke stays with the PIN-gated MandateGate; this wiring consumes that decision and runs the side effects. `SubscriptionPool.remove` and the framework logout are reused, not re-implemented.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No NEW block/allow authority. The wiring runs the data-plane effect of a decision the existing PIN-gated MandateGate already made; the only gate honored is the executor's own `enabled()` dark-flag (no-op when off). The route's existing `checkMandatePin` authority is unchanged.

Every uncertain path FAILS CLOSED toward "rotate at provider", never toward a false "removed". The trigger is wrapped so a data-plane error can never break the control-plane revoke that already succeeded.

## 5. Interactions

- **Shadowing:** none — first consumer of the executor.
- **Double-fire:** the durable store is keyed `${accountId}::${targetMachineId}`; a re-revoke or reconnect+sweep race cannot double-escalate the same pair (sweep removes on escalation; success removes on `removed`). Re-running `revoke` for the same pair upserts, never duplicates.
- **Races:** reconnect vs sweep — whichever runs first wins, both orderings honest (covered by the executor's merged tests). The new durable store preserves the in-memory upsert/remove semantics.
- **Feedback loops:** none — the sweep only removes records + emits attention items.

## 6. External surfaces

- **Other agents / mesh:** none — per the per-server model this trigger has NO mesh egress. It runs the framework logout + slot delete on the LOCAL target only.
- **Persistent state:** a new durable pending-wipe ledger (`account-follow-me-revocation-pending.json` under the state dir). Records are small and credential-free (account id, machine id, mandate id, provider name, operator email, nickname, two timestamps). PII note: operator email + machine nickname land at-rest, same posture as the §6.1a meta projection (email "never a secret"); no credential field exists in the shape. **Destructive local effect:** the wipe deletes the per-account `CLAUDE_CONFIG_DIR` (via SafeFsExecutor — audited, source-tree-guarded) and the keychain credential entry. This is the intended revocation effect and runs ONLY for a revoked account-follow-me mandate while the feature is enabled.
- **Operator surface (Mobile-Complete):** the control-plane revoke is the existing PIN-gated Mandates-tab control (already phone-complete). The new operator-facing output is the HIGH `RevocationFailedAttention` item via the existing attention-queue path. No new operator UI primitive; no API-only operator action.
- **External systems:** the honest end-state points the operator at the provider; it calls no provider API.

## 6b. Operator-surface quality

No operator-surface markup file (`dashboard/*.js`, `*.html`, approval/grant/secret-drop form) is touched by THIS PR. The dashboard `revocation-pending` / `revocation-failed` render is a tracked follow-on increment and will carry its own 6b review. Not applicable to this commit.

## 7. Multi-machine posture

Per-server: each machine revokes its OWN local account when its operator revokes the mandate on its OWN dashboard. Single-machine / flag-off is a strict no-op — the route trigger does nothing for a non-follow-me mandate and the sweep returns []. No cross-machine transport is introduced (and none was required — the per-server model is cleanly local). See "Could NOT wire" below for what the per-server model deliberately does NOT cover.

## 8. Rollback cost

Low. The feature is dark behind `multiMachine.accountFollowMe` (live-on-dev / dark-fleet). Disabling the flag makes `revoke()` a no-op and the sweep inert immediately (read live, no restart). The durable ledger is a single small JSON file; deleting it loses only pending-wipe bookkeeping (honest end-state then defaults to provider-rotation). The route trigger is additive and wrapped — reverting it restores the prior revoke behavior exactly. No schema migration beyond an existence-checked config default.

## What could NOT be fully wired (honest)

- **Offline / de-paired / hostile posture from the route trigger.** In the per-server model the operator revokes on the TARGET's own dashboard, so the target is online & cooperative by construction; the route always passes `cooperative-online`. The executor's `offline` / `revoked` branches (durable pending, provider-rotation instruction) are fully built and unit-tested but are reached by the CROSS-MACHINE revoke path, which does not exist (and is not part of the per-server model). They remain dormant-but-correct — a future cross-machine revoke increment would supply the computed posture. This is the clean-local boundary the prompt called for: I wired what IS local and did not stub the cross-machine path.
- **`onTargetReconnect` trigger.** The reconnect-fires-pending-wipe hook is built + tested in the executor but has no caller in the per-server model (a reconnecting machine revokes its own local account on its own dashboard, not via a peer's pending record). Left unwired deliberately — it belongs to the cross-machine increment.
- **Dashboard `revocation-pending` / `revocation-failed` render** — tracked follow-on (6b above).

## Second-pass review

**Independent reviewer (2026-06-17) — found ONE BLOCKING issue; FIXED + re-reviewed → CONCUR.**

The reviewer confirmed: `removed` is reachable only after a fully-successful local wipe; the trigger fires only for an `account-follow-me` mandate and a wipe error never breaks the already-succeeded control-plane revoke; dark = strict no-op (`enabled()` read live, not cached); the durable store holds no token material; the sweep timer is gated + unref'd + try/caught; the migration is idempotent + existence-checked.

**BLOCKING finding (now fixed):** `defaultDeleteSlot` did a `recursive,force` rm of the operator-provided `configHome` with NO guard — and `~/.claude` (the operator's PRIMARY/shared login) is a legitimate `configHome` value, so an `account-follow-me` revoke targeting the default account would have recursively deleted the operator's main login directory (worst case: `$HOME`/root). **Fix:** added an exported `isProtectedConfigHome()` guard that refuses (→ `slotDeleted:false` → durable pending, never a false `removed`) any deletion target resolving to a filesystem root, `$HOME` itself, an ANCESTOR of `$HOME`, or a framework DEFAULT config home (`~/.claude`/`.codex`/`.gemini`/`.pi`/`.config`), or an empty/whitespace path (which would otherwise `path.resolve('')`→cwd). The guard runs BEFORE any `safeRmSync`, is case-folded (macOS/Windows case-insensitive volumes: `~/.CLAUDE` ≡ `~/.claude`), and traversal-safe (`~/.claude/../.claude`, trailing slashes collapse to the canonical protected path). A re-review of the fix found NO bypass across an adversarial spelling battery and CONCURRED. A genuine per-account slot (`~/.claude-adriana`, `~/.instar/accounts/<id>`, tmpdir paths) is NOT matched and deletes normally. Covered by 3 new both-sides tests in `account-followme-revocation-wiring.test.ts`.

## Evidence pointers

- `npx tsc --noEmit` clean.
- 46 tests green: `account-followme-revocation-wiring` (10), `account-followme-revocation-server-wiring` (17), `account-followme-revocation-route` (4 — Tier-2 + dark no-op), plus the merged executor's 15. The existing `ws52-account-follow-me-wiring` (12) + `mandate-routes` (15) still pass (no regression).
- Tier-2 live-pipeline evidence: revoking an account-follow-me mandate over the real route returns `accountFollowMeRevocation.state === 'removed'` AND `pool.get('acct-x') === null` (the real data-plane effect); a non-follow-me revoke carries no revocation payload and leaves the account intact; flag-off returns `reason: 'feature-disabled'` with the account untouched.

## CI-green follow-up (same PR)

The `cooperativeWipe` fail-closed catches are tagged `@silent-fallback-ok` (each surfaces its failure through the function's return value → the executor keeps a durable pending, never a false `removed`), keeping the `no-silent-fallbacks` ratchet at baseline 476. The `revocationReconnectDeadlineMs` ConfigDefaults insertion shifted the `lint-dev-agent-dark-gate` hand-authored golden map by +4 lines for every `enabled:` entry below it (7 entries); the map was updated by hand to match. No behavior change — comment tags + a test line-number map.
