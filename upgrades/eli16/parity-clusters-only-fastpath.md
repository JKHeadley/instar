# ELI16 — Parity-pass clusters-only fast path (#948 fix)

## The problem in plain terms

Before an agent's feedback processing can be "cut over" from Dawn's Portal to Echo, the system runs a safety check called the **parity pass**: it compares Echo's view of the feedback *clusters* against Portal's, over an "invariant" (the fingerprint that identifies each cluster). When that check runs clean for a while, one of the two gates on the cutover door turns green.

That parity pass was **failing every 20 minutes, for hours**. The error always said the same thing: the data fetch "exceeded the max-hold budget (720000ms)" — i.e. it couldn't finish within its 12-minute safety window, so it gave up and recorded nothing. The cutover door's parity gate therefore went, and stayed, stale.

## Why it was failing — and why that was silly

To get Portal's clusters, the fetcher (`HttpParitySource.prepare()`) was paginating through Portal's **entire 145,000-row feedback table** — about 146 pages — because its stop signal is "keep going until a page returns fewer feedback rows than asked." On the busy server, all that page-fetching-and-JSON-parsing competes with everything else the server is doing, and the whole thing stretches past 12 minutes and aborts.

The silly part: **Portal returns the COMPLETE set of clusters (all 1,370 of them) in EVERY single page** — even a `limit=1` request hands back all 1,370 clusters. (Verified empirically against the live endpoint at offsets 0, 70k, and 143k, and at limit=1.) So after the very first page, the fetcher already has every cluster it will ever see. Grinding the other 145 pages of feedback adds nothing to the cluster snapshot — it's pure, budget-burning waste.

## The fix

Add an opt-in `clustersOnly` flag to `HttpParitySource`. When set, `prepare()` stops right after page 0 (it already has all the clusters). Wire the parity-pass closure in `AgentServer` to pass `clustersOnly: true`. Result: the parity pass now does **one ~1-second request** instead of 146, finishes far inside its budget, and the parity window can actually refresh — turning the cutover door's parity gate green and ending the every-20-minute lock-holding failure loop.

## Why it's safe

The flag is **opt-in and narrow**. The import rehearsal (the other caller) genuinely needs every feedback row, so it sets `captureRaw` — and `captureRaw` explicitly **overrides** `clustersOnly`, leaving the import path byte-for-byte unchanged. Nothing else reads the flag. The parity comparison itself is unchanged: it only ever used the clusters (invariant-1 fingerprint), which the fast path still delivers in full. Covered by two new unit tests (stops-after-full-page-0; captureRaw-overrides) on top of the existing pagination suite, all green.
