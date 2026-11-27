# Convergence Report — Web Chat Pending Sends Survive Tab Closure

## Cross-model review: codex-cli:gpt-6.2-astra

Actual local Codex subscription reviews ran and found material issues. The author and all internal reviewers also ran in the GPT family, so the helper's crossFamily=true is NOT evidence of cross-vendor diversity. Gemini was not authenticated; the configured Anthropic clean-door reviewer was disabled and was not enabled merely to manufacture assurance. One closure attempt timed out. The latest available complete outside opinions said SERIOUS ISSUES; their individual findings and concrete resolutions are below, not hidden as an outside approval. Final internal closure and the final exact-body outside receipt are recorded in the verdict. No runtime or tests existed at design closure.

## ELI10 Overview

The web dashboard currently keeps unfinished sends in storage that goes away with a tab. It also clears your text before protecting your selected files. The new queue saves the message and file bytes encrypted before clearing the composer, then resumes that same operation when the approved browser reconnects.

Recovery must not create another message, borrow another browser identity, revive content after sign-out, or execute an old stop against a new session. This design keeps those cases separate and retains uncertain messages for review. Automatic recovery uses browser-wide ownership; browsers without that capability keep saved content and offer explicit recovery. This is unsent content only; received-history caching remains outside this assignment.

## Original vs Converged

Review found that stable client IDs were insufficient because the media route created an upload before recording its request. The server foundation now reserves first and holds uncertainty. App/Slack stops also need the age check outside their feature/rate exemptions.

The original proposal underestimated cross-tab ownership, logout and downgrade ambiguity. The final design uses durable epochs, cleanup-pending fencing, a required origin-wide automatic-work lock, a local review generation after restoration, and retirement of old plaintext sources. It separates fresh signing headers from frozen operation IDs, read reconciliation from exhausted writes, and a current stop from a deferred one. Queued messages keep durable-admission order with an explicit user override.

## Iteration Summary

The large Tier-2 design used six correction/closure cycles. Each original reviewer artifact below retains its declared DESIGN/PRECISION counts; duplicate findings across perspectives are not added as distinct defects. Several focused correction reads occurred inside a cycle, and their actual files are preserved rather than falsely represented as full six-agent rounds. All six perspectives received final closure review. This sequencing differs from the skill's ideal full-six-at-every-intermediate-cycle cadence; no missing perspective is represented as having run. Final closure, rather than an invented clean intermediate round, is the approval basis.

| Cycle | Material changes | Inspector / outside evidence |
|---|---|---|
| 1 | Upload reservation, stop expiry, completed-chunk reconciliation; initial six-lens review | Inspector ran 102 standards; outside r1 ran, 4 DESIGN |
| 2 | Session-bound epoch, import receipts, bounded failure recovery, exact credential choice, status reconciliation | Inspector ran; outside r2 and r2-final ran, 7 DESIGN and 1 PRECISION total |
| 3 | Invalidate before erase with pending-cleanup fence, fresh headers, deferred stops, actual outcome counters, supported rollback | Inspector ran; outside r3 ran, 3 DESIGN and 1 PRECISION |
| 4 | Committed-entry ordering, explicit override, retry exhaustion survives reconnect, all definitive key cleanup | Inspector ran; outside r4 ran, 4 DESIGN |
| 5 | Origin-wide automatic ownership, no-lock explicit fallback, per-profile restoration generation and HMAC index | Outside final timed out; final-locks ran, 4 DESIGN |
| 6 | Stop evidence unknown holds, independent read/write budgets, legacy retirement; final six-perspective closure | Inspector closure ran; outside closure ran, 3 DESIGN and 1 PRECISION, resolved below; final exact-body receipt pending |

## Proportion

Tier 2 / LARGE, browser persistence and signed send recovery across text/media and three routes. Six design cycles reached the tier cap. Outside correction reads exceeded a cheap wording pass because they exposed concrete data-loss/duplicate-effect foundations. Stop review once final material findings are resolved; do not iterate on wording or add unrelated history storage.

## Left behind

- Ordering starts at successful durable admission; it does not reserve an ordering ticket before another tab finishes uncommitted file preparation.
- An already network-admitted first stop can be delayed in transit. This increment prevents recovery from dispatching saved stops; it does not introduce target-bound server stop authority.
- WebCrypto origin-local encryption cannot protect against trusted origin script or an OS administrator.
- A full historical downgrade cannot report what its old sign-out did. Restoration must advance the recovery generation with draining disabled; each browser profile reviews its old generation locally.
- Retry defaults remain reversible operational brakes, not proof an eighth attempt is unsafe. Exhausted content remains visible and explicit same-ID renewal is possible.
- Physical HTTP/server work can outlive client deadlines. Seven attempts bound admitted target attempts, not all server work or elapsed time while a browser is closed.
- Browser profile/site-data deletion or eviction is not remote backup.
- Live Telegram/Slack display and released-user interaction remain rollout gates, not claims earned from provider fixtures.

## Full Findings Catalog

Original internal findings and outside text follow verbatim from review artifacts; resolutions refer to the final design, not yet-written runtime. All internal reviewers inherited the author session's actual GPT model; no Claude run is claimed.

### Internal artifact: review-final-adversarial.md

# Final Delta — Adversarial Review

Reviewer: independent child agent, inherited GPT-6.2 authoring-family model. Read the final delta in the full current spec. No tests, source or spec edits.

## Verdict

**Zero DESIGN findings.** The final changes preserve effect safety while stating coordination and rollback limits honestly. The substantive round1–4 findings remain resolved; no new material contradiction was found in this delta.

## Delta re-inspected

- **Automatic ownership is now a real capability.** An origin-wide Web Lock is required around active automatic preparation, part decryption and network steps. A tab acquires ownership before the active work, uses one chunk buffer, releases the buffer before ownership, and rechecks epoch, identity, row and attempt state on acquisition. Cooldown waits release ownership. This avoids treating logical server idempotency as proof of bounded origin-wide automatic memory/concurrency.
- **No-lock fallback is explicitly manual.** Without Web Locks, automatic recovery emits zero HTTP; durable content remains held with an understandable browser-capability explanation. Explicit bounded Resume original request retains IDs, bytes, identity and CAS attempt admission. Simultaneous user-driven physical requests can still occur, but server start/chunk/final-send idempotency bounds their logical effects. The spec no longer claims an origin-wide physical-memory bound for that manual fallback.
- **Fresh emergency controls do not wait behind queue ordering.** Only the fresh live submission path can invoke one immediate canonical stop attempt after durable admission, bypassing earlier conversation ordering. If that path cannot run, files require deferred preparation, or the operation later becomes deferred/uncertain/offline/reloaded, it holds. Finishing an older upload cannot release it. A saved stop's general manual fallback must continue to obey this specific rule: use text in composer and a new current Send, not Resume of an old stop. This is already explicit in the stop section.
- **Queue order has an honest boundary.** Successful durable admissions receive transactional sequence order. Concurrent uncommitted preparation does not reserve a position. The test commits the earlier attachment entry before delaying its upload and admitting the correction; no cross-tab wall-clock click-order claim is made.
- **Historical restoration requires a concrete safe deployment step.** A full historical downgrade is unsupported, rather than falsely inferred safe from active key status. Restoring the new release must start with outboxEnabled=false before it serves queue-capable clients; status then prohibits queued HTTP until explicit review and re-enablement. The exact step and zero-attempt test belong in the rollback artifact. This is a deployment precondition, not a fabricated detector of prior old-client logout. Supported flag-off rollback retains epoch/logout/device-cleanup shims.
- **All definitive same-enrollment key deletions clean the same identity's outbox.** Revocation/Forget and same-machine declined/expired/not-found use expected-key fencing and ordered cleanup before signing-record removal. An answer from another machine preserves the local identity. Late cleanup cannot delete a replacement enrollment.

The prior original-ID/frozen-body/fresh-signature distinction, request-age-before-NEW-effects floor, reserve-before-upload allocation, completed-upload status reconciliation, epoch-before-erasure and pending-cleanup fencing remain unchanged and appropriate.

## Precision and proof limits

The opening's general chunk-idempotency shorthand still has the detailed completed-status qualification later in the design. It is a wording qualification, not a new design issue. Manual no-lock recovery tests should include the negative exact-stop case so the general fallback cannot accidentally override the more specific stop rule.

This reviewer did not launch any tests. Actual browser persistence, Web Locks ownership, zero-auto-HTTP no-lock behavior, manual effect idempotency, rollback flag-off behavior and provider/HTTP acceptance remain implementation evidence requirements. This review does not establish shipped or live behavior.

## Final closure re-read — four outside findings

Re-read the actual final body after the last four changes. **Zero unresolved DESIGN findings.**

1. **Stop-set changes across releases:** the entry persists exact-stop membership at admission and checks the fresh canonical set before every recovered final POST. Membership at either point holds for a new current explicit Send. Therefore removing a phrase cannot silently revive an old stop, and adding one cannot turn a previously ordinary saved entry into automatic emergency control. The check is still the server's exact canonical set, not a new heuristic authority.
2. **Absent browser profiles during historical restoration:** the server's recovery generation is captured per entry and must match fresh support before every recovered attempt. Restoration requires flag-off plus a new unique generation before boot. Re-enabling globally cannot release an old entry in a second profile that was closed during the first profile's review: its generation mismatch remains held until explicit local review/resume. The required two-profile test directly exercises this boundary. This closes the earlier global-reenable gap without pretending the server can inspect each browser's queue.
3. **Opaque conversation ordering indexes:** the design now explicitly chooses an independent non-extractable HMAC-SHA-256 key for destination index tokens. An enumerable unkeyed hash is disallowed. Tokens and monotonic sequence reveal only the lookup/equality/order metadata required by the queue, within the previously stated origin-local threat model; signing keys are neither exported nor repurposed.
4. **Every physical target attempt is accounted:** the outbox invokes the signing layer's single-physical-attempt API and never the Chats wrapper's internal401 retry loop. Every target result, including401 followed by active status, must return through the durable attempt ledger before another target request. Status reads cannot silently resend the target. The seven-attempt ceiling persists through401/active cycles and reopening until explicit renewal. This makes the enumerated target-attempt bound substantive rather than a count around a wrapper that can retry invisibly.

No new material contradiction was found in these fixes. All conclusions remain about design. This reviewer ran no tests and changed no source or spec. The final implementation must demonstrate the exact stop-set upgrade boundary, the two-profile restoration boundary, non-enumerable index construction, and repeated401/active restart attempt accounting; none is claimed proved by prose review alone.


### Internal artifact: review-final-decisions.md

# Final Review — Decision Completeness And Classification

Reviewer: outbox_decisions. Inherited GPT-6.2 family; not a Claude or cross-vendor read. Read the complete latest spec, ELI16 and actual conformance-round4.json. Review only; no source or tests changed.

## Decision Verdict And Counts

Zero unresolved DESIGN findings in decision completeness/classification. The explicit Frontloaded Decisions section corresponds to thirteen actual table rows: twelve invariants and one user judgment candidate. No mid-build operator question is required. Cheap-to-change-after tags: zero. Contested cheap tags cleared: zero. Open questions: zero. This is not a durability, release or full-constitutional-pass claim.

The invariants concern enumerable request/identity preservation, authenticated storage, durable admission, lifetime and scope epochs, cleanup, server request/result authority, same-operation replay, explicit stop recovery admission, durable conversation sequence and actual catch-up completion. The user judgment remains explicit review and re-authoring, with preserved ambiguity, a bounded action space and retain-held fallback. No unknown outcome grants permission to manufacture a fresh operation.

## Final Changes Independently Contested

- Durable commit sequence is honestly distinguished from click time across tabs. A preparation not yet committed has no reserved position. A final admission checks earlier pending operations atomically. Send this first records the user's deliberate ordering override without changing the signed application operation. This is a queue-order contract with an explicit user arbiter for bypass, not a content heuristic inferring that a message sounds more important.
- Deferred exact-stop recovery does not reinterpret saved content as current-session intent. The exact set comes from the existing server contract. Only a fresh online live Send can make its one immediate attempt; it bypasses pending ordering so an earlier file cannot block emergency control. Offline, deferred, failed, uncertain, closed or reloaded stops remain held. The remaining possibility of an already admitted first request arriving late is disclosed as an existing server authority boundary, not concealed by a client guarantee.
- Frozen operation ID/time/body and fresh signing-header time are distinct. This preserves server operation identity while allowing a legitimate current signature. It closes the earlier ambiguity about refreshing timestamps.
- Bound session and scope epochs must match the entry before every drain and attempt admission. Invalidation commits before erasure; cleanup-pending blocks new admissions. Failed deletion cannot revive old authority, and stale cleanup cannot erase a newer epoch. Definitive key removals include same-origin-machine declined, expired and not-found, with expected-key fencing.
- Supported rollback retains the epoch/logout/device-cleanup shim and disables draining. Historical binary restoration has an explicit flag-off-before-start precondition and zero-attempt-before-review test. Fresh key status is not misrepresented as proof that no historical logout occurred.
- Admission, acceptance, held/failure counters and duration are tied to real transaction/result transitions rather than inferred from a surviving zero queue. Metrics failure stays unknown.

## Actual Conformance Round 4 — Three Flags

The inspector checked102 standards, produced three possible-violation flags, reported no degradation and a usable registry canary, and rated the chosen parent fit weak. It did not return a clean pass.

### 1. Judgment Within Floors — retry constants

No remaining decision-classification DESIGN finding. Six retries and20-second response deadlines are explicitly reversible operational defaults, not a universal necessity, resource proof or content eligibility floor. The spec also withdraws the false140-second actual-wall/server-work claim: this is configured response-wait time, with at most six real finite cooldown/backoff intervals and possible closure/timer delay. Healthy successful suboperation progress advances work; neither202 nor a health probe resets its budget. Reopening/reconnect cannot reset exhaustion; explicit Resume original request is the only new bounded episode. The user's copy remains retained. The design is an enumerable bounded executor, not an attempt to decide competing social/work urgency with a counter.

### 2. Operator Channel / held predecessor

No remaining decision-classification DESIGN finding. Preserving successfully admitted message order avoids delivering a later correction before its antecedent upload. An indefinitely held predecessor remains visible and has an explicit Send this first escape, rather than a brittle inference from message wording or a timeout. Most critically, the live exact emergency-stop path explicitly bypasses this ordering and is not released later by upload completion. The browser is not claiming that unknown prior delivery vanished or that a later click implicitly cancelled it. The ordinary ordering and explicit override are frontloaded user-facing behavior, not an unspoken mid-build decision.

### 3. Bounded Blast Radius / aggregate tabs — resolved by structural ownership

Final concurrence after re-reading the amended Cross-Tab And Reconnect Execution section and updated review-final-scalability.md. Zero unresolved DESIGN findings remain from this lens. The scalability reviewer correctly rejected the earlier proposed derivation from four server uploads and shared per-operation attempts to an origin-wide client buffer ceiling. A suspended tab can keep a historical chunk while another tab completes its operation and frees server capacity; repeated distinct entries defeat that derivation. This report withdraws that proposed inference rather than treating more counters as independent corroboration.

The final design now REQUIRES an origin-wide Web Lock around automatic active preparation, network work and part decryption, across different entries. One chunk buffer is released before ownership release. Cooldowns release ownership so another conversation can progress, and every acquisition revalidates identity, epochs, row and attempt admission. Browser lifecycle ownership release, not an invented lease expiry or guessed dead tab, permits close/reopen recovery. This is a substantive execution primitive, not a symbol or a server staging proxy.

Without the coordination primitive, encrypted content remains intact and automatic recovery performs zero HTTP. A clearly disclosed Resume original request permits only a bounded user-driven fallback with the same operation identity, CAS and server effect authority. That fallback does not claim an origin-wide automatic resource guarantee. This is a capability boundary with conservative hold and a real explicit recovery action, not a new file-size, queue-count, tab-count, age or content-eligibility quota. The final classification row explicitly describes automatic ownership versus manual duplicate-effect safety; it remains an enumerable invariant with a complete unavailable outcome.

The server staging bounds remain legitimate server bounds only. Configured client deadlines remain configured waits only; they do not establish that admitted server work stopped. Actual browser tests must establish lock lifecycle release, one active automatic part, zero automatic no-lock HTTP and safe same-ID manual fallback. No runtime proof is claimed by this review.

## Evidence Limits And Precision

The P20 boundaries are now explicit: authenticated server support is not browser-save success; transaction completion plus actual reopened profile testing is not a symbol-only save claim; Queued/202/probe success is not durable acceptance; current-generation actual reads establish Updating completion. All unmeasurable cases have conservative retained/held/unknown outcomes.

The ELI16 describes current-client sign-out and names supported versus historical rollback. Keep that qualification in the rollback artifact. Local review under an unavailable original identity must not become automatic rebinding or a new Send authority.

No tests launched and no runtime source edited. Final counts: frontloaded13, invariant12, judgment1, cheap0, contested-cleared0, unresolved operator questions0, additional decision-lens DESIGN0. The aggregate-resource flag is resolved at design level by the amended structural ownership requirement and the substantive scalability counterexample/disposition above. Final concurrence; zero unresolved DESIGN findings from this lens.

The prior Platform references precision note is resolved: the final sentence now names automatic ownership rather than optional coordination.


## Final External-Finding Closure Recheck

Re-read the entire latest body after the four outside findings were addressed. Final concurrence remains, with zero unresolved DESIGN findings from this lens. The same thirteen decision rows remain: twelve invariants and one judgment candidate; frontloaded13, cheap0, contested-cleared0, unresolved operator questions0.

1. **Changing canonical stop set:** the encrypted entry records whether admission matched the canonical exact-stop set, and every recovered final POST checks the current fresh advertised set. A match on either side holds for a current explicit Send. Therefore a server upgrade cannot turn an ordinary saved message into automatically admitted emergency control. This is a preservation/irreversible-effect invariant, not a new guessed keyword classifier or session-bound stop protocol.
2. **Absent profiles across restoration:** the support answer carries a recovery generation captured by each entry. Restoration must disable draining and advance to a new unique generation before serving the release. A current enabled flag alone cannot release an old-generation entry in a browser profile that was closed during review. Each such profile needs explicit LOCAL review/resume. This is an enumerable continuity fence with conservative hold, not a proxy claiming that a live key proves no historical logout. The two-profile closed-through-reenable test directly exercises the stated failure mode. Recovery generation belongs to the existing epoch/replay permission decisions; it does not create an unfrontloaded operator policy question.
3. **Opaque conversation ordering index:** an independent non-extractable HMAC-SHA-256 key is explicitly specified rather than a guessable unkeyed destination hash. Its role is a keyed opaque index for the already-selected durable order, not an authority that infers destination or reveals received history. This completes the storage-codec choice already classified in the table.
4. **Hidden401 retries:** outbox target calls use a single-physical-attempt signing API rather than Chats.call's internal401 loop. Every target result, including401 followed by an active device status, returns to durable attempt accounting before another target fetch. A status read cannot itself replay the target. Consequently the declared seven-target-attempt episode cannot silently multiply inside another helper or across reopening. The specified repeated401/active test must observe the physical target-call count, not just logical drain iterations. This is the existing bounded-executor invariant made substantive.

The new `Structure beats Willpower` parent names the code-backed invariant approach. The earlier conformance-round4 weak-parent-fit result remains historical evidence about the then-submitted parent, not a retroactive clean verdict. No inspector result, browser run or test pass is invented here. No source or tests were changed in this closure review.


### Internal artifact: review-final-integration.md

# Final Integration And Deployment Review

Reviewer: outbox_integration. Actual inherited model: GPT-6.2 authoring family. Read the complete current spec, all thirteen decisions and `conformance-round4.json`. No source edits or test execution.

## Verdict

Zero DESIGN findings. The final design makes its compatibility boundaries explicit and addresses the integration findings. This is not implementation verification or live-channel proof.

## Material Boundaries Rechecked

- Execution belongs to the authenticated console, not a selected page. Durable session and scope epochs are required on reads, admission and writes. Invalidation is committed before erasure, cleanup-pending prevents fresh bindings, and stale cleanup cannot erase a newer epoch. The distinction between invalidation failure and erasure failure is real and must remain visible.
- Every definitive deletion outcome, including same-enrollment-machine declined, expired and not-found, goes through expected-key cleanup. Other-machine answers preserve the queue. The existing device database stays version 1; ordered cleanup does not pretend the two databases are atomic.
- Final operation IDs, application bytes, destination and Slack holder remain frozen. Signing headers are freshly generated for each physical attempt. This fits the existing signed-request time window without re-authoring a message.
- Durable commit order governs conversation admission. A later final POST checks earlier retained operations atomically; it cannot silently overtake an earlier attachment. The deliberate ordering override does not change application bytes or request identity. The exact-stop live path bypasses that ordering, but recovery never treats an old saved stop as current authority.
- Upload reservation precedes allocation, uncertain recording cannot manufacture another upload identity, and accepted final results are looked up before new-operation expiry checks. App/Slack stop expiry and current authorization remain server requirements.
- Supported rollback retains the cleanup shim and turns draining off with the explicit outbox flag. A historical binary/UI downgrade is outside that supported operation. Restoration requires flag-off before the new server starts, not a made-up detector of historical logout. The runbook must carry that precondition and its flag-off retained-row test. The design does not claim fresh active-key status proves uninterrupted consent across unsupported old code.
- Capability status remains backed by actual initialized local dependencies and enablement. Awareness uses the existing shared registry for new and updated agents. Physical credential locality remains valid under the existing parent browser-device design; no credential transfer or silent re-signing on a new machine is introduced.

## Actual Round-Four Flag Dispositions

1. **Judgment Within Floors:** The current decision row now calls six retries and twenty-second response deadlines reversible operational defaults, not physical or eligibility truths. Configured waits are distinguished from actual elapsed time and admitted server effects. A slow operation can become held rather than being lost or silently re-authored; current user retry preserves the original operation. No integration defect requires replacing that explicit bounded protocol with an autonomous intent judge.
2. **Operator Channel Is Sacred:** Preserving user admission order and preventing an unknown earlier operation from silently losing its place is a competing delivery concern. The current design supplies a deliberate ordering override and exempts fresh exact emergency stop from queue order, while retained content and explicit original-operation continuation remain available. Automatically bypassing every held predecessor would discard the chosen order guarantee. The product journey and wording should be verified, but this is not an unresolved integration gap.
3. **Bounded Blast Radius — final delta reviewed:** The final body now requires an origin-wide Web Lock for automatic preparation/network work and automatic part decryption. One active chunk buffer is released before unlocking; cooldown waits release ownership; a waiter revalidates the current epoch/identity/row before acting. This is the actual browser-native ownership primitive, not an expiring lease or a guessed liveness timer. With no Web Locks there is zero automatic HTTP and a visible browser-update explanation; encrypted content stays available for an explicit bounded original-request fallback. That fallback retains CAS and server idempotency for effect safety and makes no false origin-wide memory claim. Integration acceptance must exercise automatic two-tab serialization and the no-lock zero-auto/explicit-action branches. This resolves the automatic-work resource finding with a concrete capability boundary.

## Precision Left Behind

- The weak parent-principle fit remains metadata precision; this is principally pending-content preservation, with operator-facing recovery actions.
- Supported rollback documentation should name flag-off and the retained shim as the supported route in the same plain wording as the dense spec. Do not summarize historical downgrade restoration as automatic or safe without that precondition.

## Evidence Limits

The final design requires real browser/profile persistence, two-tab races, signed HTTP failure injection, actual capability wiring and awareness migration tests. This reviewer ran none of them. Full verification stays with throughput, publishing with Chief, and live Telegram/Slack acceptance stays a later authorized rollout gate. The card must not be closed from this review or a code commit alone.

## Final Ownership Delta Concurrence

Read the revised Cross-Tab And Reconnect section and associated decision/test rows after the scalability finding was adopted. Concur with the origin-wide automatic ownership requirement and explicit no-lock fallback. No new DESIGN finding. Awareness and plain-English product copy must describe the browser coordination requirement, and a no-lock browser test must prove content survives while automatic HTTP remains zero. The previous per-entry-lock-only resource disposition is superseded by the concrete ownership protocol above. No tests or source changes performed by this reviewer.

## External-Finding Closure Check

Read the complete body again after the four outside findings were addressed. Zero additional DESIGN findings.

- **Stop-set evolution:** Persisted admission-time membership and current canonical-set membership are both checked before every recovered final POST. Either match holds for current explicit Send. This prevents a server upgrade from turning an ordinary saved phrase into automatic stop authority without inventing a new stop classifier or target-bound protocol.
- **Absent-profile restoration:** The server recovery generation is captured per entry and checked against fresh support. Historical restoration advances the generation while support is disabled before boot. Global re-enablement cannot release old entries in a browser profile that was closed during the review; that profile must review/resume locally. The explicitly required two-profile test establishes the actual absent-profile boundary. A generation match is admission compatibility, never proof of historical logout by itself.
- **Opaque ordering index:** An independent non-extractable HMAC key replaces a guessable unkeyed destination digest. Existing identity-local scope/key cleanup must erase this key alongside the AES key. Canonical ordering tokens remain lookup metadata rather than a plaintext destination index.
- **Physical retry accounting:** Outbox uses the single-target-attempt signing seam, not Chats.call's 401 retry loop. Every target 401 returns to the persisted ledger, even if a separate status read reports active. The repeated-401/active-across-reopen test must assert target-attempt count, not simply logical drain invocations.

### Configuration And Migration Acceptance Obligations

The generation's explicit missing-value default is `"1"`. New-install/config resolution and existing-agent migration must agree; migration adds only missing fields and must preserve an existing disabled outbox and every operator-selected recovery generation. Never reset a unique restoration generation to the default during update. The chosen normal enabled default must remain subordinate to existing browser/native feature gates, while explicit `outboxEnabled:false` stays disabled. These are concrete implementation/migration checks, not a reason to ask the operator again or to infer that absent support on an old server is enabled.

Verify the support response on enabled, flag-off, missing substantive dependency and old/unsupported paths, including its generation and canonical stop set. Test current-generation recovery, mismatched generation held, local explicit review, and profile B closed until after server re-enablement. Test missing-config initialization plus idempotent existing-config migration preserving `false` and a custom generation. Add the plain-language browser-local/open-dashboard/no-Web-Locks/queued-not-delivered note through the existing awareness leaf, and verify both new-agent rendering and existing-agent update rendering include it. The rollback artifact must include both flag-off and advancing generation before serving a restored historical installation.

No source or test behavior was executed by this reviewer; these are acceptance obligations grounded in the final design, not passing results.

## Final Three-Finding Closure

Read the actual final admission, step-budget and legacy-migration text. Zero additional DESIGN findings.

1. Stop evidence now has matched/unmatched/unknown states. Missing legacy evidence is unknown and holds; it cannot acquire eligibility merely because a newer server no longer lists a phrase. Current canonical membership is still rechecked before recovered final admission. This is compatible with existing explicit fresh Send and does not grant background stop authority.
2. Read-only upload-status reconciliation and write steps have distinct immutable keys and persisted budgets. An exhausted final-chunk PUT cannot consume or reset the remaining GET budget. The explicitly required lost-seventh-ack scenario may advance from completed GET status without an eighth PUT. Implement the general exhausted-entry pause rule with this stated read-only reconciliation exception, not as an early return that prevents all reconciliation.
3. Explicit logout commits the origin-wide legacy-retired marker with invalidation. Startup/import and resumed sibling code must check it before reading or rendering legacy plaintext. Once retired, untagged legacy rows are erased on discovery rather than imported into a new sign-in. That explicit logout rule takes precedence over the generic first-time untagged-row held-import path. The paused-sibling test must check both sessionStorage and visible tray emptiness, and an unsupported old client must not restore new-client eligibility after that boundary.

These changes close the cross-format migration and upload-reconciliation seams without changing received-history policy or expanding retry authority. The previously recorded configuration/migration/awareness acceptance obligations remain. No source edits or tests performed by this reviewer.


### Internal artifact: review-final-lessons.md

# Final Lessons-Aware Review — Web Durable Offline Sends

Reviewer: outbox_lessons. Actual model: inherited GPT-6.2 family, not Claude. Reviewed the full spec body, then re-read its final ownership delta and updated ELI16, alongside the actual round-4 conformance report: 102 standards checked, three possible-violation signals, canary complete. No tests or runtime changes were made. This is a design verdict, not an implementation or live-delivery claim.

## Verdict

Concur. Zero unresolved DESIGN findings from this lens. Earlier findings are resolved by substantive behavior and evidence requirements. The final ownership delta addresses the scalability reviewer's real paused-tab counterexample with origin-wide browser ownership, without introducing a lease, tab quota or historical-client detector. The subsequent four external closure findings are also explicitly resolved in the current body, as reviewed below.

## Prior Findings And Final Changes

- **Durable-before-effect foundation:** Upload reservation/recording order and conservative uncertain recovery are explicit. App/Slack age checks cover new stop effects. Lost final-chunk receipts reconcile actual completion. Stable client IDs are no longer asserted to repair an unsafe server foundation by themselves.
- **Retry brakes without lost benefit:** Persisted admissions/cooldowns prevent sibling tabs, reloads and flapping connectivity from resetting exhausted budgets. Confirmed progress advances a finite suboperation; health probes and repeated 202 do not. Healthy uploads may exceed two minutes. Deadlines describe configured client waits, not fictional bounds on server work, closure time or already-admitted effects. Exhaustion retains content and requires an explicit same-ID new episode.
- **Actual outcome observation:** Content-free admission/accepted/held/failure and latency records come from actual transaction/result transitions. Pending-row count alone is not treated as the success denominator. Storage/metrics/decryption uncertainty is unknown, not zero. Existing local/maturation owners carry the evidence without raw message telemetry.
- **Cancellation and cleanup:** Durable epoch invalidation commits before erasure, marks cleanup-pending, and blocks fresh binding until that exact cleanup finishes. Entry/session/scope epochs must match for reads and physical admission. Stale cleanup cannot erase new admissions. All canonical definitive key-removal decisions use expected-identity cleanup; another machine's ambiguous answer does not delete the key. A cleanup abort cannot restore the old session's authority, and already-admitted requests are not claimed recallable.
- **Rollback compatibility:** Supported rollback retains the privacy/epoch cleanup shim and disables draining. Full historical downgrade is explicitly unsupported. Its restoration requires the drain-disable flag before serving the new release, followed by queue review; fresh active status is not proof of historical cancellation continuity. The rollback artifact must carry that exact precondition and the flag-off restoration scenario must prove zero queued attempts. This is an honest supported deployment boundary, not a new promise to detect every old-client logout.
- **Physical automatic-work ownership:** Automatic preparation, part decryption and network steps now require one origin-wide Web Lock. A paused owner cannot be declared dead by a timer; its retained ownership prevents another automatic worker from accumulating a second active chunk buffer. The buffer is released before ownership, and cooldown waits release ownership so other conversations can progress. No-lock browsers retain the saved content with zero automatic HTTP and expose a bounded, explicit original-request fallback. This resolves the physical amplification counterexample rather than pretending server storage caps bound browser plaintext.
- **Stop intent:** A live current exact stop gets one immediate path that bypasses earlier queued uploads. It is not a durable background permission. Deferred/uncertain/offline stops remain held, and local holding never claims to recall an already admitted request or solve the separate target-bound stop protocol.

These changes engage P1, P8, P10, P14, P18, P19, P20, P25, B22 and B24 at the actual queue/server/cleanup boundaries. Registry awareness, real browser persistence tests, three test tiers and version-bound maturation remain in scope. Received-history caching, new enrollment or a fresh permission model remain excluded.

## Final External Closure Delta

Read the actual final Local Storage, Durable Send, Capability and Rollback sections. No remaining DESIGN finding is introduced by these four closures:

1. **Canonical stop membership across upgrades:** Admission-time membership is persisted, and the fresh advertised canonical set is checked before every recovered final POST. Either match holds for a current explicit Send. This is a protocol safety floor, not a new guess about natural-language intent; a newly added stop phrase cannot silently transform a saved ordinary operation into automatic emergency control. Test the set changing between admission and recovery.
2. **Absent profiles after historical restore:** The actual support contract now carries `mobilePairing.browser.outboxRecoveryGeneration` (default `"1"`), captured with each entry. Historical restoration requires disabling draining and advancing that generation before boot. A later global re-enable cannot release an absent browser profile: an old-generation entry needs explicit local review/resume under the fresh generation. The required two-profile scenario leaves the second profile closed until after re-enable. This closes the continuity gap with an explicit supported restoration boundary; it does not claim to detect historical logouts or require reviewing every ordinary reconnect.
3. **Opaque conversation-order indexes:** The spec selects an independent non-extractable HMAC-SHA-256 key instead of an enumerable unkeyed destination hash. It does not export or repurpose the signing key. This is the specific codec/privacy choice the implementation must honor, not a new semantic gate or received-history cache.
4. **One physical target request per ledger admission:** Outbox uses the signing layer's single-attempt API and never the Chats 401 retry loop. Every target response, including 401 followed by active status, returns through the persisted budget before another target attempt. Status reads do not secretly resend. The repeated-401/reopen test must prove the seven-target-attempt bound until explicit user renewal. This is P19/P20 applied to actual effects rather than only the visible outer-loop counter.

## Last Privacy And Reconciliation Closure Delta

Read the final stop-evidence, attempt-ledger and legacy-import text. These three changes resolve their stated counterexamples; no new DESIGN finding remains:

- **Unknown stop evidence is an actual third state.** Admission stores matched/unmatched/unknown, including unknown for missing legacy evidence. Unknown holds for current explicit Send instead of being coerced to unmatched. The current advertised canonical set is still checked before recovered final POST. This follows P20's unknown semantics without claiming a substring infers intent. Ordinary offline sending remains useful when the already-approved running browser has the last known advertised canonical set; missing evidence does not manufacture that state.
- **Read-only reconciliation is not an eighth write.** Immutable GET upload-status steps and PUT/write steps have separate persisted budgets. A lost seventh final-chunk acknowledgment may be resolved by the remaining bounded GET budget and advance from actual completed state, with no eighth PUT. A failed GET spends its own budget and cannot reset writes. This preserves recovery benefit inside real effect bounds rather than treating timeout as proof of failure or making the UI require a redundant write.
- **Explicit logout retires legacy plaintext origin-wide.** The logout invalidation transaction persists the legacy-retired marker. Every new-client startup/import and resumed sibling checks it before reading/rendering legacy text; retired untagged source rows are erased on discovery and cannot be imported or displayed in a fresh sign-in's tray. The suspended-sibling logout/sign-in test must prove both plaintext source and tray empty. The earlier conservative held-import rule applies only where that explicit retirement boundary has not already forbidden import; it does not override the marker. Unsupported old-client rows do not regain eligibility after that logout. This closes the privacy return path with structural state rather than fresh-sign-in symbolism, without inventing historical-client tracking.

The Experience Fit consequence is concrete: the person does not have to send a file again merely because its last write acknowledgment was lost, and does not see supposedly cleared legacy text return on a sibling tab after sign-out/sign-in. Unknown time-sensitive control still asks for a current Send because that original temporal intent is genuinely unproven; ordinary verified replay does not acquire a new approval prompt. These are design promises pending the required actual browser and server tests, not measured results.

## Round-4 Conformance Signals — Independent Disposition

### 1. Retry constants are not universal safety floors

The exact seven-attempt and 20-second defaults are now expressly reversible operational defaults, not physical eligibility limits or a claim that slower valid messages are unsafe. The true invariants are bounded persisted physical admissions, respected cooldowns, retained content and no unauthorized changed-ID retry. The spec does not purge a valid message or lower file eligibility when those defaults exhaust. The decision reviewer independently contests classification; this lessons lens finds no new DESIGN defect merely because another operational default could also be defensible. Actual sustained-failure and slow-progress tests remain necessary.

### 2. A held predecessor and a later correction

A held attachment can delay automatic admission of a later message, but the later entry remains visibly pending with a deliberate Send this first action. That action preserves its original body/ID and records the user's ordering choice; it is not an automatic guess that a correction should overtake its context. Fresh canonical emergency control bypasses the predecessor immediately. This is therefore an explicit recoverable ordering boundary, not a silent gate that leaves the operator without a route to delivery. Do not conceal the blocker or require deleting/retyping the correction. The delayed-upload/two-tab and explicit-bypass scenarios already required by the spec must demonstrate that path.

### 3. Aggregate physical buffers across tabs

The scalability review found a genuine counterexample to the earlier argument: a paused tab can retain a decrypted buffer while other tabs process different entries; logical idempotency and server storage/admission caps do not bound that origin's plaintext memory. The final design changes what is built to address this, rather than dismissing the signal.

Automatic active preparation/decryption/network work now requires one origin-wide Web Lock. Only one chunk buffer is held; it must be released before ownership is released. An owner paused while holding that buffer remains the owner—there is no TTL takeover that could duplicate retained work. Cooldown waits release the lock so a different conversation can advance; waiters revalidate durable epoch, identity, live row and attempt admission on acquisition. A closed tab's browser lifecycle releases ownership. This supplies the missing automatic physical-work coordination mechanism.

Without Web Locks the browser still saves and retains content, but performs zero automatic recovery HTTP. It plainly identifies the browser capability limit and offers an explicit bounded Resume original request fallback. Shared IDs/CAS/server idempotency establish that fallback's effect safety; the spec correctly does not call it an origin-wide memory bound. This is a disclosed execution capability boundary, not a new file/count/age eligibility quota or a cap on how many tabs a person may open.

The implementation must prove paused-owner exclusion, buffer release-before-unlock, cooldown fairness, closed-owner release, zero no-lock automatic HTTP and bounded original-ID manual fallback. Those are implementation evidence requirements for the now-explicit design, not a new workflow engine. The final delta resolves this flag for the lessons lens; the previous server-cap-only argument should not be reused.

## Experience Fit

**Attributable goal:** Chief's quoted handoff directs completion of the durable web offline-send card. The available outcome is retaining an offline Send through closure, automatically resuming the original operation when the approved dashboard reconnects, and showing Updating during actual catch-up. No original Justin quote or measured ask-count is fabricated.

**Ordinary journey:** The person uses an already-approved browser and presses Send once. Existing credential choice is resolved before eligibility. Committed encrypted storage precedes clearing the exact draft/files; failure preserves them and reports the real problem. In a browser with Web Locks, reopening the dashboard can resume from any page without revisiting the original conversation or asking for the same permission again. Valid finite server cooldowns resume with the same operation. A browser without that coordination capability still preserves the sent content, performs no automatic network recovery, explains the browser-update path and offers a bounded original-request manual continuation. That limitation is explicit rather than a false universal automatic-resume claim. Updating tracks the actual required reads and keeps a new draft intact.

**Contrasting cases:** A lost response to the same ordinary saved operation remains that original Send. Different text or a changed actor/holder/audience is not covered merely because a channel/service label matches. An exhausted retry requires an explicit original-operation episode, never a new message ID. A held predecessor can be bypassed through the visible deliberate action, not by silently reordering meaning. A deferred exact stop requires current intent because its consequence depends on the live session; a changed canonical set is rechecked rather than relying only on the classification stored before an upgrade. Unsupported historical downgrade requires a pre-boot disable plus changed recovery generation, then local per-profile review rather than fake continuity; a profile closed during restoration still holds its old-generation entries after global re-enable. Supported rollback keeps privacy cleanup. Ordinary reconnect within the same reviewed generation is unaffected. These distinctions reflect actual authority/consequence differences, not an intent keyword classifier or a new standing grant.

**Evidence limits:** The design has not yet demonstrated recovered delivery, improved latency or reduced ask burden. The actual browser/profile, signed-server and lifecycle matrix must prove retention, one logical effect, changed-access boundaries, no-lock concurrency, explicit ordering bypass, cleanup failures and rollback flag-off behavior. Isolated provider fixtures are not actual Telegram/Slack rendering proof. The code commit is not card completion, and the operator must not become the first tester.

## Benefit And Residual Precision

A useful ordinary path survives the safeguards: the original offline text/file submission remains available and resumes under its original identity and identifiers without repeat permission. Storage, identity, uncertainty and ordering boundaries preserve that benefit rather than silently discarding it. Serial preparation is a reversible execution choice, not a refusal rule. The ELI16 now explains deferred exact stops. One short sentence disclosing that automatic recovery needs browser coordination support would also align its broad automatic-resume paragraph with the no-lock fallback; this is PRECISION only, since the detailed behavior and required visible fallback are explicit in the design.

SUMMARY: 0 critical, 0 high, 0 medium DESIGN findings. One optional low PRECISION clarification about no-lock browser support. Final lessons-aware review concurs with the latest body including the four external closure deltas and the final three privacy/reconciliation closures, and records all three actual round-4 conformance signals without claiming those signals are automatic authorities or implementation evidence.


### Internal artifact: review-final-scalability.md

# Final Scalability Disposition — Round-Four Resource Flag

Reviewer: outbox_scalability. Actual model: inherited GPT-6.2 family. Read conformance-round4.json, current spec and AppMediaStore's actual resource checks. This is source/design review only; no browser/test/source edit was performed.

## Actual Foundation Limits

AppMediaStore currently permits at most four `open`/`assembling` uploads per device, at most 256 MiB staged per device, and at most 1 GiB staged per machine. Per-file eligibility is 50 MiB, aggregate message eligibility 64 MiB and chunk geometry 1 MiB. These bound server staging/allocation according to the states counted by startUpload. They do not bound all live HTTP requests, all browser tabs or all decrypted client buffers.

## Proposed Improvements Assessed

The proposed drain changes are materially useful: no whole-file automatic decryption; one chunk buffer per app instance; durable attempt CAS before decrypting a part; a live assigned upload and GET-confirmed missing chunk before decryption; shared seven-attempt admissions and nextEligibleAt; and a twenty-second physical-attempt admission interval. They reduce ordinary duplicate work and tie automatic decryption to an admitted operation. Composer encryption preparation remains user-triggered and separately bounded by existing media eligibility, rather than being presented as automatic recovery work.

The twenty-second interval must stay a client admission/deadline convention, not proof that an older request stopped. A paused tab can resume late and an already-invoked request can finish after the client deadline. The author already discloses that limitation.

## Bounded Blast Radius — Original Proposed Derivation Rejected

The proposed no-Web-Locks derivation is insufficient for an origin-wide retained-buffer ceiling. Counterexample:

1. Tab A claims a part, decrypts its 1 MiB and is suspended before releasing the buffer.
2. Tab B later completes that part, upload and message using the same original identities. Server open/staging capacity is freed.
3. Another queued entry is admitted. Another tab can retain that entry's chunk while Tab B completes it.
4. Repeating over distinct entries leaves historical paused tabs holding buffers while current server staging remains under four open uploads and 256 MiB.

A shared per-suboperation seven-attempt cap limits one immutable operation, not all historical distinct entries. An unlimited durable queue and capacity reused over time provide no fixed aggregate buffer ceiling. Moving CAS before decryption and GET before part reading does not release memory already held by a suspended older tab. Similarly, server staging limits cannot establish a bound on already-admitted timed-out HTTP work. Do not claim a strict single uploader or an aggregate browser-memory limit from these symbols.

## Minimal Necessary Implementation Change — Now Adopted

Require one origin-wide Web Lock for AUTOMATIC draining, held across reading/decrypting a chunk, its network attempt and buffer release. Use that same lock across different entries, not a per-entry lock. Release on session disposal and do not acquire automatically after epoch invalidation. Browser/tab destruction releases the browser-managed lock, enabling normal close/reopen recovery without an invented lease or TTL.

When Web Locks is unavailable, preserve encrypted entries and expose an explicit Resume original request action; do not automatically start one uploader per tab. That fallback is user-driven, still uses the original ID/body/CAS/server authority and does not silently lose content. Describe the support limitation plainly and test it. This introduces no arbitrary tab-count cap, client lease expiry or new server ownership subsystem. The existing modern-browser automatic path remains automatic; unsupported coordination cannot be represented as established single-owner recovery.

If automatic draining without Web Locks is a mandatory product requirement, a real origin-wide ownership/execution primitive is required. Same-entry CAS plus server staging caps is not that primitive. That would be a different architecture decision, rather than a reason to fabricate the proposed bound.

## Other Round-Four Flags

- Judgment Within Floors: the numeric retry values remain operational defaults, not proof that another attempt is unsafe. Exact-ID/manual resume and retained content preserve a bounded user judgment path. This lens does not request increasing them or treating them as content eligibility floors.
- Operator Channel Is Sacred: the latest spec explicitly exempts a fresh live exact emergency-stop submission from queued ordering; saved/deferred stops remain held. An ordinary held predecessor may still require the deliberate Send this first action to reorder distinct messages. That is a contextual operator-intent choice for the integration/experience reviewer, not a scalability argument for discarding ordering.
- Parent-principle fit remains a declaration/semantic-fit issue; no resource ceiling follows from it.

## Final Resolution And Verdict

Final concurrence, zero unresolved DESIGN findings from this lens. I re-read the amended Cross-Tab And Reconnect Execution section after the author adopted the structural resolution. Automatic active preparation/network/part decryption now requires the origin-wide Web Lock. The automatic worker holds only one chunk and releases its buffer before ownership release. It releases ownership during cooldown, and revalidates identity/epochs/row/attempt admission when reacquiring. It does not steal from a paused owner using an invented lease deadline.

A browser without Web Locks performs zero automatic recovery HTTP, retains the encrypted queue and offers a disclosed bounded user-driven Resume original request fallback. That fallback retains shared CAS/exact operation identities and server effect idempotency, while explicitly declining to claim an origin-wide physical-memory bound. Supported automatic close/reopen recovery relies on actual browser lifecycle release of the Web Lock, which the real-profile test must demonstrate.

This resolves the actual round-four Bounded Blast Radius flag at design level. It replaces the invalid server-staging-to-client-memory inference rather than appending another numerical quota. No smaller attachment limit, arbitrary TTL, tab-count cap or new ownership service is required. The server staging limits remain valid server bounds; configured client deadlines still do not imply server work stopped. Composer preparation remains a separately user-initiated eligibility-bounded operation. No test receipt or runtime pass is claimed by this review.


### Internal artifact: review-final-security.md

# Final Delta — Security Review

Reviewer: outbox_security. Inherited GPT6.2 family, not Claude; no cross-vendor diversity claim. Read the full final spec and the requested final deltas, with prior one-layer browser signing/media/request-store review carried forward. Reviewed body SHA-256: `7d17fefb12ffeeeed6c94fb75aac86c9ad8519d6e6df93393ad521c4cd6dc1f7`. No source edits or tests.

## Verdict

Concur. Zero unresolved SECURITY DESIGN findings; no new precision issue warrants another round.

## Final changes independently checked

- **Automatic resource ownership:** an origin-wide Web Lock now owns each active automatic preparation/network step, including part decryption. The chunk buffer is released before ownership, and server cooldown does not retain the lock. A paused owner is not declared dead by a fabricated lease. Waiting owners revalidate epoch, identity, row and attempt admission. Without Web Locks the queue retains content and makes zero automatic HTTP attempts; explicit bounded same-ID fallback is disclosed. Server idempotency is correctly limited to proving logical effect safety, not aggregate paused-buffer memory. This resolves the earlier automatic multi-tab resource counterexample without weakening identity or exact-body constraints.
- **Committed order:** sequence means durable admission order, not cross-tab click order before an entry exists. This is an accurate claim. Final POST admission still checks committed predecessors atomically. Send this first remains a deliberate ordering override, not permission to change body/actor or defeat unrelated hold conditions.
- **Immediate stop:** a fresh live user stop can bypass an earlier upload's ordering barrier. It is invoked only from that current submission path after durable admission, never saved as a background permission. If it cannot run immediately, needs deferred file preparation, fails or loses its acknowledgment, it holds. Completion of an earlier upload cannot accidentally release it. The existing delayed first-request-at-server-receipt limit is disclosed rather than disguised as session-bound stop authority.
- **Historical restoration:** supported rollback retains cleanup/epoch behavior. After a full unsupported historical downgrade, restored serving requires outboxEnabled=false before boot and explicit queue review before re-enablement; the test demands zero queued attempts on that restored flag-off server. This is an explicit deployment precondition, not a claimed universal detector of historical logout or evidence fabricated from active-key status.
- **Definitive key deletion:** the cleanup contract now includes all existing key-removal decisions: revoke/Forget and declined/expired/not-found only from the enrollment machine. Other-machine answers preserve the identity. Cleanup precedes signing-record deletion and checks the expected key, so a delayed answer cannot erase a replacement identity. Two databases are not falsely called atomic.

## Closure safety check — final additional deltas

Read the final added clauses against the entire previously reviewed design. Concurrence remains unchanged, with zero unresolved SECURITY DESIGN findings.

- **Stop-set evolution:** each entry retains its exact-stop membership at admission and must be compared against the fresh current advertised set before every recovered final POST. Matching either holds it for a current explicit Send. Thus a newly recognized phrase after a server upgrade cannot automatically acquire emergency-control meaning, and a phrase removed later does not revive an old deferred stop. This preserves the one live immediate-attempt exception without broadening automatic recovery.
- **Absent historical profiles:** the entry captures outboxRecoveryGeneration, and every recovered attempt requires a fresh matching/reviewed generation. Historical restoration both disables draining and advances that generation before serving. Re-enabling the server alone cannot release a closed/unreviewed profile's old-generation entries; its own explicit local review is required. The two-profile acceptance test checks the second profile opening only after re-enablement. This is sufficient without inventing a history detector or storing a new grant.
- **Opaque ordering index:** an independent non-extractable HMAC-SHA-256 key replaces an enumerable destination hash. The index reveals grouping equality for order lookup, not the destination's dictionary value. Use the same durable winning-key initialization requirement for the AES/HMAC key pair; concurrent first creation must not change the mapping for already admitted entries. No key export or signing-key repurposing is added.
- **Physical retry accounting:** the outbox calls a one-physical-attempt signing API rather than the Chats401 loop. Every target response, including401 followed by active status, returns through persisted attempt admission before another target fetch. Status reads cannot silently resend the target, and reopening cannot bypass the seven-attempt budget. The explicit repeated401/active/reopen case tests the load-bearing boundary.

These clauses are concrete closures of the supplied counterexamples, not evidence of implemented code or passed tests. No new blocking design question or operator decision arose from the closure check.

## Prior security invariants retained

Separate non-extractable encryption keys and authenticated scope/entry/part binding remain; no key export, bearer copy or received-history persistence is added. Commit-before-clear, immutable original ID/body, fresh signature headers, server current grants, reservation-before-upload effects, conservative failed-finish uncertainty, completed-status reconciliation, epoch-bound reads/attempts, cleanup-pending and matching-epoch erase ownership all remain explicit. Reconnect does not reset exhausted attempts. Real browser/CryptoKey persistence and actual HTTP fault cases are still required before claiming implementation success.

## Inspector disclosure

Round4 inspector ran against102 standards with degraded:false and three possible violations. The final origin-wide ownership/no-lock hold directly addresses its aggregate-resource finding. Retry defaults are explicitly reversible brakes rather than content eligibility or a proved universal safety threshold; decision/experience review owns their proportionality. Held-predecessor behavior is explicit, with a deliberate override and the fresh immediate-stop exception; this security review does not erase other lenses' delivery-policy concerns. Weak parent-fit is an advisory classification, not a security proof or refusal. No clean inspector verdict is invented.

Final counts: SECURITY DESIGN0 unresolved; PRECISION0 new. No operator decision identified within this scope. This is design concurrence only, not a runtime, test, publication or live-delivery claim.

## Final three-clause closure check

Read the final actual stop-evidence, step-ledger and legacy-retirement clauses. Security concurrence remains: zero unresolved DESIGN findings, no new precision revision required.

1. Exact-stop evidence is explicitly tri-state. Missing/unavailable/legacy evidence is unknown and holds; it is never silently converted to unmatched. Matching the admitted or current exact set also holds. Thus a saved entry cannot gain automatic control authority from absence of an old field or a changed server phrase set.
2. Upload status GET and each immutable write step have separate persisted budgets. A lost final permitted PUT response can still be reconciled through a bounded read-only status step; no eighth PUT or reset of the write ledger is authorized. A failed reconciliation read consumes its own budget. This preserves both conservative uncertainty and bounded physical-attempt accounting.
3. Explicit logout durably marks origin-wide legacy retirement with invalidation. New-client startup/import and resumed siblings check it before reading or rendering old plaintext. Retired untagged sources are erased on discovery instead of entering a fresh sign-in or tray. This closes the suspended-sibling plaintext reappearance counterexample without pretending to control an unsupported old client's runtime; such rows cannot regain new-format eligibility after the explicit logout boundary. The specified suspended-tab test checks both storage and tray.

These operationalize existing unknown-hold, independent-suboperation and logout/privacy boundaries. They do not establish runtime success; no source edits or tests were performed by this reviewer.


### Internal artifact: review-r1-adversarial.md

# Round 1 — Adversarial Review

Reviewer: independent child agent, inherited GPT-6.2 authoring-family model; this is an internal adversarial lens, not cross-vendor review. Read-only source inspection; no tests launched or source/spec edited. The conformance gate ultimately ran against102 standards and supplied5 possible-violation flags. This lens read the updated report; none removes the grounded prerequisite failures below. The serial-file-preparation concurrency and operational-metric flags belong principally to scalability/decisions, and the live-user proof, attribution and standalone-document flags belong principally to integration/lessons. They remain signals for those reviewers, not cleared by this adversarial read.

Verdict: **not converged**. Three DESIGN findings need resolution before the no-lock/lost-response promises are supportable. These are grounded in the existing subsystem one layer below the proposed browser queue, not hypothetical new mechanisms.

## A1 — DESIGN, high: upload creation precedes its request reservation

`src/server/mobileMediaRoutes.ts:125–136` calls `media.startUpload` before `requests.reserve`, ignores a non-reserved return (including full), ignores the boolean from `requests.finish`, catches request-store errors and still returns200 with the created upload. `AppMediaStore.startUpload` creates a random upload ID and a persistent row.

Sequence: upload creation succeeds, durable request reservation fails, the response is lost, and the client repeats its exact stable start ID. Lookup now returns none and the route creates a second upload identity. The queue cannot detect this loss locally. A full request store is another deterministic instance: start is created but its ID never receives a reservation, so every replay can create another upload until media admission refuses it. A crash between start and reserve has the same gap.

The spec's claim that stable IDs plus existing start idempotency prove one upload identity is therefore false precisely at the interruption boundary it proposes to support. This changes the build: reserve before the upload effect, honor every reservation outcome and durable finish failure, and make an uncertain start stay unknown rather than automatically allocating again. A failed start before any effect may release its reservation; a possibly created upload must not be retried under fresh identity. Prove lost-response, reservation-full/failure and restart boundaries using the real route/store. A small server-side prerequisite is justified; a second browser ledger cannot repair this server gap.

## A2 — DESIGN, high: old exact stops bypass the server's request-age floor

`src/server/mobileConversationRoutes.ts:990–998` and `src/server/mobileSlackRoutes.ts:398–409` put request-age validation inside `!exactStop`. Existing completed-record lookup comes first, but `MobileChatRequestStore.prune` removes records after embedded time plus24h5m. The Telegram route checks request age outside any exact-stop exemption.

Sequence: an exact stop was accepted but the final response was lost; the durable browser entry remains; the browser reopens after request-record retention. App/Slack lookup returns none, old stop bypasses age validation and can be dispatched again into a later active session. The spec explicitly removes the client's old-age shortcut and assumes the server rejects expired NEW effects, making this gap newly load-bearing.

Change the build to enforce original request age on NEW App/Slack sends, including exact stops, after retained-result lookup and before effects. Keep exact stops exempt from feature settings/rate limits; those exemptions need not waive identity-age/idempotency. Tests must cover fresh emergency stops still reaching their existing authority with chat disabled/rate-limited, retained results replaying without a new effect, and an old stop after record pruning refusing without stopping a new session. Alternatively hold such legacy/unsupported automatic replay, but do not claim the current foundation already supplies the floor.

## A3 — DESIGN, medium: successful final-chunk replay can look like a conflict

`AppMediaStore.putChunk` returns idempotent success only while the chunk hash row remains (`src/core/AppMediaStore.ts:345–351`). Successful finalization deletes chunk rows (`:392` and removeChunks). Replaying the exact final chunk after its response is lost therefore receives409 `upload-not-open` once the upload is complete. The same occurs with two tabs when one finishes before the other's identical PUT.

The spec says identical chunk PUT is idempotent and that an explicit conflict is held, while relying on physical duplicate requests in its no-Web-Locks path. Those statements together can hold a fully uploaded file instead of automatically resuming its final send. The existing GET status endpoint can resolve this without broad server changes: classify upload-not-open through a fresh status read; `complete` advances, `assembling` waits, actual hash/chunk conflict/unknown/expiry stays held. Do this before writing a terminal held transition, and ensure a stale failing tab cannot replace winning ready/submitted progress. Test lost final-chunk response after completion/chunk cleanup and the corresponding two-consumer race. This is a common target interruption, not long-tail precision.

## P1 — PRECISION: make cross-tab logout semantics explicit in acceptance

Durable epoch/revision checks are the right basis for stopping new local admissions. The text already says requests admitted before logout can still land, so no additional cancellation authority is requested. Acceptance should distinguish another tab's pre-admitted request from a NEW admission after the logout transaction, including when signing is awaiting crypto. Do not describe local cleanup as undoing an admitted server request. This clarifies the existing design, rather than requiring another design round by itself.

## Positive findings and limits

Captured actor/path/body plus stable request IDs are appropriate. Server reservation-before-final-send is present on App/Slack, and the Telegram route looks up retained requests and validates age before new dispatch. Keeping unknown results and refusing new IDs avoids duplicate final-message effects. Encryption AAD, nonextractable keys, atomic content admission, exact-identity cleanup, and excluding received history provide a coherent local boundary; this lens did not find a material contradiction in those choices. Fresh status and live grants remain necessary, as specified.

No new operator decision is needed to repair the three grounded prerequisite gaps. No result here establishes real browser durability, server fault behavior or race outcomes; those remain required tests.


### Internal artifact: review-r1-decisions.md

# Round 1 — Decision Completeness And Classification

Reviewer: outbox_decisions. Model: inherited GPT-6.2 family, not a Claude reviewer. Review only; no tests or runtime changes.

## Verdict

The ten declared decisions are substantively classified. Nine invariants and one user judgment point cover identity, irreversible composer admission, authenticated storage, replay identity, server authority, unknown outcomes, existing media contracts, cross-tab requests, catch-up state and deliberate re-authoring. No additional operator decision is required to choose routine implementation details. Received-history caching remains expressly excluded rather than silently approved. No cheap-to-change-after exception is used.

Two known foundation DESIGN findings prevent treating the current server assumptions as established: upload-start allocation before request reservation, and App/Slack exact-stop age validation inside the stop exemption. These were independently reported by the security/adversarial lenses and are not duplicate new findings here. This review confirmed the latter in mobileConversationRoutes.ts around 991–996 and mobileSlackRoutes.ts around 399–407. The intended invariant is valid, but the existing foundation does not yet implement it. Include the accepted repairs before the next round and before advertising safe replay support.

No further DESIGN finding from this lens.

## Classification Contest

- Exact identity, destination and payload are enumerable signed-request invariants. Choosing a different actor or body after uncertain acceptance is an irreversible second-effect risk, so preserving the original is justified without an LLM arbiter.
- Commit-before-clear and epoch/revision fences are preservation and identity invariants; they do not weigh competing social or work signals.
- AES-GCM algorithm/parameters and schema version select a codec. They are implementation contracts rather than content eligibility thresholds.
- Existing server file/count/chunk, request-age and retry contracts legitimately constrain the client. This does not establish that those numbers are physical truths or authorize increasing them. Their current server authority is an external constraint for this increment. The one-file-at-a-time preparation choice is a bounded execution strategy that does not reject a second file or shrink eligible input. The conformance flag questioning that choice is not, by itself, a reason to add a dynamic concurrency arbiter.
- Re-authoring a held message has an actual arbiter: the user's explicit new send after checking the conversation. The deterministic fallback retains the original content without issuing a fresh request. That is a complete narrow action space, not an automatic resend exemption.

## P20 — State Rather Than Symbol

The proposed capability field claims local protocol support, not delivery or storage success. Its independent checks are substantive initialized request/media/native dependencies plus real signed endpoint/lifecycle tests. Unavailable, old or off support holds pending content rather than treating a version string as acceptance.

IndexedDB success is expressly a transaction-completion requirement, corroborated by real profile closure/reopen and tamper/abort tests rather than row counts or fake storage alone. An unavailable or failed save retains the original composer. Browser persistence permission is not treated as proof of durable recovery.

A queued phase or connection probe is expressly not proof of acceptance or current history. Acceptance requires the actual server result identifying the message; Updating completes only after the current generation's actual required reads/pages. The failure cases retain pending content or the real Connecting/Waiting state. The server foundation repairs above remain necessary corroboration for replay safety.

## Precision Notes — Not Reasons For Another Round

1. Add a short `## Frontloaded Decisions` section collecting the already-made choices: browser-local encrypted pending text/files; no received-history cache; open-dashboard recovery; preserve existing identity and server contracts; retain uncertain outcomes; explicit user re-authoring only. This makes the report's counts easier to audit. It changes no proposed behavior and requires no new user answer.
2. State whether held content under an elsewhere/replaced key can be decrypted for local review or only shown as an unavailable saved item until the original approved scope returns. The current text forbids automatic rebinding correctly, but “available for local review” and “only decrypt under matching approved scope” could be read differently. Preserve signing identity in either implementation; do not add an automatic new-send action. This is presentation/scope wording, not permission to transfer the queue.

## Conformance Input

Read the actual round-1 report: 102 standards checked, five flags, usable registry canary. The fixed-concurrency flag is addressed above. The observability, live-channel evidence, attribution and stand-alone-document flags belong primarily to the lessons/experience lens; they are not silently counted as cleared here. No clean overall constitutional pass is claimed by this review.

## Counts

- Declared, substantively frontloaded decisions: 10 (nine invariants, one judgment candidate).
- Explicit `Frontloaded Decisions` section entries in this round: 0; add the short summary above for audit clarity.
- Cheap-to-change-after tags: 0.
- Cheap tags contested then cleared: 0.
- Additional DESIGN findings from this lens: 0.
- Known foundation DESIGN findings cross-referenced: 2.
- PRECISION notes: 2.

No runtime files edited and no tests launched.


### Internal artifact: review-r1-integration.md

# Round 1 — Integration And Deployment

Reviewer: outbox_integration. Actual inherited model: GPT-6.2 authoring family; this is an independent internal lens, not a cross-vendor review. Read-only review; no tests or runtime edits.

## Verdict

No additional DESIGN finding beyond the two foundation repairs already accepted by the author: upload-start reservation ordering and request-age checks for App/Slack stop requests. Convergence still depends on incorporating those repairs and reviewing the resulting design. This verdict does not approve the unmodified foundation as safe.

## Source Grounding

- `dashboard/console/browser-device.js` uses `instar-console` version 1 with a single `device` store keyed by machineId. Keys are structured-cloned CryptoKeys. A separate outbox database avoids making old enrollment code fail with VersionError after rollback. The spec correctly rejects exporting or reusing signing keys for encryption.
- Current `checkAfter401`, `forget`, enrollment refusal and machine-change paths call `deleteRecord`. The design's ordered outbox cleanup and expected-key fence must cover this shared deletion seam, rather than just the visible Forget button. The requirement is already explicit; tests should exercise all relevant callers.
- `mountBrowserDeviceRoutes` currently knows browser enablement and pairing state, but not substantive conversation/request/media readiness. `createMobilePairingRouter` receives `poolCtx.appConversations`; this is a real injection seam for the proposed status capability. The spec's false/unknown behavior for unavailable dependencies is appropriate. A hard-coded version alone would not implement this design.
- `chats.js` owns a `ChatsPage` that is disposed when the console route changes. `console.js` owns sign-in and overall start; `page-lifecycle.js` provides per-page disposal and self-refreshing state. The design needs a console-lifetime outbox drainer to satisfy reopening the dashboard on a different page; it must not be accidentally tied to the selected conversation or Chats page.
- `src/awareness/registry.ts` explicitly supports one new `src/data/awareness/<id>.md` leaf, read by document generation and existing-agent migration. The proposed awareness delivery uses the actual shared registry instead of adding another migration or editing generated templates.

## Findings

### PRECISION I1 — Name the outbox worker's lifetime explicitly

The design already requires automatic draining on approved dashboard start and independently of the open conversation. Name the console sign-in lifetime as the worker owner, with Chats subscribing for bubble/status projection. The current code makes a page-owned implementation tempting, but that would violate the stated outcome rather than represent an unresolved design choice. The acceptance test should reopen on Work/Home, not merely reopen Chats with a different conversation.

### PRECISION I2 — Bound the rollback statement about sign-out

The separate database is a sound rollback strategy and the spec honestly says old UI cannot execute the new queue. An older UI also cannot perform the new outbox cleanup on sign-out or Forget. State that pending encrypted copies remain dormant across rollback, including actions performed by that older UI, until cleared by a supporting version or site-data deletion. This is a compatibility disclosure, not a reason to destructively migrate or export keys. Do not promise that an old UI implements new cleanup behavior.

## Multi-Machine Contest

The `machine-local-justification: physical-credential-locality` marker is substantively valid. The private signing CryptoKey and separate encryption CryptoKey physically reside in this origin's browser profile; automatically migrating the pending operation to another browser/machine would either transfer credentials or re-author a signed operation. The design preserves original actor/host/request and treats changed identity as held. Once accepted, ordinary server conversation replication remains responsible for the message. The local browser-status capability is explicitly not a whole-agent delivery verdict. No new notices, public URLs or duplicate one-voice emitter are introduced.

This does mean a tunnel-origin change does not expose the previous origin's IndexedDB queue. The specification already scopes recoverability to the same origin/profile and denies remote backup. The actual acceptance test must use that same origin/profile rather than claiming cross-origin recovery.

## Standards-Conformance Input

The gate ran against 102 standards and returned five flags. The attribution and unexplained parity-row flags are document precision issues. The live-channel proof and observability flags should be weighed by the lessons/experience lens; the proposed isolated profile and signed HTTP evidence are necessary but must not be represented as actual owner/provider rollout proof. Serial file preparation is not an integration incompatibility; it does not reduce accepted file size/count, and the performance reviewer should decide whether its cost warrants a design change. The weak parent-principle fit is a metadata precision issue, not evidence that the retention design is unsound.

## Limits

Reviewed the draft and one layer of existing implementation. Did not validate IndexedDB commit durability, CryptoKey cloning in Chrome, actual server capability wiring or any provider send. Those remain implementation and three-tier verification obligations. No protected constitution or owner decision is added by this integration design.


### Internal artifact: review-r1-lessons.md

# Lessons-Aware Review — Round 1

Reviewer: outbox_lessons. Actual model: inherited GPT-6.2 family, not Claude. Read-only review; no tests or runtime edits.

## Sources And Limits

Reviewed the spec and ELI16 companion, the substantive conformance report (102 standards, five flags), the canonical `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` index, and the current relevant constitution articles for user experience, trust, intent classification, observability and live user-channel proof. Inspected the named foundation one layer down: composer clear/send/deliver/start/dispose in `dashboard/console/chats.js`, and reservation/age boundaries in `mobileMediaRoutes.ts`, `mobileConversationRoutes.ts` and `mobileSlackRoutes.ts`.

A bounded search of the running agent's root `.instar/memory/` found no `feedback_*.md` files to load. The canonical index carries their named source references; their original local contents were not independently verified. The direct attributable assignment available here is Chief's 2026-11-23 14:00:44 handoff to finish card `wc_9da6a822b3133f76`; the inherited context describes its outcome as retaining offline sends across closure and showing Updating. No verbatim original Justin offline-priority message was available to this reviewer. Do not turn that derived attribution into a direct quote.

## Findings

### F1 — Foundation must meet the durable-before-effect claim

- **Class / severity:** DESIGN / high. Known accepted findings, not additional scope.
- **Index:** P1 Structure > Willpower; P10 Comprehensive-First; P14 Distrust Temporary Success; B24 ambiguous timeout outcomes.
- **Sources:** canonical index; `src/server/mobileMediaRoutes.ts:125`; App/Slack age-exemption blocks.
- **Spec sections:** Grounded Existing Seams; Durable Upload And Send State; Cross-Tab And Reconnect Execution.
- **Finding:** Stable client IDs cannot provide the stated single-upload guarantee while upload allocation precedes request reservation and recording failures still return success. Likewise, replaying an old exact stop cannot rely on server age refusal where App/Slack exempt that path. These are false foundation assumptions, not a reason to weaken the client promise or add a new identifier on retry. Completed-upload reconciliation must account for chunk rows removed after assembly.
- **Resolution:** Include the accepted minimal server repairs: reserve before upload allocation, make uncertain recording hold rather than appear safely replayable, preserve chosen upload identity where recoverable; enforce original request age before new App/Slack stop effects while retaining prior-result lookup and existing legitimate stop exemptions; reconcile upload status after interrupted completion. Prove lost-response and stale-stop cases against actual endpoints. No recurrence-risking deferral is justified.

### F2 — A new durable drain needs explicit failure brakes

- **Class / severity:** DESIGN / medium.
- **Index:** P19 No Unbounded Loops; B22 Own The Lifecycle; P8 No Dead Ends.
- **Source:** `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` P19; `dashboard/console/chats.js` deliver's existing `for (;;)` loop.
- **Spec sections:** Cross-Tab And Reconnect Execution; Durable Upload And Send State.
- **Finding:** The draft says to inherit backoff/Retry-After and server limits without a new budget. The underlying final-send loop has growing delay capped at 30 seconds but no breaker; a persistent 202/429/5xx can therefore keep an automatic drain trying indefinitely. Server capacity limits are not a client breaker. Extending that foundation to every saved entry and every dashboard start broadens the same uncontrolled retry surface.
- **Resolution:** Name an existing suitable bounded retry owner, or define a bounded drain episode with backoff, per-attempt bounded work and a sustained-failure stop that leaves the encrypted row visibly retained. A real reconnect or explicit retry can start a new episode with the same IDs/body. Declare and test its sustained-rejection behavior. Do not restore silent count/age pruning, mint new IDs, introduce an arbitrary content expiry, or require an LLM for mechanical immutable replay. The exact brake values should reuse justified existing behavior where possible; this review invents none.

### F3 — Measure the recovery outcome without collecting message content

- **Class / severity:** DESIGN / medium.
- **Index:** P18 Observation Needs Structure; Observability constitution article; P20 Verify The State, Not Its Symbol.
- **Source:** conformance Observability flag; current constitution's whole-loop metrics requirement.
- **Spec sections:** Capability And Awareness; Tests, Rollback And Completion.
- **Finding:** The declared maturation owner and test matrix are useful but do not state how the shipped feature reveals whether eligible queued messages actually reach durable acceptance, remain held, or wait indefinitely. Queue-entry presence and an `outbox` support flag cannot establish that outcome. This matters especially when the feature resumes outside the original conversation.
- **Resolution:** Add a small privacy-preserving measurement contract using the existing local queue and maturation owner: admitted/attempted/accepted/held outcome counts or equivalent derived local measures, pending age, version and explicit unknown when storage cannot be read. Make these inspectable on the existing pending-send surface and record the actual browser-run outcomes in the existing evidence carrier. No raw text, destination, filename or secret telemetry, new server message store, competing registry or new watcher is required. Ordinary sending must not be disabled merely because a diagnostic aggregate cannot be read.

### F4 — Keep attribution, completion evidence and scope wording precise

- **Class / severity:** PRECISION / low.
- **Index:** L7 Bug-Fix Evidence Bar; P26 Documents Stand On Their Own; Live-User-Channel Proof Before Done.
- **Finding / resolution:** The ELI16 stands on its own. In the dense opening, explain offline-send retention and real catch-up before mentioning W3/W6, and cite the actual logged source or simply name the Chief/card assignment rather than unsupported direct Justin attribution. The real isolated dashboard test can be the user-role proof; make its version-bound scenario matrix an artifact required before asking the operator to try the feature. Where an end-to-end scenario claims visible Telegram or Slack delivery, use isolated demo channels and retain that evidence; mocked acceptance alone must not be called real provider delivery. This clarifies the already-required actual-browser completion gate rather than demanding a new test framework.

## Conformance Flags — Independent Disposition

1. **One-file preparation as fixed boundary:** No new eligibility floor is justified by serial execution. Treat serial processing as an implementation choice to limit live plaintext/memory, not a universal authority or reduced file allowance. Preparing files sequentially still admits every supported file; no material user benefit is removed. PRECISION unless implementation turns it into a refusal.
2. **Outcome observability missing:** Accepted, F3 DESIGN. Scope the repair to local/metadata evidence, not message collection.
3. **Live user-surface proof:** The spec already requires real Chrome, actual initialized server and close/reopen behavior. Require the actual user-role artifact before done/operator testing (F4). A dashboard feature does not acquire a new production-account requirement merely because HTTP routes also support providers.
4. **Unbacked direct attribution:** Accepted as F4 PRECISION; direct original user words remain unverified here.
5. **Unexplained W3/W6 and handoff:** Accepted as F4 PRECISION. The ELI16 itself is clear; no misleading product design is inferred from internal row labels.

## Experience Fit

**Attributable goal/source:** Chief's explicit assignment is to carry the durable web offline-send card to a commit. Available card context says a sent offline message survives closing/reopening and sends automatically; the connection line shows Updating during catch-up. The original user's words are unavailable, so this is assigned scope rather than a fabricated verbatim user preference.

**Ordinary journey:** The person presses Send once in an already-approved browser. Successful encrypted admission precedes composer clearing; failure leaves the actual text/files in place. Reopening the dashboard and reconnecting resumes the original operation without opening its conversation, repeating text or approving the same send again. Updating reflects actual reads rather than a health ping. This fits the requested experience. The implementation must honor dashboard-wide resume, not quietly make it depend on visiting Chats; the spec already promises that boundary.

**Contrasting cases and trust:** Retrying the same immutable saved operation is covered by the original Send, even after a lost response; it needs no new approval. A different message in the same channel is a different user send, not inferred permission from a service label. Changed actor, destination or Slack holder must not be substituted under that original Send. Current server permissions remain authoritative. This feature creates no standing grant, pairing authority or semantic classifier. Held uncertain content gets Check conversation; it does not automatically become a new message with a new audience or ID. The trust article supplies the no-repeat-ask and no-widening boundaries; it does not require asking again for every transport retry.

**Evidence and limits:** This is a design assessment, not a measured ask-count or delivered-message result. Before/after browser scenarios must show draft survival, one logical effect and no redundant prompt. Permission changes and refused/unknown outcomes are separate cases. The known foundation issues F1 would defeat that intended experience until repaired. F2/F3 are needed so a retained message does not silently become an endless invisible retry.

## Benefit Survives The Walls

Identity binding protects the original actor at the cost of holding sends after identity changes; automatic rebinding would change authority. Durable-before-clear costs local storage/crypto work but is the actual retention benefit. Holding unknown outcomes costs automatic progress when acceptance is ambiguous but protects against duplicate real effects. An open dashboard is a browser execution limit, not an invented new approval. Unsupported/older backends hold safely until upgraded; the version field must be grounded in real dependencies. No new queue-count/age purge, history cache or service-worker phase is warranted. The surviving concrete benefit is one original offline send retained and resumed once per tested scenario; population success rate remains unmeasured until implementation evidence exists.

## Other Applicable Lessons

Migration/awareness are correctly routed through the existing registry, with new/existing-agent verification. Real browser persistence and all three test tiers engage P4/L7 rather than relying on fake IndexedDB. No secret export, production-profile use or received-history persistence is proposed. Non-extractable origin-local keys are honestly described as insufficient against trusted origin code. Rollback preserves enrollment and encrypted data without falsely claiming the old UI can execute it. Mechanical replay should be recorded as Tier 0 with no new semantic policy decision; existing server authorization remains authority. This is a short rationale, not a reason to add per-message LLM cost or permission prompts.

SUMMARY: 0 critical, 1 high, 2 medium, 1 low findings. DESIGN findings: 3 (one consolidates already-accepted foundation findings); PRECISION findings: 1. Convergence-blocking until the stated DESIGN resolutions are represented in the next spec.


### Internal artifact: review-r1-scalability.md

# Round 1 — Scalability And Storage Review

Reviewer: outbox_scalability. Actual reviewer model: inherited GPT-6.2 family, not a Claude reviewer. Read-only source review; no test suite or browser launched. Spec, ELI16 and conformance-round1.json read in full. Standards conformance input reports HTTP 400/unavailable, not a clean constitutional result.

## Verdict

One DESIGN finding in the existing upload-start foundation prevents concurrence. The client storage design is otherwise reasonable for the inherited message/file limits. No new count quota, age purge, server message store or received-history cache is requested.

## Findings

### S1 — DESIGN / High: Upload-start does not provide the claimed durable idempotency contract

Source: src/server/mobileMediaRoutes.ts, POST /mobile/media/uploads, especially media.startUpload followed by requests.reserve/finish. src/core/MobileChatRequests.ts reserve exposes `full` and can throw on persistence; finish returns false if its result cannot be persisted.

The route allocates the upload first, then attempts its request reservation. It ignores the reservation kind, including `full`, and catches persistence errors while still returning a successful upload response. A lost HTTP response after a failed/full reservation, or a crash between allocation and reservation, permits replay of the same original upload-start ID to allocate a second upload. This is a realistic disk-pressure/crash boundary, precisely the interrupted-upload path this spec promises to recover. Stable client IDs and entry CAS cannot repair a missing server reservation.

Required resolution: specify and implement a narrow reserve-before-effect upload-start admission, treating non-reserved/uncertain outcomes explicitly, before advertising the capability as safe. The existing request-store `entered`/unknown contract can conservatively hold an ambiguous operation; this need not become a new durable workflow engine. Do not create an upload when request capacity is full. Finish/result-write failure must not be silently presented as a durable replayable result. Add failure-injection HTTP tests for full/reservation persistence failure and the allocation/result crash/lost-response boundary. If choosing another implementation, demonstrate causally why repeating one original start ID cannot allocate another upload. This extends one layer below the spec boundary because that foundation's guarantee is load-bearing.

### S2 — PRECISION / Medium: Read completion state before re-sending chunks

Source: AppMediaStore.finalizeUpload marks complete and removes chunk rows/files; uploadView returned by repeat POST includes `received` but not `state`. Thus a completed upload can return an empty received list after an acknowledgment loss. The spec already requires GET state and says an empty list is not completion. Implementation must obtain GET state before deciding which chunks need sending, and reconcile `upload-not-open` with GET completion when two tabs race. A complete upload must not become held merely because a second tab replayed a now-removed chunk. This is an implementation-order clarification of existing requirements, not a request for another design round by itself.

### S3 — PRECISION / Low: Preserve the stated memory bound while doing atomic file admission

Source: inherited appMediaTypes MAX_MESSAGE_BYTES=64 MiB, MAX_FILE_BYTES=50 MiB, CHUNK_BYTES=1 MiB, MAX_ATTACHMENTS=10. The spec's prepare-ciphertext-before-one-transaction plan is bounded by those existing limits, but may simultaneously retain the whole selected plaintext, complete ciphertext and IndexedDB structured-clone buffers. Process one file/part at a time, release plaintext promptly, keep ciphertext as Blob/typed parts, and cursor only entry metadata during enumeration/progress. Include an eligible near-limit file in actual-browser acceptance, without adding a smaller local file cap. No additional fixed memory budget is requested.

## Two-Tab/CAS Assessment

Immutable persisted operation IDs plus exact payloads can make physical duplicate requests harmless if the server contract is real. CAS updates must require the winning revision/epoch, losing tabs must reread instead of rebuilding final JSON, and terminal deletion must defeat late progress. Those requirements are stated. A Web Lock is a useful optimization rather than an invented lease authority. The finding above is why the server side must be repaired/proven before relying on no-lock correctness.

## Storage Assessment

Keeping crypto/File awaits outside active IndexedDB transactions is correct. Atomic admission before clearing the composer avoids exposing a partial queue as safely saved. A separate database avoids the existing device-database version rollback problem. Quota/transaction failure retains the composer, and no silent queue pruning is proposed. Global/scope epochs and existing-row revision checks provide the right stale-write fence; they must be exercised with actual asynchronous transactions, not inferred from a memory-map fixture. Opaque identifiers plus ciphertext avoid content enumeration during queue scans.

## Foundation And Scope

MobileChatRequestStore performs synchronous reservation persistence before other callers' effects and exposes unknown after restart; it is an appropriate existing primitive for S1. Its inherited capacity/retention is not asserted as a physical eligibility truth. The new design should retain content when those authorities refuse, rather than turning capacity pressure into another start ID. No request to change advertised attachment eligibility, increase retry budgets, persist received history or execute with the browser closed.


### Internal artifact: review-r1-security.md

# Round 1 — Security Review

Reviewer: outbox_security. Actual inherited authoring/review family: GPT 6.2, not Claude; no cross-vendor diversity claimed. Read-only review; no tests or runtime edits. Reviewed the full spec and ELI16, the reported conformance result, and one layer of the current browser-device, console, media route/store and request-store foundations.

Standards-Conformance Gate input: unavailable, HTTP 400 in the supplied round-1 artifact. This is reduced evidence, not a clean constitutional result.

## Verdict

One material DESIGN finding remains. The encryption and identity boundaries are otherwise appropriately narrow: separate non-extractable encryption key, authenticated per-part identity, committed bytes before destructive composer changes, exact original actor/body replay, durable deletion fencing, conservative handling of uncertainty, and no received-history persistence. Do not approve the current one-upload-identity guarantee until the server foundation below supports it.

## S1 — DESIGN / High: upload-start idempotency is not durable before its effect

The spec relies on a repeated upload-start ID recovering one upload identity after a lost response, including no-Web-Locks two-tab operation. In `src/server/mobileMediaRoutes.ts`, the start route calls `media.startUpload(...)` first. That function creates a fresh random upload ID, directory and SQLite row. Only afterward does the route call `requests.reserve(...)` and `requests.finish(...)`. A reservation exception is caught, degradation is reported, and the route still returns the newly created upload as a normal success. `finish` can also return false without this caller checking it.

If that response is lost after request-store persistence failed, the client's durable state still contains only its original upload-start request ID. Repeating that exact ID finds no retained request and creates a second upload identity. The client cannot follow the proposed instruction to hold on uncertain server storage, because no failure reaches it. Repeated responses lost under request-store failure can consume the device/machine staging allowance while the same logical file remains queued. The existing staged-byte limits bound this resource effect, but they do not establish the proposed identity/recovery guarantee.

Required resolution: repair the upload-start foundation so a stable chosen upload identity is durably bound to the original request before creating its effect; recover an interrupted reserved operation with that same ID, and do not advertise durable-outbox support when this contract is absent. Alternatively redesign the advertised contract and recovery protocol explicitly, without claiming one upload identity from the current code. Exercise reserve failure, finish failure and lost response against real HTTP/store dependencies. This is a foundation issue directly within the outbox's load-bearing protocol, not a request to broaden received-history or provider scope.

Evidence: `mobileMediaRoutes.ts` start route, especially `media.startUpload` before its reservation/catch; `AppMediaStore.ts` `startUpload` creates a random ID and row; `MobileChatRequests.ts` `reserve` removes its in-memory record if persist fails and `finish` returns false on persistence failure.

## S2 — PRECISION / Medium: pin concurrent first-key initialization in implementation

The spec says to check key/epoch in the atomic admission transaction, which can support the right implementation. Make that check substantive: simultaneous first submissions in two tabs may each generate an AES key before either writes it. A tab must use the single durable winning scope key, or abort and re-encrypt under that key; it must never overwrite a scope key while another committed entry still depends on the prior key. Test two first admissions with Web Locks disabled. This clarifies the already-required atomic key check; it does not require a new protocol or key export.

## S3 — PRECISION / Medium: test sign-out from another tab across a crypto await

The spec already requires scope/global epochs, an existing row at physical-step admission, post-await liveness checks and no resurrection. The browser enrollment remains intentionally present on logout, so a second tab's cached device record alone cannot establish current queue authority. The implementation and real two-tab acceptance test must use the durable queue epoch/row for its network-admission fence, including a signature in flight when another tab signs out. A request durably admitted before logout can remain uncertain, as the spec discloses; no new admission may be justified only by the still-loaded signing record afterward. This is an explicit test of existing design requirements, not a demand for cross-database atomicity or an impossible unsend guarantee.

## Other reviewed boundaries

- A non-extractable encryption key does not defend against trusted same-origin script; the spec states this limit honestly.
- Existing request ID age checks and current signing authorization remain server authority. No automatic new ID is introduced for an ambiguous prior send.
- Encryption at rest does not create a bearer/grant copy; the pending content remains browser-local under the approved physical credential boundary.
- Sign-out and Forget errors must remain visible; encrypted data is not silently described as removed after an aborted transaction.
- Browser/profile close-and-reopen evidence, real structured-cloned CryptoKeys, quota/abort and tamper tests are appropriate completion gates. A fake IndexedDB fixture alone would not satisfy them.

DESIGN findings: 1. PRECISION findings: 2. No operator decision identified within this scope.


### Internal artifact: review-r2-adversarial.md

# Round 2 — Adversarial Review

Reviewer: independent child agent, inherited GPT-6.2 authoring-family model. Read-only spec/source inspection; no tests or source edits. Reviewed updated spec and substantive conformance-round2 report:102 standards,6 possible-violation flags.

Final verdict after the reviewed round-2 amendment: **zero unresolved DESIGN findings**. The three prior findings are resolved. The newly introduced scheduling finding below was raised during this round and corrected in the final inspected spec; its original reasoning and resolution remain recorded rather than erased.

## Prior findings

- **A1 resolved:** the Minimal Server Foundation Repairs section requires reserve before upload allocation, explicit handling of non-reserved/full/conflict outcomes, and durable finish before success. Failed finish/crash retains uncertain custody rather than allocating another start ID. This is the necessary foundation repair, subject to actual fault-boundary tests.
- **A2 resolved:** request-age validation covers NEW App/Slack exact stops after retained-result lookup, while preserving feature/rate exemptions for fresh stops. Explicit record-pruning and later-session tests are required. No broadened stop or replay authority is proposed.
- **A3 resolved:** read current upload status before interpreting chunk absence; after lost final-chunk acknowledgment, complete advances and assembling waits. Real conflicts/unknown/expiry hold. Together with the existing prohibition on overwriting winning final JSON, this resolves the common duplicate-final-chunk race without claiming its409 means failure.

## A4 — DESIGN, medium, resolved during round 2: server-directed waiting could strand a recoverable send

The new drain brakes pause after120 seconds and six retries, and explicitly forbid a self-rearming continuation. If Retry-After exceeds remaining time, the entry pauses until a new reconnect, submission or user Retry. Example: the browser reconnects, sends an original upload-start request and receives429 Retry-After180s. The dashboard remains open and connected; at180s the server is available, but no event wakes the paused queue. The person must notice and intervene. This fails the stated automatic-resume journey on a routine server-directed backoff, even though all content and request IDs remain safe.

Resetting the failure budget after confirmed chunk/phase progress correctly avoids pausing a healthy finite slow upload, but does not resolve a single Retry-After longer than the remaining budget or six transient failures followed by recovery without a new connectivity transition. The conformance report's Agent Carries the Loop flag identifies this same ordinary boundary.

Resolution should preserve bounded work while honoring a legitimate future continuation: schedule one cancellable same-ID wakeup at the server's retry time under declared dedupe/session-epoch/brake rules, or wire to an existing recovery scheduler whose later wakeup is actually guaranteed. No fresh operation ID, shortened Retry-After, content purge, indefinite hot loop or duplicate controller is needed. The design must say which actual event performs eventual retry when connectivity remains up. A real Retry-After-beyond-window test should advance to that event and observe automatic continuation without a user click.

### Resolution re-inspected

The final spec now bounds each immutable suboperation to the inherited six retries (seven attempts) with a20s per-attempt deadline: at most140s of network work plus at most six actual finite backoff/server-cooldown intervals. A finite Retry-After receives one same-ID scheduled continuation and is not shortened; waiting does not reset attempts or cause polling. Attempt admissions persist through entry CAS, so sibling tabs cannot each reset the failure budget. Confirmed chunk/phase progress advances the finite suboperation;202/probes do not. Only actual failure-budget exhaustion pauses for an explicit retry/reconnect/submission. This resolves the ordinary180s server-cooldown counterexample without an unbounded hot loop or a new operation identity. Implementation must retain the cooldown and epoch/identity fence when the continuation wakes; the prescribed real race/browser tests remain required. No remaining material contradiction identified.

## Other round-2 changes

Session epoch binding at authenticated console lifetime addresses a sibling tab re-adopting the post-logout generation. A durable content-free legacy import receipt surviving entry deletion prevents stale sessionStorage import resurrection. Keeping original final JSON and replaying retained results after upload expiry avoids reconstructing a different operation. Moving drain ownership above Chats navigation meets recovery without opening the original conversation. These are appropriate changes.

The memory statement now distinguishes reversible serial preparation from file eligibility. This lens does not add a lower size or queue-count limit. Conformance's aggregate no-lock resources flag remains for the scalability lens; idempotent logical effects do not by themselves prove a global resource bound. The rollback section openly says old-client sign-out cannot clean the new queue, and should not be read as proof that re-upgrade active status establishes no intervening logout. Security/integration lenses retain that qualification.

## Precision and evidence limits

The Grounded Existing Seams paragraph still calls identical chunk PUT idempotent without its completion qualification; later text now handles the actual boundary, so this is wording precision, not another design round. Clarify that chunk rows make duplicates idempotent while retained; completed upload status resolves later repeats.

No actual browser or HTTP tests ran in this review. Convergence is about the proposed design, not a durability or release claim.


### Internal artifact: review-r2-decisions.md

# Round 2 — Decision Completeness And Classification

Reviewer: outbox_decisions. Inherited GPT-6.2 family, not a Claude or independent cross-vendor read. Review only; no tests or runtime files changed. Read the complete final round-2 spec, ELI16 companion and conformance-round2.json.

## Verdict

Zero unresolved DESIGN findings from this lens. Eleven classified decisions are now collected by an explicit Frontloaded Decisions section. Ten are invariants and one is a user judgment point. No unresolved operator question, cheap-to-change-after exemption or contested cheap tag remains. This verdict concerns the proposed design; implementation and actual browser/HTTP evidence remain required.

The previously false foundation assumptions are explicitly changed rather than accepted as existing behavior: upload-start reserves before allocation and holds uncertain completion, and App/Slack NEW exact-stop requests receive age validation after retained-result lookup. Completed-upload status is reconciled before missing-chunk logic. Those changes are prerequisites for the safe-replay claim, not claims that existing source already satisfies it.

## Decision Contest

Exact actor, destination, immutable request bytes, admission-before-clear and durable epoch/revision fencing remain enumerable preservation/identity invariants. Moving the drain above page navigation and fixing its epoch at authenticated console startup closes the opportunity for a surviving sibling tab to adopt post-logout authority through another Send or route. Credential-shaped-text consent belongs to the exact captured content before it becomes eligible; a dialog in one tab cannot leave an automatically drainable entry in another.

The legacy-import receipt is a concrete cross-store crash guard. An untagged legacy row cannot prove continuous session authority and is therefore retained for review with zero automatic sends. This is a conservative missing-evidence result, not a guess about whether logout occurred.

The final replay distinction is complete: status 0/lost acknowledgment and 202 permit only the original operation under current server capability/result/age authority; explicit unknown, conflict, expired or definite refusal holds. The primary action is Check conversation. Resume original request can continue the same admitted operation and cannot create a fresh message ID. Re-authoring a new message remains the user's separate explicit decision. The action space, arbiter and fallback are therefore stated without requiring a mid-build user answer.

## Retry And Fixed-Limit Contest

The conformance report inspected an earlier 120-second drain cutoff. The final inspected body removes that cutoff and specifies seven attempts per failed immutable suboperation, each with the existing 20-second HTTP deadline, plus at most six actual finite cooldown/backoff intervals. Finite Retry-After receives a cancellable same-ID continuation rather than being shortened or stranded beyond a wall window. Successful chunk/phase progress advances to another finite suboperation; a health probe or repeated 202 cannot reset the budget.

Persisted attempt admissions and nextEligibleAt are shared through entry CAS. Their meaning is an operational brake on work, never content eligibility, permission to purge content, or proof of delivery. The operational number is a reversible choice derived from existing upload behavior, not a physical truth about how long valid content remains eligible. This is appropriately an enumerable bounded executor rather than a competing-signals social/work arbiter. On actual exhaustion the copy remains intact and the user can explicitly resume the original operation. No additional numerical policy decision is left to the operator.

## P20 And Conformance Disposition

The inspector ran: 102 standards, six possible violations, usable registry canary and a weak parent-fit verdict. This review does not relabel that report a clean constitutional pass.

- **Judgment Within Floors:** the final design separates per-attempt execution deadlines, finite server-directed waiting and input eligibility; healthy progress is not stopped by the removed total drain cutoff. Disposition above resolves this lens's concern.
- **Agent Carries the Loop:** one retained same-ID wakeup honors a finite server cooldown with no new user click. Only actual failure-budget exhaustion pauses. No health-based reset or automatic new message ID is permitted.
- **Bounded Blast Radius:** shared attempts and cooldowns constrain duplicate suboperation admissions. Aggregate file-memory/in-flight testing remains the scalability lens's responsibility; this review does not assert that logical idempotency alone proves a resource bound.
- **Observability:** the local pending view claims surviving count/phase/reason/age, not an end-to-end acceptance rate. Unmeasurable decryption/storage stays unknown rather than zero. Actual admission-to-acceptance behavior still needs the declared causal browser/profile and signed HTTP tests; a zero queue count is not accepted as that proof.
- **Verify State / downgrade:** the final rollback text explicitly withdraws old-client queue cleanup and continuous-session claims. An active signing key is not proof that no old-client logout occurred. Old software cannot provide the new queue's sign-out semantics; this is a disclosed compatibility limit, not corroboration. No automatic identity transfer is authorized by re-upgrade. Keep this qualification visible in release-facing rollback guidance.
- **Attribution:** the supplied Chief instruction is task provenance, not a claim that Chief authored this design. Exact quotation wording is a document precision matter handled by the lessons/experience lens.

Capability means substantive local protocol support, corroborated by real dependencies and route/lifecycle tests; missing/off/old support holds. Transaction completion plus actual profile restart, not a storage-symbol count, establishes durable admission. Durable server acceptance naming the message, not Queued/202/probe success, establishes acceptance. Actual generation-bound list/history/event reads, not a healthy health response, establish Updating completion. These boundaries and their unknown outcomes are explicit.

## Remaining Precision Notes

The earlier local-review wording should continue to distinguish possession of a saved encrypted item from authority to send under its old scope. It does not authorize rebinding, key export or automatic new sends. This was already noted in round 1 and does not require another design round.

The ELI16 sign-out statement describes the new client. If release guidance discusses downgrade, include the final spec's old-client exception there rather than promising the prior UI can erase a database it does not know. This changes no proposed behavior.

## Final Counts

- Frontloaded decisions: 11.
- Invariants: 10.
- Judgment candidates: 1.
- Cheap-to-change-after tags: 0.
- Cheap tags contested then cleared: 0.
- Unresolved operator questions: 0.
- Unresolved DESIGN findings from this lens: 0.

No tests launched and no runtime source edited.


### Internal artifact: review-r2-integration.md

# Round 2 — Integration And Deployment

Reviewer: outbox_integration. Actual inherited model: GPT-6.2 authoring family; independent internal lens, not a cross-vendor opinion. Read-only review; no test launches or runtime edits.

## Verdict

Zero DESIGN findings in the current round-two body. The accepted foundation repairs, console sign-in worker ownership, session epoch fencing and atomic legacy-import receipt address the material integration risks. This is a design review, not an implementation or browser-durability pass.

## Changes Verified Against Round One

- The drainer now belongs to the authenticated console session rather than the ChatsPage or selected conversation. The actual `console.js` start/sign-out and per-page `page-lifecycle.js` split supports that ownership. Reopening on Work/Home remains an important test of the stated requirement.
- The old enrollment database stays at schema 1, and the encrypted queue has its own database. Rollback explicitly leaves the queue dormant and does not claim that an older client's sign-out can clear it. Re-upgrade requires active identity/status; no unsupported client receives permission to reinterpret or send the queue.
- The legacy import receipt is committed with the encrypted entry, and survives entry removal while the old source might remain. Untagged legacy rows are held rather than automatically sent. This addresses the separate sessionStorage/IndexedDB crash seam without falsely claiming atomicity across the two stores.
- Upload-start reservation precedes allocation, and failed result recording stays uncertain instead of advertising successful durable recovery. App/Slack stop age validation is outside feature/rate exemptions after retained-result lookup. These are the required minimal fixes to the existing server foundation, not an unrelated messaging redesign.
- The status capability must come from initialized conversation/request/media dependencies and actual enablement. It is explicitly local support, not proof of a browser save or a whole-agent delivery verdict. Old/off support holds the queue.
- Awareness remains a single registry leaf, using the existing new-agent and migration renderer. No unnecessary new migration or generated-template edits are proposed.

## Parent Design And Multi-Machine Contest

Reviewed the existing dashboard-conversations-browser-device design, particularly browser key storage, route/signature boundaries, unfinished sends, lifecycle, machine posture and rollback. Its non-extractable key is origin/profile-local and signs the exact device/host/method/path/time/body. The new design preserves that authority, separates encryption from signing, keeps owner approval and server grants, and does not transfer private keys or re-author pending operations on another machine. Therefore `physical-credential-locality` remains a substantive justification, not an incidental preference for a local cache.

The older design's sessionStorage and client-only 23-hour behavior are deliberately superseded only for pending sends. Received history is still excluded. Accepted messages continue through ordinary server replication; an unsupported or dark holder is unknown/held. No new notice emitter or generated cross-machine URL is added.

## Conformance Round Two Disposition

The report's 120-second-window and server-cooldown findings refer to an earlier body. The current body removes that cutoff, uses seven finite attempt admissions plus their actual finite waits, does not treat health/202 as progress, and persists nextEligibleAt/shared counters. A scheduled continuation does not shorten the server cooldown. This addresses the concrete timing incompatibility rather than merely renaming the cap.

Without Web Locks, stable request identities and the accepted reserve-before-effect repair govern logical effects; persisted CAS attempt admissions also bound duplicate attempts per suboperation. Resource pressure remains a performance test obligation, not an integration reason to add a new lease authority.

The rollback sign-out flag is a real compatibility limit, and the current spec discloses it. Fresh active status must not be described as proof that no old-client sign-out occurred. The design instead keeps old-client cleanup outside its compatibility promise. The current rollback text makes that distinction; it does not claim retrospective cancellation. No server or browser migration can make an already-shipped old UI perform new cleanup, so preserving encrypted state with a clear limitation is preferable to a fabricated guarantee or destructive downgrade migration.

The pending-view metric flag concerns operational observability, not a dependency/migration gap: count zero alone must never be called proof of admission success. Actual commit success and real restart/acceptance tests remain the corroboration. Attribution and weak parent-principle fit are document precision issues.

## Left Behind — Precision Only

The ELI16 statement that sign-out clears pending copies should be qualified as behavior of a supporting version, matching the dense spec's explicit older-client rollback limitation. This is a one-line compatibility clarification and does not change the build.

## Evidence Limits

No actual IndexedDB transaction, Chrome profile restart, status dependency wiring, new/existing awareness rendering, server failure injection or provider delivery was executed by this reviewer. Those remain acceptance obligations. A code commit is not card completion or live Telegram/Slack acceptance, as the current spec correctly states.


### Internal artifact: review-r2-lessons.md

# Lessons-Aware Review — Round 2

Reviewer: outbox_lessons. Actual model: inherited GPT-6.2 family, not Claude. No source/test edits or test launches. Reviewed the entire amended spec body and round-2 conformance report (102 standards, six flags). Canonical lessons and relevant constitution articles were read in round 1; this is a delta review against those same sources, not a claim of implementation proof.

## Resolved Round-1 Findings

**Foundation, P1/P10/P14/B24:** The minimal server repairs now explicitly reserve upload starts before effects, require durable recording before success, hold uncertain reservations, enforce original age on new App/Slack stop effects, and reconcile final-chunk completion. These address the known false foundation assumptions. Implementation and fault-injection tests remain required.

**Retry brakes, P19/P25:** The revised failed-suboperation budget is persisted across tabs/reopen; it names seven attempts, per-attempt request limits and finite actual backoff/Retry-After waits. A single cancellable timer can honor a temporary server cooldown without polling. Exhaustion retains the content and has no self-rearming episode. Only independently confirmed successful chunk/phase progress resets the budget; probes and repeated 202 do not. This fixes the unbounded inherited loop without pausing a healthy large upload merely because two minutes elapsed. No new DESIGN finding on that design, assuming the cited existing ceilings are verified in implementation.

**Experience and migration:** Console-session-owned draining now explicitly survives page navigation. Credential-choice gating precedes eligibility. Unknown-session legacy rows are held rather than being guessed safe after sign-in. Import receipts prevent re-import after a cross-store crash. These are useful structural boundaries, not extra approval prompts for ordinary recovery.

## Remaining Findings

### F1 — Fresh status does not establish rollback sign-out continuity

- **Class / severity:** DESIGN / medium.
- **Index:** P20 Verify The State, Not Its Symbol; P8 UX; current trust article's no unsupported coverage boundary.
- **Spec:** Rollback; Identity, Logout And Deletion; Cross-Tab And Reconnect Execution.
- **Evidence:** The spec now acknowledges that the old client cannot clear the new outbox through sign-out, while re-upgrade requires a fresh active identity/status and honors existing epochs. An old client can remove/reacquire the dashboard bearer without advancing the new outbox epoch; the enrolled signing key is deliberately retained. The same active identity and old epoch can therefore exist both with and without an intervening sign-out.
- **Finding:** Disclosure fixes the false cleanup claim, but fresh status alone still cannot justify automatic replay as if sign-out continuity were verified. This is exactly the conformance report's P20 counterexample. A previously queued operation could automatically resume after the user signed out through the downgraded UI.
- **Required resolution:** Define and verify the supported compatibility boundary: e.g. a rollback procedure that quarantines retained operations before serving an unaware client, or another actual continuity mechanism that makes re-upgrade hold/review when cancellation continuity is unknown. Do not claim that a key/status or unchanged local epoch supplies missing evidence. Have integration/security reviewers settle the smallest safe protocol; this review does not invent a new credential or remote message store.
- **Limit:** This is a source-grounded design counterexample, not a performed downgrade test. If the product explicitly treats old-client sign-out as outside its cancellation contract, that exception must be a defended compatibility decision with an honest ordinary-user consequence, not merely an assertion that status is fresh.

### F2 — Pending-row visibility is not yet whole-loop outcome measurement

- **Class / severity:** DESIGN / medium.
- **Index:** P18 Observation Needs Structure; Observability; P20.
- **Spec:** Multi-machine posture; Tests, Rollback And Completion.
- **Finding:** Count/phase/held reason/queued time and explicit storage-unknown are good pending-send diagnostics. They do not distinguish a queue that admitted and accepted every send from a queue that never admitted a submission: both can show zero current rows. No denominator or admission/acceptance outcome evidence is specified outside release tests. The round-2 conformance flag remains substantive.
- **Required resolution:** Add a minimal privacy-preserving admitted/accepted/held/admission-failed outcome contract or equivalent to the existing local/maturation evidence. Include version, missing/unknown storage evidence and the browser-run denominator. Reuse existing owners and the pending-send read surface; no message text, filename, destination collection, server queue copy, new watcher or competing registry. This need not become an elaborate telemetry feature.

## Conformance Flags — Independent Disposition

1. **120-second window / six retries / 20-second deadline:** The 120-second whole-message cutoff is gone. Healthy finite progress may exceed it; failed-work bounds and actual Retry-After waits are now explicit. Resolved for this lens; decision-classification reviewer independently judges the inherited ceilings.
2. **Agent carries temporary cooldown continuation:** Resolved by the cancellable same-ID timer and persisted nextEligibleAt. Exhausted sustained rejection remains visibly retained with explicit same-ID recovery, not silently forgotten.
3. **No-lock aggregate amplification:** Logical idempotency is not a physical concurrency bound. Persisted CAS attempt admissions now stop tabs independently resetting retry counts, but the integration/scalability lenses must verify at-most-one admitted physical step/buffer owner or bounded physical duplicates against their actual implementation. No additional lesson-only finding is added here; this overlaps their concurrency authority.
4. **Observability denominator:** Unresolved, F2.
5. **Rollback status symbol:** Unresolved, F1.
6. **Chief attribution:** The spec supplies the exact handoff identifier; the source available in the parent conversation says, "Return to the durable web offline-sends card you chose ... Carry it to a commit and send it to me." The stated assignment is supported. Adding that short quote is a one-line PRECISION improvement; another round is not warranted for it. It is not a direct Justin quote.

## Experience Fit

**Goal/source:** Chief's explicit assignment for card `wc_9da6a822b3133f76`, plus the available card outcome: retain an offline send through closure, automatically resume it after reopening, and show Updating during real catch-up. Original Justin wording remains unavailable to this reviewer; no fabricated attribution or measured ask burden is claimed.

**Ordinary journey:** In an approved signed-in console, the person presses Send once. Its exact credential-shaped-text choice is resolved before another tab can send it. Successful encrypted admission precedes clearing; failure preserves the actual draft/files. Closing/reopening and reconnecting can resume the same operation from any dashboard page without visiting its original conversation or giving the same approval twice. A valid finite server cooldown resumes automatically. Healthy chunk progress can continue beyond the failed-work budget. This preserves concrete benefit after the safeguards.

**Contrasting cases:** The same saved body/destination/actor after a lost response is the same requested send and needs no new permission. Another message with the same channel label is a separate explicit send. A changed actor/destination/Slack holder is not covered by the old operation and must not be substituted. Definite outcome uncertainty gets Check conversation; a disclosed Resume original request can only repeat the exact original operation. Received-history caching and new grants remain excluded. Legacy rows with unproven session lifetime correctly require review rather than pretending fresh status reauthorizes them.

**Evidence/limits:** Actual recovery and ask burden remain unmeasured until implementation. The real Chrome/profile and signed-server scenarios are appropriate pre-operator evidence. The spec now distinguishes code commit, isolated acceptance and later actual demo-channel rendering; it does not claim fixtures prove provider delivery. The rollback journey is the remaining experience exception in F1: a newer user's sign-out expectation cannot be inferred from old-client state that never recorded it.

## Benefit And Proportion

A real benefit remains: one originally authorized offline operation is retained and resumed with the same actor and identifiers, without new permission or lost content. Serial preparation is correctly described as a reversible execution strategy, not reduced eligibility. No new received-history storage or service worker is demanded. The remaining fixes should be narrow continuity/measurement declarations, not broader infrastructure.

SUMMARY: 0 critical, 0 high, 2 medium DESIGN findings; 0 new blocking precision findings. Round 1's foundation and retry findings are represented in the revised build; the current rollback continuity and whole-loop outcome measurement still need explicit resolution or a defended compatibility disposition before this lens is quiet.


### Internal artifact: review-r2-scalability.md

# Round 2 — Scalability And Storage Review

Reviewer: outbox_scalability. Actual model: inherited GPT-6.2 family, not Claude. Read the complete latest durable-outbox spec, the round-two conformance report, the parent browser-device design and the upload/request-store foundation examined in round one. No tests or source edits performed.

## Verdict

Concur with the revised design. Zero unresolved DESIGN findings from this lens. Implementation and actual-browser acceptance remain necessary; this review is not evidence of storage durability, memory use or endpoint behavior.

## Round-One Findings

- S1, DESIGN/high — resolved. The new Minimal Server Foundation Repairs section requires durable request reservation before media allocation, handles full/refused/conflicting outcomes before effects, and requires durable finish before returning success. Allocation or result uncertainty leaves the original reservation entered/unknown, so replay cannot allocate another upload. Retaining a stranded upload until existing expiry is the stated conservative tradeoff; it does not discard the user's local bytes or create a new logical operation.
- S2, PRECISION/medium — resolved in the stated build contract. GET completion state precedes interpreting missing chunks. Complete uploads advance despite removed chunk rows; assembling waits; lost final-chunk responses are reconciled by actual state rather than inferred from an empty list.
- S3, PRECISION/low — addressed. Plaintext buffers are released after encryption, ciphertext uses Blob/typed parts, admission uses existing advertised aggregate/file bounds, and queue enumeration excludes file-data getAll/stringification. No narrower eligibility cap is introduced. The parent media contract is 64 MiB aggregate, 50 MiB per file, 1 MiB chunks and ten attachments. Actual-browser near-limit behavior still needs measurement; the spec is not a measured resident-memory guarantee, and implementation should account for ordinary cipher/structured-clone overhead rather than claim an exact RSS ceiling.

## Retry And Cross-Tab Assessment

The final retry wording supersedes the conformance report's older 120-second window. Each failed immutable suboperation has seven total admitted attempts using the existing 20-second HTTP deadline: at most 140 seconds of network work, plus at most six finite actual server/backoff waits. A server Retry-After continuation retains the original ID and nextEligibleAt; it is not cut short by a separate elapsed-window deadline. Neither health probes nor repeated 202 replies reset the budget. A successful, newly confirmed finite chunk/phase advance does. Attempt admissions and cooldown are persisted through shared row CAS, so the bound belongs to the queued operation across sibling tabs and reopenings rather than being multiplied independently by every tab. Terminal epochs and deletion defeat stale writes.

This addresses the Scalability/Bounded Blast Radius conformance concern at design level: Web Locks reduce duplicate physical work, while shared admissions bound the no-lock fallback. During implementation, a CAS loser must reload the winning entry/counters and must not issue HTTP using a stale admission. Repeated confirmation of the same already-known chunk is not a new phase advance. These follow the stated shared-counter/progress contract, not a request for an added lease or new quota.

Honoring a finite Retry-After automatically addresses the recoverable-429 loop concern raised by the conformance report. Genuine exhaustion pauses with content/progress retained and a same-ID Retry action; actual reconnect can start another bounded episode. This does not promise perpetual autonomous retries or delivery while the browser is closed. The pause is observable rather than a silent drop.

## Storage And Lifecycle Assessment

The console-lifetime runner prevents route changes from stranding all eligible pending entries. It is separate from the received-history catch-up state and does not keep Updating active for a long upload. Durable session epochs are captured once rather than silently reacquired by an old tab. Atomic import receipts prevent a surviving legacy sessionStorage row from being imported again after its first encrypted entry was accepted/removed. Crypto remains outside IDB transactions, and key/epoch checks plus entry/parts admission remain atomic. Existing-row revision checks prevent callbacks from recreating a removed entry.

The pending-sends view describes actual retained rows and explicitly treats decrypt/storage failure as unknown. A zero-row view is not claimed to prove a successful admission or delivery rate. The conformance observability flag therefore does not justify a new telemetry store or content counter in this scope; actual browser tests must separately prove admission and later durable server acceptance. Site-data eviction and old-client sign-out limitations are disclosed rather than represented as new-client cleanup guarantees.

## Evidence Still Required By The Build

Existing specification gates cover the relevant performance and recovery boundary: real IndexedDB/WebCrypto restart, quota/transaction failure preserving draft and bytes, two tabs with Web Locks disabled, persisted attempt/cooldown CAS across reopening, complete-upload/lost-ack recovery and server reservation/finish failure injection. In-memory fixtures alone cannot establish these behaviors. No new reviewer-requested budget, server message store, received-history cache or service worker is required.


### Internal artifact: review-r2-security.md

# Round 2 — Security Review

Reviewer: outbox_security. Inherited GPT 6.2 family, not Claude; no cross-vendor diversity claimed. Read-only review, no tests or source edits. Reviewed the updated complete spec, its browser-device parent (§4.1 key boundary, §4.6 lifecycle, §4.8 unfinished sends, multi-machine posture), prior security findings, and round-2 conformance report.

## Verdict

Zero unresolved SECURITY DESIGN findings. The prior material upload-start finding is resolved by the conservative server protocol now specified: reserve before allocation, refuse failed reservation before effects, and keep an entered/unknown reservation rather than allocate again when finishing or its response fails. This does not require reconstructing a chosen upload ID after a crash, because the design deliberately holds that uncertain operation instead. Actual implementation and tests must establish that contract before the new support field is advertised.

The parent browser design supplies a physical-credential boundary rather than an origin-script security guarantee. The new specification preserves that distinction, does not export or repurpose signing keys, keeps received-history caching excluded, and changes automatic recovery only for operations admitted by the user under the same identity/body.

## Prior findings

- S1 DESIGN: resolved by Minimal Server Foundation Repairs and corresponding real-store HTTP fault tests. Reservation full/refusal must also precede allocation. Check finish's Boolean result, not only exceptions.
- S2 PRECISION: still applicable implementation detail within the atomic key/epoch-check requirement. Two first admissions must use the winning durable scope key or re-encrypt; never overwrite a key protecting an existing entry. Include no-Web-Locks contention coverage. No new design choice is required.
- S3 PRECISION: strengthened/resolved at design level by an authenticated console lifetime epoch that sibling tabs cannot silently adopt. Test a signing await spanning another tab's logout, and use durable row/epoch admission rather than the surviving enrollment record. Already-admitted network uncertainty remains disclosed.

## Round-2 conformance flags

The inspector ran against 102 standards and returned six possible violations with `degraded: false` and a weak parent-fit verdict. That is an advisory result, not a clean gate.

1. **Judgment Within Floors / retry episode constants.** The final revision bounds 120 seconds of consecutive failed recovery, resets only after independently confirmed successful chunk/phase progress, and excludes repeated 202/probe answers as progress. This avoids pausing a healthy finite transfer merely for its total duration. The episode is a reversible operational default, not message eligibility, and content is retained. It does not weaken authorization or create new effects. The decision/experience reviewers should contest whether pausing the current episode appropriately carries the user's delivery loop; no separate security design finding.
2. **The Agent Carries the Loop / paused retries.** A stalled valid queue is a delivery/usability limitation, not evidence of a security bypass. The pending item must remain visible with its real held/paused reason. Avoid automatically interpreting a pause as delivery or removal. Experience/decision disposition remains necessary.
3. **Bounded Blast Radius / no-lock tabs.** Logical IDs bound effects, not aggregate transport memory. This is a substantive performance lens: the implementation must not claim Web Locks are required for identity safety, and must use the current server rate/staging limits. Additional physical-request coordination may be warranted; the scalability/adversarial reviewers own that finding. No independent expansion of security retry authority is proposed.
4. **Observability / zero-entry ambiguity.** The spec's pending count explicitly describes surviving local encrypted rows, not successful admission or recovery rate. Zero is not treated as proof of delivery, and storage/decryption failure remains unknown. Thus the security evidentiary boundary is honest. A receipt/counter proving the user's full journey is a separate implementation/experience requirement, not derivable from queue count.
5. **Verify State / downgrade sign-out.** The old client cannot clear a database it does not know about or invalidate its epoch. The updated rollback section explicitly discloses that limit and does not claim old sign-out performs new-queue cancellation. Fresh key status proves current identity authorization only; it must never be described as proof that no intervening logout occurred. This is a bounded compatibility limitation, not something the implementation can infer from another proxy. Retain it in rollout/review documentation; no claim of cross-version logout detection is permitted.
6. **Attribution / Chief's direction.** Source quotation is an attribution/experience lens, not a browser security mechanism. The exact card and handoff are named, and received-history scope remains excluded. The author should satisfy that lens with actual source words rather than reconstructed authority.

## Additional checks

Reviewed the final failed-recovery-budget amendment after the inspector report: successful chunk/phase progress resets the failure budget; repeated 202 and health probes do not. This narrows the inspector’s healthy-upload concern without granting new message identities, changing retry authority or silently discarding content.

- The new stale-stop age floor follows retained-result lookup but precedes a new stop effect. This addresses the replay hazard after request pruning without removing existing fresh emergency-stop exemptions.
- Completion status is reconciled before missing chunks; removal of chunk rows after completion must not cause a completed upload to be uploaded again.
- Stable legacy import receipts and session invalidation prevent a crash between encrypted admission and legacy deletion from resurrecting a removed operation.
- The server support field remains a local, substantive contract and cannot claim browser storage success, authorization, provider delivery, or deployment evidence.
- Real profile/IndexedDB/CryptoKey acceptance and fault-injected server tests remain required. This review does not certify unimplemented code or test results.

DESIGN findings (security): 0. PRECISION items retained: 1 (concurrent winning scope key); cross-tab logout now has an explicit design fence and remains a test requirement. No operator decision identified within scope.


### Internal artifact: review-r3-adversarial.md

# Round 3 — Adversarial Review

Reviewer: independent child agent, inherited GPT-6.2 authoring-family model. Entire current spec read, including final round-3 changes. Read-only review; no tests, source or spec changes. Conformance-round3 was still pending when this report was first written; it is not claimed as read or cleared.

## Verdict

**Zero DESIGN findings. One PRECISION qualification remains from earlier wording.** The reviewed design resolves the adversarial failure paths identified in rounds1–2 and makes the new safety boundaries explicit. This is a design verdict, not an implementation, durability, release or live-delivery claim.

## Re-inspected boundaries

1. **Upload reservation before allocation.** Same-ID repeated starts cannot create another upload after failed reservation/finish or restart. Non-reserved/full outcomes occur before allocation; uncertain completion retains the original reservation and content. Fault-boundary tests remain necessary.
2. **Final chunk response loss.** Current GET status resolves a completed upload after its chunk rows were removed. An empty chunk list is not treated as missing bytes by itself. Actual conflict/expiry/unknown holds; assembling waits. This supports real duplicate physical requests without treating every409 as failed delivery.
3. **Original operation age and stop timing.** NEW App/Slack effects, including exact stops, receive age validation after retained-result lookup. More significantly, exact stops cannot be automatically replayed after offline admission, deferral, failure/uncertainty or reload. Only the existing canonical exact set is used. The fresh immediate attempt belongs to a current live user interaction; another tab/recovery cannot manufacture that interaction. Holding the original and offering text in the composer preserves user content without firing an old stop into a later session.
4. **Operation bytes versus signatures.** Embedded operation ID/time, destination and serialized body remain frozen; each physical request uses a fresh signing-header timestamp/signature from current corrected time. This supports authentication freshness without creating a new logical send or treating an expired signing header as grounds to rewrite application bytes.
5. **Logout failure ordering.** Durable epoch invalidation commits before the separate erasure transaction. An erasure abort cannot roll back the prior invalidation. Failure to invalidate remains explicitly different from successful fencing but failed cleanup. Live sibling broadcast/fence supplements rather than substitutes for the durable epoch. Already-admitted network work is not falsely called cancelled.
6. **Legacy import and actor continuity.** Content-free durable import receipts survive entry removal, so a legacy sessionStorage row cannot resurrect a deleted/accepted item. Untagged legacy rows cannot prove no intervening sibling logout and are imported held, not automatically sent. Actor/key/machine mismatch is never repaired by re-signing under another enrollment.
7. **Retry scheduling and multiple tabs.** A finite Retry-After gets a single cancellable same-ID wakeup. Persisted nextEligibleAt/attempt admission prevents reopening or sibling tabs shortening the cooldown or resetting budgets. Six retries/seven attempts are finite; confirmed phase/chunk progress, rather than202/health checks, advances the suboperation. Exhaustion preserves content and exposes the exact-original operation separately from a new send.
8. **Supported rollback.** Flag-off retains queue/epoch/logout/device-cleanup shims and holds encrypted rows. The design no longer calls a full pre-feature binary downgrade an automatically safe cancellation/recovery path. Active key status alone is not treated as evidence of uninterrupted consent. Required explicit review after such an unsupported downgrade is a conservative limitation rather than a continuity claim.
9. **Metrics.** Content-free admission/acceptance/held/failure counters and actual acceptance durations arise from real transaction/result transitions. They distinguish zero admitted sends from an empty queue after acceptance, and unavailable measurement remains unknown. They do not claim the browser key or a healthy probe proves delivery.

## Precision qualification

The Grounded Existing Seams paragraph still calls identical chunk PUT idempotent without qualifying the completed-upload boundary. The detailed state machine now handles that boundary correctly, so this is **PRECISION**, not a further design defect. A concise wording change may say duplicates are idempotent while chunk hashes remain, and completed status resolves repeats after cleanup. No additional convergence round is needed for that wording alone.

## Evidence and scope limits

Real no-Web-Locks two-consumer tests, reservation/finish fault tests, stale-stop/current-session tests, logout failure transactions, real-profile close/reopen, and wire/history acceptance are still required. No such test was executed by this reviewer. Received-history persistence, new identities, service workers and cross-origin replication remain outside this card, appropriately.


### Internal artifact: review-r3-lessons.md

# Lessons-Aware Review — Round 3

Reviewer: outbox_lessons. Actual model: inherited GPT-6.2 family, not Claude. Reviewed the amended spec body and ELI16 against the canonical lessons/current articles loaded in prior rounds. No tests or runtime edits. This is design concurrence, not evidence that the feature is implemented, delivered or live.

## Verdict

No remaining DESIGN findings from this lens. The two round-2 findings are resolved by substantive design changes rather than by treating a proxy as proof or introducing universal historical-client tracking.

## Resolution Of Prior Findings

**Rollback/sign-out continuity — resolved.** Supported rollback is now explicitly a retained queue/epoch/logout/device-cleanup shim with draining disabled through `mobilePairing.browser.outboxEnabled: false`. Pending content stays held; sign-out still fences and clears it. The flag-off cleanup path is a required test. Serving a pre-feature UI/binary is outside that supported rollback contract, cannot prove cancellation continuity and requires explicit queue review before re-enabling. The design no longer claims that a fresh active key/status proves no old-client sign-out occurred. This addresses P20 without inventing a universal historical-version detector, new credential or remote content store.

**Whole-loop outcome measurement — resolved.** The pending surface now includes content-free admitted/accepted/held/failure counters and acceptance duration from actual storage/result transitions. Zero current rows is no longer asserted to mean either successful delivery or no failures. Unknown metrics/storage/decryption remains unknown. Existing local/maturation owners carry the evidence; raw content, destination, filename and remote message telemetry are excluded. These are the causally tied transitions required by P18/Observability/P20.

**Foundation and retry brakes — retained.** Upload reservation precedes effects; uncertain recording cannot claim safely replayable success. Old App/Slack stops must pass age checks before new effects, while retained results remain replayable. Completed-upload status reconciliation handles removed chunk rows. Retry admissions/cooldowns persist across tabs, real successful chunk/phase progress starts the next finite suboperation, and healthy uploads are not cut off by an arbitrary whole-message wall. The finite same-ID Retry-After continuation avoids pushing a temporary recoverable cooldown onto the user; exhaustion still retains content visibly.

## Additional Final Edits

Durable epoch invalidation before the separate erase transaction resolves the meaningful distinction between a failed cleanup and a failed cancellation fence. An erase abort cannot resurrect the prior session's admission authority. Concrete failure disclosure does not fabricate a successful wipe.

Fresh signing-header timestamps are correctly distinguished from frozen operation IDs/times and bytes. Transport authentication can remain current without turning an old message into a new logical operation.

Deferred canonical emergency stops are held rather than automatically applied to a later session. The canonical exact set is an existing structured safety floor, not a new natural-language intent classifier. A fresh current Send is distinct from an automatic ID refresh. This protects current-session intent while keeping ordinary non-stop offline text/file recovery useful.

## Experience Fit

**Attributable goal/source:** Chief's explicit 2026-11-23 assignment for card `wc_9da6a822b3133f76` and the available card outcome: retain offline sends through closure, resume the original operation after reconnect, and show Updating during actual catch-up. No direct original Justin quote or measured ask-count is invented.

**Ordinary journey:** An already-approved browser takes one explicit Send. Credential-choice resolution occurs before eligibility, then committed encrypted storage precedes composer clearing. Storage failure leaves the actual draft/files and reports failure. Reopening any authenticated dashboard page can resume without navigating to the original conversation, repeating the text or approving the same immutable operation again. Finite server-directed cooldowns continue automatically. Current catch-up reads, rather than a probe, control Updating. This satisfies the assigned ordinary journey in design.

**Contrasting cases:** Lost acknowledgment of the same ordinary message uses the same actor, destination, request ID and body; it is the original Send, not a new approval. Different text with the same channel label remains a new explicit Send. Changed actor/holder/audience is not silently substituted. An offline exact stop is a time-sensitive exception: it is retained for current review, not automatically executed against a later session. Unsupported historical-client rollback cannot claim cancellation continuity; supported drain-disable rollback retains cleanup. Unknown-session legacy rows remain held. These boundaries follow from actual intent/authority differences, not task labels.

**Evidence and limits:** This is not measured successful recovery. Real browser/profile close-reopen tests, signed-server effects and the scenario artifact must precede completion/operator testing. Isolated provider acceptance must not be called actual Telegram/Slack delivery; the spec leaves that rendering receipt to an authorized isolated channel rollout gate and keeps the card open until earned. No new standing grant, pairing action or received-history cache is introduced.

## Benefit Survives The Safeguards

A concrete useful path remains: one authorized ordinary offline text/file message is saved before its sole draft is cleared and resumes under the original actor/identifiers without a second approval. Exact-stop deferral costs automatic time-sensitive execution but preserves the text and gives a current user-controlled path. Identity and ambiguous-result holds protect against changed authority and duplicate effects; their held state stays visible. Serial file preparation is an execution choice, not reduced eligibility. Supported rollback preserves privacy cleanup rather than imposing a new migration or historical tracking subsystem.

## Precision Only

The ELI16 remains self-contained. One short sentence noting that time-sensitive stop messages wait for current review would make its broad automatic-resume wording more exact. The dense spec already defines that behavior correctly, so this is PRECISION and does not justify another design iteration.

## Conformance Report Availability

At this review's initial write, `conformance-round3.json` had not yet been created. The author was notified; this report does not claim to have read an unavailable report. Any subsequently supplied substantive flag must be weighed before the overall convergence verdict. The earlier round-2 flags are addressed by the resolutions above or the responsible concurrency/decision reviewers; no extra lesson-only design finding is added by repeating their lenses.

SUMMARY: 0 critical, 0 high, 0 medium DESIGN findings. One optional PRECISION sentence. Lessons-aware body review concurs; actual implementation and final conformance evidence remain distinct gates.


### Internal artifact: review-r3-security.md

# Round 3 — Security Review

Reviewer: outbox_security. Inherited GPT 6.2 family, not Claude; no cross-vendor diversity claimed. Read-only review; no source edits or tests. Reviewed the complete round-3 spec and current ELI16, carrying forward the one-layer foundation audit of browser signing, request reservation and media allocation.

Standards-Conformance Gate round 3: ran against102 standards, degraded:false, four possible violations and weak parent fit. The initial report was pending; the final read includes it. This is advisory evidence, not a clean inspector pass.

## Current verdict

Final security concurrence. The author added the durable cleanup-pending/current-epoch erase guard and the ELI16 stop-command sentence after this review identified them. Zero unresolved security DESIGN findings remain. The review makes no implementation or test-pass claim.

## R3-S1 — DESIGN / Medium, resolved: new admission during the erase gap

The new logout protocol correctly commits durable epoch invalidation before erasure, so an erase failure cannot restore the old session. However, the text does not yet define what happens if a fresh sign-in/new tab binds the newly advanced epoch and admits a new message after that commit but before the old logout's separate blanket rows/parts/keys erase. Deleting that fresh, committed message would violate commit-before-clear durability.

Resolve either by a durable cleanup-pending state that forbids new admission/key creation until the erase completes, or by erasure restricted to pre-invalidation generations with newer rows/keys preserved. The former is simpler. A failed erase should retain the cleanup-pending fence and a retryable cleanup action; fresh login must not silently clear that fence. Test the exact interleaving: invalidate, fresh sign-in/admission attempt, delayed erase, retry cleanup, then fresh admission. This is a concrete concurrent transition introduced by two-phase logout, not a request for universal historical-client tracking.

Resolution verified in final body: the invalidation transaction marks cleanup-pending; a fresh session cannot bind/admit until cleanup completes. Deletion clears that marker only for its still-current epoch. Startup may finish the exact pending cleanup, and a stale eraser cannot delete newer-epoch admissions. Superseding logout owns its own cleanup. This closes the race at the design level.

## Resolved security changes

- Upload-start reservation now precedes allocation; full/refused/failed reservation prevents effects. Failed finish leaves an entered/unknown request and never creates a fresh upload from that admitted start ID.
- Deferred exact stop commands are held. Only a fresh online user interaction can authorize one immediate attempt; failure/uncertainty/offline/reload never automatically acts on a later session. The canonical exact set comes from the server, not a guessed substring.
- Fresh physical signature timestamps are distinct from the immutable embedded operation request ID/time/path/body. This permits valid signature freshness without a second logical send identity.
- Epoch invalidation is now distinct from erasure and its result, avoiding a false assertion that a failed atomic clear stopped the old session.
- Supported rollback retains the privacy/logout/device-cleanup shim and disables draining. Unsupported historical UI cannot be treated as continuous session evidence; current active-key status does not certify prior logout continuity.
- Untagged legacy entries import held rather than asserting an unknowable same-session epoch. Stable import receipts stop resurrection across a crash between databases.
- Content-free counters derive from actual admission/acceptance/held/failure transitions, not zero current rows. Failures remain unknown, and raw message content is excluded.

## Precision items

1. Retain the concurrent first-key implementation requirement: both tabs must use the durable winning scope key or re-encrypt, never overwrite a key referenced by another committed entry. This fits the existing atomic key/epoch check and needs no new design choice.
2. Resolved in final ELI16: saved exact stop commands require a new current Send, and supported rollback retains cleanup protection.

## Scope and evidence limits

The queue remains browser-local under the existing approved physical credential boundary. It does not promise protection from trusted same-origin script, a new grant, closed-browser delivery, provider acceptance or received-history caching. No speculative universal historical downgrade tracker is required. Real browser, two-tab, storage/crypto and server-fault tests remain implementation gates; this spec review proves no runtime result.

## Round-3 inspector disposition within this lens

- Retry constants: operational brake tuning belongs to decision/experience review. These values do not grant a new actor, operation ID or changed payload, and exhaustion retains content. No independent security finding.
- Reconnect flapping after exhaustion: the author was explicitly alerted that repeated reconnects must not silently reset persisted per-suboperation attempts while claiming a bounded immutable operation. Adversarial/decision review must resolve the recovery-policy wording. Server idempotency bounds effects, not physical request load; this security concurrence is not a blanket performance/controller approval.
- The claimed140 seconds must describe client response waiting, not server/network execution. Timed-out work can continue after client abortion; the spec already preserves uncertainty and forbids a new logical ID, but the quantitative wording should be corrected. Precision within this security lens.
- Chief attribution requires actual quoted source words rather than a handoff identifier alone. This is an attribution disposition, not an authentication boundary. The operator card scope remains pending sends only.

Final security count: DESIGN0 unresolved (one round-3 design finding resolved); PRECISION1 retained for concurrent winning scope-key initialization, plus the inspector's client-wait wording correction. The inspector/adversarial/decision process may identify other material non-security concerns; this report does not erase them.


### Internal artifact: review-r4-adversarial.md

# Round 4 — Adversarial Review

Reviewer: independent child agent, inherited GPT-6.2 authoring-family model. Read the entire current body and actual conformance-round3 report (102 standards, four possible-violation flags). Read-only; no tests, source or spec edits.

## Verdict

**Zero DESIGN findings. Two PRECISION qualifications.** No unresolved material failure was found in the design's declared recovery-admission, durable epoch, exact-operation, supported rollback and accepted-queue ordering boundaries. This is not implementation or release evidence.

## Final changes contested

- **Old entries versus fresh sessions:** matching signing identity no longer suffices. Every read/drain/physical attempt must also match the entry's admission epoch to the bound session and exact scope epoch. Consequently a retained row after failed erasure cannot be revived by merely signing in again with the same browser enrollment.
- **Cleanup races:** logout commits invalidation plus cleanup-pending before erasing. New sessions cannot bind until that exact cleanup completes. Clearing pending requires the same epoch, and stale cleanup cannot delete newer admissions. This addresses both deleted-authority resurrection and a delayed older cleanup destroying a later valid queue.
- **Per-conversation accepted-queue order:** sequence assignment and checking all earlier retained entries happen transactionally. Another tab cannot final-POST a later admitted text while an earlier admitted attachment is pending. Held predecessors stay visible and block automatic ordering. Explicit Send this first changes local ordering permission, not signed application body or request ID. No timeout/navigation implies bypass consent.
- **Exact stop limitation:** recovery does not dispatch an offline/deferred/uncertain saved stop. The spec correctly narrows this to recovery admission and explicitly does not claim a first request already admitted to the network can be recalled or interpreted against a target-bound session. The latter protocol remains separate work.
- **Exhausted-attempt flapping:** reopening/reconnect resumes only remaining attempts/cooldowns. It never creates a new batch after exhaustion. Only explicit Resume original request authorizes another bounded episode for the held original. New submissions affect only their own entries. This resolves the conformance self-action flag.
- **Quantitative subject:** 140s now binds configured client response-wait deadlines across seven attempts, not actual server work or elapsed duration across closure/late timers. Finite Retry-After is preserved through durable nextEligibleAt and a cancellable same-ID wakeup. The real uncertainty remains explicit.
- **Inherited operational retry settings:** six retries/20s are stated as reversible operational defaults, not proven universal safety/content floors. This addresses the classification concern without pretending the constants are mathematically necessary. There is no added message eligibility reduction or destructive purge.
- **Attributed scope:** Chief's actual instruction now accompanies its handoff reference. It supports carrying the assigned card to commit, without implying publication or live acceptance.

The three original subsystem findings remain resolved by the planned reserve-before-upload repair, NEW-send age validation including stops, and GET-status reconciliation for completed uploads after chunk cleanup. Current identity/auth/grants and immutable operation bytes remain authoritative.

## Precision qualifications

1. The Grounded Existing Seams paragraph still calls identical chunk PUT idempotent without qualifying completion cleanup. The detailed state machine correctly reconciles that boundary through upload status. This is wording precision only.
2. The monotonic sequence currently orders durable ADMISSION commits, not necessarily the instant Send was clicked in two different tabs. A tab preparing/encrypting a large file may be overtaken before its entry is admitted by a later tab's small text. The current declared transactional queued-order guarantee is sound; avoid implying chronological click order before admission. If first-click order is intended as an additional requirement, it needs a nondrainable sequence ticket before lengthy preparation and the corresponding test. This report does not silently expand the queued-order contract into that stronger cross-tab interaction guarantee.

Neither wording qualification warrants another design round by itself. Actual implementation tests must establish the stated durable-admission ordering, epoch fences, no-lock races, real profile persistence and provider/HTTP effects. No tests were run by this reviewer.

## Author disposition on ordering precision

The author confirmed the bounded guarantee is successfully durable-admitted queue order. Concurrent uncommitted preparations do not reserve a position before commit; the acceptance case commits A first, then delays its network upload before B is admitted. That is an honest, coherent scope limit and does not require a preparation-ticket/orphan controller in this increment. No DESIGN finding results.


### Internal artifact: review-r4-scalability.md

# Round 4 — Scalability And Storage Review

Reviewer: outbox_scalability. Actual model: inherited GPT-6.2 family, not Claude. Read the complete current durable-outbox spec and conformance-round3.json. conformance-round4.json was not yet present at review time; this report does not claim to have assessed it. No source changes, test suites or browser processes launched.

## Verdict

Concur. Zero unresolved DESIGN findings from this lens. The original reserve-before-allocation defect remains addressed by the specified server repair. New ordering and cleanup fences have clear, implementable invariants. This is design concurrence, not evidence that the implementation, actual browser storage or endpoints pass.

## Material Changes Assessed

### Retry Admissions And Quantitative Scope

The shared per-entry CAS counter, persisted nextEligibleAt and single cancellable continuation prevent sibling tabs or reopening from silently renewing a failed suboperation's budget. Reconnect/reopening now explicitly resume only remaining admissions/cooldowns; exhaustion survives flapping connectivity. Only the user's explicit Resume original request begins another episode. A new submission has its own independent operation and cannot renew a prior one. This resolves the round-three Capacity Safety flag rather than merely relabeling it.

The 140-second number now names its actual subject: seven configured client response-wait deadlines. The spec expressly excludes server execution time, late in-flight work, browser closure and timer wakeup latency. At most six actual finite cooldown/backoff waits remain additional. This resolves the quantitative network-work overclaim.

Six retries and twenty-second request deadlines are disclosed as reversible existing operational defaults, not claims that another retry or a slower response is unsafe or ineligible. The safety invariants are bounded shared admissions, exact-ID/body replay, preserved content and conservative uncertainty. The explicit retained-content Resume action permits operator judgment without minting a new operation or pretending the chosen retry count is a physical floor. No new quota or request to raise the defaults is needed from this lens.

### Per-Conversation Ordering

Atomic per-scope/conversation sequence assignment and an earlier-pending check in the final-POST admission transaction prevent a later text correction from overtaking an earlier attachment upload in a second tab. Explicit held-predecessor bypass is local, user-initiated and does not mutate application bytes or idempotency identity. Other conversations need not be held behind that predecessor. This is an appropriate ordering boundary; it does not require a global worker lease or timeout-based inference of abandonment.

Implementation precision: use metadata cursor/index/key-range access for predecessor checks instead of decrypting all file data or repeatedly scanning the whole queue. Any clear conversation lookup token must remain opaque under the encryption/privacy contract, rather than expose the destination in a plain-text ref or a trivially enumerable digest. This is a storage/index implementation requirement consistent with the stated opaque identifiers and asynchronous metadata traversal, not a new unresolved design decision.

### Cleanup And Session Epochs

Every drain/attempt requires the entry's original admission epoch to match the session's once-bound epoch and current scope epoch. Sign-out first durably invalidates authority and marks cleanup-pending; only then erases content. New session binding is blocked until matching-epoch cleanup completes. Consequently a deletion abort cannot restore old admission authority, and a late cleanup cannot erase rows admitted under a later epoch. Atomic deletion may still be expensive for a large local queue, but errors are surfaced, retries are explicit and old rows are fenced rather than falsely reported erased. No silent pruning is added to hide that cost.

### Upload Foundation, Completion And Memory

The reserve-before-effect/durable-finish-before-success upload-start repair still addresses round one's material idempotency gap. GET state remains required before interpreting absent chunks, preserving completion after chunk cleanup or a lost final-chunk acknowledgment. Existing aggregate/file limits bound serial admission data; plaintext is released after encryption and enumeration does not fetch all file bytes. Cipher and structured-clone overhead must be measured in the actual browser rather than described as an exact resident-memory ceiling. No smaller file-eligibility cap is proposed.

## Conformance Input And Scope

The round-three retry-flapping and quantitative-subject flags are addressed above. The exact Chief direction is now quoted, addressing attribution. Parent-principle fit is the declared principle's semantic classification rather than a scalability blocker; the feature's durability outcome and actual restart acceptance remain explicit. The round-four checker result was pending, so any new material flag there still needs the appropriate review lens before convergence is claimed.

The specification honestly limits stop handling to recovery admission: a locally held saved stop is not automatically replayed into a later session, but already-admitted delayed network work cannot be recalled by the browser. That is a boundary disclosure, not a new network-work bound. Full session-bound stop authority stays in its separate design.

## Build Evidence Still Required

Real profile close/reopen durability; transaction/quota failure retaining the actual composer; shared-counter and cooldown races with Web Locks disabled; reconnect/reopen exhaustion that does not reset; earlier-file/later-text final-POST ordering across two tabs; explicit held-predecessor bypass; epoch invalidation followed by aborted erasure and startup cleanup; request-store reservation/finish failure injection; completion after removed chunk rows. These tests establish the claimed implementation behavior; this review launches none and supplies no pass receipt.


### Internal artifact: review-r4-security.md

# Round 4 — Security Review

Reviewer: outbox_security. Inherited GPT6.2 family, not Claude; no cross-vendor diversity claim. Read the complete current spec, including all final deltas, against the earlier browser-device/server foundation audit. No tests or source edits. Reviewed body SHA-256: `eb59a1ca3e05159ba65a4b4bf8fc751210a74f1d16f107681e7b9120c98483e4`.

## Verdict

Security concurrence: zero unresolved DESIGN findings. No additional security revision is needed before implementation. The final changes close the prior authority/cleanup/recovery gaps without introducing a new signing protocol or claiming impossible recall of admitted network work.

## Material deltas checked

- **Epoch authority before reads and effects.** The entry's admission epoch must equal the authenticated session's bound epoch, with the exact scope epoch, before any drain or physical attempt. A surviving identity/key alone cannot revive an old entry. This complements the existing write CAS fence rather than relying on it as proof of read/drain permission.
- **Two-phase logout.** Durable invalidation marks cleanup-pending before erasure. No fresh session can bind/admit until the matching-epoch erase completes. The erase transaction checks its epoch and pending ownership, so a stale eraser cannot delete newer admitted data. Startup can complete pending cleanup, and failed erase does not restore old authority. The previously reported new-sign-in/erase race is resolved.
- **Stop commands.** No deferred/reloaded/offline stop automatically dispatches. A fresh online user action may make one immediate attempt, and its transit delay retains the existing server-at-receipt semantics. The final document now correctly labels this as recovery admission, not a target-session-bound server stop guarantee. It does not claim a local hold recalls an already admitted HTTP request or import a new stop protocol from the separate message-actions work.
- **Retry braking.** Reconnect/reopen can resume only remaining attempts/cooldowns; neither resets exhaustion. Only explicit Resume original request authorizes another bounded episode, under the same ID/body and current authority. Flapping network events can no longer manufacture unlimited new attempt batches from the stated policy.
- **Timing evidence.** The140-second figure is correctly qualified as configured client response-wait deadlines over seven attempts. It no longer claims to bound server work, elapsed closure time or delayed timers. Post-timeout server effects remain uncertain.
- **Conversation order.** Atomic per-conversation admission sequence and final-POST predecessor checking prevent a later tab's text from silently overtaking an earlier file upload. The explicit Send this first action is confined to the ordering override; its purpose does not change frozen bytes, actor, operation ID or other hold/authorization conditions.
- **Foundation.** Upload reserve-before-effect and conservative failed-finish unknown state remain required. The support field must not advertise this contract until substantive route/store wiring and fault tests demonstrate it.
- **Rollback and privacy.** Supported rollback keeps the logout/device-cleanup shim and disables draining. A historical bundle is not claimed to certify continuous session intent. Received-history caching stays excluded, metrics remain content-free, and approved physical credential locality is explicit.

## Precision and implementation checks

No precision item warrants another review round. Carry forward the winning-scope-key concurrency test from prior rounds and test that Send this first bypasses only predecessor ordering, never epoch/identity, exact-stop deferral or an explicit outcome-unknown hold. These exercise already stated requirements, not new policy choices.

## Inspector evidence

The round-4 inspector artifact had not landed at the final read, so this report does not invent a clean gate result. The parent convergence process must record its actual result or honest unavailable state and disposition any new flags. The round-3 flags are substantively addressed in the read body: attempts do not reset on reconnect,140s is client-wait accounting, operational defaults are not content eligibility, and Chief's actual direction is quoted. Security concurrence is not a substitute for the other lenses or for real-browser/server-fault acceptance.

Final security counts: DESIGN0 unresolved; PRECISION0 new. Earlier implementation test notes remain applicable. No operator decision or additional security scope identified.


### Outside artifact: external-closure.json

Status: ok; model: gpt-6.2-astra; verdict: SERIOUS ISSUES; reason: None.

**Verdict: SERIOUS ISSUES**

- **DESIGN — Durable Upload And Send State / Capability And Awareness.** Recovery checks whether the text matched an emergency stop at admission or matches one now. Offline admission may lack the advertised stop set, and the spec gives no rule for an unknown match. If a phrase disappears from the set before reconnect, treating unknown as false could send the text automatically. Persist `matched`, `unmatched`, or `unknown` against the last known set. Require a current explicit Send for `unknown`. Apply the same rule to legacy imports that lack this evidence.

- **DESIGN — Cross-Tab And Reconnect Execution.** Each HTTP attempt consumes a durable retry budget, but recovery must read upload status before interpreting missing chunks. The spec says a successful status read without chunk progress cannot reset the budget. It leaves open how to charge a *failed* status read or a crash after admitting the seventh chunk PUT. Define separate budgets for status reads and writes. After the last uncertain PUT, allow bounded read-only reconciliation. Test a committed final chunk whose seventh PUT acknowledgment is lost, then reopen and verify that completed status advances the entry without an eighth PUT.

- **DESIGN — Identity, Logout And Deletion / legacy migration.** Browser-device §4.8 places legacy plaintext in tab-local `sessionStorage`. The proposed logout clears known source rows, while migration permits untagged rows to return as held items after fresh sign-in. A suspended sibling can therefore restore signed-out content for local review even with zero network sends. Define how logout retires legacy sources across tabs. For example, persist an origin-wide cutoff after which untagged rows are erased on discovery. Test a sibling suspended through logout and resumed after sign-in, checking both its tray and its plaintext storage.

- **PRECISION — Grounded Existing Seams / Minimal Server Foundation Repairs.** The first section describes age checks before new effects as existing behavior. The second requires that ordering to be implemented for App and Slack. Browser-device §3 establishes 24-hour ID retention but does not establish route ordering after pruning. Distinguish existing behavior from required repairs per route, and test a pruned, expired ID on each route with an assertion of zero new effects.


### Outside artifact: external-final-locks.json

Status: ok; model: gpt-6.2-astra; verdict: SERIOUS ISSUES; reason: None.

**Verdict: SERIOUS ISSUES**

- **DESIGN — Durable Upload And Send State / Capability And Awareness.** The server advertises the exact emergency-stop set, but the spec does not say what happens when that set changes between offline admission and reconnect. A draft classified as ordinary text under the old set could execute as a stop under the new one. Persist whether the text matched at admission, and check the current advertised set before every recovered final POST. A match at either point must hold the entry for a fresh user Send. Test a server upgrade that adds a stop phrase while the tab is closed.

- **DESIGN — Tests, Rollback And Completion.** The restoration procedure requires the server flag to stay off until “explicit queue review and re-enablement.” Local Storage and Multi-machine posture put each queue in its own browser profile, outside server visibility. Reviewing one profile and enabling the server also enables recovery for an absent profile whose retained rows nobody reviewed. Add a recovery generation to the status response that the operator advances on restoration. Each browser must hold older-generation entries until reviewed locally. Test with two profiles, keeping the second closed until after re-enablement.

- **DESIGN — Local Storage And Cryptography / Cross-Tab And Reconnect Execution.** The spec encrypts the destination, excludes conversation identifiers from clear metadata, prohibits asynchronous decryption inside an IndexedDB transaction, and requires that transaction to check for earlier entries in the same conversation. It specifies no lookup key connecting those requirements. Define a stable, opaque per-scope conversation token, index entries by token and sequence, and document that the index reveals which queued entries share a destination. Test simultaneous first admissions for the same conversation in two tabs.

- **DESIGN — Cross-Tab And Reconnect Execution.** The seven-attempt ceiling counts physical HTTP attempts. Browser-device §4.6 separately directs the client to retry an active key’s signed request up to five times after a 401. The draft does not assign ownership when these retry rules meet. For outbox calls, make the signing layer return each physical result to the drain. Test repeated `401 → active` responses across a tab restart and count requests at the server to verify the persisted ceiling.


### Outside artifact: external-final.json

Status: degraded; model: gpt-6.2-astra; verdict: None; reason: timeout.


### Outside artifact: external-r1.json

Status: ok; model: gpt-6.2-astra; verdict: SERIOUS ISSUES; reason: None.

**Verdict: SERIOUS ISSUES**

- **DESIGN — Identity, Logout And Deletion / Cross-Tab And Reconnect Execution.** Sign-out stops the current app’s workers and advances a durable epoch. The spec requires each tab to check the epoch on writes, but doesn’t say when a tab acquires its session’s epoch. A still-open tab could read the *new* epoch when Send is clicked and admit a draft from the signed-out session. Bind each tab to an epoch at authenticated session initialization. Test that a sibling tab paused across sign-out cannot admit another send until fresh sign-in.

- **DESIGN — Durable Upload And Send State / Tests, Rollback And Completion.** The spec freezes the final POST and defines file metadata checks on upload-start replay. It does not establish what happens when the final POST succeeded, its acknowledgment was lost, and the upload expired before replay. If a route validates the attachment before consulting its retained send result, it could report an accepted message as expired. Require a route-level test for App, Telegram and Slack that combines those events and verifies that a currently authorized replay returns the original message identity with one effect. The inlined material contains no route implementation or test result establishing that behavior.

- **DESIGN — Cross-Tab And Reconnect Execution / Legacy migration.** Encrypted import and plaintext removal are separate operations. An interruption between them can leave both copies. If the encrypted entry is subsequently sent or explicitly removed, a surviving legacy copy could be imported again. Specify a stable import identity and a durable import receipt committed with the entry. Retain the receipt through entry removal until the legacy source is retired. Test interrupted import followed by local removal and another startup.

- **DESIGN — Local Storage And Cryptography.** Processing files one at a time bounds concurrent file reads, but preparing all ciphertext before one transaction can still retain the entire submission’s ciphertext before commit. Specify bounded staging of encrypted parts followed by an atomic transaction that makes the complete entry eligible to drain. Define cleanup of interrupted staging and test the maximum supported attachment set while verifying that failed admission preserves the composer.


### Outside artifact: external-r2-final.json

Status: ok; model: gpt-6.2-astra; verdict: SERIOUS ISSUES; reason: None.

**Verdict: SERIOUS ISSUES**

1. **DESIGN — A delayed emergency stop can affect a later session.** *Minimal Server Foundation Repairs* requires an age check for a new stop and preserves the exemption for a fresh stop. Its test covers an **accepted** stop whose result was pruned. It misses a stop queued offline during session A and first received after session B starts, while the request ID is still fresh. Age and deduplication cannot distinguish those sessions. Hold queued stops for explicit confirmation against the current session, or bind the stop to its intended session and have the server verify that binding. Test the fresh, never-received case.

2. **DESIGN — Logout cleanup failure leaves the earlier session eligible to drain.** *Identity, Logout And Deletion* puts epoch advancement and deletion in one transaction. On abort, both roll back. The specified failure message informs the signing-out tab, but its sibling still holds a matching epoch and browser key. Persist session invalidation before attempting deletion, and gate draining on that invalidation. Distinguish failure to invalidate from failure to erase. Test a deletion abort with a second tab paused immediately before attempt admission.

3. **DESIGN — Signing time and operation time need separate replay rules.** *Durable Upload And Send State* says never to refresh an old timestamp automatically. Browser-device §3 requires a signature timestamp within ±60 seconds and rejects a repeated canonical request. Read literally, the two requirements prevent recovery even after a short closure. Freeze the request ID, including its embedded time, and the application path/body. Sign each physical attempt with a fresh server-corrected header timestamp. Test reopening after the signature window but within the operation’s validity window.

4. **PRECISION — The retry ceiling does not bound elapsed wall time.** *Cross-Tab And Reconnect Execution* derives a wall bound from seven deadlines plus scheduled waits, although the design explicitly permits closure and reopening. Describe 140 seconds as the aggregate configured request-deadline budget per suboperation episode. Treat `nextEligibleAt` as the earliest permitted retry and test that a late wake preserves the remaining attempt count.


### Outside artifact: external-r2.json

Status: ok; model: gpt-6.2-astra; verdict: SERIOUS ISSUES; reason: None.

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Cross-Tab And Reconnect Execution, legacy migration.** Browser-device §3 says `sessionStorage` is private to each tab. Sign-out advances a shared epoch, but a legacy row in a suspended sibling tab has no specified epoch. After fresh sign-in with the same device, that row can look eligible for first-time import. Define how an importer proves the row predates no intervening logout. If it cannot, retain the row for explicit review. Test sign-out in tab A, then sign-in and first import in tab B. Assert zero automatic sends.

2. **DESIGN — Cross-Tab And Reconnect Execution, drain deadline.** The draft pauses a drain after 120 seconds and forbids timer-based continuation. Browser-device §3 permits 64 MiB per message. At 4 Mbit/s, transferring 64 MiB takes about 134 seconds even with zero request overhead. A healthy upload can therefore require manual intervention after reconnect. Apply the deadline to stalled progress or time spent retrying. Test a maximum-size upload that makes steady progress beyond two minutes and completes after one reconnect.

3. **DESIGN — Composer Admission.** Browser-device §4.8 gives the operator a choice when text resembles a credential. The draft makes a committed entry eligible for sending from another tab, but leaves the ordering of that choice and the commit unspecified. Require “send as written” for the exact captured text before making the entry drainable. Test with a second tab actively draining while the prompt is open and after the operator chooses Secret Drop.

4. **DESIGN — Durable Upload And Send State, Cross-Tab And Reconnect Execution.** One section gives an ambiguous prior send “Check conversation.” The other prescribes “Retry original” on exhaustion and explicitly calls a timeout after invocation uncertain. A lost final POST response can satisfy both rules. Specify when exact-body replay is permitted to recover a retained result, which server responses require a hold, and which action the UI displays after exhaustion. Test a lost final acknowledgment through retry exhaustion and a subsequent reconnect.


### Outside artifact: external-r3.json

Status: ok; model: gpt-6.2-astra; verdict: SERIOUS ISSUES; reason: None.

**Verdict: SERIOUS ISSUES**

- **DESIGN — Identity, Logout And Deletion.** Logout advances the epoch before erasing content and explicitly allows erasure to fail. The drain checks the current browser identity, but the spec only requires an epoch match for writes. A fresh sign-in can use the same identity and encryption key. Require every drain to match the entry’s **admission epoch** to the session epoch before admitting a network attempt. Limit cleanup to invalidated epochs and preserve keys needed by newer entries. Test a failed erase, fresh sign-in, new offline send, and delayed cleanup. Only the new send should survive and drain.

- **DESIGN — Durable Upload And Send State / Minimal Server Foundation Repairs.** The server interprets exact stop text in the session active at receipt. The proposed age check addresses expired requests. A never-received stop can still have a valid request ID after session A ends and B begins. The client’s one-attempt rule prevents replay but cannot recall a delayed first POST. If the guarantee covers that case, bind the stop to an expected session generation and check it before acting. Otherwise narrow the guarantee to preventing client recovery from dispatching the stop. Test by delaying the first POST across a session change while its ID remains valid.

- **DESIGN — Cross-Tab And Reconnect Execution.** The spec deduplicates attempts for one request ID but gives no ordering rule for *different* messages in the same conversation. A queued attachment followed by a text correction can arrive in reverse order if another tab drains the text while the attachment uploads. Assign a per-conversation sequence in the admission transaction and admit final POSTs in that order. Specify how the user can proceed past a held predecessor. Test two tabs, two messages, and a delayed upload.

- **PRECISION — Cross-Tab And Reconnect Execution.** Seven 20-second deadlines give 140 seconds of configured HTTP timeout budget. They do not establish an elapsed-time ceiling when the tab can close between attempts. Describe the bound as seven admitted attempts per suboperation per episode, and distinguish scheduled cooldowns from elapsed time until recovery.


### Outside artifact: external-r4.json

Status: ok; model: gpt-6.2-astra; verdict: SERIOUS ISSUES; reason: None.

**Verdict: SERIOUS ISSUES**

- **DESIGN — Composer Admission / Cross-Tab And Reconnect Execution.** Each entry gets its conversation sequence when encrypted admission commits. A large attachment can still be hashing in tab A when a later text correction commits in tab B. B then has the earlier sequence and can send first. The proposed delayed-upload test starts too late to catch this. Reserve an ordering position before file preparation, define how cancellation or failed preparation releases it, and test with A paused before its encrypted commit.

- **DESIGN — Durable Upload And Send State / Cross-Tab And Reconnect Execution.** The spec allows one immediate emergency-stop attempt, while ordinary final admission waits behind earlier pending messages. It leaves the behavior of a fresh online stop behind an unfinished upload implicit. Specify whether that live stop bypasses conversation ordering or immediately becomes held. In either case, test that finishing the upload cannot trigger the stop later.

- **DESIGN — Tests, Rollback And Completion.** Re-enabling after a full downgrade requires explicit queue review. The same section says the old binary cannot record cancellation, and the startup rule automatically drains eligible entries. No durable signal distinguishes an untouched queue from one that survived a sign-out under the old binary. Define an enforceable deployment step, such as restoring with draining disabled until review completes. Test downgrade, sign-out, and re-upgrade with an otherwise eligible entry and assert zero HTTP attempts before review.

- **DESIGN — Identity, Logout And Deletion.** The draft specifies outbox cleanup for revocation and Forget. Browser-device §4.6 also deletes the signing key on `declined`, `expired`, or `not-found` from the enrollment machine. The draft leaves the retained content’s disposition undefined on those paths. Route every definitive key-removal decision through the same identity-checked cleanup procedure. Test a same-machine `not-found` with queued files and verify that the same answer from another machine preserves them.


## Outside Finding Resolutions

- Upload effect before reserve: reserve synchronously before allocation; full/write failure has zero allocation; failed finish leaves unknown and never reallocates the same admitted ID.
- Stop age gap: retained-result lookup first, age before any NEW effect on App/Slack including stops. Existing fresh-stop feature/rate exemptions remain.
- Final chunk lost acknowledgment: GET complete before interpreting absent chunk rows; read-only reconciliation has its own bounded budget after PUT exhaustion.
- Epoch/cross-tab logout: bind once per real sign-in; every entry read and network admission matches its admission epoch. Invalidate durably with cleanup-pending before separate matching-epoch erase; no new session can race old erasure.
- Legacy import/reappearance: receipt atomic with import; untagged unknown session rows hold initially. Logout durably retires the legacy source globally and each resumed sibling erases it before rendering/import.
- Memory/cross-tab ownership: automatic work requires origin-wide Web Locks. Server storage limits/idempotency are not falsely called plaintext-memory ownership. No-lock fallback is explicit bounded user work.
- Credential prompt: exact text choice precedes drainable admission; Secret Drop/cancel leaves zero drainable entry.
- Operation/header time: operation ID/time/path/body frozen, every physical attempt freshly signs corrected header time.
- Retry/401: one target physical result per durable ledger admission. No inner Chats401 loop; separate step budgets, persisted cooldowns; reconnect never resets exhaustion.
- Healthy progress/server cooldown: finite successful progress continues; honor finite Retry-After via one cancellable same-ID timer without resetting attempts.
- Different-message ordering: monotonic opaque per-conversation sequence committed atomically; final admission checks predecessors, explicit user override only.
- Stop deferral/set changes: one live immediate online path may bypass prior upload; no background stop grant. Matched or unknown at admission, or matched in the fresh current exact set, holds recovery. No first-request recall claim.
- Historical restoration/multiple profiles: flag off plus new recovery generation before boot; each profile requires local review of its older generation even after global re-enable.
- Opaque order lookup: independent non-extractable HMAC key and index; same-scope first-key races reuse the durable winner. Grouping equality/sequence is metadata, not destination plaintext.
- Outcome denominator: actual durable admission/acceptance/held/failure transitions and acceptance durations, not current-row-count inference. Storage failure is unknown.
- Definitive key cleanup: all original keyDecision deletion paths use expected-identity cleanup, including same-machine not-found/expired/declined; another-machine answer preserves content.

## Standards-Conformance Disposition

The inspector ran, with 102 articles and healthy registry canary. Flags are signals, not an invented clean gate. Fixed retry defaults are operational executor bounds, not content eligibility claims. Ownership is enforced by the browser primitive; without it automatic work holds and content remains. Conversation ordering protects user-authored sequence while explicit Send this first and fresh immediate stop preserve control. Actual transition metrics and real-browser/channel rollout evidence answer the observability/state concerns. The final inspector artifacts and flags are included in the design build records; the final report records any residual disagreement.

## Experience fit

The ordinary supported-browser journey is Send, durable commit, close/reopen, authorized reconnect and automatic same-ID recovery, without another approval. No-lock fallback, deferred stop, unsupported/changed server generation, unknown outcome and expired operation are explicit retained states. They do not turn a saved message into Delivered. Received history remains excluded, so the separate privacy decision is not silently consumed.

## Convergence verdict

Converged at the Tier-2 cap after source-grounded final closure. There are zero unresolved DESIGN findings in the final six-lens reports; precision and compatibility limits remain disclosed above. Outside opinions ran and materially changed the design, but did not return a clean approval. The author approves on the final internal closure and explicit resolutions, with reduced external assurance visible. Implementation and real browser/HTTP/lifecycle evidence remain entirely unearned at this stage.

## Final exact-body outside receipt and closure

The final successful outside receipt remained SERIOUS ISSUES; it is not represented as approval. The following original findings received explicit source-grounded security, adversarial and integration closure afterward:

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Durable Upload And Send State.** A fresh online stop may run only immediately after durable admission. Browser-device §4.8 requires a Telegram composer to be read-only when that machine cannot send, but the outbox adds a broader dependency across routes. If IndexedDB admission fails, Composer Admission forbids network activity even when the browser is online, authorized, and the server could accept the stop. Preserving the draft does not stop the session. Give a current, explicit, text-only stop a direct single-attempt signed path when persistence fails. Test a quota failure and a lost response, with zero automatic replays.

2. **DESIGN — Minimal Server Foundation Repairs.** Upload start reserves before allocation, but the draft specifies an age-before-new-effect check only for final sends. Browser-device §3 describes a 24-hour request memory. The supplied text establishes no upload-start rule after reservation pruning. If the allocation succeeded and its response was lost, repeating the original start after pruning could allocate again, contrary to the stated guarantee. Require retained-result lookup followed by an age check before any new allocation, with reservation retention covering the entire admissible ID window. Test a lost response followed by replay after pruning.

3. **DESIGN — Capability And Awareness / Multi-machine posture.** The status field attests to **local** dependencies. The draft also says old or unreachable holders are held, freezes the original Slack holder, and requires repaired Slack age and replay behavior. Browser-device §5 says sends can be forwarded. The draft never specifies how the serving machine establishes that the holder executing the effect supports those repairs. Make recovery eligibility specific to the destination holder, and hold when its capability is unknown. Test an upgraded dashboard server forwarding to an older Slack holder and require zero recovered writes to that holder.

4. **DESIGN — Cross-Tab And Reconnect Execution.** `Send this first` records an ordering override on a later entry, but the draft leaves its scope unspecified. With two earlier entries, one held and one actively uploading, implementations could skip either the held entry alone or both. Bind the override to the predecessor IDs the user explicitly chose to bypass. Test both predecessors together and verify that the uploading entry keeps its place unless explicitly included.

### Final resolutions

1. A current explicit online text-only canonical stop gets one direct signed attempt when the pending-content store fails; actual acceptance alone clears the still-matching draft. Lost acknowledgment is unknown, never an automatic replay. This is fresh user intent, not a saved grant.
2. Actual mobileMediaRoutes already performs retained-result lookup then age validation before allocation. The repair preserves that ordering and tests pruned/expired replay with zero new allocations; durable request retention covers the valid age window.
3. The outside premise that Slack writes forward was contested with source: mobileSlackRoutes rightMachine refuses another holder before effects; only history reads forward. Recovery also holds any nonlocal/unknown holder before target HTTP.
4. Ordering bypass stores exactly the predecessor IDs the user selected. An unselected earlier upload remains a blocker. No broad boolean skip-all permission.

All six internal perspectives recorded final concurrence; the last safety/adversarial/integration source checks explicitly closed these four items. The lightweight comparator ran on the final internal findings and separately identifies the outside receipt; no cross-vendor or outside clean-pass claim is made. No protected constitution or CODEOWNERS path is amended, and no operator question remains.

## Implementation-bound precision clarification

The pending view and its counters are scoped to the current browser identity. Unknown previous identities retain encrypted content but are not aggregated/decrypted in this increment; local review requires the original identity again. This is not a claim that moving to another serving machine cancels, transfers or erases those entries. The implemented behavior is narrower than the original broad local-review phrase; the code review flagged and the final spec discloses it.
