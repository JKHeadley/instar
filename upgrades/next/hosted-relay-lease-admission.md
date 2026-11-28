# Prepare the optional relay serving lease check

## What Changed

The relay foundation can verify which machine may serve a name and keep the latest accepted lease through a restart.

## What to Tell Your User

The optional relay remains disabled. Its test gate rejects an old connection when an authorized replacement takes over.

## Evidence

Real Ed25519 and SQLite fixtures cover single-use challenges, a wrong machine key, reconnect, takeover, expiry and two connections to one database.
