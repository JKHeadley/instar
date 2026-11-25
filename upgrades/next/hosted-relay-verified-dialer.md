# Verify the optional relay before sending lease proof

## What Changed

The agent can check the relay's certificate, hostname, and pinned public key before starting the private tunnel.

## What to Tell Your User

The optional relay remains off. Certificate verification is being tested locally.

## Evidence

Loopback fixtures check a trusted relay, a changed key, an untrusted certificate, a wrong hostname, missing HTTP/2 and cancellation.
