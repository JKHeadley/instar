# Side-Effects Review — `google-passkey` login method (Increment 4)

**Version / slug:** `passkey-inc4-login-method`
**Date:** `2026-09-22`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (admission policy + login-method plumbing for credential-bearing repairs)`

## Summary of the change

Increment 4 of the approved spec `docs/specs/agent-held-google-passkey.md` (§3.4 "Login method
`google-passkey` and the code it touches", plus the §6 CLAUDE.md parity item and the §3.4 rollback
lever). It teaches every layer of the assisted re-login path that a `google-passkey` method exists,
without enabling it anywhere:

- **`PlaywrightProfileRegistry`** — `PlaywrightLoginMethod` gains `'google-passkey'`; `vaultBindings`
  gains a `passkey` role holding the machine-local passkey STORE entry key (never a vault name, never
  material); the method and the binding are one thing (neither without the other, 400); the binding is
  validated through an injected `passkeyEntryExists` predicate (null ⇒ fail closed 409; NOT injected ⇒
  refused 409 — so on this build no route can assign the method at all); the registry records the
  method a passkey assignment REPLACED as `priorLoginMethod` (derived, never caller-supplied; kept
  across a passkey re-assign; an `unknown` prior is not recorded); `revertLoginMethod()` restores it and
  drops the binding; `listPasskeyAccounts()` enumerates the method's accounts. The passkey key is excluded
  from vault-ref presence and dangling-ref checks.
- **`SubscriptionReloginPolicy`** — `SUPPORTED_LOGIN_METHODS` gains `google-passkey`; the profile input
  gains `passkeyEntryKey` + `passkeyCell` (a closed `PasskeyCellAdmissionState`); a passkey account is
  admitted ONLY when the cell is `ready` — every other state (and an uncomputed one) refuses by NAME
  (`passkey-cell-security`, `-breaker-open`, `-unverified-stopped`, `-quarantined`, `-rejected`,
  `passkey-suspended`, `passkey-chrome-unverified`, `passkey-cell-state-unknown`; a missing key →
  `passkey-binding-missing`); the `inputDigest` carries the method + entry key FOR THE PASSKEY PATH
  ONLY (legacy digests are byte-stable across the upgrade).
- **`SubscriptionReloginStore`** — `loginMethod` column on `repair_episodes` via a PRAGMA-guarded
  `ALTER TABLE` run right after the schema (tested on a pre-existing database); the insert writes it;
  `getUnattendedEvidence(..., loginMethod?)` scopes ONLY successes + `oldestSuccessAt` by method
  (legacy NULL rows count for a legacy method, never for `google-passkey`), while identity mismatches
  and unexpected origins stay counted across ALL methods; new failure class `passkey-refused`.
- **`SubscriptionReloginRuntime`** — `autonomousLoginMethod()` accepts the method; admission passes the
  entry key + cell state (from an optional `passkeyCellState` dep — ABSENT on this build ⇒ `unknown`
  ⇒ refused) and reads evidence per method; the candidate/episode records the method; the DRIVE boundary
  refuses a passkey account by name (`passkey-refused` → a REFUSED terminal, not a failed attempt) —
  it is never driven through the password/session flow.
- **`AnthropicReloginBrowserDriver`** — request `loginMethod` union gains the method; a password fill is
  allowed ONLY for the password-family methods (`usesPassword`) — defensive hardening for the widened union
  (the old union already excluded every other method).
- **`SubscriptionReloginOrchestrator`** — `passkey-refused` is a refusal (state `refused`).
- **Route `POST /passkeys/revert-method`** (dashboard-PIN gated, dev-gate 503 on the fleet) — restores
  `priorLoginMethod` for the named accounts or, by default, every passkey account; accounts with no prior
  are left unchanged and listed as `noPriorMethod`; each account audited (names only, no entry keys).
- **CLAUDE.md parity** — one bullet inside the Playwright Profile Registry section (new agents) +
  `migrateClaudeMd` inserts it into existing files behind a route-path content sniff (idempotent).

**Nothing turns the method on.** No production code constructs a `passkeyEntryExists` predicate or a
`passkeyCellState` reader, so: no account can be assigned the method, no passkey repair can be admitted,
and the only reachable new behaviour is the revert route (which can only move an account OFF the method)
and the driver's tightened password rule. The passkey EXECUTOR (credential load + the passkey page classes,
spec §3.5–§3.8) and the cell-state producer (store + health watcher, §3.1/§4) are the next increments of
the same run. <!-- tracked: CMT-544 -->

## Decision-point inventory

- `evaluateSubscriptionReloginAdmission` passkey branch — add — pure invariant over declared state; named refusals (spec §10 "Repair method selection and admission refusals").
- `driveBrowser` passkey refusal — add — invariant (one method per tuple; no fall-through).
- `usesPassword` in the driver — modify — narrows an existing allow rule to the methods that own it.
- `revertLoginMethod` — add — restores recorded state only; never invents a method.
- `getUnattendedEvidence` method scoping — modify — graduation evidence is per method by construction.

---

## 1. Over-block

- A passkey account is refused on this build no matter what (cell `unknown`). Intended: the path is dark
  until the state producer exists; the refusal is named, not silent.
- `passkeyEntryExists` absent ⇒ every passkey assign is 409. Intended for the same reason.
- The driver's password fill is now allowed only for the password-family methods. The old request union
  already excluded every other method (and `autonomousLoginMethod()` throws for them), so this is defensive
  hardening for the widened union, not the closure of a reachable path; no admitted repair changes.
- `revertLoginMethod` on a passkey account whose prior was `unknown` reports `no-prior-method` and leaves
  the account on the passkey method. Correct: an `unknown` method is not a working sign-in path to
  "restore".

## 2. Under-block

- Revert restores the METHOD but not the password/TOTP bindings the enrollment replaced (they were
  overwritten at assign time; the registry has no history of them). A reverted `password` account with no
  `password` binding is still ADMITTED (admission checks dangling VAULT refs, not binding presence) — the
  repair then tries the profile's live session first, as today; if it reaches a password page it has no
  allowed action and returns `provider-transient`, retrying until the attempt budget is exhausted (bounded,
  audited). This is the pre-existing behaviour of any binding-less `password` account (the provision route
  creates them with `needsSecureCredentialDrop`); revert is merely a new producer of one. So the revert result
  now carries `bindingMissing: true` (also written to the audit row) so the caller re-binds before relying on
  the restored method. A binding-presence admission check is NOT added here: a password account with a live
  session cookie legitimately succeeds without a fill, so refusing it at admission would be an over-block.
- The route reverts by name; it does not touch the passkey STORE entry (the store is not on this build's
  server side). The enrollment increment owns delete-on-revert. <!-- tracked: CMT-544 -->
- Legacy NULL rows counting toward a legacy method is a judgement (they can only have been produced by a
  legacy method); it preserves existing graduation and never helps `google-passkey`.

## 3. Level-of-abstraction fit

Each rule sits where the state lives: the registry validates bindings, the pure policy decides admission,
the store owns evidence, the driver owns action allowlists. The runtime only carries fields between them.

## 4. Signal vs authority compliance

All new checks are deterministic invariants over declared state (method, binding, cell enum) — no content
detectors, no heuristics with blocking authority. The supervisor is untouched.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points; invariants only.

## 5. Interactions

- Approval revalidation: a cell that turns non-ready between suggest and approve refuses at approve with
  the named reason (tested); a method change between suggest and approve changes the digest (passkey ↔
  legacy) and refuses with `approval-input-digest-mismatch` (the existing mechanism).
- Breaker: a `passkey-refused` terminal is a refusal and counts toward the existing failure breaker like
  any other refusal; on this build nothing can reach it (admission refuses first).
- The existing runtime/e2e relogin suites pass unchanged (legacy digests unchanged by construction).

## 6. External surfaces

- New route `POST /passkeys/revert-method` — PIN-gated, dev-gated, audited to `logs/playwright-profiles.jsonl`.
- Registry rows gain two optional fields older builds ignore (no schema version; additive).
- `repair_episodes` gains a nullable column (additive; older builds ignore it).
- CLAUDE.md bullet (new agents + migration).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The revert route is a PIN lever with a plain-English CLAUDE.md line; it names every account it touched and
every account it deliberately left alone. No dashboard control yet (the passkey dashboard surface is the §5
increment). <!-- tracked: CMT-544 -->

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN and by spec (§12, FD2 operator-ratified): a passkey cell is (account × machine); the
registry, the store column and the revert route all act on THIS machine's state only. The route's default set
is this machine's passkey accounts; a peer's cells are reverted on the peer (mandate op in a later increment).

## 8. Rollback cost

Pure code + two additive nullable fields. Reverting the code leaves the column/fields inert. An older build
refuses repair for a `google-passkey` account with `login-method-not-autonomous` (spec §15) — safe.

---

## Conclusion

The method now exists end-to-end as DECLARED state with named refusals at every boundary, and nothing on
this build can turn it on. The one behaviour change reachable today is the tightened password rule in the
driver, which only narrows an allowlist to the methods that own it. Clear to ship after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude), 2026-09-22 21:15 PDT — **Concur with the review**, with one
artifact-wording correction (applied above in §1 and §2) and minor notes (addressed below). The reviewer
verified independently: no production construction site passes `passkeyEntryExists` or `passkeyCellState`,
so nothing on this build can assign the method or admit a passkey repair; the policy is fail-closed for
every cell state incl. null/undefined; legacy digests are byte-identical by construction (sorted keys, zero
added keys); the evidence SQL binds `method` and builds the scope from constants with matching placeholder
order; the ALTER runs before `prune()` and is idempotent; `usesPassword` changes no admitted path; the PIN
check cannot throw on unequal lengths; audit rows carry no entry key; `.instar/state/` is gitignored so the
registry and `repairs.db` never replicate. The full named battery plus the pre-existing relogin/registry/
driver suites passed (19 files, 194 tests).

Minor notes and what changed:
1. §1/§2 wording corrected as above (the reviewer's concrete scenario is recorded in §2).
2. An explicit-list revert was not atomic on an unknown target (a mixed list reverted the valid entries,
   then 404'd). Now every explicit target is validated for existence BEFORE the first write (`hasAccount`),
   and the mixed-list case is tested: 404 and nothing reverted.
3. Spec §3.4 says "PIN or mandate"; only the PIN lever ships here — the `passkey-cell` mandate op lands with
   the mandate increment (§7 above). <!-- tracked: CMT-544 -->
4. `revertLoginMethod` has no broker-profile guard; immaterial (a broker profile cannot hold a passkey
   account — `assignAccount` is the only writer and the broker profile has no such account).
5. The legacy-DB fixture hand-writes the pre-change table; adequate for the ALTER guard.

---

## Evidence pointers

- `tests/unit/playwright-registry-passkey-method.test.ts` — 8 tests: fleet default refuses (409, nothing
  written); fail-closed on unreadable store; unknown key; method↔binding coupling (400); key is not a vault
  ref; `priorLoginMethod` derivation incl. rotate / off-method / unknown; revert semantics + `bindingMissing` +
  404s; additive rows.
- `tests/unit/subscription-relogin-policy-passkey.test.ts` — 6 tests: ready admits; every non-ready state by
  name; missing key; cell ignored for other methods; digest separation + legacy stability; ordering.
- `tests/unit/subscription-relogin-store-login-method.test.ts` — 5 tests: ALTER on a pre-existing DB
  (idempotent); insert/read; per-method success scoping incl. legacy rows; cross-method mismatch counts;
  `passkey-refused` terminal.
- `tests/unit/anthropic-relogin-driver-passkey-method.test.ts` — 2 tests: no password/TOTP action under the
  passkey method even with bindings; a forced `fill-password` never resolves or fills a secret.
- `tests/unit/PostUpdateMigrator-passkeyLoginMethodBullet.test.ts` — 3 tests: template + section carry the
  bullet; insertion into an older section; idempotent.
- `tests/integration/subscription-relogin-runtime-passkey.test.ts` — 6 tests through the production-shaped
  runtime: no candidate when unwired / not ready; no candidate without a key; suggested episode records the
  method + passkey digest; drive-boundary refusal (browser never opened); revalidation refusal by name;
  per-method graduation evidence.
- `tests/integration/passkeys-revert-method-routes.test.ts` — 5 tests: 401/503; PIN 403 ×3 (no change);
  400; default-set revert + audit + idempotency; explicit list + notPasskey + all-or-nothing 404.
- `tests/e2e/passkeys-revert-method-lifecycle.test.ts` — 3 tests: ALIVE (200 + real revert) on a dev agent;
  403 without PIN; 503 on a fleet config.
- Existing suites unchanged and green: relogin policy/store/service/orchestrator/runtime/routes/lifecycle,
  driver, playwright registry unit/integration/e2e.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. New capability from an approved spec; no
self-triggered controller is added.

## Post-review follow-up (CI)

- `capabilities-discoverability` refused the new `/passkeys` route prefix as unclassified. Classified it in
  `INTERNAL_PREFIXES` (same class as `playwright-profiles`): a dashboard-PIN-gated operator lever, dev-gated,
  surfaced through the CLAUDE.md bullet rather than `/capabilities`. `dev:preflight` passes locally with it.
