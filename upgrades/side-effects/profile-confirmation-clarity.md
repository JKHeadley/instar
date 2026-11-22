# Side-Effects Review — Clear Conversation Change Questions

**Version / slug:** profile-confirmation-clarity
**Date:** 2026-11-22
**Author:** Echo
**Second-pass reviewer:** Independent internal security reviewer; corrected bounded runtime CONCUR, plus real external review DESIGN=0.

## Summary of the change

Tier 2: security-sensitive confirmation plumbing across Telegram ingress, the proposal HTTP route, profile storage and the existing write surface. Questions use conversation names and explain consequences. Several immutable identified requests can coexist; intentional reminders preserve the request and expiry. Only the existing verified-owner, native-reply, exact-yes control tuple authorizes a write. Nonexact prose goes to the conversational agent and never applies a change. Source and tests are isolated in a fresh helper-created worktree. Five commit attempts were needed to complete framework-literal, parent-principle and self-action declaration metadata checks; all failures and fixes remain recorded. Six full exact-scope design rounds reached the cap; Chief authorized a two-case bounded closure, not full convergence. One post-build review correction replaced a disconnected acknowledgment-failure test with the production consumer and real adapter lifecycle coverage. Full Local Verify remains required through the normal queue.

The first real-user demo run failed: actual Telegram reply IDs were dropped at polling and lifeline composition. The amendment preserves native reply metadata only from those first-party seams; bearer-only/mobile assertions never establish it. A separate Codex rollout-capture failure blocks normal conversational reminders and is not bypassed. Live proof remains a hard merge hold.

## Decision-point inventory

- Proposal delivery and receipt selection — modified: each send belongs to an immutable request and actual platform receipt; failed sends grant no authority.
- Verified owner and destination eligibility — passed through and rechecked at commit; no new principal or broader consent authority.
- Placement — modified: source/destination ownership epochs must match the displayed question; unreadable or transferring state needs a fresh question.
- Exact yes protocol — retained; numbered, quoted, forwarded and other prose cannot authorize a change.
- Clarification — added server-owned operation; current audience is checked before revealing pending labels.
- Durable profile commit — modified: live and shadow changes commit together under the existing store lock after consequence revalidation.
- Acknowledgment — separated from cached committed results; delivery retry cannot rerun the write.
- Legacy recovery — retained with receipt arbitration so a new visible question cannot accidentally activate an older recovery slot.

## 1. Over-block

A numbered yes or quoted question plus yes still does not apply a change. This is the explicit final disposition; the agent may send a plain reminder asking for a native reply containing yes. Missing or ambiguous receipt, expired question, audience change, placement change and unverified sender require a new safe question. These are structural protocol floors, not a natural-language classifier. Ordinary agent messages do not cancel pending requests. Five attempted notices per ten minutes and the inherited expiry remain compatibility limits; they do not decide whether urgent accessibility feedback may be captured.

## 2. Under-block

A verified owner's exact yes applies only the stored patch selected by its delivered receipt. It cannot authorize a later patch, a request from another conversation or a changed consequence. Requests and inbound outcome caches are ephemeral; a process restart invalidates outstanding questions. There is no claim of durable inbound deduplication across process restart or of Slack consent support. The existing principal and ownership infrastructure remains trusted. No new authority is inferred from agent prose.

## 3. Level-of-abstraction fit

The collection owns request identity, receipts and idempotency. The existing write surface owns mutation authority and runtime effects. The store owns atomic serialization. The normal conversational agent interprets nonexact prose only to clarify or remind, never to grant consent. Route handlers do not invent an independent authorization path.

## 4. Signal vs authority compliance

No new natural-language detector holds blocking or consent authority. The exact control tuple is the existing structured protocol: authenticated owner, native reply to a delivered registered request, and exact yes enum. Deterministic identity, expiry, integrity and ownership checks are safety floors. This is not a claim that a substring matcher understands intent, that yes is an emergency-stop constant, or that Chief may amend the constitution. The six-round review report preserves the literal registry tension and its independent disposition. See [signal versus authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. Receipt identity, authenticated principal, one immutable patch and ownership epochs are enumerable integrity constraints. Nonexact conversational meaning remains with the agent, with no permission to execute from that interpretation. Delivery failure is a recorded transport outcome, not evidence that an already committed mutation failed.

## 5. Interactions

- Shadowing: authenticated platform ingress runs first. Identified reply handling precedes legacy recovery, which remains available only for its own valid receipt.
- Double-fire: the source/inbound-ID promise is reserved before asynchronous selection; duplicates share the write result. Acknowledgment runs afterward and may retry independently.
- Races: pending send attempts bind their own receipts; known receipts do not wait for unrelated sends. Timeout results are terminal for that inbound. Ownership, eligibility, expiry and displayed consequences are checked inside the mutation lock; live and shadow settings flush once. A later runtime-eligibility failure honestly reports saved settings without claiming a restart.
- Feedback loops: no autonomous reminder loop is added. Every reminder is an explicit agent operation, bounded by the existing shared send budget. Agent messages never cancel another pending request.

## 6. External surfaces

Telegram questions and reminders become plain language with request references as supporting metadata. Confirmation is phone-completable using Telegram's native Reply action and the word yes. HTTP callers gain requestId, remindRequestId and clarifyPending; reminders cannot create or modify a patch. Pending request state is ephemeral; the existing durable profile format is unchanged. Telegram transport timing and failed delivery are explicitly tested with simulated receipts. Live-owner Telegram delivery and Slack are not proved. Agent awareness ships through the new awareness entry to both new and existing installs; no custom config or installed-file migration is needed.

## 6b. Operator-surface quality

1. The question leads with the named conversation and proposed action, then relevant consequences and how to answer.
2. Engine names are familiar product names; identifiers are supporting references, not headline content. No raw JSON is required from the user.
3. No delete or revoke action is introduced. Restarts and loss of Claude escalation are disclosed when applicable.
4. Plain text uses Telegram's existing wrapping and native reply affordance. Tests inspect actual sent text. No screenshot or live phone-width review is claimed; this patch adds no custom layout or tap target.

## 7. Multi-machine posture

**machine-local BY DESIGN**: pending questions are capabilities tied to this process's actual delivery receipts and verified current ownership epochs. They must not migrate as reusable authority. Topic transfer or unreadable ownership invalidates application; the conversational agent prepares a fresh question on the current owner. Existing durable profiles retain their normal replication and transfer path. No new durable state or generated URL is added. User-facing notices use the existing verified notification envelope and delivery gate; no second autonomous voice is introduced. No status, health, capabilities or channels answer is changed; a dark holder is not treated as locally eligible.

## 8. Rollback cost

Revert the patch and ship a normal patch release. There is no data migration or new profile schema to undo. Process replacement invalidates pending questions; tell the user a fresh question is needed. Already authorized saved profile values remain valid and are not automatically reversed. Rollback restores the old single-slot wording and cancellation limitations until a corrected release ships.

## Conclusion

The review produced server-owned privacy-safe clarification and a committed-result cache separate from acknowledgment. Targeted HTTP and lifecycle tests exercise those paths; full Local Verify and live-user proof remain distinct requirements. Approval is the explicitly authorized bounded closure, not a clean full-convergence claim. No new authority is assigned to an LLM or a semantic matcher.

## Second-pass review (if required)

**Reviewer:** Independent internal security reviewer plus real external cross-model reviewer.
**Independent read of the artifact: concur (scoped).** Internal security independently reran three HTTP cases and one lifecycle case: all passed. It concurs only that server-rendered clarification reveals no request details for shared or unreadable audiences, and a failed acknowledgment neither erases nor replays a committed write. External corrected runtime review returned MINOR ISSUES, DESIGN=0 with no truncated prompt. No full source audit, full Local Verify or live Telegram roundtrip is certified.

## Evidence pointers

The approved scope and dissent are in docs/specs/profile-confirmation-clarity.md and docs/specs/reports/profile-confirmation-clarity-review.md. Tests live in profile-proposal-requests.test.ts, profile-proposal-placement.test.ts, topicProfileWriteSurface.test.ts, topic-profile-routes.test.ts and owner-framework-confirm-lifecycle.test.ts. Private review transcripts and throwaway deployment reports remain in the agent-home design-feedback-private directory; they contain no public owner screenshots.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. `defectClass: unbounded-self-action`, `closure: n/a`, `reason: one-shot user-driven confirmation; no self-triggered loop`. A verified owner’s native exact-yes reply commits one immutable request. No automatic reminder or restart controller is added. Explicit confirmation remains required.
