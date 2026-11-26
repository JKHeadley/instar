# Side-Effects Review — Durable Local Conversation Identity

Date: 2026-11-23. Author: Echo. Tier 2 under the approved, converged local-history-native-contract specification. Five independent perspectives reviewed crash behavior, compatibility, private boundaries, storage bounds and test integrity. This component adds durable provenance to the existing private writer; it does not expose a native import action. The source changes comprise one identity module, the private store and protected-file lists, with semantic unit, HTTP and lifecycle fixtures.

## Decision-point inventory
The existing writer gains a durable identity invariant before local-session append: stable owner, source and original session identify a destination; project, parser representation and contract version cannot silently change. A real SQLite writer transaction must remain held through append and flush. This is data integrity, not permission to import. Current owner admission, signed transport and fresh confirmation remain separate requirements of the same ongoing topic 143810 implementation.

## 1. Over-block
Unknown, missing, corrupt, oversized or incompatible claims refuse re-import instead of assigning provenance to existing bytes. Legacy unscoped local rows are never adopted or merged into an owner-scoped destination. A valid empty claims database with no orphan destination data can initialize after an early crash. An existing legitimate archive import remains compatible outside the callback API; inside a writer callback it must retain that callback’s actual lease. A callback with dirty local bytes must flush explicitly.

## 2. Under-block
A claim is not an authorization grant, source authenticity proof or native host proof. Callers must obtain those through the approved native flow. An actor who can rewrite the entire private agent state is outside this component’s boundary. No availability, upload endpoint, native screen or acceptance proof is asserted by adding this helper.

## 3. Level-of-abstraction fit
The claim commit belongs inside ImportedHistoryStore’s existing cross-process writer lease. It commits independently before destination append, so a process death between append and manifest publication cannot erase source identity. Owner-hashed keys separate people without probing the existence of another person’s unscoped legacy reference. The fixed claims SQLite database is private state, not a content index or replicated record.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. These are enumerated structural and idempotency invariants on stored bytes, covered by that principle’s hard-invariant and transport-idempotency exceptions. They do not evaluate message meaning or an agent’s intent and add no conversational authority.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Equality of the recorded owner/source/project/parser contract and possession of the actual writer lease are mechanically enumerable invariants.

## 5. Interactions
The claim database uses the existing private import directory validation and inode protections. Fixed database and sidecar names are denied through key-material file serving and alias checks. Read lookup never creates storage or changes its permissions. SQLite itself performs hot-journal recovery under query-only logical access; application code never removes a live journal or guesses a process identifier. A live writer causes the existing busy refusal or exposes only committed values. Same-instance reentry is refused, lost physical leases reject local and callback-scoped archive writes, and failed dirty callbacks clear cached state while retaining claims and appended bytes for a fresh retry. Length validation uses octet_length directly to avoid loading a damaged large cell before rejection.

## 6. External surfaces
No public endpoint, action, command, availability flag or agent-awareness feature is enabled. Existing legacy APIs continue to hide local-format rows. HTTP tests use the actual stored opaque references and prove owner and agent detail paths reject them. No content, owner identity, original id or project path is logged by the helper. No automatic external messaging occurs.

## 7. Multi-machine posture
Machine-local by design: claims bind the private imported-history bytes on the destination machine and remain under the existing excluded private-import namespace. They are not replicated, backed up through shared state, or inferred from a peer’s files. Stable owner identity is independent of a rotating transport key. No status, health, capabilities, channels, URL or user-notice surface changes.

## 8. Rollback cost
The feature is dark and this commit adds no live caller. Revert code before enabling the native action. Preserve any existing claims and local destination bytes together; never delete claims to make an incompatible import appear valid. No migration is needed for archives. Existing installed key-material ignore migration consumes the extended protected list.

## Evidence
The final focused run passed 37 source-claim tests, 46 archive-store tests and 10 SQLite wiring tests. Tests kill real child processes after append and during SQLite journal spill, reopen in fresh stores, verify exact-once keys and original committed identity, exercise actual lost leases and reentry, and reject unsupported/forged/schema-damaged state. A real 64 MiB damaged-cell test exceeded its memory bound with CAST and passes with direct octet_length. Eleven real HTTP tests and production lifecycle coverage protect existing archive behavior and the absence of local legacy access. Complete suite verification remains required before publication or availability.

## Second-pass review
Reviewers: review_import_verification_repairs, review_local_claims_crash, review_local_claims_compatibility, review_claims_storage_bounds and review_claims_test_integrity. Findings led to removing the unscoped existence probe, checking actual opaque HTTP references, closing archive lease loss and same-instance reentry, avoiding oversized cell materialization and recovering valid empty initial storage. The final crash reviewer confirmed all three final boundary findings closed and found no further concrete issue. Reviewers did not claim to run tests; test evidence above is from the primary agent.

## Conclusion
This is a verified supporting storage component. The complete native workflow remains active work under topic 143810 and the approved contract; no user-facing import availability is claimed.

## Class-Closure Declaration
No agent-authored prompt, hook, config, skill, standards-text defect or self-triggered controller change — not applicable. Crash recovery delegates to SQLite and explicit caller retries; no autonomous retry controller is added.
