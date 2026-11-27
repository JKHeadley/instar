# Message retry envelope scan

This is a reversible change to the retry sweep's candidate scan. It separates filesystem work into batches of 16 and retains only message ID, expiry inputs, recipient and phase for each active filename. Each scan lists the directory, checks file metadata and drops cache entries for disappeared files. Size, inode and nanosecond change timestamps distinguish same-size replacements and ordinary writes. The cache starts empty after restart. Files that cannot be read or parsed are reconsidered on the next scan.

The sweep preserves newest-first ordering and direct or broadcast addressing. Inert terminal phases require no action. Candidates that can have work are still claimed and reloaded before delivery, expiry or escalation. The fresh message must match both the claimed message ID and the receiving agent or broadcast address. An unexpired sent message still belongs to its initial dispatcher. The watchdog uses its existing independent read path. Existing public inbox and outbox queries use their existing implementations.

## Class-Closure Declaration

The cache supplies candidate metadata only. Recipient matching and expiry checks are based on the same fields as the existing scan. A message selected for an action still goes through the existing ownership claim and authoritative envelope read. Storage layout, retry budgets, and transition rules are unchanged.

## Evidence

A local synthetic fixture used 2,000 active envelopes with 32 KiB bodies and a concurrent reader. The original inbox scan read all 2,000 bodies synchronously in each of three passes. It delayed a scheduled 5 ms heartbeat to 107–175 ms. The revised cold scan read 2,000 bodies asynchronously and the heartbeat fired in 4 ms. Each warm scan reopened zero bodies and the heartbeat fired in 4–5 ms. This measures the candidate scan on Studio. Laptop production-layout qualification is separate.

Independent Codex reviewer retry_review concurred after the fresh ID, recipient and initial-dispatch safeguards were added. The reviewer checked the source and replacement test cases.
