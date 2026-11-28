# Run the optional relay with secure local listeners

## What Changed

The disposable launcher combines the verified agent connection, signed lease checks, and end-to-end encrypted client forwarding.

## What to Tell Your User

The optional relay remains off in production. The secure path is being tested locally.

## Evidence

A loopback fixture verifies two distinct TLS identities and closes partial connections on shutdown.
