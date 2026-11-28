# Local Verify per-peer offer ceiling

The coordinator reads the configured peer entry and its existing fresh resource-fit score immediately before reserving a run. A configured ceiling allows a new offer only for a finite, nonnegative score strictly below the ceiling. A missing measurement or an invalid configured ceiling holds offers to that peer. The ceiling augments the existing resource checks and does not increase the global limit.

This makes a local configuration value an additional admission condition. It grants no authority to a peer and changes no lease, authentication, signer, result import, or accepted reservation behavior. Existing peer entries can omit the field. Removing the field restores the earlier behavior for new offers. No persisted result schema changes.

The coordinator journal records the peer, score, ceiling, and refusal reason, with the existing peer-skip interval as a rate limit. Invalid settings also reach the existing degradation reporter.
