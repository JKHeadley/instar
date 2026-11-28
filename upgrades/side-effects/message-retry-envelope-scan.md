# Message retry envelope scan

This is a reversible change to the retry sweep's candidate scan. It separates filesystem work into batches of 16 and retains only message ID, expiry inputs, recipient and phase for each active filename. Each scan lists the directory, checks file metadata and drops cache entries for disappeared files. Size, inode and nanosecond change timestamps distinguish same-size replacements and ordinary writes. The cache starts empty after restart. Files that cannot be read or parsed are reconsidered on the next scan.

The sweep preserves newest-first ordering and direct or broadcast addressing. Inert terminal phases require no action. Candidates that can have work are still claimed and reloaded before delivery, expiry or escalation. The fresh message must match both the claimed message ID and the receiving agent or broadcast address. An unexpired sent message still belongs to its initial dispatcher. The watchdog uses its existing independent read path. Existing public inbox and outbox queries use their existing implementations.

## Class-Closure Declaration

The cache supplies candidate metadata only. Recipient matching and expiry checks are based on the same fields as the existing scan. A message selected for an action still goes through the existing ownership claim and authoritative envelope read. Storage layout, retry budgets, and transition rules are unchanged.

## Evidence

A local synthetic fixture used 2,000 active envelopes with 32 KiB bodies and a concurrent reader. The original inbox scan read all 2,000 bodies synchronously in each of three passes. It delayed a scheduled 5 ms heartbeat to 107–175 ms. The revised cold scan read 2,000 bodies asynchronously and the heartbeat fired in 4 ms. Each warm scan reopened zero bodies and the heartbeat fired in 4–5 ms. This measures the candidate scan on Studio. Laptop production-layout qualification is separate.

Independent Codex reviewer retry_review concurred after the fresh ID, recipient and initial-dispatch safeguards were added. The reviewer checked the source and replacement test cases.

## Delivered messages with no action due

The cache also records message type and the last delivered transition. A delivered message with neither an elapsed delivery deadline nor an elapsed acknowledgement deadline does not need reopening. The authoritative expiry path and acknowledgement path use the same acknowledgement cutoff calculation as the cache. The fallback for stores that only implement the ordinary inbox remains available. A due candidate is still claimed and reread. Its fresh phase and deadlines govern any action.

Independent Codex reviewer retry_review concurred on the deadline fast path. The reviewer checked that due candidates still reach the claim and fresh read, and that the cutoff and fallback preserve the existing rules.

A full retry-cycle fixture used 2,000 envelopes, including 1,300 delivered handoffs with no action due, and a concurrent reader. The ordinary-inbox fallback made 3,300 synchronous body reads per cycle, and its 5 ms heartbeat fired in 211–255 ms. The revised warm cycle made zero body reads and its heartbeat fired in 4–5 ms. The revised cold cycle read all 2,000 envelopes asynchronously and its heartbeat fired in 6 ms. Real workloads still reopen messages that may require action.
