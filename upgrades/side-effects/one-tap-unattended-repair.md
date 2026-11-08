# Side-Effects Review — One tap turns on automatic sign-in repair

**Version / slug:** `one-tap-unattended-repair`
**Date:** `2026-11-08`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (cross-machine operator authority over a credential-repair setting). Adds an "Automatic sign-in repair" section to the console Accounts page and two routes: `POST /subscription-relogin/configure-pool` (fronting, recent dashboard unlock only) and `POST /subscription-relogin/configure-with-mandate` (target point of use, Bearer + a delivered single-use mandate). `GET /subscription-relogin` now carries each machine's closed repair setting (`config`, merged as `pool.configs` with `configsMissing`). The delivery gates (`authorizeMandateDeliver` in server.ts/MeshRpc, `acceptMandateDelivery`) admit one new mandate shape, configure-only. `applySubscriptionReloginOperatorConfig` now bumps a `generation` counter, records provenance, and writes an UNVERSIONED restart request (the old update-shaped request could be skipped by the supervisor's per-version cap; this also fixes the existing configure route). Files: `src/core/SubscriptionReloginOperatorConfig.ts`, `src/core/SubscriptionReloginRemoteConfigure.ts` (new, pure rules), `src/coordination/AccountFollowMeMandateDelivery.ts`, `src/core/MeshRpc.ts`, `src/commands/server.ts`, `src/server/routes.ts`, `src/core/types.ts`, `dashboard/console/accounts.js`, `dashboard/console/auto-repair-model.js` (new), `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, `src/data/state-coherence-registry.json`. Effort: 6 spec review rounds (the Tier-2 cap), proportionate to the authority involved; findings were 14, 7, 5, 8, 4, 5, and round 6 cut machinery (a consent flag) instead of adding more.

## Decision-point inventory

- Fronting guard (`configure-pool`) — add — session header only, the same bar as the existing `configure`; no PIN-in-body fallback.
- Target acceptance (`configure-with-mandate`) — add — R4a signature, target, digest, expiry, single use; then the closed set, owner-consent mode check, identity subset, compare-and-set.
- Mesh coarse gate `authorizeMandateDeliver` — modify — the sender must be an active registered machine first; a configure-only mandate then passes regardless of follow-me state. The follow-me path is unchanged.
- `acceptMandateDelivery` — modify — shape check first; configure-only is accepted for this machine with a well-formed digest; mixed authorities are refused; the follow-me path is byte-for-byte the same.

---

## 1. Over-block

- A machine set to "asks you first", watching only, or off cannot be switched to "without asking" from another machine (`owner-must-enable-here`). This is deliberate; the row says to do it on that machine.
- A remote tap cannot change a machine's waits (`invalid-config`). Deliberate.
- A pool email with a dotless domain is not offered, because the configure validator would refuse it.
- A request read at an older revision is refused `stale-config`, even if the intervening change was unrelated. The page re-reads and the operator taps again.

## 2. Under-block

- The PIN is a human-presence signal, not a lock against the agent: an agent can read it from its secret store, and a peer machine's identity key is a file on that machine. Bounded, not closed: a forged mandate can only refresh an already-unattended machine's list within its own accounts, or switch it back to asking first. Filed as fb-ae274b03-db6, together with the PIN-in-body fallback on the existing relogin routes and the `author: 'justin'` defaults.
- Compare-and-set is atomic only within the server process. A hand edit or a CLI write outside the process shows as a new revision on the next read.
- If `generation` is removed by hand it reads as 0; the 15-minute mandate expiry is then the bound on an old mandate.

## 3. Level-of-abstraction fit

The authority stays where it already lived: the dashboard unlock on the fronting machine, and the existing signed-mandate path (repair-cell) for crossing machines. The new rules are a pure module (`SubscriptionReloginRemoteConfigure.ts`) consumed by the routes; the dashboard model is pure and unit-tested. No parallel gate is introduced.

## 4. Signal vs authority compliance

Every new refusal is an authenticity, exact-match, closed-set or ordering check on authority the operator just granted. No heuristic detector holds blocking authority. Compliant with docs/signal-vs-authority.md.

## 4b. Judgment-point check

There is no competing-signals decision point. Which machines change is the operator's own choice (ticks); defaults preserve current state.

## 5. Interactions

- Repair-cell mandates share the delivered-mandate store and the mesh verb. The follow-me consumer sweep filters to `account-follow-me` authorities, so configure mandates are invisible to it. `readFollowMeBounds` returns null for configure mandates, so they cannot be replayed at `approve-with-mandate`.
- Restart: an unversioned request never overwrites a pending versioned (update) request; that update restart applies the setting too.
- The existing `configure` route now writes `generation` and an unversioned restart. Its tests expect `requestedBy` and `plannedRestart`, and both still hold.

## 6. External surfaces

- A new section on the console Accounts page, plus `config` added to the `GET /subscription-relogin` body (also on its 503). Existing consumers ignore unknown fields, and the 503 status is unchanged.
- A new mesh mandate shape. Older peers refuse it, and the card shows "may need an Instar update".
- CLAUDE.md template: one new bullet and one reworded sentence, with a content-sniffed migration.

## 6b. Operator-surface quality

- **First screen:** the section sits on the Accounts page after the needs-you cards. Each row leads with the machine name and its state in plain words.
- **Mobile:** it reuses the page's rows, the sheets and `askPin({ adapter: 'session' })`, all of which already work on a phone.
- **Every warning has a path:** "Couldn't read" offers "Try again" (a re-render). "Needs an update" points to that machine. "Turn this on from that machine's own dashboard" is explicit. "Finish restarting" recovers a missing restart.
- **Preview matches the write:** the accounts listed are exactly the identities sent, with removals marked. Waits are shown, and so is the plain warning for machines never repaired before.
- **F9:** ticks are kept across the 30-second re-render, with `data-interaction-open` set while they differ from the defaults.

## 7. Multi-machine posture

- Read: proxied through the existing `GET /subscription-relogin?scope=pool` fan-out, with no extra poll.
- Write: fan-out from the fronting machine. Each target gets one signed, exact, ordered, single-use authority.
- Each machine's setting is machine-local by design (physical-credential-locality, which the posture lint accepts): it governs that disk's login slots. Delivered mandates are machine-local (single-use, consumed where addressed).
- No user-facing notices, so one-voice gating does not apply. No generated URLs cross machines.
- **Status surfaces:** `GET /subscription-relogin` (`config`, `pool.configs`, `pool.configsMissing`).

## 8. Rollback cost

Revert the PR. Machines already switched keep the operator's chosen config, reversible on each machine. Stored configure mandates are ignored by the reverted code. The leftover `generation` key is ignored by the old reader. No data migration.

## Conclusion

Ship. The remaining risk (the PIN is not a lock against the agent; peer keys are readable files) is a foundation property filed separately, and this change bounds rather than widens it.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (claude-opus-5-5), read the artifact, spec and code
**Independent read of the artifact: concern → resolved, then concur**

Concern raised: on the operator's own machine, when it was already "without asking" with non-zero
waits, a "Turn on" tap forced the waits to 0/0 while the row said they would remain.

Resolution: a tap on this machine when it is already unattended now keeps its waits and only
refreshes the list. The rule is the same as for a remote tap, and is enforced in
`evaluateConfigureRequest` and in `configurePayload`; the server no longer forces 0/0. New tests:
`subscription-relogin-remote-configure` ("this machine already without asking: a tap keeps its
waits") and `console-auto-repair-model` ("…keeps its waits in the request").

The reviewer verified every other claim against the code: the order of checks at the target, the
closed set, the owner-consent reading, both delivery gates, the header-only fronting route, no
reuse at the follow-me consumers, and signal-vs-authority. Minor notes:
- The two routes are now listed in CapabilityIndex.
- "Finish restarting" consumes before the revision check, as the spec says.
- A refused configure mandate stays usable until expiry, but it can only ever apply the exact
  authorized list.
- An older machine with follow-me off may show "Couldn't reach" rather than "may need an update".
- `acceptDeliveredMandateCommand`'s `reloginEnabled` reads a missing `dryRun` as live. The
  configure path does not depend on that line, and it is left unchanged.

## Evidence pointers

- `tests/unit/subscription-relogin-operator-config.test.ts`: runtime-exact mode reading, effective minimums, revision vs. order and generation, digest binding, apply provenance plus unversioned restart, never overwriting an update restart, activation-pending re-queue.
- `tests/unit/subscription-relogin-remote-configure.test.ts`: every boundary of the point-of-use rules, including A→B→A.
- `tests/unit/console-auto-repair-model.test.ts`: ticks, removals, waits, unreadable rows, exact request, result words, confirmation.
- `tests/integration/subscription-relogin-configure-pool.test.ts`: two real routers with real Ed25519 signatures and a real delivered-mandate store, with follow-me and repair off on the target.
- `tests/e2e/subscription-relogin-one-tap-lifecycle.test.ts`: the production AgentServer path.

## Follow-up after the first Local Verify run (2026-11-08)

Two standing ratchets that landed on main in the meantime flagged the new routes. Both are fixed:
- `storage-error-response-ratchet`: the `apply-failed` detail now goes through `operatorError(error, stateDir)`, which names storage failures plainly.
- `pool-rope-health-feedback`: the peer apply call now goes through `poolPeerFetch` (connection health recorded, credential-safe URL admission) instead of a bare fetch.

There is no behaviour change otherwise. The unit ratchets and the integration test pass.
