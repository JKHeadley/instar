# WS5.2 Increment B / B2 — dead-default eviction + correlated-outage floor (dark/unwired)

<!-- bump: patch -->

<!--
  NOTE: dark/unwired pure logic. Extends the B1 CredentialRebalancerPolicy decision core
  with §2.4 objective-0 (keep ~/.claude alive). No IO, no config flag, no route, no
  credential write path. Same dark/unwired posture as B1 — the actuation that consumes
  the decision is a later gated step.
-->

## What Changed

Adds the highest-priority objective to the balancer decision core: keep `~/.claude` serving a healthy account so manual `claude` invocations stay predictable (§2.4 objective-0).

- **Dead/quarantined-default eviction** — when the default slot's tenant goes needs-reauth/disabled OR the default slot is quarantined, `decidePass()` now deals a healthy, identity-verified-recent tenant into `~/.claude` (a `default-eviction` decision), parking the dead/quarantined credential in the vacated slot with an attention note. This runs before wall-avoidance and drain — a frozen default freezes the operator's manual `claude`.
- **Correlated-oracle-outage floor** — when NO slot is currently oracle-verifiable (an `api.anthropic.com` storm quarantines every probe at once), the policy does NOT empty or churn the default: it preserves the last-known-good assignment, surfaces a degraded + attention entry, and performs no eviction until the oracle returns. Honest bound: the floor's guarantee is "preserve last-known-good + flag", explicitly NOT "manual claude is certified live".
- **Bounded fallback** — verifiable slots exist but none is an eligible healthy tenant → surface, do not act. Two new inputs (`desiredDefaultAccountId`, per-slot `lastKnownGoodAccountId`) + the `default-eviction` objective. Still pure, still unwired; consecutive-forced-eviction P19-capping is the next step <!-- tracked: 20905 -->.

## What to Tell Your User

Still nothing changes — off-by-default internal logic. This teaches the (not-yet-active) account-balancer to protect the one login that must always work: your default Claude account. If that account ever needs a re-login or gets quarantined, the balancer's plan is to slide a known-good account into its place so your plain claude command keeps working, and flag the broken one for you. And if the check it relies on (Anthropic's identity endpoint) is down for everything at once, it deliberately does nothing rather than risk making the default worse — preserving the last-known-good and telling you honestly that it can't currently certify it's live. It only decides; nothing acts yet.

## Summary of New Capabilities

No new runtime capability — extends the unwired Increment-B decision core. `decidePass()` gains §2.4 objective-0: dead/quarantined-default eviction (deal a healthy verified tenant into `~/.claude`) and the correlated-oracle-outage floor (preserve last-known-good, never empty the default during an outage). Not wired into any runtime path; no route, no config flag, no credential write path.

## Evidence

- `tests/unit/credential-rebalancer-policy.test.ts` (+6, 24 total) — deals a healthy verified tenant in when the default tenant is needs-reauth; rescues a quarantined default too; correlated-outage floor preserves last-known-good and does NOT evict; dead default with no healthy tenant surfaces without acting; healthy default is a no-op (normal objectives run); inert when no default account is configured. tsc + full lint clean.
