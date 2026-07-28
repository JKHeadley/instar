# Telegram recovery queue truth

When a Telegram reply hits a temporary delivery failure, the relay now reopens
the canonical recovery database and verifies that its delivery ID, topic, text
hash, and queued state all match before saying “Queued for recovery.” If that proof fails, it says the
message was not queued.

When recovery drains later, one worker owns and continuously renews a delivery
ID, and only its exact ownership token can finish the row. Two workers cannot
send the same recovered message twice. Historical zero-byte databases at
obsolete paths are atomically renamed into quarantine and never auto-deleted;
non-empty files are preserved for review.
