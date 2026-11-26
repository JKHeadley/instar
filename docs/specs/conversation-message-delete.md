---
title: App Message Delete
slug: conversation-message-delete
author: echo
status: approved
approved: true
approved-by: echo under standing build approval for local storage, private signed admission and execution, and unmounted history projection only
parent-principle: Operator-Surface Quality
tier: 2
review-convergence: "2026-11-25T23:38:53.878Z"
review-iterations: 45
review-completed-at: "2026-11-25T23:38:53.878Z"
review-report: "docs/specs/reports/conversation-message-delete-convergence.md"
cross-model-review: "cross-model-review: codex-cli:gpt-6.2-astra"
---

# App Message Delete

The first increment hides one exact occurrence in an App conversation after an authorized person confirms Delete. It starts off. The client captures the paired machine, conversation and settled message event when the action is selected. A forwarded copy has its own occurrence. Removing one occurrence cannot remove a copy elsewhere.

## Signed action and authority

Use a device-signed action scoped to a live App conversation, exact event ID and request ID. The existing People policy supplies the current actor and row visibility. An eligible conversation owner may remove a visible occurrence. Author-based removal requires immutable historical person evidence and is outside this admission checkpoint. Establish author identity from recorded person and signed evidence, never display names or the current owner of an old device. Ambiguous or missing authorship grants no author privilege. Require active serving custody on the immutable creation machine for a first write. Same-intent retries keep the signed scope and return the recorded outcome. A changed target under the same request ID conflicts. An unresolved write cannot authorize a replacement mutation.

## Visibility and durability

Persist an immutable removal fact naming the original exact event and message IDs. Keep the fact valid if it reaches a replica before its target. Once removed, the occurrence cannot appear as visible history, an exact link or a quote preview. Apply removal to every server-side projection before exposing text, including incremental sync, search, preview, pins, reaction state, media authorization and future session context. For incremental clients, carry a removal instruction containing only the IDs needed to evict the cached row. Older readers must be kept from serving this conversation once they cannot enforce the removal fact. Include authenticated requests against stale replicas and old clients in the activation tests.

Retain original journal bytes under the existing storage policy. Message removal is a visibility action. Verify and describe what remains in historic transcripts, backups, downloaded files, and copies already sent to another conversation. Attachments must become unavailable through the removed occurrence. Shared bytes and references held by other authorized occurrences keep their own lifecycle. Removing a message does not itself request storage purge.

## Client and provider boundary

Show Delete only for a live capability and a settled row with an eligible action. Confirm on the captured target. Evict that row after an accepted response or an authenticated removal event. Leave the existing draft and other message actions intact. A denied or unavailable result must not remove a different row. The client must distinguish an unresolved request from a completed removal.

Telegram mirroring follows the App action. It requires an exact verified provider mapping and independent provider authority. Report the two outcomes separately. The App copy can be removed even if Telegram fails or is unavailable. No substitute mutation can run when the mapping is missing. Mirroring will require durable pending work bound to the same verified occurrence, and ambiguous provider acknowledgments remain unknown until reconciled.

## Related work

- Exact App message links and Reply for target identity, quote visibility and signed recovery.
- App Forward for separate occurrence identity and stale client boundaries.
- App attachment purge for reference lifecycle and authorization.
- Mobile unread and pool history for replica and incremental payloads.

## Overlapping reads and cache ordering

Name the mobile feed event `message-removed`, distinct from the existing conversation tombstone. It carries the exact removed event ID and the destination conversation scope. The paired and authorized feed establishes the account scope. Use the event ID as the merge key even when the retained message row also has a legacy message ID.

A confirmed action response or authenticated feed event records a removal marker before applying any history merge. Scope markers by pairing, conversation and exact event ID. Apply markers to the current view, delayed history pages, exact context and any restored cache. Persist the marker and evict the row together when the client has durable history. A history page cannot clear a marker or revive that occurrence, even if the page was fetched later from a lagging replica. Keep markers across pagination, cursor changes and restart. Display restored durable history for a Delete-enabled conversation only after an authenticated restore handshake obtains the creation custodian’s current sync high-water mark and the client has durably applied authorized sync through that mark. Until then, keep that cached history covered. Reconcile cached rows against current visibility before uncovering them. If current access cannot be reconciled, discard those rows and fetch authorized history. Clear markers with sign-out and when dropping the entire corresponding cache namespace, including any pending read generation. A denied or unknown action response leaves the row until an authenticated removal is observed.

## Store and read-path acceptance

Keep the immutable journal available to replication and recovery. Use a conversation-scoped removal index to determine interactive visibility before pagination. Bind each removal to the exact event and its message ID. Never infer a removal by display text, the newest row or the message ID alone. Index a removal before its target if replication arrives out of order. When that target arrives later, apply the marker before exposing it. Preserve the removal in a rebuild from the journal.

- **History and unread.** Exercise chronological browse, the unread window, direct event and message lookup, and exact context on the same removed row. A deleted row must not consume the visible page limit or revive on a peer after an older page arrives. A direct request for a removed anchor uses the same response as an unavailable anchor.
- **List and search.** Seed the removed row as the most recent message. Confirm the list preview falls back to a still-visible message or empty. Search for a sentinel string unique to the removed text and confirm it never appears in local or merged results. Keep the older visible message available.
- **Incremental sync.** A fresh reader sees the removal marker without seeing the original payload. A reader that already holds the row sees the marker after its current cursor and evicts that exact row. Exercise a stale page before and after the marker, as well as a store rebuild and cursor restart. Conversation-level tombstones retain their existing meaning.
- **Dependent content.** The target's quote previews, pin text, reactions and media authorization must stop resolving through it. A shared attachment's unaffected occurrence must still resolve. Forwarded copies in other conversations remain independent. An ordinary agent session started after deletion must omit the removed occurrence from generated context.
- **Replica compatibility.** Verify removal-before-original, duplicate replay of one fact, two different facts for one target, mismatched target identity, and a stale peer returning a prior snapshot. Keep the feature off until every serving reader can apply or respect the removal state. An older peer serving the original is an activation failure. It may retain journal bytes only while excluded from interactive reads.

## Storage checkpoint

The first runtime checkpoint defines and tests a local journal fact and its derived lookup. It adds no signed route, new network kind registration, or client advertisement. The app cannot create or project a removal until the admission, replica and read changes can ship together. The lookup distinguishes an absent matching fact from unresolved creation or index evidence. It can look up any valid occurrence fact for visibility or a specific fact ID for a request receipt. Event, derived row and byte checkpoint are indexed in one transaction. Negative proof checks the journal bytes against both indexes and caches only complete evidence for that file checkpoint and SQLite write generation. Byte disagreement or an event without its derived row yields unknown, including when the index files reopen. A route may acknowledge removal only after confirming the exact indexed fact backed by durable journal bytes.

The fact carries the conversation key, its own event ID, the exact target event ID, the target message ID, timestamp and custodian machine ID. It stores no message text. The derived table admits multiple distinct candidate bindings so a mismatched arrival cannot block a later valid one. Only a candidate from the machine named by unique creation evidence may take effect. The target event/media kind and both identifiers must match. Creation or original arriving later cannot change which IDs the fact names. Raw journal access stays available for trusted recovery, replication and writer reconciliation.

## Frontloaded decisions

The write route, when mounted, accepts one exact confirmed target and uses the same request intent at one signed custodian. Before append, persist the actor-scoped request reservation and the digest of the custodian, conversation and resolved target. The derived fact ID binds the request ID. Derive the removal event ID from the custodian, actor and request ID. A retry can acknowledge only the exact durable fact matching that reservation. Changed intent conflicts. A matching reservation with conclusively absent bytes may resume only on its original custodian after current authorization and target revalidation. Incomplete proof remains unknown. Projecting a removal into mobile sync needs authorization against the retained original access stamp, independently of whether the row itself is currently visible. Stop sync before the marker when original authorization cannot yet be determined, leaving the cursor before the fact and returning no later entries. Resume the same cursor after the original authorization evidence arrives. Consume a conclusively denied marker without exposing its IDs and continue to later entries. Recheck successful history and exact reads after awaited peer and pagination work. Before enabling Delete for a conversation, route interactive projections for that conversation to its immutable creation custodian. Fail closed while that custodian or its indexed visibility evidence is unavailable. Pool lists and search cannot fall back to a peer copy. Persist the authoritative-read requirement independently of the write flag. Keep it across disablement, transfer and downgrade, including while the custodian is unavailable. Only an upgraded custodian can serve affected interactive reads. Activation requires a version-independent front-door check that excludes incompatible serving builds, including during downgrade.

## Decision points touched

| Decision | Classification | Authority and evidence |
| --- | --- | --- |
| Exact target binding | invariant | basis: irreversible-consequence; evidence: removing the wrong occurrence can hide unrelated content. |
| Creation custody | invariant | basis: external-constraint; evidence: the existing unique creation record and active serving state identify the one admitting writer. |
| Removal proof | invariant | basis: irreversible-consequence; evidence: a negative or unreadable derived row cannot justify confirming success to the client. |
| Projection and broadcast | invariant | basis: irreversible-consequence; evidence: a raw row or unauthorized sync marker can disclose protected content or its existence. |

## Multi-machine posture

A future supported removal fact replicates through the existing App event journal. The decoder and authenticated sender must agree on custodian identity, and an index waits for unique creation evidence before using that fact. The storage checkpoint adds no network ingress. Before activation, confirm peer freshness, version compatibility, authenticated sender binding and recovery from missed replication. A local fact cannot authorize success on another machine merely because the client switched routes.

## Maturation plan

- **test-agent-live:** Enable only after the signed action and permitted reads are wired in an isolated throwaway agent. Exercise restart, out-of-order replication and cache overlap.
- **dev-agent-live:** Keep off until full candidate verification and native confirmation.
- **fleet:** Keep off pending compatible peer and client versions and actual acceptance of all read surfaces.
- **graduation criterion:** Exact confirmed removal survives reopen, replication and stale page merges without disclosing the original text or altering any unaffected occurrence.
- **dark-window:** Review within 14 days of the runtime merge and record any failed condition with the next review date.
- **ladder:** mobilePairing.native

## Signed admission checkpoint

Fresh admission runs the exact-message device authority, then checks current conversation read access, unique creation custody, active serving status, conversation ownership, the current delete grant and exact row access. It takes a signed JSON object containing exactly `custodianMachineId`, `eventId` and `requestId` on the path that names the conversation. Denied, missing, unreadable and ambiguous targets share one response once custody and conversation authority are established. An unavailable custodian returns the same result for any target ID.

The first implementation admits the recorded conversation owner. A legacy owner conversation admits its owner profile when the server has a stable named person or owner account identifier. A named owner must match the current signed person in the creation machine namespace. The pairing namespace and serving machine ID must agree. Broader conversation grants do not confer ownership. The existing device signature binds the sending key and original request, but does not authenticate a historical person assignment. Author-based admission must wait for immutable person evidence so that reassigning a device cannot transfer a former person's removal rights.

The admission result is internal. It includes a derived fact ID bound to the custodian, signed pairing, current person identity and request ID, and a digest that also binds the conversation and exact message occurrence. A later handler must persist and compare these values before touching storage. The namespace uses the signed device key and named user ID, or owner account identifiers for unnamed owner profiles, so an owner account change does not inherit the old namespace. The fresh-admission helper issues no receipt and does not reserve, append, advertise or expose a production route. This keeps the storage and authorization checkpoints separate from the visibility change. Retry and recovery will run before fresh admission when the client already has a recorded request. They still require current signed scope and must not disclose original text.

## History projection checkpoint

Use an explicit removal-aware read on the creation custodian. Read the page or exact candidates from the same SQLite snapshot used to establish removal integrity. Filter by the authoritative machine, conversation, event ID and message ID before applying the page limit. Derive the backward cursor from the last visible tuple selected by the query. A missing integrity proof must produce an unavailable read, never an unfiltered fallback. Raw journal reads stay separate for receipt recovery and replication.

Exact context starts with the authorized anchor. If a known removal matches that anchor, return the same unavailable result as a missing or unreadable target. The earlier-message query uses the visible window, but the server must also recheck the anchor and every returned row against current removal evidence immediately before sending a response after asynchronous work. A changed snapshot must be retried or refused as a whole. A legacy identifier that can name multiple rows must remain ambiguous until the ordinary access check resolves it.

Use one fixture across browse and exact context: insert an older visible row, a visible anchor and a newest removed row. Fetch a page of one row and require the visible anchor, with the older row available on the next page. Direct exact lookup of the newest row must be unavailable. Add a second fact with the wrong target message ID and verify that it cannot hide the older row. Then add a valid removal of the anchor while the context response is paused, and require the response to withhold it. Exercise a replica with no removal evidence and prove it cannot act as the authoritative read source.

The local projection checkpoint provides store methods for custodian-only browse and exact candidates. It changes no app route. The cold proof compares the journal checkpoint and removal and message identity bindings. It makes no claim to detect same-length content edits that preserve those bindings. App journal retention and origin verification retain their existing responsibilities. Before interactive use, bound proof cost or move it off the request path and measure a realistic large-history and multi-conversation workload. An ordinary app read keeps its existing projection until the full visibility boundary is ready.

The unmounted store keeps up to 64 recently used history proofs, one per conversation. A cached proof is reused only for the same journal checkpoint and SQLite write generations. Rebuilding the index clears every entry. Alternating between conversations on an unchanged index can reuse their proofs, while ordinary writes continue to invalidate them. This cache does not bound the first proof scan or make the projection ready for request-path use.

The next unmounted checkpoint separates proof preparation from interactive reads. A cold read returns unavailable without scanning. A caller may request proof preparation after admission, with one active scan per store and coalescing for the same conversation. The scan yields after each journal chunk and compares file identity, journal metadata, local SQLite writes and external data version before each batch and at publication. Changed, missing or corrupt evidence never publishes a proof. After preparation the read repeats the checkpoint check around its indexed selection. This does not mount a route or change receipt recovery.

The store-wide write generation conservatively invalidates preparation even for unrelated chat writes. Measure readiness under ordinary sustained writes before mounting the route. The startup count query is synchronous within the first scheduled turn and remains part of the first-turn performance measurement.

The local store can classify a successful plain-message append as scoped to its own journal and indexed conversation. Such an append does not invalidate proof for a different chat. A change to the target journal still invalidates its proof. All other local writes, failed indexing, catch-up and external SQLite commits keep the conservative invalidation rule. The exception covers only the known committed index transaction, while retained receipt proof remains unchanged.

## Private signed execution checkpoint

Current signed identity, conversation ownership, read/delete grants and creation custody are checked before a request record is read. The request namespace belongs to the original pairing and current person. An existing request compares its original intent using the conversation, exact event and stored message binding. A changed intent conflicts. A previous success or an interrupted reservation can yield a receipt only after the store verifies its exact durable removal fact. The receipt returns only the target event ID and removal event ID. An uncertain reservation never appends again. A fresh request checks its age and exact row visibility before reserving, then appends one local fact. The private signed fixture reopens the request store to test completed and uncertain retries. Mounting the route still depends on removal-aware history and sync.

A fresh request must prove that the target has no prior effective removal. A prior removal produces the same unavailable answer as a missing row, and unsettled index evidence produces a temporary failure. A reservation that remains entered when the process ends is unknown on reopen because the new process has no matching active entry. It can return a receipt if the exact fact is proven. This checkpoint deliberately leaves an interrupted request unresolved even when absence can be proven. It never resumes an entered request by appending again. The private executor checks absence through a prepared background history proof before reserving a fresh request.

Receipt recovery also checks current access to the retained target row. Current conversation access alone cannot expose its receipt. The ledger retains request bindings until 24 hours and five minutes after the request timestamp; fresh admission accepts IDs no older than 24 hours. If lookup prunes a record after it was read, the attempt returns `request-id-too-old` without fresh admission. An expired ID cannot reserve another intent.

The executor verifies current owner scope and the target's row access before starting background preparation. It repeats signed scope, active custody, request lookup and removal-aware row checks after the await. If a durable request appeared while preparation was running, the existing request wins. Reservation, append and exact positive receipt proof are synchronous after the last authorization check. A stale or absent prepared proof fails closed without starting any synchronous journal scan. Prior requests need only exact positive fact evidence. A missing fact leaves the outcome unknown without a full journal scan.

The private executor serializes reservations in one serving process. An App creation custodian and serving lease identify a machine, so they are insufficient on their own to exclude overlapping processes using the same state directory. Before mounting the route, wire and revalidate the server's boot-acquired `SingleInstanceLock` at the mutation boundary, fail closed on a missing or lost lock, and prove that a second process sharing the state directory cannot reserve or append. The private in-process fixture cannot establish that property.

## Private writer-lock checkpoint

The private executor requires a server single-instance lock. It revalidates the lock against disk after initial signed scope and after preparation, immediately before reservation and append, and before writing a receipt or unknown state. If the lock is lost after reservation, the old process reports an unresolved result and leaves the durable entered record for the next process. It must not rewrite the shared request store after losing custody. The private HTTP fixture uses an acquired real lock. In a distinct Node process, a contender using the same state directory is refused while the writer lives. This checkpoint does not mount the production route. Production construction must supply the boot-owned lock and exclude deliberate second-instance bypass mode.

The private executor rejects a lock for a different state directory and rejects a deliberate bypass acquisition even when that acquisition can read its own lock record. Normal lock checks establish cooperative ownership. They do not fence a lock file replaced out of band. Before mounting, close or explicitly prove out live-ownership replacement during simultaneous start and stale reclaim in the shared lock primitive, then run the production-wiring two-process proof.

## Atomic process-lock publication checkpoint

A fresh server lock is published by linking a complete, unique temporary record to the canonical lock name. The filesystem creates the destination atomically only when it is absent. A competing publisher cannot replace the active record, and the temporary name is removed on a best-effort basis. A leftover temporary name confers no ownership. A filesystem that cannot publish the link denies acquisition. The empty-directory startup test releases two independent Node processes together and confirms that only one claims and retains the record. This change addresses fresh publication. Stale reclaim still uses the existing verification and removal path and must separately exclude replacement of a newly live record before Delete is mounted.

## Serialized stale process-lock recovery checkpoint

A stale reclaimer takes a non-waiting SQLite write transaction on a host-local mutex adjacent to the lock. While holding it, the reclaimer re-reads the canonical record, requires the same owner, process start and heartbeat, and rechecks liveness before removing it. Only this stale-reclaim section uses the database. The database contains no application records and is intentionally retained so all processes take the same OS-backed mutex. A process exit releases the transaction. A fresh publisher can acquire the free filename after stale removal, and atomic no-replace publication prevents overwrite in that case. Busy or unavailable mutexes fail closed and use the existing bounded acquisition loop.

This protects cooperating updated processes sharing one host-local state directory. Production Delete mounting still requires all processes that can open that directory to use the updated primitive, the actual boot lock to be wired, and authoritative history and sync to be enforced.

## Private message-change sync projection checkpoint

Use the same prepared custody proof for an indexed sync page. The proof verifies journal sequence order against the index. The page also verifies the indexed identity and sequence for each returned source event. A missing or changed proof yields no page. Apply the current row access predicate to the retained occurrence before returning its content or its removal marker. Suppress removed content even for a reader starting before the removal.

Emit one exact marker for the earliest matching removal by the creation custodian, at that fact’s original ingest position. If its target or authorization is unresolved, mark the page blocked, retain the cursor immediately before the fact, and withhold all later entries until it can be resolved. A conclusively denied marker advances without revealing its IDs. Signed route wiring must bind cursor validity to the current reader visibility and cache epoch before the client can reuse a cursor. The marker contains only the kind, conversation key, removal event ID and exact target event ID.

This private projection covers message rows and exact removal markers. It does not replace generic App sync or define client cache restoration. Production mounting still needs a signed scope and serving-lease check, approved wire sanitization, cursor scope and consistent removal enforcement across the related event and read surfaces. The existing dark generic events route explicitly omits raw removal facts.

An otherwise visible message whose authorization is unresolved likewise blocks before its sequence and can be retried from the held cursor. When the visibility epoch changes, an already open client must cover its affected cached rows and reconcile them under current authorization before showing them again. Verify this with a conversation kept open across access revocation and removal. A conclusively denied marker never reveals its IDs.

## Private signed sync cursor codec

The cursor is authenticated by a process-local server key and binds the immutable creation custodian, conversation, paired device ID, device key hash, reader ID and exact nonnegative ingest sequence. It carries an opaque visibility epoch derived from the same scope and a distinct current authorization revision. The revision source must change on access loss and restoration even if the final grant set looks identical. A valid cursor from the same scope under a former epoch requests reset. Foreign scope, malformed, modified and former-process cursors cannot resume. The authenticated route must make a rejected continuation cover the affected cached rows and restart reconciliation and omit the sequence from rejection and reset responses. The issued token authenticates the sequence and does not conceal it. A new epoch never clears confirmed removal markers in the same pairing and conversation.

This codec remains unmounted. Production must create one codec instance per serving process and share it across issuance, verification and authoritative history and sync epochs. Supply a current visibility revision, verify paired scope, and invalidate the epoch if journal restoration may reuse sequence values. In the open-client acceptance test, hold an old authorized page, revoke access and reconcile under the new epoch, then release the delayed page. The client must check the response epoch at merge time so the revoked row stays absent. A valid token authenticates resume state rather than granting read access.

## Private Team Access revision checkpoint

The Team Access Log exposes a conservative, process-local visibility revision. A new log instance starts a fresh identity. Loading, accepting new rows, changing the verification fold, rebuilding, restoring or changing the confinement record advances its revision. The counter is log-wide, so unrelated access events may also require reconciliation. Normal reads with no new evidence are stable. A grant removed and then restored still produces a new revision even when the effective grant matches its original value.

The cursor can consume this log revision, but it is only one input to final route authority. Production must also account for changes outside this log, including legacy access or temporary policy/refusal changes, current pairing and reader state, and journal restoration. No route is mounted in this checkpoint.

Use an independent revision for key-ledger and verification authority. In particular, the current log fold may not observe every verifier transition while its pending-row count is unchanged. A stable log revision alone cannot prove that verification authority is unchanged.

## Private device-key evidence revision checkpoint

The paired-device key ledger exposes a process-local verification revision for a readable and stable ledger containing recognized rows. The underlying file checkpoint includes device, inode, size, modification time and change time. Revision issuance compares it before and after accessing the current row cache or parsing the file. Missing, malformed or unstable evidence yields no revision. Ordinary ledger reads keep their existing tolerance for malformed rows, and callers receive detached rows rather than mutable access to the cache. An accepted activation or revocation invalidates the prior observation; duplicates do not. Replacement by another file cannot reuse a revision even if the data is the same.

This is evidence about the device-key ledger, not complete verifier authority. Production composition must also include the pinned machine key registry, current pairing and access policy, and the journal incarnation. A missing revision cannot authorize continuation. No route consumes this value yet.

On a ledger cache miss, compare the descriptor with the observed file checkpoint before and after reading. Compare the canonical path again before publishing cached rows. A path swap cannot populate the cache with records for a different file. The revision also checks the cached evidence against a fresh canonical checkpoint.

Before mounting the cursor route, define how connected clients receive a visibility invalidation while idle and how they renew a bounded display lease. An open client must cover the affected rows after invalidation or detected disconnect, and no later than its last authoritative display deadline even if the connection fails silently. Exercise revocation with the chat open and idle, including a lost connection, when verifying client integration.

Before mounting removal-aware sync, specify a bounded authoritative reconciliation path for a marker whose original never arrives. A snapshot reset must cover and rebuild the client's affected cache under current authorization, allow later visible messages to be read, and retain the unresolved removal separately without sending its IDs. Verify a permanently unavailable original followed by a later visible message. The private incremental projection still holds before unresolved evidence.

## Private machine trust evidence checkpoint

Use IdentityStore’s historical signing-key rules. The identity epoch store and identity files supply the lookup, while the registry checkpoint independently invalidates its revision. Registry entries do not override retained key history or grant membership in this helper. Limit raw input to 64 IDs, then canonicalize the set and cache up to 64 scopes. Verify the descriptors used to read the captured records against the initial checkpoint. Check canonical files again after capture, and couple the revision with the exact captured lookup. Refuse capture or reuse while an identity transaction journal exists. Construct the observer at controlled boot, since opening the identity store can recover a pending transaction. This lookup does not use the existing timed historical cache. A previous snapshot stays immutable. An unreadable or changed capture yields no protected cursor authority.

Before mounting, derive the complete machine set from current signed authority evidence and revalidate the revision before returning a page. Compose it with the Team Access revision and device-key evidence. The shared Team Access verifier must re-evaluate affected rows against the current captured lookup before a refreshed epoch becomes authoritative. This checkpoint supplies fresh signing inputs, and does not certify current membership or serve a route.

Protected signer capture rejects a malformed authority map, a present malformed machine epoch and malformed signing cutoffs. A missing epoch entry can still use the established pre-history fallback. When production establishes a display deadline, renewal must authenticate sync through the current custodian's high-water mark so a missed removal can expire or cover an idle view even without an access change.

## Private signed owner sync authority checkpoint

Resolve the current owner from the signed device, then require the recorded conversation owner, ordinary read access and a live App conversation on its active creation custodian. Legacy owner conversations use the same owner fallback as Delete admission. A stable owner account binds the reader field. Compose ledger, machine trust, journal and any configured Team Access revisions. A missing provided revision cannot resume sync. Evidence sources are read-only dependencies owned by the caller. Compare two complete revision samples, then recheck current signed owner, conversation liveness, creation evidence and serving custody before returning authority.

This checkpoint uses the signed owner in a private HTTP fixture and does not mount a sync route. Both the current owner profile and recorded conversation ownership are required. A person who remains the recorded owner but changes to a team profile is refused in this checkpoint. Before mounting, supply production evidence providers, revalidate the composed authority around any awaited preparation and bind history and sync to the same epoch. Do not use the authority result as a response body.

## Private signed owner sync page checkpoint

The private executor validates the signed owner and cursor, prepares removal-aware storage, and re-resolves authority before projection and again before issuing a response. It also checks that the prepared journal proof remains current after the final authority observation. It supplies the validated numeric cursor directly to the store. A stale epoch returns a reset with no page, and an unavailable proof returns a temporary failure with no continuation.

The fixture emits text, role, time, message ID and event ID for visible messages, and only the existing exact fields for a removal marker. It deliberately omits media, related events and client cache readiness. Nothing mounts this executor in production. The live route still needs authoritative history wiring, a bounded high-water handshake, a rule for a permanently unresolved marker and client epoch reconciliation.

The final check compares the exact proof used by the selected page. A replacement proof cannot bless older rows. In the owner-only fixture, an unexpected row access refusal is indeterminate and holds the cursor. The removal fact ID deduplicates delivery of the marker, while the target event ID identifies the row to evict. Neither an empty page nor `blocked: false` proves catch-up. The production handshake must separately verify the current high-water mark before opening cached history.

## Private signed high-water checkpoint

The private sync page observes the current conversation high-water mark inside the same prepared journal/index snapshot as the page. The server authenticates the high-water identifier under a distinct purpose, so it cannot be reused as a continuation. An input cursor beyond that snapshot cannot yield a page. A page is caught up only when its continuation equals the observed high-water sequence and no unresolved entry blocked it. An empty page that only consumed filtered records can still fall short.

Only a caught-up response offers a private maximum display budget of 30 seconds. A client must measure the budget from the monotonic start of the request and durably apply authorized changes through the matching cursor before uncovering cached history. A stale response cannot restart the timer. Detected disconnect or access invalidation covers the affected history immediately. The budget expires if the connection fails silently or a new removal is missed. The fixture does not mount this protocol or authorize a client to uncover stale rows. Production still needs cursor renewal, a client acceptance run and the bounded snapshot reset for permanently unresolved history.

A new authoritative read suppresses the removed row. An already open client evicts on an authenticated removal and covers on detected invalidation or disconnect. If it misses the notification, it covers by the deadline measured from renewal request start. For client acceptance, deliver the response at 29 seconds and finish writing the page and cursor at 31 seconds. The durable changes may commit, but the client keeps history covered until another qualifying renewal. The production response must be non-cacheable.

## Store-backed journal revision checkpoint

The signed private page uses the App store's real journal revision by default. It observes the indexed file's device, inode, size and write timestamps. A known local append can carry the current revision forward only when it starts on the exact observed file descriptor, commits the journal bytes and updates the index. Ordinary appends then advance the page frontier without invalidating the cursor. Unknown replacement, mismatched index bytes and rebuild require a refresh. The bounded observed revisions are local to the store.

The production server constructs this same store. Its lifecycle test verifies the underlying revision while the route remains inactive. The private signed test exercises the actual revision instead of a constant, including invalidation after rebuild. Production still needs the other authority providers, read-surface enforcement and route activation.

Carry-forward checks the prior indexed size and proves that the same descriptor grew by exactly the event's byte count. Journal repair and restore must be offline or cooperate with the exclusive writer. Concurrent in-place rewrites by a separate process cannot be authorized as normal appends.

A short write is rolled back before indexing. Eviction from the bounded revision cache can require reconciliation when revisiting an otherwise unchanged conversation. The revision is not a content hash and does not authorize an out-of-band rewrite during append. The production lock and restore policy both apply before mounting.

At first activation, an older disconnected client may still display a copy accepted before this protocol existed. The server cannot retract an offline pre-activation copy. The live display guarantee applies to views already enrolled in the deadline protocol. Before first deletion, verify how the supported clients enter that protocol and test a connection lost immediately before activation. Legacy offline copies remain subject to the existing cache and retention policy.

## Private signed first-history-page checkpoint

An owner-only history fixture shares the signed sync authority and epoch codec. It uses the exact prepared journal proof from the selected page. It rechecks owner, custody and epoch after preparation and after row selection, then revalidates the selected proof. A concurrent removal can invalidate that proof without resetting the epoch. If a row's access is uncertain, refuse the page without returning either the row or a pagination position. This fixture returns a bounded first page, applies no-store and cannot renew a display deadline. It does not mount the production history route or decide the wire contract for older pages and exact reads.

## Isolated server-router acceptance

An in-process development-server hook enrolls synthetic conversations for the owner-only first page and sync on the normal App URLs. It shares a boot-scoped codec and uses the real ledger, journal, Team Access log and the machine trust revision for the synthetic single custodian. Enrollment sticks for the life of the acceptance process, and an enrolled route never falls back to legacy history. Normal CLI boot does not supply the hook. No removal write, production enrollment or capability advertisement is added. This proof covers these two HTTP projections. It leaves other read surfaces and the preactivation requirements in place.

The isolated router also serves exact context under the signed sync epoch. The exact anchor, its adjacent rows and the older boundary use one prepared custodian proof. The store excludes removals before it takes the bounded window. The response is refused if the proof changes or row access is uncertain. A removed or missing exact anchor has one unavailable outcome. Related previews and link issuance still require separate enforcement.

On the isolated server, link issuance derives its conversation key from the validated App reference and applies the same exact anchor proof as context. Removed and missing targets share the existing link-unavailable response. The live HTTPS link contract stays the same for a surviving anchor.

The isolated reply-preview route selects the requested reply bases and quoted originals under one prepared removal snapshot. It checks the same signed epoch as history and sync. A removed base is indistinguishable from an absent base. A surviving base whose original has been removed returns the established unavailable quote state without original text or target identifiers.

The isolated notification-preview route reads an exact agent message by message ID under the signed custodian proof. A removed target and a missing one produce the same unavailable response. Bearer and notification-only credentials cannot authorize this acceptance path. Before production enrollment, verify the generic fallback for notifications that lack a current signed owner read.

In isolated protected history, a pin only appears if its exact message ID resolves to a surviving readable App row under the page's prepared custodian proof. Rebuild preview text from that row. Do not reuse the saved pin preview. Loss of the page proof prevents delivery of the entire history response, including pins.

On the isolated server, signed owner reaction reads use the exact target and prepared custodian proof before returning actor state. Removed and missing targets share the unavailable response. Enrolled reaction writes stay unavailable until they have removal-aware mutation admission.

Isolated keyword and meaning search omit enrolled App conversations until authoritative search is available. An authorized exact-scope request is unavailable. A broad search keeps eligible results from other conversations and indicates partial coverage. Apply enrollment to local candidate selection and peer results, and recheck already selected local hits after waiting for peers. Share process-lifetime enrollment with history and sync. This is not the durable production custody rule.

A prepared media lookup joins each non-purged attachment occurrence to the exact App message in the named conversation and excludes only removals from the creation custodian. Verify the index entries against the attachment recorded on the surviving row before authorizing a matching hash. A second readable occurrence can qualify the same hash. Return the exact journal proof for caller revalidation. The store helper does not mount download or session-copy enforcement.

The isolated App download route verifies the signed custodian and exact surviving occurrence before locating bytes, then rechecks both after opening the file and before sending headers. A disappeared or changed proof returns the same absence as a missing file. Local byte-range semantics stay the same. Session copies, other media projections and already admitted streams are outside this checkpoint.
