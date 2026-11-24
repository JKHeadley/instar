# Side-Effects Review for Local History Preview Prerequisites

The approved local history contract calls for a private preview of a prepared conversation snapshot. This checkpoint adds a fixed reader, bounded parent supervision, destination inspection, project summaries, and private temporary-run ownership for future copy work. The checkpoint excludes HTTP routes and upload-staging integration. It adds no user entry point.

## Over-block

The reader rejects incomplete artifacts, untrusted headers, corrupt destination files, revoked admission, and exceeded resource limits. Exact writer contention is retryable before artifact input starts. A damaged but recoverable destination needs its established store recovery path.

## Under-block

Preview counts can change as the destination changes. A future copy protocol needs fresh validation, actual copy consent, and scoped write permits. Resource sampling is approximate. Temporary-run custody identifies owned artifacts but does not reserve physical disk allocation.

## Abstraction fit and interactions

The worker validates normalized artifacts and only returns bounded metadata. The store owns writer admission and reads canonical files under its lock. Parent supervision checks authorization across process boundaries and holds custody through actual child exit. Private temporary-run ownership binds exact identities and preserves ambiguous residue for recovery. Existing legacy write entry points retain their ordinary behavior. The preview does invoke the existing writer-lock helper. That helper can create a private lock database, tighten older SQLite file and sidecar permissions, and trigger SQLite's ordinary lock recovery. Future admission must budget for those effects. Conversation payloads and copy consent stay read-only during preview.

The optional write planner exposes additive allocation input metadata for append bytes, attachment files, manifest replacement, and SQLite database and journal sizing. Those fields inform the eventual physical policy and do not issue a permit.

## Signal versus authority

Under docs/signal-vs-authority.md, artifact hashes, file identities and current admission are hard protocol facts. A preview summary carries no authorization to copy. The optional planned-write mode enforces the caller's declared writer mode and uses a branded allocator. The checkpoint wires no caller to that mode.

## External surfaces and machine scope

The checkpoint creates no HTTP route or installed control. Private normalized artifacts and temporary-run identities stay on the selected machine. No content, pathname diagnostics, or process secrets are sent to an external service.

## Rollback

The checkpoint can be reverted before activation without migrating user data. Future integration must preserve custody for existing runs and account for unresolved residue.

## Evidence

Focused component tests exercised real child exit, corrupt framing and artifacts, destination inspection, project counters, and temporary-run ownership. The held integration also passed worker and staging checks with a real SQLite writer lock. Full verification and an installed app run are separate gates.

## Independent review

The reviewer concurred with the intended source scope subject to describing writer-lock metadata effects and the additive sizing fields. Both disclosures appear above. The reviewer inspected source and artifact only and did not attest to the Git index or test execution.

## Class-Closure Declaration

The unbounded-self-action class does not apply to the fixed reader. An explicit preview request owns one child and a bounded termination sequence. Transport or read failure ends that invocation without launching another reader.
