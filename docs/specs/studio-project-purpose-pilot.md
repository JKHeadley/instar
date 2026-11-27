---
title: "Studio project purpose pilot"
slug: "studio-project-purpose-pilot"
author: "Echo"
status: approved
approved: true
approved-by: "Echo, after reading convergence evidence and Chief of Staff's authorized targeted closure, for the disabled draft only."
eli16-overview: docs/specs/studio-project-purpose-pilot.eli16.md
parent-principle: "Attributed Statements Trace to Their Source"
review-convergence: "2026-11-27T06:37:41.484Z"
review-iterations: 7
review-completed-at: "2026-11-27T06:37:41.484Z"
review-report: "docs/specs/reports/studio-project-purpose-pilot-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Studio project purpose pilot

## Problem statement

The Context Budget pilot needs the original owner purpose at the top of its standing summary before the batch confirmation surface ships. The project registry already owns confirmed revisions and its operator-session authorization remains the only way to confirm a purpose.

## Proposed design

After direct disclosure authorization, a release can pin one Studio machine, authorizing Telegram account ID, project, target conversation, original Telegram source, and exact wording digest. The machine-local pilot file stores the project and source coordinates and the expected SHA-256 of the UTF-8 bytes of the complete stored Telegram text, with no normalization beyond the adapter's established ingress behavior. The release computes the grant using the verified authorizing account ID, so a different account with matching text cannot authorize it after restart. The file can enable or disable that exact proposal. A file written by another process running as the same user cannot designate different content or a different project. The file contains no quote. Accept only a bounded, regular, non-symlink file owned by the running process user with no group or world permissions. There is no HTTP writer for this file. Deploy it atomically on the designated Studio after the approved release is active.

The registry specification requires an operator session for general source selection and disclosure. The proposed deployment instruction identifies one source and one destination but is not direct authorization. This draft has no production grant. Before adding a grant, verify a direct, non-forwarded message from the Telegram owner account expressly authorizing disclosure of that exact source to the stated project conversation on Studio with advisory status. The approved scope and the reviewed immutable release grant establish authority for this one use. Any other selection or disclosure still requires the existing operator-session flow. Confirming or changing the registry's purpose always requires that operator session.

The registry reader first checks the unique active project binding and returns a confirmed revision if available. If any confirmed revision has existed but no current confirmed record verifies, use ordinary recovery. This suppresses replay after a previously confirmed project moves away and back. A still-unconfirmed project can show the same pinned proposal when its exact original binding returns. The optional proposal reader must match the exact designated project and target conversation. At service boot it uses the same original, non-forwarded, verified owner Telegram history lookup as the existing confirmation route and additionally requires the expected text hash. A proposal does not change the project record.

The quote describes the original message as recorded at its source timestamp. Requests read only the small designation, a retirement marker, and current verified owner identity. They never scan Telegram history. Delivery requires the current Telegram account ID to equal the verified original author's account ID captured at startup. Losing or changing the verified account blocks delivery, including a direct switch from one verified owner to another. The original source is reverified at every startup before any proposal can be returned. A proposal whose original row has aged beyond the existing history scan can remain in use for that boot and will be unavailable at the next startup.

Removing the designation pauses new delivery while the file is absent. Permanent revocation first creates the local retirement marker in persistent agent state, outside the application release and rollback tree, and then removes the grant in a reviewed release. All granting versions must honor that marker at boot and on each read. Deployments and supported application rollbacks preserve the marker. Restoring the designation under a rolled-back granting binary then still fails closed. A verification fixture retains the marker while recreating the reader with the old granting digest and the original designation. Do not activate a release that lacks this check.

Only the dedicated standing-packet lookup can receive proposal text, using the destination conversation that the session already resolves. The ordinary registry lookup and diagnostic HTTP routes cannot return the proposal text, even for the correctly bound project. Standing summaries show the proposal in the first section with its source and an explicit unconfirmed label. The registry establishes the binding and confirmed-record precedence. The startup history lookup establishes the exact wording. A bounded quotation preserves that wording, and the renderer reserves the authoritative labels for the verified first section. It neutralizes duplicate labels in derived text, and the verifier rejects unescaped duplicates outside the verified quotation. Fresh launch and restart use a current packet. Claude checks the staged packet again after compaction. For native Codex recovery, the hook sends its existing per-session bind token. A proposal packet is returned only when the token covers the topic, native session, and current tmux incarnation. A bounded tmux environment read compares both the expected Instar session ID and its current token. After that asynchronous read the route reruns live eligibility, including the retirement check, and requires the live wording and staged digest to match. Bearer-only requests still work for ordinary packets. PreCompact and practice folds omit the proposal.

A changed designation, confirmation, owner, binding, or retirement marker invalidates old packets. Edits to the original history are rechecked at startup. Delivery commits at the final successful current-packet check before the packet is handed to the framework. Withdrawal prevents later checks from succeeding. A submission already past that check may finish, and text already delivered cannot be retracted.

## Decision points touched

- Designation admission — invariant; basis: irreversible-consequence; evidence: selecting cross-conversation text can disclose it, so the release pins the exact approved machine, project, target, source, time and wording digest. The private file can activate only that tuple.
- Project binding — invariant; basis: enumerable-domain; evidence: no unambiguous active project and target pair exists when the binding is missing, ambiguous, or different from the designation.
- Confirmation precedence — invariant; basis: enumerable-domain; evidence: only the current confirmed registry state carries approval, and an unresolved existing confirmed record cannot be replaced by an advisory proposal.
- History admission — invariant; basis: external-constraint; evidence: the existing Telegram exact lookup establishes owner, non-forwarded source, conversation, ID and time and uses the same bounded history budget as the confirmation route.
- Bounded designation read — invariant; basis: external-constraint; evidence: the file is a single coordinates-and-hash object with short ASCII identifiers and a canonical UTC millisecond timestamp. The maximum accepted serialized file is 2 KiB, including whitespace, to bound synchronous file access.
- Whole quotation — invariant; basis: external-constraint; evidence: the standing packet reserves at most 2,000 UTF-16 units for the entire project block, including its heading and source. If the complete approved wording does not fit, omit the whole block and use ordinary recovery. Verify the complete rendered block fits before activation.
- Packet recovery — invariant; basis: enumerable-domain; evidence: recovery accepts only the exact current registry-backed block and uses ordinary recovery when verification fails.
- Codex proposal delivery — invariant; basis: irreversible-consequence; evidence: a shared bearer does not establish that a caller is the named destination session. The proposal requires the signed bind token and exact current runtime environment. Each asynchronous tmux read ends after 500 ms so this optional proof leaves most of the existing three-second Codex hook request budget for ordinary recovery.

## Multi-machine posture

- machine-local-justification: physical-credential-locality

The pilot file and its lookup depend on the Studio Telegram adapter's source, owner identity and the original Studio history. An authorized grant binds the pilot to the Studio's machine identity. Neither owner wording nor the local designation is copied to another machine. A session that moves uses ordinary recovery if the same confirmed registry state is unavailable. Jobs and Projects owns the Mini source reader and batch confirmation separately from this Studio pilot.

## Verification and rollout

Exercise the pilot reader through the standing-packet boot path with exact source history, a missing designation, a rewritten designation, mismatched wording, and a forwarded row. Confirm that switching to a different verified owner does not unlock the proposal, including after restart with text and coordinates that match. Check that the exact quote is absent from the sibling conversation and from ordinary registry and HTTP diagnostics for the correct project. Check that confirmation wins and that the persisted `approvedProjectAnchorRevision > 0` floor suppresses replay even when rebinding cleared the old record. Simulate a supported rollback by reusing the granting reader factory with the old designation and the retirement marker still present, and verify ordinary recovery. Run the existing HTTP, Claude, and Codex recovery fixtures, including requests without a bind token and with a token for a different topic, session, or incarnation. Inspect actual hook output after withdrawal or failure to verify freshness, leaving staged bytes intact. Ordinary recovery must still be present and the old quote absent. Inject a duplicate heading in derived text and verify that it cannot pose as the genuine block, whose wording is preserved.

Before activation, verify that the exact Studio Telegram adapter still finds the original row within its bounded history scan. If it ages out, keep the proposal off. Time repeated packet verification with headroom under Claude's two-second request deadline. The exact Telegram source lookup happens at startup, outside that deadline. A regression fixture must show recovery reads the already verified source without repeating history I/O.

After shared verification and release, install the designation for Context Budget alone and use the supported Studio service restart to load and verify it. Start or restage the pilot conversation before checking Claude recovery, since a staged packet from before activation may carry no project fingerprint. Verify the first section on fresh start, restart and native compaction, and check the staged fingerprint against the live route. Keep practice folding disabled. Pausing the pilot removes the local designation and refreshes the standing packet. To retire it, create the durable retirement marker first and then deploy the grant-free release. Confirmed registry data needs no repair.

## Maturation plan

- **test-agent-live:** Exercise owner verification, source isolation, both generated recovery hooks and rollback with disposable fixture data.
- **dev-agent-live:** Enable one Studio project only after direct disclosure authorization, release verification, and exact source and latency preflight.
- **fleet:** Keep this release disabled elsewhere. Jobs and Projects owns the next graduation review once durable cross-machine source verification and audience authorization are proven.
- **graduation criterion:** Require exact placement on launch, restart and both native recovery paths, no sibling or diagnostic disclosure, and verified withdrawal.
- **dark-window:** This draft contains no production grant. Production cannot display a proposal before direct exact-scope authorization and a reviewed activation release.
- **ladder:** Disposable fixtures, then the authorized development Studio conversation, then a separately reviewed multi-machine path.

## Frontloaded Decisions

- Ship the draft with no production grant. A verified exact-disclosure instruction is an activation prerequisite with a fixed owner and verification procedure.
- Keep proposal visibility confined to standing summaries for the uniquely bound destination. Keep all normal registry readers and approval routes unchanged.
- Verify immutable wording from original history at service start and recheck designation and owner identity before each use.
- Use ordinary recovery when source, binding, or availability checks fail. Do not extend the history scan or recovery deadline.

## Open questions

*(none)*
