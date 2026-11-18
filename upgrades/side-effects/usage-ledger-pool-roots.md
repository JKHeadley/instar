# Side-effects review for subscription transcript coverage

**Owner** Echo

**Date** 2026-11-17

**Spec** docs/specs/unified-usage-ledger.md, Membership and Slices 1 and 2

## Summary of the change

The unified usage ledger refreshes its Claude and Codex source directories from the local subscription pool at startup and at each scan. A newly enrolled home can contain older member requests as well as live sessions. The existing readers, membership filters, date windows, round-robin file budget, and per-file checkpoints apply. This closes a measured hole on the Studio. In an isolated replay with five selected campaign transcripts the original configuration missed all 224 observations in a fixed 26-minute window.

An observation may arrive in a copied transcript before it arrives in the original. The original can promote a copied-history row to counted, using the original's detail and passing through normal pair settlement. The promotion, rollups, and checkpoint belong to the same transaction. Both orders produce one observation. Rows already counted or held, and detail replays, keep their existing semantics.

## 1. Over-block

This changes usage totals, trends, and coverage on machines where the unified ledger is enabled. Access to the existing usage endpoints uses the same authorization controls. Each machine reads its own directory registrations, including inactive local accounts with historical files. Neither pool selection, credentials, usage limits, nor session routing change. Claude and Codex are the two supported transcript readers. Other frameworks keep their existing one-shot coverage.

Polling can enumerate more local directories and there can be more files awaiting the first scan. An independent measurement of one newly eligible home found 7,255 rollouts and 404 MiB in the first 500. Processing those 500 without yielding occupied the server event loop for 1,680 ms. Directory listing runs asynchronously on the recurring production path. The async scanner now yields after each file transaction, allowing an HTTP request or a shutdown to proceed between committed files. File ingestion stays within the shared per-tick budget. The HTTP report names the machine, source directories, listing state and pending file count. A file that cannot be opened keeps a pending count. Subsequent files in the same home still get a turn. A registry read failure is observable and drops pool-only registrations for that tick. Static registrations remain eligible.

## 2. Under-block

Removing an account registration stops new reads from its pool-only directory. It preserves the ledger's earlier events and checkpoints. Restoring the registration continues from the stored offsets. The same path can legitimately be both a Claude and a Codex home. Each reader gets its own coverage and the same reader sees a shared path once. The reader skips symbolic links and reports a missing or inaccessible transcript folder as unavailable. The initial backfill is bounded by the existing age and depth policy. Listing completion and a nonzero pending count can coexist.

Reverting the code restores the previous scanner. Earlier legitimate rows already added to the existing ledger remain in its totals. There are no database migrations, provider writes, or production configuration changes. The local CLI can still read unregistered account directories outside this feature. Content membership and a session's entitled account remain independent of where a file was found.

## 3. Level-of-abstraction fit

The source inventory belongs to SubscriptionPool; UsageLedger owns its reader list, membership, checkpoints, and rollups. The server injects the local inventory into the ledger at boot. The existing HTTP report surfaces these observations at its usual scope, and labels the machine whose source folders it describes.

## 4. Signal vs authority compliance

The machine-local subscription registry supplies candidate paths. For example, a disabled account can have valid historical observations while an active account directory can contain somebody else's work. Each candidate still needs membership by recorded spawn or matching project cwd. A directory name supplies neither membership nor account identity. A foreign machine's registry or an unavailable local registry supplies no paths. This feature computes observational totals. It has no authority to change model selection, capacity readings, scheduling, or account enrollment.

## 5. Evidence and review

The isolated replay recovered all 224 fixed-window observations across five files and read no files again on the next tick. Unit cases exercise dynamic add/remove/re-enroll, foreign membership, both traversal modes, deferred files and copied histories in both discovery orders. Integration cases use the real pool, filesystem, SQLite and HTTP routes to cover unavailable peer registries and retrying an unreadable file. The feature-is-alive test boots an AgentServer and enrolls a disabled local Codex slot after boot, then checks its tokens and coverage via HTTP.

**Independent second pass, 2026-11-17** — The pacing controller independently checked the local registry and membership boundaries, HTTP attribution, and transactional promotion. It requested the coverage machine identifier and an event-loop yield between backfill transactions. After both changes the reviewer ran the new scanner on the physical account home in an isolated in-memory ledger. It committed 500 files, reported 6,756 pending, and a 5 ms timer ran 189 times during ingestion, with a longest observed gap of 106 ms. The previous batch had run uninterrupted for 1,680 ms. The reviewer concurred after verifying both fixes. A large individual transcript can still occupy the event loop for the duration of its file transaction.
