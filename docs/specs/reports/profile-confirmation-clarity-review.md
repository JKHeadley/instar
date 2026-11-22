# Exact-yes confirmation slice: capped review and final corrections

The final Chief disposition is message 3ef983bf-3127-4a50-a348-a96feca62208: only exact yes to an identified pending question applies; nonexact wording reaches the agent for reminders only. This supersedes both the broad model-authority draft and the numbered-grammar slice. Those are parked unapproved under .instar/design-feedback-private/parked-authority-idea and narrow-expanded-grammar-unapproved.md.

## Review result

Six rounds of the final exact-yes scope ran. Each had real GPT-tier external review of the full candidate and both complete parent specs, six internal lenses paired across three independent Codex agents, and a 102-standard conformance check. The internal reviews are Codex, not Claude-family; that limitation is explicit. Round 6 internal security/adversarial and integration/scalability found zero design issues. The external round still found two design details and one precision detail. At that capped design checkpoint there was no quiet external round, convergence tag, source implementation, live test or full-suite pass. The later authorized closure and implementation are recorded below.

## Final corrections after round 6

1. Clarification is now an explicit `{clarifyPending:true}` server operation. It loads pending labels and checks the current audience/eligibility itself; shared or unreadable audience receives generic wording, with no sensitive destination/action details. No agent-authored pending-detail list is trusted.
2. Cache the committed write result before attempting acknowledgment. Delivery failure is tracked separately and cannot erase a successful mutation or cause duplicate delivery to write again. Duplicate handlers join the pending selection/write result; acknowledgment retry never retries the mutation.
3. Check expiry again after a receipt wait timeout before offering another reply; an expired question needs a fresh question, not an impossible retry.

These are explicit implementation acceptance cases in the corrected spec. They did not receive a seventh full audit: the six-round cap was honored. The Chief-authorized bounded check below is separately labeled.

## Conformance disposition

The checker is a source of flags, not a clean-pass certificate. The final recorded round checks 102 standards and flags inherited TTL/send limits, exact-yes structural authority, remote-destination recovery and Telegram-only live proof. Lessons review independently notes genuine literal registry tension but distinguishes the existing structured protocol tuple (verified principal, native reply to delivered registered request, exact yes control value) from inferring intent in prose, under the registry's structured-enum survivor and approved parent Tier0 contract. This is not a claim that Chief can amend the constitution or that yes was added to stop constants. Nonexact wording cannot authorize anything. TTL/rate remain the explicitly preserved parent protocol; the agent can ask a fresh question. Remote recovery should be prepared and linked by the agent, not left as human routing. The existing numeric Telegram API adds no Slack authority, and no Slack live proof is claimed. These flags and judgments remain visible to the approver.

## Source of truth

Active spec: docs/specs/profile-confirmation-clarity.md. Plain overview: docs/specs/profile-confirmation-clarity.eli16.md. Complete review artifacts: agent-home .instar/design-feedback-private/exact-r1..r6-*.

## Independent existing work

PR 3642 was refreshed to fc125717e60d9ccac35aef99d8e32930f418cb19 with current main and the exact red/green ladder declaration repair; all 55 commit lints passed, focused ladder test 7/7. Throughput owns complete Local Verify and safe merge. PR 3643 remains parent-held until 3642 merges and its child head is updated. Three original constitution follow-ups are recorded on build/automatic-check cards. No full manual suites were run.

## Authorized bounded closure

Chief of Staff explicitly authorized a bounded confirmation in message 433dc627-10d2-407a-ba81-e30caaaa7fab, rather than another full convergence audit. One real external Codex review and one independent internal security review checked only server-owned clarification and committed-result caching before acknowledgment. Both returned DESIGN=0. Internal security had PRECISION=0. External output was manually read: MINOR ISSUES, DESIGN=0, PRECISION=1; its automatic parser returned UNKNOWN because the response was tabular. The precision item adds an unreadable-audience sent-text assertion and is incorporated.

At the time of that bounded design review its tests were planned, not executed. The actual build verification follows. This is operator-authorized bounded closure, NOT a quiet full convergence round. The structural review tag records the authorized closure and carries `full-convergence: false` plus its authority. The full six-round external findings and checker dissent above are not erased.


## Corrected bounded runtime verification

The first post-build internal reviewer found a real coverage defect: the acknowledgment exception in the test was disconnected from the production consumer. The implementation now extracts `handleAndAcknowledgeProfileProposalReply`, calls it from production Telegram ingress, and exercises it in both HTTP-composition and actual-adapter lifecycle fixtures. A failed acknowledgment and repeated inbound ID preserve the disk-saved setting and cause one restart. A standalone fake rejection was removed from the unit test.

The single corrected bounded recheck authorized by Chief returned internal CONCUR and external MINOR ISSUES, DESIGN=0, with an untruncated prompt. Internal security independently ran three HTTP cases and one lifecycle case, all passing. These cover only server-owned clarification privacy and committed-result preservation across acknowledgment failure. The concurrency unit checks shared promise identity before the apply callback starts; it does not prove a duplicate arriving during an active disk flush. No broader clean audit is claimed.

Executed focused checks: 125 unit tests across request identity, placement, write surface, ingress and awareness; 35 HTTP integration tests; seven owner-framework lifecycle tests. All passed. TypeScript checking and the build passed. Existing ten-case profile lifecycle coverage passed earlier in the same build. The throwaway deployment/startup check passed with Telegram roundtrip explicitly skipped; it is not live-user delivery evidence. Full Local Verify remains the throughput queue's responsibility. No full manual suite was run. No owner screenshot, private operator identity or Telegram credential is committed.


## First real-user Telegram run: failed, amendment required

The approved signed-in user browser on the Laptop sent only into the isolated demo group, using its actual Telegram API without opening chat UI. The Studio throwaway agent was the sole demo-bot poller. Questions155/156 were delivered; user157 replied `1) yes` to156, and user159 replied exact `yes` to155. Both settings stayed unchanged. Message158 reported session-delivery failure; message160 reported session recovery. Neither is successful confirmation proof.

Two concrete defects were distinguished. The candidate omitted the actual native reply ID at both polling and verified lifeline-forward Message construction, so profile ingress never saw the reply receipt. The amendment carries only the native field, positive safe integer, with verified non-mobile lifeline authority. Polling unit regression failed18/1 before repair then passed19/0; actual polling-to-confirmation lifecycle passed8/0; verified-lifeline integration passed37/0 and proves a bearer-only body cannot supply the field. Separately, the existing Codex session had no captured rollout generation and StageB refused injection before pane mutation. Its safety floor is retained. No synthetic owner update, forged transcript, disabled StageB or substituted bot identity is used.

GitHub3653 retains the prior exact head and an explicit live-proof merge hold while the amendment is prepared. The first live run is FAIL and will remain in the signed evidence history. Passing simulated checks is not used to erase it. A fresh signed four-scenario live matrix is still required before merge.


## Second live run: three behaviors proved, reminder still failed

On a fresh Claude-hosted source, exact user189 to question182 saved only target A; B remained Claude. Exact user191 to question183 then saved B separately. Agent Ready184 and ordinary agent response187 intervened without canceling either question. The source's numbered user185 changed nothing. However response187 incorrectly said there was no question to tie it to: the already-running model received only the person's text, not the server-posted question. That reminder scenario remains FAIL despite successful exact writes. The first-party wiring repair independently received scoped security CONCUR, with three relevant regression cases rerun and passed.

The next amendment adds only checked native-question context to normal conversational turns. It verifies source owner, current audience, registered receipt, unchanged ownership and current consequence before disclosing any pending details. User text is unchanged and remains non-consent. Unknown, forwarded, shared, expired, consumed or unreadable contexts disclose nothing. This is no seventh general convergence round and no semantic consent authority. A fresh full live matrix is still required.


The corrective context implementation received scoped security CONCUR. The reviewer independently reran three context unit cases and one actual-polling lifecycle case, all passing. Full executed files passed21 request/context unit and9 owner lifecycle tests; TypeScript checking and build passed. The review certifies no real model-to-reminder journey. The corrected live matrix must still be rerun.


## Final conformance signals after the context clarification

The built-in checker ran at22:30:50.763Z against102 standards, without degradation. It repeated exact-yes enumeration, inherited send budget/expiry, remote preparation and Telegram-only proof questions. It additionally flagged transient refusal retention, maturation classification, parent-principle fit and the self-contained opening. These are possible-violation signals, not a clean-pass certificate or independent authority to change consent.

The parent and opening are corrected: **Agent Proposes, Operator Approves** directly governs prepared changes and one specific owner approval; Testing Integrity governs verification. Remote recovery explicitly belongs to the agent, which arranges a fresh holder-issued question and delivers its link. The exact enum remains the approved parent's structured control tuple, not NLP; Chief's final exact-only disposition is retained. TTL/rate remain compatibility safeguards from that parent and are not used to suppress capture of urgent feedback. Multiple pending records repair existing request loss without adding a new human authority or action; cross-topic reach retains its existing dark-on-fleet switch. This is the classification used for this repair, not an invented new ladder registry entry. A transient unresolved receipt produces a cached non-application result and an honest delivered recovery message; no durable distributed approval/refusal ledger is claimed. The checker’s stronger ledger interpretation remains recorded as a residual concern, not silently relabeled as proved. The requested live matrix covers the existing Telegram-only API. Slack is neither enabled nor certified; no claim of broad channel parity or full project completion follows from this patch.


The next real run delivered the correct named reminder (message212), with no settings change, but it was agent-composed and therefore not a registered receipt. That is an unfinished reminder journey, not a pass. The context now supplies the exact server reminder operation and requires it once when the agent judges that a reminder is appropriate. A lifecycle regression executes the supplied operation and confirms its actual returned reminder receipt, rather than inventing an answerable ordinary message. Failed and aborted live attempts remain preserved.


The corrected-parent conformance check ran at22:35:53.745Z against102 standards, without degradation; fit now reads **fit** for Agent Proposes, Operator Approves. Five possible-violation flags remain: exact-yes enumeration, inherited send budget, inherited expiry, agent invocation of the reminder operation, and Telegram-only proof. The first three retain the dispositions above. Reminder rendering and receipt binding are one server operation; the conversational agent chooses whether to call that operation, never decides consent or manually reconstructs its side effects. The actual model-to-operation journey must pass before completion, rather than relying on an instruction as proof. Channel scope remains Telegram-only and is disclosed to Chief; the checker is not described as clean.

The final operation review found one concrete same-topic bug: sending confirmIn equal to the destination is invalid. The correction omits that field for in-topic reminders and keeps it cross-topic. Two operation-driven lifecycle cases passed, including confirmation through the actual reminder receipt. The same-topic context uses the normal audience checks without requiring the cross-topic-only switch. No cross-topic consent floor was widened.
