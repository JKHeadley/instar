# Side-Effects Review — Conversation List Read States

**Version / slug:** chat-list-visible-states
**Date:** 2026-11-23
**Author:** Echo
**Second-pass reviewer:** Independent lifecycle, paging/data and UI-state source reviewers concurred after concrete corrections.

## Summary of the change

Tier1 reversible repair of existing interactive Conversations list reads. STANDARD build, three focused source perspectives and corrected rereads. Product changes are list state/operation coordination, scheduler accounting for an already-shared read, and cancellation/record-identity guards on an obsolete browser-status read. No new approval, enrollment, send or policy authority. The board-policy adapter remains parked. The proportion grew from the visible missing states because existing polling and401 handling share the same asynchronous read; those seams needed meaningful regressions rather than only wording tests. Exact file totals and normal commit attempt are recorded with the candidate.

## Decision-point inventory

- List read state: modify loading/waiting/failure/retry/empty presentation; validate readable success rather than imply zero.
- List operation ownership: modify identical-read coalescing, different-page serialization, current-owner/revision checks and a20 second abortable deadline matching existing console reads.
- Scheduled read accounting: pass one in-flight operation through the scheduler without charging twice for the same GET; preserve429 Retry-After.
- Obsolete status recovery: modify cancellation and original-record identity checks before client key/DOM mutation. The signed server refusal and live revocation decisions remain authoritative.
- Sending, setup/PIN/approval, owner policy, server permissions and transport signature: pass through unchanged.

## 1. Over-block

Valid server rows and cursors retain existing parsing. An unreadable answer is an error, not a false empty list; cached rows remain. A known pinned row is not hidden just because the ordinary page is empty. Explicit feature-off disables list actions until an authoritative success, while retaining and labeling the cached list. No new enrollment or approval is demanded. The deadline affects only a GET and does not cancel an already-confirmed send.

## 2. Under-block

An obsolete successful read is dropped after a newer applied list revision. Queued reads retain their original list owner. Teardown aborts the owned request, and obsolete scheduled work cannot finish into a rebuilt scheduler. Cancelled status checks cannot mutate a replacement device record or repaint the recovered page. A current un-aborted revoked answer still deletes the key, covered by existing signed-client tests. This does not claim complete cache invalidation across every source-visibility transition or a whole-screen accessibility certificate.

## 3. Level-of-abstraction fit

All list entry points share the same signed GET operation; send/history paths are not reimplemented. The existing scheduler receives an optional accounting flag for an existing read. The browser-device helper checks its own captured record before mutating its local key, while the page checks its DOM owner before repainting.

## 4. Signal vs authority compliance

These are enumerable request/identity invariants and presentation states, not language detectors or new permission gates. A cancelled read may not mutate a different context. Server signature and revocation checks remain unchanged; keeping a local key after an obsolete check does not make a refused server request valid. Feature-off wording follows the exact existing response code, never guessed prose.

## 4 b. Judgment-point check

No new static heuristic at a competing-signals decision point. Ten seconds is the existing design-standard explanation boundary. The20 second read deadline follows the existing console Conversations read bound; it creates a recoverable transport failure, not an authority decision or retry loop. Page/record identity and parsed cursor domains are enumerable invariants.

## 5. Interaction audit

Shadowing: initial/retry/more/scheduled list reads share one operation. Double-fire: matching paths share a promise; different pages wait, and scheduler starts do not spend another slot for a shared read. Races: successful/error stale results, aborted status recovery, queue ownership and teardown/rebuild have dedicated tests. Feedback loops: no automatic retry loop is added; the existing scheduler and429 backoff remain. Failure does not clear known rows, pins or cursor. Source metadata broadcasts can recover errors without an older response restoring them.

## 6. External surfaces

Only existing signed read endpoints are used. Retry is phone-completable beside the list. No server/API schema, durable source data, credential format or proof is changed. Browser key mutation remains the existing device helper's job; optional cancellation affects only obsolete reads. No source/history/enrollment/message action is triggered by a URL. No live policy change is included.

## 6 b. Operator-surface quality

Controlled plain-language states explain what is happening and provide a visible recovery. A true empty list points to New conversation; an empty page with cursor and an incomplete machine result are distinct. Retry remains visible and disabled while working, then returns focus to a current list row/container without stealing focus from another control. Cached feature-off rows are labeled and unavailable actions disabled. Normal Chrome fixed-frame scenarios cover loading/waiting/failure/retry/cursor/cached rows at 390 and 1280 pixels in both themes, with real fixture-verified signed GETs and no application writes. This is sample-data source evidence, not installed-phone or full accessibility approval.

## 7. Multi-machine posture

Proxied-on-read through existing scope=pool list requests. Cursor and pool.failed semantics are preserved; no machine invents global emptiness from one empty filtered page. Cross-tab results retain ownership/revision checks and existing budget broadcasts. No new machine-local state, notices, status endpoint or host-specific user link. Existing feature-off and dark-source behavior are reported distinctly.

## 8. Rollback cost

Revert the code and release a patch. No migration or data cleanup. The old blank/error/list retry behavior returns. No durable policy or approval is rewritten. Client memory and timers disappear through normal page disposal/reload.

## Conclusion

The scoped source repair is supported by genuine original-code REDs, expanded DOM/state tests, real signed-client compatibility checks, existing HTTP/lifecycle contracts and normal browser sample-data proof. Complete suites and publication remain Chief/throughput responsibilities. Independent history-state and composer repairs must be preserved when integrating the shared chats.js file.

## Second-pass review

**Reviewer:** echo-pipeline-strategy independent second-pass reader (Pipeline Strategy session, independent of the author), 2026-11-28

The reader concurred on staged tree cf6440912bc5852855e79cc8316458750e509d87 against main 7a929eeb35. The review covered all ten paths, including the full protected audit at docs/audits/chat-list-read-states.md, the view and browser-device changes, the two test files, and the release and side-effects records. The reader confirmed the noted behavior is present in the code, the pending fragment is in upgrades/next, and shipped guides are unchanged.
