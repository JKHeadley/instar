# Telegram delivery confirmation expiry

The owner classifies the timed-out confirmation on read using the stored time at which the transport attempt became uncertain. Local and signed remote outcome reads return the same plain-language detail. The dispatch state and durable retry guard are untouched by the lookup. Older readers receive their existing unknown verdict from the same owner and retain the resend guard. Updated readers recognize the optional expiry flag.

The transition requires an ambiguous dispatched attempt with a usable timestamp. Pending requests and imported rows without dispatch evidence keep their existing classification. A later correlated receipt overrides expiry. The signed read cache excludes this verdict so later evidence remains visible. Rollback reverts the read behavior without changing stored attempts.

## Second-pass review

**Reviewer:** Independent expiry reviewer.
**Result:** Flagged loss of owner attribution on mixed-version meshes. The revised wire response retains the existing unknown verdict and adds a boolean expiry flag. The specification also records partial-delivery precedence and sender lookup scope.

The reviewer concurred after checking the revised wire encoding and the existing receipt precedence.
