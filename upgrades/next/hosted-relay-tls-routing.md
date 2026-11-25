# Prepare optional encrypted relay routing

## What Changed

The relay foundation can forward encrypted connections by destination name while the agent handles TLS.

## What to Tell Your User

A local test proved that a relay can forward the connection while direct access still works. The optional relay service is still being built.

## Evidence

The TLS parser rejects malformed names. A loopback integration test verifies that the client trusts the agent certificate, receives a 512 KiB response intact, and keeps direct access when the relay refuses a name.
