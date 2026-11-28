# Connect the optional relay in a disposable service

## What Changed

The test relay accepts a signed control handshake and forwards an encrypted client stream through the authorized outbound session.

## What to Tell Your User

The optional relay is still off in production. The first complete local connection is being tested.

## Evidence

The disposable service refuses an early stream offer, admits an exact signed lease, uses the agent certificate for end-to-end TLS, and closes data streams when control ends.
