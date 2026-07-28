# Side-Effects Review — WS5.2 Step 6: census consumer re-routing (live credential re-pointing, dark)

**Version / slug:** `ws52-step6-census-rerouting`
**Date:** `2026-06-13`
**Author:** `Echo`
**Second-pass reviewer:** `4-adversarial-lens self-review (folded as named tests)`

## Summary of the change

Step 6 of live credential re-pointing (spec §2.2). Every place in the live code that today treats a
pool account's enrollment `configHome` as the LIVE location of its credential is re-routed through a
single new chokepoint, `CredentialLocationGate`, which reads the `CredentialLocationLedger` (Steps
1–5, merged). The gate is FLAG-GATED on the EXISTING `subscriptionPool.credentialRepointing.enabled`
(no new config flag → the dark-gate line-map is UNCHANGED), back-compat-on-unknown (a never-seeded /
UNKNOWN ledger falls back to today's enrollment-home behavior), and fail-open-loud (an UNKNOWN-mode
read returns the fallback + ONE HIGH attention, never throws into a hot path). Files touched:
`src/core/CredentialLocationGate.ts` (new), `src/core/QuotaPoller.ts` (census #1–#4),
`src/core/InUseAccountResolver.ts` (census #8, the E4a liar), `src/core/SessionManager.ts` (census
#5/#6 spawn placement), `src/monitoring/CredentialProvider.ts` (census #9 manager-level refusal gate),
`src/monitoring/AccountSwitcher.ts` (surfaces the #9 refusal cleanly),
`src/core/CredentialSwapExecutor.ts` (an `onSlotsChanged` commit hook for the #8 cache-bust),
`src/server/routes.ts` (census #10/#11 PATCH configHome → 409), `src/commands/server.ts` (the wiring
chain: ledger + gate + consumers + the process-shared refusal gate).

## Decision-point inventory

- `CredentialLocationGate.slotForAccount/tenantForSlot` — add — the single re-route chokepoint; flag-gated, back-compat-on-unknown, fail-open-loud.
- `QuotaPoller.accountForReads` — add — resolves each account's live slot for token read / 401-refresh / needs-reauth; email auto-patch SUPPRESSED while enabled.
- `InUseAccountResolver.resolve` — modify — when enabled + ledger-known, resolves the default badge from the ledger instead of a `claude auth status` re-probe; `bustCache()` added.
- `SessionManager.resolvePinnedSpawnHome` — add — a pinned account's spawn home resolves through the ledger; an explicit caller home (account-swap path) still wins.
- `writeCredentialsSerialized` refusal gate — add — a manager-level competing-writer refusal at the funnel chokepoint (not only the route).
- `PATCH /subscription-pool/:id` configHome — modify — refused 409 while enabled.
- `CredentialSwapExecutor.onSlotsChanged` — add — a best-effort commit hook that busts the in-use badge on a default-slot swap.

---

## 1. Over-block

The only block surfaces are: (a) the PATCH-409 on `configHome` — refuses ONLY when the flag is
enabled (always off while dark), and ONLY the `configHome` field (every other field still PATCHes);
(b) the manager-level competing-writer refusal — refuses ONLY when the flag is enabled AND the ledger
holds a tenant for the (canonicalized) slot. A legitimate switch to a slot the ledger does NOT own is
not refused. With the flag off (the shipped dark state) neither block fires: no over-block surface
exists in the shipped configuration.

---

## 2. Under-block

The competing-writer refusal keys on "the ledger holds a tenant for this canonical slot." If a writer
targets a slot the ledger has never recorded (a brand-new enrollment home not yet seeded), it is NOT
refused — but that slot is not repointing-owned, so writing it cannot clobber a ledger tenant; this is
correct back-compat, not an under-block. The refusal is at the SOLE manager funnel
(`writeCredentialsSerialized`), so a non-route caller cannot dodge it — the spec §2.7 "every item a
unique source dodge" is closed by construction.

---

## 3. Level-of-abstraction fit

`CredentialLocationGate` is a thin DETECTOR/router (sync in-memory ledger read + a flag check), not an
authority — it never decides policy, it answers "where does account X live now?" The single authority
in the change is the manager-level refusal, which is a deterministic ownership check (does the ledger
own this slot?) — the correct altitude per spec §2.7 (manager chokepoint, not a brittle route guard).
The gate FEEDS the existing consumers; it does not run parallel to them. The ledger (Step 2) is the
lower-level primitive the gate USES; nothing is re-implemented.

---

## 4. Signal vs authority compliance

**Reference:** docs/signal-vs-authority.md

- [x] No — the re-routing reads are SIGNAL (advisory location resolution feeding existing consumers);
      the two block surfaces (PATCH-409, competing-writer refusal) are deterministic OWNERSHIP checks
      over durable ledger state, not brittle heuristics — they have full structural context (the
      ledger is the single source of truth), so they are smart-gate-equivalent, not brittle detectors.

The gate reads never own block authority: an UNKNOWN-mode read fails OPEN (returns the enrollment
fallback + an attention item), so a corrupt ledger degrades to today's behavior, never blocks a poll
or a spawn.

---

## 5. Interactions

- **Shadowing:** the PATCH-409 runs BEFORE `subscriptionPool.update` in `/subscription-pool/:id` — when it fires the update never runs (intended; the field-edit must not land). Other fields are unaffected. The competing-writer refusal runs BEFORE the funnel lock in `writeCredentialsSerialized` — when it fires no lock is taken and no write occurs (intended, non-destructive).
- **Double-fire:** the swap-commit `onSlotsChanged` fires exactly once per committed swap; it is best-effort and a throwing consumer is swallowed (the commit is the load-bearing op and is never rolled back by a cache-bust failure — proven by a named test).
- **Races:** the gate reads are sync in-memory (no shared mutable state); the refusal gate reads the ledger's in-memory assignments (single-writer process). The InUseAccountResolver cache-bust is idempotent.
- **Feedback loops:** the email auto-patch SUPPRESSION removes a feedback loop that previously cross-contaminated pool emails after a swap (spec §2.2 #3) — a net REDUCTION in a feedback path.

---

## 6. External surfaces

- **Other agents on the same machine:** none — the ledger/gate are per-machine and read-only over the local ledger.
- **Install base:** none while dark (flag off → byte-identical behavior; proven by the E2E strict-no-op test + per-consumer flag-off unit tests).
- **External systems:** none — no new network calls; the gate is a pure in-memory read-router.
- **Persistent state:** reads the existing `state/credential-locations.json` (Step 2); writes nothing new (Step 6 is read re-routing + two refusal surfaces — neither adds a credential write; the `lint-no-unfunneled-credential-write` lint is clean).
- **Operator surface:** the PATCH-409 changes a `/subscription-pool/:id` response (409 with a plain-English message pointing at `POST /credentials/set-default`) ONLY when the flag is enabled. The AccountSwitcher refusal returns a `SwitchResult` with a plain-English message — phone-surfaced via the existing `/switch-account` Telegram command path. No new operator-only API action is introduced.

## 6b. Operator-surface quality

No operator surface (no dashboard renderer / approval page / grant form) is added or touched — the
dashboard Subscriptions-tab `/credentials/locations` fetch is census #11, which Step 7 owns per the
build plan §6/§7 sequencing. Not applicable to this step.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The reason it SHOULD differ per machine: each machine's
`CredentialLocationLedger` is the truth for ITS OWN slots (`SubscriptionPool` decision 1A —
per-machine enrollment = independent grant lineages). An N-machine pool has N independent ledgers and
this step adds NO cross-machine read. A swap on machine A never needs to bust machine B's in-use cache
(B's `~/.claude` is a different physical slot with a different credential). Degrades safely:
ledger-unknown on any machine → that machine shows today's (re-probed) badge / enrollment-home reads.
No user-facing notice is emitted by the re-routing (the only notice is the UNKNOWN-mode HIGH attention,
which is a per-machine local degradation surface — correct as machine-local). No durable cross-machine
state is created; no URLs are generated. (Phase C of the build prompt, answered explicitly.)

---

## Rollback

Pure dark-ship: the feature is gated on `subscriptionPool.credentialRepointing.enabled` (default
false). With the flag off — the only shipped state — every census consumer is byte-for-byte today's
behavior, the refusal gate refuses nothing, the PATCH-409 never fires. To roll back the code entirely,
revert this commit; nothing persists (no migration, no new state file — the ledger file predates this
step). No two-flag flip is part of this step.

## 4-adversarial-lens verdict

1. **E4a-liar resurrection (THE blocker) — PASS.** `InUseAccountResolver` does NOT re-probe `claude auth status` for the default badge when enabled + ledger-known; it reads `ledger.tenantOf('~/.claude')`. `bustCache()` clears the cache, fired at swap-commit by `onSlotsChanged` for any `~/.claude` swap. Named tests: "resolves from the ledger, NEVER re-probes auth status" (`probe` spy asserted `.not.toHaveBeenCalled()`) + "bustCache clears a cached probe result" + the E2E flag-on `probeCalls() === 0`.
2. **Competing-writer clobber — PASS.** The refusal lives at the MANAGER (`writeCredentialsSerialized`), before the funnel lock; a non-route caller inherits it. Named tests: "REFUSES at the manager when the slot is repointing-owned (no write occurs)" + AccountSwitcher "REFUSES the switch (no write) … active account unchanged."
3. **Hot-path safety — PASS.** A ledger UNKNOWN-mode read returns the enrollment fallback + ONE deduped HIGH attention, never throws. Named tests: "UNKNOWN mode → fallback + ONE deduped HIGH attention, never throws" + "a THROWING attention emitter never escapes the read."
4. **Dark-ship inertness — PASS.** Flag off → every consumer byte-for-byte today. Named tests: the per-consumer flag-OFF unit tests (every census row) + the E2E "FLAG OFF: the full wiring is alive AND strictly inert" (in-use re-probes, quota reads enrollment home, PATCH allowed).

## Test tiers

- Unit: `tests/unit/credential-location-gate.test.ts` (19), additions to `credential-swap-executor.test.ts` (#8 cache-bust + throw-safety), `interactive-session-pin.test.ts` (#6 spawn re-route ×3), `account-switcher-provider.test.ts` (#9 refusal ×2).
- Integration: `tests/integration/credential-repointing-census-routes.test.ts` (PATCH-409 live, flag-off 200, non-configHome field still PATCHes).
- E2E: `tests/e2e/credential-repointing-census-lifecycle.test.ts` (feature-alive: flag-off strict no-op end-to-end + flag-on ledger short-circuit).
