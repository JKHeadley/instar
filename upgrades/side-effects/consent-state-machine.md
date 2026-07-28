# Side-effects review — consent state machine (PR 5 of tunnel-failure-resilience chain)

**Scope (PR 5 of the chain):** Land the consent state machine inside
`TunnelManager` and append `LocaltunnelProvider` (from PR 4) to the
default Tier-2 slot. Adds public `grantConsent` / `declineConsent`
methods so the upcoming Telegram callback handler (PR 6) can drive the
owner-approval gate. Spec
`specs/dev-infrastructure/tunnel-failure-resilience.md` is converged
+ approved on main.

**Files touched:**
- `src/tunnel/TunnelManager.ts` — adds Tier-2 to `buildDefaultPool`;
  modifies `exhaustedOrBackoff` to branch on Tier-2 availability +
  consent cooldown; adds `findAvailableTier2`, `requestConsent`,
  `clearPendingConsent`, `grantConsent`, `declineConsent`,
  `recordConsentDecline`, and the `pendingConsent` accessor; updates
  `stop()` to clear the pending consent.
- `tests/unit/tunnel-consent-state-machine.test.ts` — 11 tests covering
  the awaiting-consent transition (and its negative cases — no Tier-2
  available, cooldown active), grantConsent happy path, nonce
  rejection (wrong nonce, replay), grant-failure paths (unreachable
  relay, provider.start throws), declineConsent happy path + wrong
  nonce, stop() clearing pendingConsent.

**Under-block**: None at user-visible runtime. Agents without the
`localtunnel` npm dep installed continue to fall through to
`exhausted` exactly as before (the Tier-2 slot's `isAvailable()`
returns false; `findAvailableTier2` returns null; the branch picks
the existing `exhausted` path). This is the spec's opt-in posture —
PR 4's side-effects review documented it explicitly.

**Over-block**: Minimal. Agents that DO have `localtunnel` installed
WILL see the new `awaiting-consent` transition fire instead of going
straight to `exhausted` — but the manager has no UX layer to surface
the prompt yet (PR 6 lands the Telegram callback handler that
actually calls `grantConsent` / `declineConsent`). For now the
manager sits in `awaiting-consent` for the 15-minute timeout, then
auto-declines and falls through to exhausted with the cooldown
advanced. From the user's perspective this looks identical to
"exhausted" today — there's just a 15-min delay before the cooldown
counter ticks the first time.

To explicitly avoid this UX gap during the interim window between
PR 5 and PR 6, operators who don't want the awaiting-consent state
can simply not install `localtunnel`. The default ships without it.

**Level-of-abstraction fit**:
- The state machine lives in `TunnelLifecycle` (PR 1); the manager
  drives state through the existing CAS-guarded transitions.
- `_pendingConsent` is private state on the manager (binds nonce +
  episode + provider). Exposed read-only via the `pendingConsent`
  accessor that returns a snapshot — callers cannot mutate the
  manager's state from outside.
- `grantConsent` / `declineConsent` are the AUTHORITY surface for
  consent decisions. The Telegram callback handler (PR 6) will be
  the SIGNAL layer — it validates the click came from the owner and
  the message id matches, then calls these methods.

**Signal vs authority**: Compliant. The manager is the authority for
state transitions and the consent record's lifecycle; external
callers can only ask for grant/decline by presenting the nonce, and
the manager validates+decides. The Telegram callback handler in PR 6
will be a thin signal layer above this; it cannot bypass the nonce
check.

**Interactions**:
- `_pendingConsent` is single-flight per manager instance — only one
  consent record can be active at a time (the lifecycle's `episode`
  invariant: one episode = one consent prompt = one nonce).
- `clearPendingConsent` is called on every terminal path (grant
  success, decline, timeout, stop, episode change). The timer is
  cleared atomically with the record so no stale callback can fire.
- The consent timeout uses the lifecycle's `recordConsentRefusal`
  to advance the cross-episode cooldown — same path as a manual
  decline. The cooldown progression is exponential (1h → 4h → 24h)
  per PR 1's lifecycle implementation.
- `rotationPending=true` is set on entering `relay-active` (the
  crash-safe persisted marker for the upcoming rotation lifecycle
  in PR 6). The actual rotation work is NOT in this PR — only the
  marker.
- Reachability probe on the granted Tier-2 provider follows the
  same `/health` semantics as Tier-1 — a relay that emits a URL
  but doesn't actually serve traffic falls through to exhausted +
  cooldown (so the owner isn't asked again immediately).

**External surfaces**:
- New public methods: `grantConsent(nonce)`, `declineConsent(nonce)`,
  `pendingConsent` getter on `TunnelManager`. All require the
  caller to have the current pending nonce, which is itself only
  accessible via `pendingConsent.nonce` — there's no broader
  exposure.
- No new API endpoint, no new CLI command, no new config field.
- The default tunnel pool now includes a `LocaltunnelProvider`
  slot, but the manager only activates it after Tier-1 exhausts +
  consent is granted, so users who never hit a Tier-1 exhaustion
  never see Tier-2 attempted.

**Migration parity**: N/A. Server-side code only.

**Rollback cost**: Trivial. Revert `TunnelManager.ts` + the test file.
The new methods become unused (they're not called from anywhere
outside the manager + tests yet). LocaltunnelProvider stays in tree
from PR 4 but is no longer in the default pool.

**Tests**:
- 11/11 new tests in `tests/unit/tunnel-consent-state-machine.test.ts`.
- 19/19 tests in `tests/unit/tunnel-manager-rewrite.test.ts` (from
  PR 2 + 3) still pass.
- 32/32 lifecycle, 13/13 notifier, 10/10 providers, 7/7 localtunnel-
  provider — all still pass.
- `tsc --noEmit` clean. `npm run lint` clean. No existing tests
  modified.

**Decision-point inventory**:
1. `_pendingConsent` stores the provider directly (vs. a provider-name
   key into the pool) — keeps the grant path independent of the pool
   ordering, and ensures a provider that becomes "unavailable"
   between request and grant is still the one we attempt (failure
   surfaces cleanly).
2. Nonce is 128-bit CSPRNG via `generateNonce` from PR 1 — meets the
   GPT external review's spec for entropy + atomic compare-and-delete.
3. Single-use enforced by `clearPendingConsent` BEFORE the provider
   starts — a replay of the same nonce loses cleanly even if the
   start is in flight.
4. Timeout = 15 min (spec Part 4 default, staggered off the 10-min
   reconnect window per verification finding V1).
5. Reachability failure on a granted relay → cooldown advanced.
   Reason: the relay started but doesn't serve; bothering the owner
   again immediately wouldn't help. The cooldown gates the next ask.
6. State machine transitions `awaiting-consent → exhausted` directly
   on decline/timeout/start-failure — same transition the cooldown
   path uses, so background retry semantics are uniform.
7. `pendingConsent` accessor returns a defensive snapshot — mutating
   it does NOT affect the manager. External callers cannot inject
   their own nonce or change the bound provider.
