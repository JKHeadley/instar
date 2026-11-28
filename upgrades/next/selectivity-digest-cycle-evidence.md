# Each daily notification digest leaves one durable record

## What Changed

The optional daily digest of quiet notices (off unless the operator turns it on) had no reliable record of its own. The only row it left was the delivery decision written when a summary was routed, so a quiet day with nothing to count left no trace and a digest whose send failed left none either, while the disk-space summary that runs with the digest off was counted as if it were a digest. The maturity ladder for the digest counted those rows, so its "14 digests in 14 days" bar could not be met honestly.

Now every daily digest cycle, while the digest is on, writes one row to the notification log: `digest-sent` (handed to the sender without error), `digest-empty` (nothing to count that day) or `digest-send-failed` (with only the error type). The row holds counts only, never the digest text. The ladder now counts these cycle rows, and a failed send counts as harm. The digest stays off by default, and only the operator can turn it on. This is CMT-2221.

## What to Tell Your User

Nothing changes unless you have turned on the daily summary of quiet notices. If you have, each day now leaves a small record of whether the summary went out, so its reliability can be checked before anyone suggests keeping it on.

## Summary of New Capabilities

No new capability. The daily digest writes one count-only record per cycle, which its maturity ladder reads.

## Evidence

Before: the digest ladder counted rows with reason `single-use-local-permit`, which are written only when a non-empty digest is routed; no row for an empty day or a failed send. After: tests/unit/notification-digest-cycle-evidence.test.ts shows one `digest-sent` row with counts and no text, a `digest-empty` row on a quiet day, a `digest-send-failed` row with only the error type, one row per day, no row while the digest is off (including the disk-only summary that still runs then), and the ladder metrics pointing at exactly these rows.
