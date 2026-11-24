# Quoted Replies — Integration And Deployment Review, Resumed Round 2

Actual reviewer: inherited Codex model. This is an independent source-grounded lens, not a Claude or cross-vendor review. Read the current draft, resumed round-2 conformance signal, round-1 integration report/ledger, and the existing store, replication codec, HTTP pool/client, request recovery and maturation seams. No tests, external calls or source edits were performed. Only this report was written.

## DESIGN — High: Accepted Quote Information Still Has No Single-Machine Survivability Contract

The draft correctly improves complete/stripped arrival-order handling, but explicitly allows a completed quoted send to lose its relation permanently when the sole complete copy disappears (spec line 73). Its unified posture at lines 114–118 relies on the existing App event stream and disclaims global acknowledgment. That underlying stream is best-effort after local commit: `AppConversationStore.ts:708` catches replication-hook failure after the local append has succeeded. The actual codec allowlist (`AppConversationsReplicatedStore.ts:28`) has no new quote fields/kind until upgraded, and the older receipt validator demotes unknown versions (`AppConversationStore.ts:434–448`). A second installed machine can therefore retain the message body while being unable to recover which original the person answered.

This is continuity-bearing information, not a machine-local operational log. The standing multi-machine rule (`docs/STANDARDS-REGISTRY.md:521–522`) requires coherent operation on any installed machine; simply reporting partial/unknown compatibility does not conserve the relation. The conformance signal is substantively supported, with one important correction: Amendment 6's Pending exception expressly covers the Conversations hierarchy only. It cannot automatically license a new quote Pending protocol.

**Required design resolution:** name and use actual existing support that establishes durable complete quote custody on the installed members before reporting the relation fully acknowledged, including old-codec/unreachable-member behavior and recovery; or obtain an existence-checkable operator ruling scoped to the temporary continuity limitation. If the requisite substrate is missing, record it as a blocking foundation dependency rather than marking ordinary best-effort replication as unified completion. Do not add a parallel quote store or borrow the hierarchy's Pending exception without authority. Test losing the origin after another installed member has only a stripped copy, not only full/stripped arrival order while complete evidence remains available.

## DESIGN — Medium: Existing Native-Conversation Maturation Evidence Does Not Measure Quoted Replies

The draft's maturation plan names only `mobilePairing.native` and leaves its dark window as “until evidence” (lines 184–191). The real entry in `src/data/feature-ladders.json:58` measures all native conversation fired/error records; existing ordinary sends already emit that feature ID in `mobileConversationRoutes.ts`. It has no quoted-protocol/version or verified-relation outcome dimension. Ordinary chat traffic could therefore satisfy that old ladder without any quoted reply ever executing or surviving the required recovery/projection cases. Conversely, a quote increment awaiting native proof has no named owner/date/awake carrier in this plan to prevent indefinite incubation.

**Required design resolution:** reuse the existing maturation machinery, but identify quote-specific/version-bound run and outcome evidence and its live producer/reader. Name the review owner and dated review/window, promotion criteria and carrier positive control owed by the standing maturation standard. Do not invent a new watcher or claim the old native-chat count proves the new relation works. This changes what must be wired and measured, so it is DESIGN, not a prose-only clarification. Exact thresholds must receive the existing fixed-limit contest rather than copying arbitrary new counts.

## PRECISION — Narrow The Test-Scheduling Sentence To Actual Shared Resources

The sentence “No competing suite runs” can read as a global prohibition, but this work's actual instruction is normal host admission and shared full-verification custody. Scope it to duplicate runs and the relevant host/shared resource owner; an independently admitted run on another machine is not inherently competing. No quote runtime arbitration or new scheduler needs to be built. I classify this wording clarification as PRECISION because the existing allocated queue protocol already supplies the intended behavior; I do not infer a new global runtime gate from one execution-plan sentence.

## Conformance Signals And Prior Findings

- Multi-machine continuity: supported as the high DESIGN finding above; the hierarchy-only Pending scope is narrower than the signal's suggested alternative.
- Stop recognition: the security/adversarial lenses should ground the existing semantic stop path; this integration read does not add a duplicate independent finding.
- Scheduling: the scoped execution-plan wording issue above, not a new quote scheduling subsystem.
- Maturation: supported with real evidence-key mismatch as the medium DESIGN finding above.
- Parent-principle fit marked weak: preserved as an advisory. Correct message selection and truthful unavailable projection support the native quote action, but native journey proof remains separately required; backend compilation or a capability symbol is insufficient.
- Round-1 exact-source/capability gaps: the typed App event prerequisite and dedicated signed action paths now avoid ambiguous public IDs and old-holder silent unquoted fallback. The mounted local protocol capability is appropriately distinguished from message availability and delivery. App-link source is a sibling prerequisite, not falsely claimed present on main.
- Provider credential locality: the physical-credential-locality declaration is justified by real provider installations and their physical namespaces. It does not justify fragmenting the quoted relation itself.
- Cache projection: explicit reopen/focus/actor invalidation plus actual history revalidation addresses the current client's event-only cache risk, provided native and web implementation tests exercise that promise rather than relying on a new reply event.

Verdict: not converged. Two DESIGN findings remain for integration/deployment. This report grants no implementation or release approval.
