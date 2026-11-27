# Keep owner words and current work in recovery

## What Changed

Recovery recognizes direct Telegram sender IDs that match both configured owner records. It gives the framing quote, recent owner messages, and current work room before bare ledger references. Claude checks staged protected quotes against current authority and source text before using them.

## What to Tell Your User

When context recovery is enabled, the next rebuilt packet can carry your exact framing, recent messages, and current work across compaction. If the saved packet no longer matches the current owner or source, the session uses ordinary recovery.

## Summary of New Capabilities

Standing recovery and pre-compaction steering validate owner-bound staged data against the current owner and exact source rows.

## Evidence

The isolated Studio replay verified framing, fourteen recent messages, and current work in a 5,948-character packet with zero bare ledger lines. Focused tests exercise owner rotation, corrected source provenance, route authentication, and both framework recovery fixtures.
