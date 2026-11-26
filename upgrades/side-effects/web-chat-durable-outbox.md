# Side-Effects Review — Durable Web Chat Sends

**Version / slug:** web-chat-durable-outbox
**Date:** 2026-11-23
**Author:** Echo
**Second-pass reviewers:** outbox_security, outbox_decisions, outbox_integration, outbox_scalability, outbox_adversarial (independent caller reviews; component authors did not approve their own components).

## Summary of the change

The web console saves outgoing text and selected file bytes in a separate encrypted IndexedDB database before clearing the composer. A console-lifetime worker resumes original operations when the browser returns, including without the conversation page open. Server upload admission now records idempotent intent before allocation. Existing server stop, enrollment, holder and channel authorities remain authoritative. Source: dashboard/console/chat-outbox.js, outbox-runner.js, chats.js and the browser-device, console and connection lifecycle; mobile pairing, conversation, Slack and media routes; canonical config defaults and the awareness entry.

## Decision-point inventory

- Add atomic encrypted admission, epoch invalidation, immutable operation binding and compare-and-swap updates in chat-outbox.js.
- Add origin ownership through Web Locks; browsers without it require an explicit bounded manual action.
- Add fresh capability and exact identity checks before each physical signed request. Preserve server authority and local Slack holder restrictions.
- Add finite seven-attempt budgets per immutable network step, persisted cooldowns, predecessor checks and explicit local recovery-generation review.
- Pass through canonical exact stop phrases; old or uncertain stop evidence is held. A fresh text-only stop may use the existing direct path once when durable storage fails, subject to identity and epoch guards.
- Modify upload reservation order and retained-result-before-expiry behavior. Unknown outcomes retain the original operation rather than inventing a new request.
- Modify console logout and browser-key replacement cleanup to invalidate queued access before deletion, including paused sibling tabs and replacement-key races.
- Add human decisions to resume, bypass named predecessors, save local file copies, use saved text or remove a local copy. These never silently create a replacement send.

## 1. Over-block

Unavailable storage leaves the current draft and attachments in the composer. Unsupported Web Locks, revoked enrollment, changed holder, disabled capability, generation changes, stale original operations and uncertain stop evidence preserve content for review instead of sending it. A held predecessor can pause a later message; the operator can explicitly select the displayed predecessor bypass. This is deliberate protection of destination, authority and message ordering. Identity-scoped views do not expose another enrollment's decrypted queue.

## 2. Under-block

Browser-profile deletion, browser eviction and device loss can destroy local data; this is not a backup. A request already admitted by the server cannot be recalled by deleting its local copy. Provider and network availability can remain unknown. Received-history offline caching is a separate tracked card, wc_d811087189ecc048. A closed browser does not execute recovery. Tests use a real browser and production initialization with a local native provider fixture; they do not establish a live Telegram or Slack installation result.

## 3. Level-of-abstraction fit

Durability, cryptographic scope and compare-and-swap belong in IndexedDB. A console-lifetime worker owns local recovery, while server stores own admission and retained results. The existing pairing, stop sentinel, holder and channel routes decide whether an operation is authorized. The page renders state and obtains explicit decisions; it does not maintain a second send loop.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. Connection health is a signal that starts fresh reads; it cannot grant delivery authority or declare catch-up complete. Exact identity, session epoch, ownership, immutable-request binding and reservation uniqueness are deterministic invariants, not linguistic judgments. Exact stop matching uses the existing sentinel's canonical set; no new natural-language detector owns blocking authority. Unknown outcomes are displayed for human review. No brittle semantic heuristic was added.

## 4b. Judgment-point check

The spec enumerates thirteen decisions: twelve invariants and one explicit human recovery decision. Automatic repetition cannot choose a new identity, destination, request identifier, recovery generation or ordering exception. The operator makes those decisions through visible controls. Retry limits are finite resource bounds; they do not claim to infer whether an operation succeeded.

## 5. Interactions

Retained server results are read before age or media-expiry checks. Upload intent is reserved before allocation; failure to persist a final result returns uncertainty rather than a false success. Web Locks serialize active work only; waits release ownership. Every physical request rechecks the latest row and signing identity after asynchronous preparation. Frozen final requests bypass obsolete media preflight. Status budgets advance only with confirmed stored chunk progress. A final lost chunk acknowledgment can be reconciled by bounded reads without granting another exhausted write. Reconnect does not reset counts. Explicit Resume resets counts but preserves every future server cooldown. Identical holds do not rebroadcast indefinitely. Logout fences, durable epochs and expected-old-key deletion prevent stale tabs from restoring plaintext or deleting a replacement identity. Actual history reads, including paged App events, control Updating; healthy probes cannot finish it early.

## 6. External surfaces

The pending panel shows saved messages, reasons and local actions. The signed browser status response adds versioned outbox capabilities and a recovery generation. Canonical missing-only defaults reach both init and update; false and custom values survive migration. The awareness registry reaches existing and new agents. No background service worker, transferable key export or new public relay is added. Existing native, Telegram and local Slack send paths retain their authorities.

## 6a. Mobile-Complete

Every added operator action is in the web console: inspect saved text, continue an original request, explicitly bypass a named predecessor, save file copies and remove a local copy. Failures remain visible and retryable. File recovery downloads inert application/octet-stream bytes and revokes object URLs when the dialog closes. No shell or bearer-token copying is required by the operator.

## 6b. Operator-surface quality

The composer remains the primary action. Pending messages use ordinary text and readable reasons rather than request identifiers or hashes. Constructive recovery controls precede the quieter remove action, which requires confirmation and stays open on failure. Saved text never overwrites a newer draft without a decision. The panel wraps long text and actions, uses 44-pixel action targets and a bounded scrolling body. Actual Chrome measurements at a 390px CSS viewport confirm a 390px document and body, 44px pending controls and a 44×44px sheet-close control. A 244-character filename wraps within a 348px download control ending at pixel369. The initial real-browser RED found both the narrow close target and clipped filename; scoped sheet rules corrected them. Evidence: server-chrome-phone-geometry.json and server-chrome-six-final.log.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: each encrypted browser queue is scoped to host, holder machine, enrolled device and key hash. It cannot silently migrate identity or destination when a topic moves. Topic transfer does not delete bytes: the original holder and enrollment remain recorded, and the view explains recovery holds. Remote Slack writes are refused; history forwarding remains read-only. Status capabilities describe this responding machine and its actual dependencies, never a whole-agent health verdict; a dark holder is unknown and cannot grant recovery. Local file-copy URLs are short-lived browser object URLs, not shareable machine URLs. There are no new server-origin user notices requiring a second one-voice mechanism; tab broadcasts contain invalidation signals rather than message content.

## 8. Rollback cost

This creates persistent browser data, so a whole historical binary rollback is not a privacy-safe rollback plan. Before deployment of a rollback, set mobilePairing.browser.outboxEnabled false and advance outboxRecoveryGeneration. Keep the privacy shim that understands encrypted storage, session epochs and logout fences. Restoring support requires explicit review separately in each browser profile, including a profile absent during restoration. Retain saved bytes until the operator recovers or removes them; do not erase the database as an automatic rollback. A historical client that predates encrypted-queue cleanup cannot be claimed to clear it on logout. Ship a corrective patch preserving these guards, then resume only after normal verification. No live deployment or rollback has been performed by this change.

## Second-pass review

Five independent caller perspectives identified real regressions in legacy cleanup, hold broadcasting, stale signing-key deletion, draft replacement, request-budget selection and local recovery controls. Each was reproduced and corrected. The final file-export guard also rechecks sign-in synchronously after the last asynchronous storage read; the regression previously returned plaintext after disposal. Final review receipts and source hashes are under .instar/state/build/code-review-*.md. Final combined real-Chrome execution passes all six cases with zero skipped in server-chrome-six-final.log; source-start/end hashes are preserved. Individual earlier cases are not substituted for that combined result.

**Reviewer:** an independent Claude Opus 5.5 reviewer subagent, for the 26 Nov 2026 merge of main (1a6fb96ee) into this branch. It concurred with the merge commit. It checked that both self-action controllers and both style blocks were kept, that taking main's removal of the client-side Needs loop orphaned nothing, that the follower-tab lock override keeps the original test's intent and resets after it, and that the auto-merged chat and conversation-route files have no semantic clash. It also found that the branch's pending-sends notice pointed at "below", which the dashboard wording rule forbids. That notice now names the Resume original request button instead. Two further fixes found by running the affected unit tests after the merge: the held-send bubble carries a warning-exempt note pointing at the saved-messages panel's buttons, and the hand-authored ConfigDefaults line map in lint-dev-agent-dark-gate shifts by three for the branch's mobilePairing default. No product behaviour changed in the merge beyond the notice wording.

## Evidence pointers

The original draft-loss RED is preserved against ec9401e5. Root runner decisions: file-export-fence-green.log, 24 passing, after an actual logout-during-file-guard RED. Real IndexedDB: queue-browser-six-green.log, six passing with no skip, after cooldown RED. Page, HTTP and production-start tests, build, lint and throwaway deployment receipts are in .instar/state/build. Final exact-head verification is coordinated through throughput; this document does not claim a complete-suite pass.

## Class-Closure Declaration (display-only mirror)

Defect class: unbounded-self-action. Closure: guard. Enforcement: ratchet. Citation: tests/unit/self-action-convergence.test.ts. The browser-outbox-recovery registry model maps reconnect and retry to one durable original request and immutable step. Seven persisted attempts, finite upload parts and bounded status reads settle into a retained hold under persistent failure. Reload and reconnect cannot renew the episode; explicit Resume is human-triggered and retains future cooldowns. Identical holds do not broadcast another recovery trigger. The registry's unchanged enforcing ratchet passed all 896 cases. The machine-readable decision-audit declaration must carry this same argument.

## Conclusion

The implementation preserves original operations, authority and local content through the tested interruption paths. Publication remains contingent on final focused browser evidence, independent closure and the normal complete verification gate. Production release and owner-channel acceptance are separate from a local commit.
