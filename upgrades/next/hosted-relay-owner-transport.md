# Prepare the optional relay tunnel and owner checks

## What Changed

The relay foundation can check the owner's pinned record and the current machine lease. An outbound HTTP/2 connection can carry multiple separate relay streams.

## What to Tell Your User

The relay still runs only in disposable tests. Direct access remains available.

## Evidence

Signed owner-record fixtures test revocation and invalid lease evidence. A loopback HTTP/2 fixture tests two bidirectional streams and refusal of offers from a different session.
