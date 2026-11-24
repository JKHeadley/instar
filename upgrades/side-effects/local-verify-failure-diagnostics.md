# Side effects of retaining verification failure diagnostics

## What changes

A retained failed checkout can hold up to 64 KiB of assertion summaries and another 64 KiB of diagnostic data in its existing private failure file. The bounded diagnostics preserve recent failed process output, failed-suite context and error-reporter evidence. Limits apply to UTF-8 serialized JSON size, entry count and individual text length.

## Effect on decisions and cleanup

The existing verdict parser, admission controls and retry criteria remain the authorities. Diagnostic collection happens before temporary report cleanup. A capture exception or an exception logging that capture error cannot change the verification verdict. Failed checkouts normally rotate through the existing three-entry list. Existing cleanup failures and malformed retention state can extend the lifetime of a checkout.

## Privacy and scope

Creation uses an exclusive write with mode 0600. Known credential formats are masked before diagnostic tails are taken. A masking error or over-limit input produces an omission notice. Arbitrary sensitive text can still appear, so the file must remain private. The status endpoint and ordinary logs do not receive raw diagnostic content from the collector. Preflight helper stderr is outside the new process capture wrapper.

## Failure modes and rollback

A capped buffer can omit an early or oversized message. Reporter evidence distinguishes a valid zero count from a missing, malformed or unavailable report. A failed exclusive write can leave the diagnostic file unavailable. Reverting the collector returns future runs to the original assertion summary. Existing files retain their ordinary checkout lifetime.

## Verification

The baseline whole-file run had 131 passes and three failures. The first combined unit run had 152 passes and one failure. That fixture simulated an otherwise successful run while expecting a retained failed checkout. After the fixture supplied an actual failed case, all 153 unit tests passed. Both integration tests passed. The first lifecycle run preserved the private evidence, then received HTTP 409 when the peer queried a coordinator-only route. After the fixture queried the peer status route, the lifecycle test passed with HTTP 200 and no raw diagnostic text in the response. The original failed receipts were retained.
