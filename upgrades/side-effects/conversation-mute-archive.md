# Side-Effects Review — Conversation mute and reversible archive

**Version / slug:** conversation-mute-archive
**Date:** 2026-11-22
**Author:** Echo
**Second-pass reviewers:** mute_archive_merge_review and mute_final_identity_review for the current merge; context_spec_security and context_spec_adversarial for the historical feature review.

## Summary of the change

Adds reader-scoped preferences and reversible archive selection to the mobile API. ConversationPreferences owns compact replicated field winners and a durable emission outbox. MobilePushPending separates typed pending notifications from unattributable legacy summaries. The sender reevaluates reader ownership, authorization and mute immediately before provider transport. No conversation, session or history is deleted.

## Decision-point inventory

- Preference route: add explicit current-reader authorization, exact operation reservation and lost-access clearing only.
- Conversation list: modify ordinary selection by captured reader archive state; retain the canonical Chief navigation locator.
- Replication: add the conversation-preference journal kind and durable append acknowledgement; retry refused outbox work on the existing maintenance cadence.
- Push admission: modify current ownership and authorization checks; mute only reply contributions, preserve independent document and account policy.
- Legacy migration: add durable quarantine and crash-safe episode accounting; never infer the original reader.

## 1. Over-block

Unverifiable foreign aliases cannot be mutated. Unknown ownership and unattributable legacy summaries hold delivery. A private latest represented reply can hold an earlier public reply in the same coalesced contribution; no arbitrary history search substitutes a different witness. These limits are explicit in the spec and readiness response. Archive filtering never removes direct readable history.

## 2. Under-block

An offline machine can retain an older preference until replication resumes. A successful local save is not a global quiet acknowledgement. Heartbeat protocol support is not proof that a particular preference arrived. The response exposes pending emission, unknown legacy status and partial or unknown delivery support. Old senders require the documented push-disable rollback floor.

## 3. Level-of-abstraction fit

Reader preferences are authorization-scoped data, not a heuristic about user intent. Existing request reservations own retry identity; existing journal and peer-stream infrastructure own replication. Provider admission uses the actual current person, conversation visibility and document policies. There is no new notification scheduler or global acknowledgement protocol.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

The allow/deny decisions enforce enumerable security invariants: verified identity, explicit reader choice, readable resources and exact user preference values. Unknown delivery support is a signal reported to clients, never promoted to global certainty. No text detector receives authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The spec declares reader and ACL safety floors. Urgency affects only eligible contributions under the existing notification budget and cannot override privacy or mute. Selection of the latest represented trigger is an explicit coalescing contract rather than a claim about globally ordered history.

## 5. Interactions

Request reservations precede mutation and recover only their original fixed events. Atomic sidecar publication includes every recipient and the dedupe receipt, preventing retry from losing a recipient. Provider callbacks reevaluate after authentication awaits. Exact-version acknowledgements preserve arrivals during transport. An unavailable person/phone-standing proof holds contributions; only affirmative device inactivity permits cancellation. Independent fields prevent unarchive from unmuting. Migration clears only its captured unchanged legacy slot. Existing maintenance retries outboxes without introducing a timer.

## 6. External surfaces

Adds a signed-device preference route and archive list filter, with additive receipts and readiness fields. Device ownership is checked afresh. Typed state contains identifiers, not message bodies. Apple owns the phone and Mac controls; server source completion does not close the user-facing card. Native adoption and actual deployed channel evidence remain required.

## 6b. Operator-surface quality

No renderer is changed in this server increment. Native controls must use plain mute and archive labels, display local saving and uncertain synchronization honestly, and provide an obvious unarchive action. No native screenshot or released UI claim is made here.

## 7. Multi-machine posture

Preferences are replicated through the conversation-preference coherence-journal kind and peer stream. Archive pool selection applies the answering reader's captured fold to authorized candidates. The notification sidecar is machine-local by design because the provider credential and physical device token are local; it must preserve the intended reader rather than follow current token reassignment. Capability heartbeat advertises guarded sender support only. Save emission status is local, dark holders remain unknown, and no new whole-agent health verdict is introduced. No new user-facing notice or URL is generated.

## 8. Rollback cost

Keep all preference tombstones and sidecar records. Before any older unguarded sender starts, persist mobilePairing.push.enabled=false and verify the old pending slot is empty and migration complete. Push, including notices, remains unavailable until the guarded sender returns. Source documents and Attention remain available. Reverting only the code without this operational floor is unsupported and can break mute or original-reader privacy. No chat cleanup is necessary.

## Conclusion

Independent runtime review converged after six rounds, and real AgentServer lifecycle checks passed. Complete exact-head verification, deployment readiness and native UI proof remain required. This artifact makes no live readiness claim.

## Second-pass review

**Reviewer:** context_spec_security and context_spec_adversarial.

Security independently verified corrected identity, recipient custody, document policy, decision payload and strict represented-witness admission. Adversarial review repeated after its list and cursor findings and reported zero new material findings on the final source. Integration, performance and completeness reviewers also rechecked their fixes. Their concurrence does not replace actual full verification or native evidence.

## Integration With Current Main

The normal merge retains both per-reader preference identities and authoritative creation hierarchy metadata. Explicit represented readers are resolved consistently; non-owner rows omit owner hierarchy fields, malformed or removed readers fail closed, and removal during an awaited pool read cannot become implicit owner access.

The final source review found a canonical Slack identity issue: the registry tuple lookup can match a different workspace. The hierarchy dependency now additionally requires exact returned canonical-key equality. This preserves the separate origin-checked machine-qualified alias path and does not change registry-wide routing. The actual AgentServer signed-device lifecycle fixture covers refusal without child creation for a wrong workspace and successful exact-workspace parent recording. This is mistaken-placement prevention; no unauthorized access incident is claimed.

Independent main-merge and final identity reviewers concurred with bounded validation. Actual validation receipts below distinguish the executed focused pass from pending complete and live gates. The old remote head remains held. A new exact pushed head needs normal complete Local Verify, then separate guarded installation and actual native evidence. No conversation was moved or deleted.

Actual corrected-merge validation: normal build passed;78unit,25HTTP and4production lifecycle cases passed, zero failures/skips, all nine whole files executed under the independent allocation. Initial ABI failure stopped before execution and is retained; dependencies were isolated before rebuilding the private binding. The App and graph binding paths remained separate. Final reviewers: mute_archive_merge_review and mute_final_identity_review concurred on the final source. No full candidate, deployment or native pass is claimed here.
