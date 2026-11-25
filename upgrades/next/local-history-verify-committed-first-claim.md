# Verify the committed first copy claim

The private permit module can verify that a first-claim permit matches the exact committed slot and its applying operation. The check uses a separate read-only connection, so an uncommitted parent transaction cannot satisfy it. The check is available for future worker wiring.
