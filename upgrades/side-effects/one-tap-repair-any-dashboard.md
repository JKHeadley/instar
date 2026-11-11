# Side-Effects Review — one-tap repair setting works for every machine from any dashboard

**Version / slug:** `one-tap-repair-any-dashboard`
**Date:** `2026-11-10`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Operator rule (Justin, 2026-11-10 11:15 PST, topic 33890): "A user should be able to take ALL actions for an agent on the dashboard, regardless of which machine is serving/driving that dashboard". The console Accounts page's "Automatic sign-in repair" section could raise only the machine serving the dashboard to "repairs without asking"; any other machine that was off, watch-only or "asks you first" had no tick box and the target refused `owner-must-enable-here`. Now a PIN-unlocked operator on any machine's dashboard can switch any paired machine to "without asking" (and back) through the same `configure-pool` → signed single-use mandate → `configure-with-mandate` path. The authority for a remote raise is the operator's recent PIN unlock on the issuing dashboard, carried in the mandate's signed bytes (`author: 'dashboard-pin-operator'` + bound `operatorUnlock: 'dashboard-pin-session'`); the target refuses a raise without it (`403 operator-unlock-missing`). Files: `src/core/SubscriptionReloginRemoteConfigure.ts` (point-of-use rules), `src/coordination/AccountFollowMeMandateDelivery.ts` (`readConfigureBounds` reports the carried claim), `src/server/routes.ts` (issues the claim, passes it to the evaluation, fronting-side audit row), `src/core/SubscriptionReloginOperatorConfig.ts` (audit: `previousMode`, `operatorUnlock`; new `appendSubscriptionReloginIssueAudit`), `dashboard/console/auto-repair-model.js` + `accounts.js` (every readable row with accounts gets a tick box, the "only from that machine itself" text is gone, intro reworded, turning any machine on sends 0/0 waits), `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (agent-awareness bullet + idempotent rewording migration), spec amendment + ELI16, tests. Tier 2 (authorization surface). Size: 10 source/doc files plus 5 test files, roughly 250 changed lines. Effort: one build pass, no spec re-convergence rounds (amendment directed by the operator).

## Decision-point inventory

- `evaluateConfigureRequest` step 4 (target, remote "without asking") — modify — was "refuse unless already unattended"; now "refuse a raise unless the verified mandate carries the PIN unlock", plus the same 0/0-waits rule as a local raise.
- `readConfigureBounds` — modify — additionally reports `operatorUnlockCarried` (bound + author, both signed).
- Dashboard tick-box eligibility (`buildAutoRepair.canTurnOn`) — modify — any readable row with at least one verified account.
- Mandate verification, CAS, identity subset, closed config set, nonce single-use, expiry, delivery acceptance — pass-through, unchanged.

---

## 1. Over-block

A remote raise issued by a fronting machine still on an older Instar (no carried claim) is refused `operator-unlock-missing`. That is intended: such a mandate was never issued under the new authority. The card says the tapping machine needs an update. List refreshes from older fronting machines keep working. No other legitimate input is newly rejected.

---

## 2. Under-block

The carried claim is as strong as the fronting route's `verifyDashboardOperatorSession` and the issuing machine's identity key; an agent that holds its own PIN or its own machine key could mint one. That is the same foundation every PIN-gated relogin route rests on (spec "Honest scope of the authority"); this change neither strengthens nor weakens it. What a rogue signer can achieve stays bounded on the target: only that machine's own verified emails, only live unattended/approval, no waits on a raise, CAS on the revision, single use, 15-minute expiry, audit line.

---

## 3. Level-of-abstraction fit

Right layer. The authority decision stays at the target's point of use (`evaluateConfigureRequest`), fed by the signature-verified mandate; the dashboard only decides which rows to offer. No new parallel gate.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no brittle block/allow surface.

The refusals are authenticity and exact-match checks on authority the operator just granted (signature-covered fields, revision equality, set membership), not heuristic detectors. The change removes a block rather than adding one; the one new refusal (`operator-unlock-missing`) is an exact check that the authority is present.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is the operator's unlock carried in this signed mandate?" is an enumerable invariant (present and exact, or not).

---

## 5. Interactions

- **Shadowing:** the mandate checks (signature, expiry, consumed, target, digest) still run first in `configure-with-mandate`; the new claim is evaluated after them, inside the same synchronous block, before consume. A refused raise leaves the mandate unconsumed but it is bound to one exact config and expires in 15 minutes.
- **Double-fire:** none; one mandate per target per tap, as before.
- **Races:** unchanged; CAS on `expectedRevision` within one synchronous read-compare-write block.
- **Feedback loops:** a raise writes a restart request (supervised restart), as a local raise always did.
- Delivery acceptance (`acceptMandateDelivery`) ignores the extra bound; older targets ignore it too (`readConfigureBounds` reads only the fields it knows) and keep refusing raises with `owner-must-enable-here`, which the card now reads as "needs an Instar update".

---

## 6. External surfaces

- Other machines of the same agent: can now be switched to "without asking" from any dashboard after the operator deliberately ticks their row. Rows not already unattended start unticked.
- Install base: the dashboard section and the CLAUDE.md bullet change wording; the migration rewords the installed bullet idempotently.
- Persistent state: the target's audit line gains `previousMode` and `operatorUnlock`; the fronting machine appends `operator-configure-issued` lines to its own `logs/subscription-relogin-config.jsonl`.
- Operator surface: the action is phone-completable from whichever dashboard is open (that is the point of the change).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes: the section's rows and tick boxes come first; "Turn on for ticked machines" is the primary button, unchanged.
2. **Zero raw internals as primary content?** Yes: machine names via `verifiedDisplayName`, no ids; result codes map to plain sentences (two new ones for mixed versions).
3. **Destructive actions de-emphasized?** Unchanged: "Switch back to asking first" stays secondary; nothing here disables repair.
4. **Plain language + phone width?** The intro now reads "You can switch any of this agent's machines on or back to asking first from this page, whichever machine is showing it." No layout change; rows that previously showed an empty tick column now show a checkbox in the same column.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read for the read (`GET /subscription-relogin?scope=pool`, unchanged) and fan-out write with one signed, exact, single-use mandate per target. Each machine's repair setting stays in its own config (machine-local by design: it governs re-minting login slots and browser profiles that exist only on that machine). This change is what makes the write surface symmetric across machines: every dashboard can now take the same actions for every paired machine. No notices; no URLs generated; no durable state that strands on topic transfer. Status surfaces: none changed.

---

## 8. Rollback cost

Pure code revert. Machines already switched keep the setting the operator chose and can be switched back to "asks you first" from any dashboard. Audit lines with the extra fields are ignored by older code. The reworded CLAUDE.md bullet stays reworded after a revert (harmless; describes the newer behaviour) until the next migration rewrites it.

---

## Conclusion

The change removes a restriction the operator ruled to be an Instar failure, and replaces "the target's current mode" as the gate for a remote raise with an explicit, signed carry of the operator's PIN unlock, keeping every other target-side check. Clear to ship after second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

The remote raise is gated on `operatorUnlock` + `author`, both inside `canonicalMandate`'s R4a-signed bytes, and every other target check (signature, revoked/expiry, target binding, digest, closed set, own-pool identity subset, CAS, single-use consume after evaluation) still runs before any write. Mixed versions fail closed. Non-blocking notes:

- The carried claim is the issuing machine asserting itself, not a cryptographic proof of a PIN. Any ACTIVE paired machine's key can now raise a peer (`authorizeMandateDeliver` admits configure-only mandates from any active machine whatever its feature state). Also, the PIN-gated `/mandate/issue` accepts any `author` and any bounds, so it can mint a configure mandate that carries the claim, though no route delivers such a mandate today. Recommendation: have `/mandate/issue` refuse the reserved `subscription-relogin-configure` action and the `dashboard-pin-operator` author, so only `configure-pool` can produce the claim.
- A remote raise sets `enabled: true` on a machine whose repair was deliberately off and drops any waits it had while it was "asks first". That is intended and the same as a local raise, but the row only says "removes the wait". It should also say it turns repair on for a machine where it is off.
- On the `finish-restart` path (old code, not changed here), `consume()` runs before the `stale-config` check, so a stale refusal burns the mandate. This is harmless (the tap is re-issued), but the order is the reverse of the configure path.
- Minor issues: the fronting audit hardcodes `'dashboard-pin-session'` instead of `SUBSCRIPTION_RELOGIN_OPERATOR_UNLOCK`. Peers that timed out are audited as `outcome-unknown` even if they apply later. `buildConfig`'s `isSelf` parameter is unused. The new-dashboard text for `operator-unlock-missing` cannot be reached in practice, because the dashboard and its fronting server always ship together.
- Verified: the 4 unit test files pass (30 tests) and `tsc --noEmit` is clean. The reviewer did not run the integration file (the runner did not pick it up).

A second independent reviewer, run separately, also concurred and raised the same non-blocking notes.

**Resolution of the notes (before commit):** `POST /mandate/issue` now refuses the `subscription-relogin-configure` action and the `dashboard-pin-operator` author (400), so only `configure-pool` can produce the claim (test: `tests/integration/mandate-routes.test.ts`). The row for an off or watch-only machine now says turning it on switches repair on there. The fronting audit uses the shared `SUBSCRIPTION_RELOGIN_OPERATOR_UNLOCK` constant. The audit row for a peer that timed out says `outcome-unknown`, which is accurate: the target's own audit line is the record of what applied. The `finish-restart` consume order is old behaviour this change does not touch, and it is harmless.

---

## Evidence pointers

- `tests/unit/subscription-relogin-remote-configure.test.ts` — raise with carried unlock from approval/observe/off succeeds; without it refused `operator-unlock-missing`; raise sets no waits, refuses foreign identity, unreadable pool, stale revision.
- `tests/unit/configure-mandate-delivery.test.ts` — the claim is read only when both the signed bound and the author match.
- `tests/integration/subscription-relogin-configure-pool.test.ts` — real HTTP + Ed25519: peer off/observe/approval raised via configure-pool with audit on both sides; a signed mandate without the unlock refused; an expired mandate refused; a used mandate refused on replay.
- `tests/unit/console-auto-repair-model.test.ts` — every readable row tickable, no "only from that machine itself" text, 0/0 for any raise.
- `tests/unit/PostUpdateMigrator-oneTapAnyDashboard.test.ts` — the migration rewords the old bullet once and is idempotent.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
