# Side-effects review — credential identity resolver: dual-subscription email

**Change:** the pool-mapping half of `credResolveIdentity` (`src/commands/server.ts`) was
extracted into an exported pure function `resolveClaudeSlotAccountId`
(`src/core/InUseAccountResolver.ts`) and scoped to claude-code accounts, over a shared
candidate helper `claudeAccountsMatchingEmail` and a shared normalized comparison
`emailEquals`. `matchAccountByEmail` was refactored onto the same definition;
`CredentialLocationLedger`'s two email comparisons were routed through `emailEquals`.

**Second-pass review: CONCERN, resolved, then CONCUR on re-review.** The reviewer raised three
concerns and empirically DISPROVED the first version's test claim by reverting the production
callsite and watching all 9 tests still pass. All three were folded in; on re-review the
reviewer concurred and found two further overstatements in this artifact, which are corrected
in place below. Every correction is marked ✎ rather than silently rewritten, because a claim I
checked and withdrew has to stay distinguishable from one I never made.

**Tier:** 1 (single-callsite correctness fix + a pure helper extraction; no new capability,
no new surface, no new state, no config).

## Evidence (measured, not inferred) — 2026-08-26, Mac Studio

- Live pool: 8 accounts. Exactly 2 carried `identityDrift.repairState =
  'owner-relogin-required'` / `actualAccountId = 'missing-local-login'`, both stamped
  `2026-08-25T03:29:54Z`.
- Those 2 (`sagemind-justin`, `justin-gmail`) are exactly the 2 claude-code accounts whose
  email is also carried by a codex-cli account. The other 4 claude-code accounts have unique
  emails and carried no drift. 2/2 correlation, 0 false members.
- `readClaudeOauthAsyncDetailed` on both flagged slots: `ok`, access token present, refresh
  token present, `expiresAt` in the future, Max subscription, full scopes. The credentials
  were never missing.
- `CredentialIdentityOracle.resolveSlotTenant` on both flagged slots: RESOLVED, correct email.
  The oracle half was never failing.
- Replaying `buildCredentialRepairPlan`'s exact composition against the live pool reproduced
  `ownerReloginAccountIds: ['justin-gmail','sagemind-justin']`; the same replay with the
  framework-scoped lookup produced `[]` with `complete: true`.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

✎ **Corrected after second-pass review.** The first draft of this section claimed a narrowed
candidate set "can never turn a previously-resolving slot into an ambiguous one". That is
false — 1 match narrowing to 0 is also `!== 1`, and 0 fails closed exactly like 2 does.

The concrete case the reviewer found: `SubscriptionPool` validates `provider` and `framework`
against their unions INDEPENDENTLY, with no cross-check, so `{ provider: 'openai', framework:
'claude-code' }` is an admissible row rather than "malformed by construction". And it is not a
safe failure: `buildCredentialRepairPlan` selects the accounts it plans over on `framework`
ALONE, so such a row would enter the plan, resolve to `null`, and receive
`owner-relogin-required` plus a beacon commitment plus eviction from `isLocallyExecutable` —
manufacturing precisely the false alarm this change exists to delete.

Resolved by making the candidate predicate EQUAL the account-selection predicate: the scope is
`framework === 'claude-code'` and deliberately does NOT also require `provider === 'anthropic'`.
A candidate predicate narrower than the selection set one layer up is the bug, not a
tightening. That invariant is stated in the helper's docstring and pinned by a unit test.

With that, over-block is nil: the candidate set is exactly the account set, so no slot that
resolved before can fail to resolve now.

## 2. Under-block — what failure modes does this still miss?

Deliberately unchanged and still present:
- An oracle that cannot answer (no token, network failure, 401/403/429/5xx, unparseable) is
  still a flat `unavailable` with the reason string discarded one line later by
  `buildCredentialRepairPlan` (`accountId: 'unavailable' in identity ? null : …`). So
  "credential absent" and "credential present but rejected" still collapse into one
  indistinguishable `missing-local-login`. That is a real defect — it is the reason the
  expiring-vs-disappearing question is currently unanswerable — but it is a DIFFERENT defect
  with a different fix, and it is the subject of the in-review
  `docs/specs/subscription-signin-ledger.md` (round-1 findings ADV-1, ADV-5, LES-1, LES-8 all
  name it). Fixing it here would be an unscoped second change riding a one-line correctness
  fix. <!-- tracked: CMT-167 -->
- A genuine two-Claude-accounts-one-email collision still fails closed. Intended.
- Non-claude-code frameworks still have no drift raise or clear path at all
  (`buildCredentialRepairPlan` and `QuotaPoller.reconcileIdentity` are both claude-code-only).
  Unchanged by this fix and out of its scope. <!-- tracked: CMT-167 -->

## 3. Level-of-abstraction fit

Correct layer, and the change improves it. The scoping rule is a property of *what the oracle's
answer means*, so it belongs beside the oracle's consumers, not inside the pool or the planner.
It already existed at that layer in `matchAccountByEmail`; the fix removes the second,
scope-less re-implementation rather than adding a third.

✎ **Corrected after second-pass review.** The first draft claimed the remaining two definitions
"disagree only on whether a framework-less row counts". They also disagreed on `provider` and —
more seriously — on email NORMALIZATION: `CredentialLocationLedger:466/557` compared with raw
`===`, no trim, no case-fold. A provider returning a differently-cased email would have
reproduced the same pool-vs-ledger contradiction in the opposite direction, silently.

Both ledger sites now use the shared `emailEquals`. What is honestly NOT converged is the SCOPE
predicate: the ledger's `isClaudeCodeAccount` additionally admits a framework-LESS legacy row.
Widening the shared helper to match would make such a row a candidate without putting it in the
repair plan's account set — reintroducing the collision in a new shape. So the scopes still
differ by that one case, deliberately, and the helper's docstring says so rather than claiming a
convergence that did not happen. <!-- tracked: CMT-167 -->

## 4. Signal vs authority compliance (`docs/signal-vs-authority.md`)

The resolver is a DETECTOR. It adds no blocking authority; it makes an existing detector
correct. The fix strictly *reduces* the authority previously exercised, because a
manufactured `unavailable` was being rendered downstream as an authoritative
`repairState: 'owner-relogin-required'` — a detector's uncertainty presented as a verified
state. The fail-closed rule on genuine ambiguity is retained precisely because this detector
DOES feed a mutation authority (`CredentialSwapExecutor` moves credential blobs between
homes), and a guess there is irreversible.

This is also a clean instance of the P20 failure the constitution names: the SYMBOL was
`matches.length !== 1`; the STATE claimed was "no local login exists"; the corroboration
(the credential blob is readable and the oracle resolves) was available at zero cost and
never consulted; and the unmeasurable case was rendered as the alarming value rather than
as `unknown`.

## 5. Interactions

- `CredentialSwapExecutor` — consumes `resolveIdentity` for pre-flight identity checks. It now
  gets a resolution where it previously got `unavailable`, so a swap that was refused with
  `precondition-failed` can now proceed. That path is dev-gated AND `dryRun: true` on this
  agent and dark on the fleet, so no live credential write changes today.
- `QuotaPoller.reconcileIdentity` — the sole falling-edge writer. It returns early on
  `unavailable` ("uncertainty never mutates truth"), which is exactly why the flag latched.
  With the fix it resolves, `identity.accountId === expected.id`, and it clears
  `identityDrifted` and calls `onIdentityRestored`. **Expected live effect: the two latched
  accounts self-clear on the next poll with no operator action.** ✎ Independently verified by
  the second-pass reviewer against `pollAll`, `accountForReads` and the in-memory
  `identityCache` (emptied by the restart that ships the fix): no path skips a drifted account,
  and nothing else must happen first.
- `SubscriptionPool.isLocallyExecutable` excludes `identityDrifted` accounts, so those two Max
  accounts re-enter the capacity pool. That is a capacity *increase* on a machine that was
  under-using paid subscriptions; it cannot exhaust anything that was not already available.
- `MissingLoginSessionDetector` raises a HIGH attention item on this predicate. Fewer false
  raises; it is signal-only and mutates nothing.
- `CredentialLocationLedger.auditIdentities` already scoped by framework, so it never had the
  dual-subscription bug — which is why the pool and the ledger were visibly contradicting each
  other (pool: missing since Monday; ledger: verified an hour ago). That contradiction resolves.
  ✎ Its two email comparisons now also share `emailEquals`, closing a separate latent
  case-sensitivity divergence the second-pass review found. **This is a real behaviour change
  on one input shape, not none** — the first draft of this artifact said otherwise and was
  wrong. Two claude-code rows whose emails differ only in CASE are not rejected at `add()`
  (there is no email-uniqueness constraint), and case-folding turns them from one exact match
  into an ambiguous pair, which quarantines the slot rather than resolving it. That is the
  fail-closed direction, both surfaces now agree on it, and two accounts sharing an email
  modulo case genuinely IS ambiguous — so it is accepted, but it is stated. The opposite
  direction (previously matched, now does not) is reachable only for two whitespace-only
  emails, which `normalizeSubscriptionEmail` rejects at `add()`.
- ✎ `onIdentityRestored` (server.ts) does more than clear the flag: it DELIVERS the
  `credential-identity-relogin:<id>` commitment and marks the attention item done. So the
  self-clear leaves no orphan beacon nagging the operator about a resolved condition.
- No double-fire, no shadowing, no race introduced: the helper is pure and synchronous.

## 6. External surfaces

`GET /subscription-pool` will stop reporting `identityDrift` for dual-subscription accounts —
visible in the dashboard Subscriptions grid and to any operator or peer reading pool state.
That is the intended user-visible effect and it is a correction, not a new surface. No route
added, no schema field added or removed, no config key, no message text, no agent-installed
file. The `reason` string on a genuine ambiguity now reads `(N claude-code pool matches)`
instead of `(N pool matches)` — strictly more accurate, and it appears only in audit rows.

Timing/runtime dependence: none introduced. The helper is deterministic over its inputs.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local` by construction, and correctly so — `machine-local-justification:
physical-credential-locality`. The resolver reads a credential blob that physically lives in
one `configHome` on one disk (a Claude OAuth login cannot be relocated between machines; that
is why each machine mints its own). The subscription-pool ROWS it matches against already
replicate as credential-free metadata, and this change reads that metadata without altering
what replicates. No notice, no durable state, no generated URL — so no one-voice gating, no
topic-transfer strand, no machine-boundary link concern.

Each of the operator's four machines runs its own resolver over its own slots and will fix
itself independently as it updates; there is no cross-machine ordering dependency.

## 8. Rollback cost

Near zero. Two files, no state written, no migration, no data shape change. Revert the commit
and the previous behaviour returns exactly. Nothing persisted during the fixed window needs
repairing: `identityDrifted: false` is the same state a successful owner re-login would have
produced, and `CredentialLocationLedger` assignments were already being written correctly by
the path that never had the bug. No hot-fix release coupling, no agent state repair.

## Known adjacent issues NOT fixed here (named so they are not mistaken for absent)

- The discarded oracle `reason` (see §2) — the cause-class evidence exists and is thrown away
  at `buildCredentialRepairPlan`. <!-- tracked: CMT-167 -->
- `buildCredentialRepairPlan` uses `framework === 'claude-code'` while
  `CredentialLocationLedger.isClaudeCodeAccount` treats an ABSENT framework as claude-code, so
  a framework-less row is in one subsystem's account set and not the other's. Pre-existing,
  unchanged, and not reachable by any live row (all 8 pool rows carry a framework).
  <!-- tracked: CMT-167 -->


## ✎ Test adequacy (added after second-pass review)

The first version of this change was tested through a hand-copied closure declared inside the
test file. The reviewer reverted `src/commands/server.ts` to `origin/main`, left the helper
fixed, re-ran the suite, and got 9/9 green — the tests pinned the helper's semantics and the
production defect could have been reintroduced silently. That is a worse failure than no test,
because it certifies a guard that is not there.

Resolved structurally rather than by adding assertions: the mapping half of `credResolveIdentity`
is now an exported function (`resolveClaudeSlotAccountId`) that `server.ts` actually calls, and
the tests import it. Nothing in the test file is a copy of the code under test.

Verified by mutation rather than asserted, and stated precisely because the obvious summary
would overclaim. Two different things can be broken, and they need two different guards:

- **The LOGIC.** Reintroducing the pre-fix predicate inside `claudeAccountsMatchingEmail`
  (whole-pool filter, raw `===`) fails **7 of 17** tests, including both composed
  `resolveClaudeSlotAccountId -> planCredentialIdentityRepair` cases.
- **The WIRING.** Reverting `src/commands/server.ts` ALONE — re-inlining the lookup at the
  callsite while leaving the helper correct — left every logic test green. ✎ The reviewer
  demonstrated this, and it matters more than it sounds: re-implementing the lookup at the
  callsite is *precisely how this bug was born*, since the correct rule already existed in a
  sibling module. `credResolveIdentity` is a local `const` inside `startServer`, not an injected
  dependency, so there is nothing to reach at runtime; two source assertions are the honest
  instrument available. Both fail on a callsite-only revert, verified the same way.

The distinction is recorded rather than smoothed over: "7 of 17 fail" would have implied the
callsite was covered when it was not.
