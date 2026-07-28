# Side-effects review — self-heal stability gate (PR 8 of tunnel-failure-resilience chain)

**Scope (PR 8 of the chain):** While a Tier-2 relay is active, run an
unbounded low-frequency probe for Tier-1 (Cloudflare) recovery. Migrate
back only after **N consecutive** successful Tier-1 establishments
(default 3, ~5 min) via an atomic new-then-old switch-back, then rotate
credentials (PR 7) because the relay episode has terminally ended. Spec
Part 5.

**Files touched:**
- `src/tunnel/TunnelManager.ts` — `SELF_HEAL_PROBE_INTERVAL_MS` +
  `SELF_HEAL_REQUIRED_SUCCESSES` constants; `_selfHealTimer`,
  `_selfHealSuccesses`, `_switchingBack` fields; `startSelfHealProbe`,
  `stopSelfHealProbe`, `runSelfHealCheck` (public, for deterministic
  tests), `performSwitchBack`, `firstTier1Provider`. Wired: probe starts
  on `relay-active` entry (grantConsent) and stops in `stop()`.
- `tests/unit/tunnel-self-heal.test.ts` — 3 tests.

**Over-block:** None. The probe only runs while `relay-active`; every
other state (active/retrying/exhausted/awaiting-consent) is untouched.
The bounded startup-reconnect ladder and the post-exhausted retry are a
separate counter — self-heal does not interfere with them (spec's
"separate counter so it never goes silent after the ceiling").

**Under-block (the URL-thrashing HIGH):** A single Tier-1 success does
NOT switch — `_selfHealSuccesses` must reach N consecutively, and any
failed probe resets it to 0 (tested with a flapping sequence). The
switch-back is atomic new-then-old: the recovered Cloudflare handle is
started AND reachability-verified by the probe, then `_state.url` is
assigned and `'url'` emitted BEFORE the relay is torn down — so
`getExternalUrl()`/`url` never returns a dead URL mid-switch (tested:
post-switch url is the recovered CF url and the relay handle's stop was
called).

**Level-of-abstraction fit:** The manager owns the stability gate +
state-machine transitions (`relay-active → self-healing → active`); the
relay provider's `stop()` owns forceful teardown (SIGINT→SIGKILL +
PID-verify is the provider contract — localtunnel is in-process per PR 4,
so its stop() is a best-effort close; a future child-process relay
escalates inside its own stop()); credential rotation is reused from
PR 7. The manager never reaches into provider internals.

**Signal vs authority:** A probe result is a low-context signal. The
N-consecutive gate + the single-writer lifecycle transition is the
authority — one lucky ping during flapping can never trigger a switch.

**Interactions:**
- The probe starts a Tier-1 tunnel each tick. Both tunnels forward to the
  same local port (no conflict). On a non-final success the throwaway
  probe tunnel is stopped immediately; on the Nth success that
  already-verified handle is PROMOTED (no redundant second start).
- `performSwitchBack` is re-entrancy-guarded (`_switchingBack`) and
  bails if state isn't `relay-active` at entry. On failure it restores
  the relay handle/provider/url and transitions back to `relay-active`,
  resetting the counter — the agent stays on the relay rather than going
  dark.
- On reaching `active`, `runCredentialRotation('self-heal')` fires
  (rotationPending was set on relay-active entry) → PIN + authToken
  rotation, exactly as PR 7's stop-path does.
- The probe timer is `unref()`'d so it never blocks process exit; `stop()`
  clears it.

**Performance note:** while on a relay, the probe establishes a real
Cloudflare tunnel every ~100s to detect recovery (the only reliable
signal that quick-tunnel rate-limiting has cleared). This is a degraded
recovery path, not steady state; the throwaway tunnels are torn down
immediately.

**Tier-2/Tier-3:** No HTTP route in this PR — per spec Part 8 the
HTTP-assertable surface is the `/tunnel` route in PR 9. Self-heal is
event-driven and is covered deterministically via `runSelfHealCheck()`
(stability gate + atomic switch + rotation). Wiring verified: the probe
is started from the `relay-active` entry in `grantConsent`.

**Rollback cost:** Low/additive. Revert = drop the self-heal
methods/fields/constants + the two wire points (grantConsent entry,
`stop()`). The `self-healing` lifecycle state predates this PR. No config
or persisted-schema change.
