# Close displaced connections during relay takeover

## What Changed

The optional relay's test coordinator closes the old connection and its streams after an authenticated takeover.

## What to Tell Your User

Direct access still works during a relay handover. The optional relay is still disabled.

## Evidence

A loopback TLS test sends traffic to two holders in sequence and verifies that the first connection closes while the first agent's direct address still responds.
