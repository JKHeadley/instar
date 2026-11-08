# Rate-limited subscription recovery

## What Changed

Subscription accounts marked `rate-limited` can return to active after a fresh authenticated quota reading proves both short and weekly windows have headroom and any previously exhausted window has reset.

## What to Tell Your User

An account held by a past usage limit can become available again automatically on a later quota check. No action is needed.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Automatic rate-limit recovery | Runs on the normal subscription quota poll after limits clear. |

## Evidence

The related `tests/unit/quota-poller.test.ts` covers recovery, continued limits, missing short-window evidence, rollout fallback, and untouched statuses.
