## What Changed

- When the dashboard reads lists from your other machines, a broken Cloudflare route no longer counts as working, and a read moves on to that machine's next route (for example Tailscale) instead of giving up. Only routes the existing safety check already allows are used, and requests that change something are never retried.

## What to Tell Your User

The dashboard should say "part of the list could not be checked" much less often: when one way of reaching a machine is down, it now tries the other ways.

## Evidence

- On a live agent, one machine's Cloudflare route answered "could not reach" (HTTP 530) on every read while its private Tailscale route worked, and the broken route kept being chosen. Unit tests cover the fallthrough, the credential guard on fallback routes, no retry for non-read requests or timeouts, and unchanged behaviour when no other route is known.

## Summary of New Capabilities

None. This makes cross-machine reads more reliable.
