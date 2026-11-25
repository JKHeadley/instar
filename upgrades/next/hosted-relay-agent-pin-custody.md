# Remember the verified agent key across restart

## What Changed

The test client records a verified TLS pin with its lease and owner evidence in one transaction.

## What to Tell Your User

The optional relay remains off. The storage test verifies that an older key cannot replace a newer one after a restart.

## Evidence

SQLite fixtures use separate connections and reopen the database, verify authorized rotations and takeovers, and reject old or corrupt evidence.
