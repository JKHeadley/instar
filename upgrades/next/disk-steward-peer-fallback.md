# Disk Readings Survive One Failed Connection

<!-- bump: patch -->

## What Changed

The pooled disk API and scheduled disk watcher now use the existing shared peer-read fallback and connection-health recorder. A failed registered local-network connection can fall back to an admissible secure connection. Credential admission, timeouts, and cleanup requests retain their existing behavior. Fixes fb-abe77867-a57.

## What to Tell Your User

Disk checks can now reach another computer through a working connection when its first connection fails.

## Summary of New Capabilities

None. This repairs disk readings across machines.

## Evidence

50 unit, 8 HTTP integration and 3 production-factory lifecycle checks passed, along with typecheck. Regressions cover refused plaintext Tailscale and public fallbacks, successful secure fallback, raw URL health keys, and a single notice acknowledgment through the working connection. Full suites run through normal Local Verify; no live deployment is claimed.

Plain HTTP Tailscale addresses remain refused by the existing credential guard. A machine with only a failed LAN address and that refused address still needs an approved working connection.
