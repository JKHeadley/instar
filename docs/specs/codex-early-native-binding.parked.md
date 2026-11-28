---
status: parked
slug: codex-early-native-binding-parked
approved: false
review-mode: corrected-bounded-core-review-pending
full-convergence: false
finding: N80
eli16-overview: docs/specs/codex-early-native-binding.eli16.md
---

# Capture Codex Identity Before an Idle Conversation Needs a Message

A conversation can be alive but unable to receive its next message because Instar has not recorded the native conversation identity. The rollout baseline is the verified transcript position used to check a physical injection; StageB is the existing guarded message-dispatch path. This repair observes that identity earlier and reports failures truthfully while keeping those dispatch guards intact.

Parent principles are verified state over success symbols, honest uncertainty, and agent-carried follow-through: distinguish a stored event from binding, distinguish a refused attempt from an unknown original outcome, and retain an existing tracked obligation without granting replay authority.

## Authority and Evidence

Chief of Staff message `985daa2a-92a1-4b0c-b27f-718ab78eb903` explicitly selects the bounded core and authorizes one review round of this corrected draft. Its exact bounded-scope instruction is: “No new automatic custody or replay design. Disclose plainly that the core does not guarantee eventual delivery.” The scope includes early capture and parity, typed binding and readback, truthful duplicate handling, durable failure visibility, and agent-owned follow-through through existing tracking. It excludes new automatic custody or replay and does not guarantee eventual delivery.

Chief of Staff message `8b040a6a-1541-471a-b47f-d88d76c822b4` requested the live audit and a normal-path repair that captures the Codex rollout baseline at spawn or first idle and never silently drops an owner message. The directly cited build authority is that Chief of Staff message. The earlier program approval is not used here as a substitute for a verifiable approval record. Its implementation approval remains false until the normal design review is complete; this document does not approve itself.

The design standards owner retained a real throwaway failure: user message157 reached an alive, idle Codex session whose native ID was null. StageB refused physical injection because its rollout baseline was unavailable. The bot displayed failure158. Message159 followed a separate reply-metadata recovery path and is not evidence of the same failure. All eight sampled live Echo Codex sessions had IDs matching genuine rollout metadata. Twenty historical effect-unknown records and twenty do-not-replay tombstones are uncertain outcomes, not proof of twenty lost messages; this repair must not replay them.

Supported init with both frameworks omitted project Codex registration before server startup; the same home later had registration after startup. That before/after evidence establishes an init-path parity gap, not historical delivery causation. Current source registers the event reporter on PostToolUse and UserPromptSubmit, but not SessionStart or Stop. HookEventDispatch already bridges native session IDs for received events. The exact native input contract includes session_id, cwd and hook_event_name, as documented in the existing empirically verified Codex hook spec. Actual startup capture still needs an isolated production-path proof.

## Problem and Scope

A tool-less first turn can become idle before the server has recorded its native session identity. The ordinary idle-session injection guard must continue refusing unbound physical effects. Preserve the existing narrow preRolloutBootstrap exception for an exact matching pending bootstrap input; this repair does not reclassify or expand that path. Early identity observation and honest failure reporting should prevent the resulting dead end without guessing IDs or widening replay authority.

This is a local capture and refusal-reporting repair. It changes project-scoped hook registration, an identity-only reporter mode, existing native-ID bridging, and explicit notice of a known unsent Telegram message. It does not create a new inbox, transfer an uncertain delivery, change lease rules, repair consent, add cross-machine forwarding, enable user-disabled hooks or alter personal Codex configuration.

## Signal and Authority

Native lifecycle input is an observation from the session's own installed hook. It is not permission to inject or send. Existing per-session identity binding, conversation owner/epoch, rollout baseline, physical-effect tracking and transport guards remain the authorities. Missing, malformed or ambiguous identity stays unbound. The reporter cannot authorize a tool, bypass a Stop gate or change trust.

The refusal classifier reports a hard-invariant failure before physical dispatch. It never interprets message meaning and never converts an unknown effect into an unsent message.

## Decisions

### D1 — Identity-only lifecycle observation

Append an identity reporter to the existing SessionStart and Stop groups. Preserve all existing event groups, command positions, matchers and blocking gates. In particular, do not insert before an existing command: trust and user-disabled entries use event/group/index slots, so reordering would change whose disabled choice is preserved. SessionStart is the primary early observation; Stop is an additional idle observation on every turn where the framework fires it, not permission to bypass a blocking Stop gate. Do not describe it as first-idle-only or add an unreviewed process-local suppression cache. Its repeated cost must be included in the installed proof.

Use the existing project reporter with an explicit internal `--native-identity` mode. In this mode, project only the native session_id and cwd and a fixed identity-only event name through the existing authenticated hook receiver and instar_sid bridge. Recognize native hook_event_name and legacy hook_event only to validate an allowed lifecycle input; do not remap generic reporting into real Stop events. This prevents an identity repair from activating unrelated consumers. Keep the generic reporter path byte-equivalent in behavior.

The new command must quote its own absolute script path correctly, including projects with spaces. Do not rewrite unrelated hook commands as part of this repair. Validate native IDs with the existing safe-session-reference contract. No transcript content, prompt, tool input, credentials or model output belongs in the identity-only payload.

### D2 — Bounded receipt, honest absence

Identity-only reporting waits for the actual local receiver response within a finite budget below the existing hook timeout. Keep the existing reporter's two-second overall safety deadline and five-second registration budget; in identity-only mode remove the fast 50ms exit and wait for the receiver response within that existing total deadline. Do not increase a deadline or add a new retry timer. Read one complete JSON document through stdin end, counting UTF-8 bytes as chunks arrive. The current reporter has no byte cap; source inspection confirmed unbounded concatenation. Propose an identity-mode-only 1 MiB maximum complete input frame, measured as raw UTF-8 bytes before decoding. This is a resource-protection proposal for review, not an empirical native payload maximum or an injection authority threshold. Oversized input simply remains unbound with an observable failure; it never authorizes fallback parsing. Include boundary tests at the cap and one byte above it and an actual native lifecycle payload measurement in the installed proof. Do not claim an inherited cap exists. Reject overflow immediately without parsing a truncated prefix; reject malformed or incomplete input at the existing overall deadline. Do not issue an identity request before successful complete-frame validation. Keep the generic reporter behavior outside this change. A non-2xx, transport failure or timeout does not count as a captured baseline. Nor does a generic HTTP 200 that merely stored the event. The identity-only response must distinguish event storage, whether the exact current running session accepted the binding, and whether its baseline is resolvable. Route identity-only events through a conditional binding operation before the generic last-writer-wins bridge: verify the exact current running incarnation, bind an empty native-ID slot or confirm an identical ID, and reject a conflict without saving or emitting any binding side effects. Return that operation’s actual result and do not run the generic bridge again for this identity-only event. Preserve generic-event respawn/resume rotation behavior. Test that a conflicting report leaves the original ID and side-effect count unchanged. Return only bounded status fields, never raw rollout paths or contents. Unknown, stopped or mismatched contexts must not receive a binding-success result. The hook remains non-blocking to the framework: it must not deny a tool or trap the session in a Stop loop. Generic post-tool reporting retains its existing fast path.

The server binds only the session named by the existing instar_sid context. This uses the existing authenticated project hook trust boundary; a safe native ID and an existing rollout do not independently prove that the submitting process owns that ID. Do not claim stronger process authentication than the current bridge provides. Preserve existing context checks and reject an observed conflicting incarnation rather than overwriting it as a successful early capture. It does not select a newest rollout, infer identity from terminal text, copy another session's binding or weaken the existing safe reference checks. A native ID without a real resolvable rollout is not an injection baseline. Existing guard evaluation remains in force.

### D3 — Fresh and existing installation parity

Fresh project init, existing-project init, standalone init, shared refresh and post-update migration must all reach the same project registration capability for enabled Codex. Avoid invoking the whole shared refresh from fresh init if it would overwrite unrelated jobs or settings. Install the reporter script before registering or arming a command that references its new mode. The update path must always refresh the built-in reporter and then update the Codex registration.

Keep registration project-scoped. Preserve custom hook groups and user-disabled trust slots. Use the existing arming policy and opt-out; do not manually write trusted hashes, unrelated personal Codex settings or approval bypasses. Only the existing native trust flow may update this project's path-keyed slots, including when Codex stores those slots in its shared config file. Registration is not proof of arming. Tests of registration must not claim actual native hook execution. An unavailable trust step must remain honestly reported by existing mechanisms.

### D4 — One typed refusal observation, no new dispatch decision

Add a synchronous observed-injection wrapper for the Telegram ingress call. It invokes the existing injection method exactly once and returns its boolean together with a narrowly typed `codex-baseline-unavailable-before-dispatch` observation when that exact guard rejects. Capture that observation in an invocation-local context and restore the previous context in finally, including nested calls. Existing boolean callers retain their behavior. Do not infer the reason by parsing logs or by running a second baseline decision after dispatch.

Only a branch that has performed no physical effect may emit this unsent observation. A failed or unknown physical dispatch retains its existing classification. The observation does not enqueue, retry, respawn or acknowledge the message. Correct the existing duplicate-marker ordering: a known before-effect refusal must not leave a marker that makes a repeated source message return true and emit Delivered without any physical dispatch. Preserve markers and uncertainty protection once an effect may have occurred. Add a same-source repeated-refusal test and an unknown-effect duplicate test; do not broadly delete markers on every false return.

### D5 — Owner-visible failure must name actual custody

On that typed, known-unsent Telegram refusal, persist a narrowly scoped attention item through the existing adapter before scheduling its ordinary topic response. The message says this attempt stopped before sending. Only when authenticated original-source history independently proves no earlier dispatch may it also say the message was not delivered. If an earlier attempt is uncertain, explicitly say its delivery outcome is unknown. Apply the same distinction to attention prose, commitment descriptions and topic replies; it must not say queued or saved for automatic retry unless existing committed custody actually proves that claim. This invocation-local observation proves only that this invocation did not dispatch. It does not prove that an earlier attempt for the same source message was unsent. Do not tell the person to resend unless the original source history independently proves that doing so is safe. In particular, retained replay metadata and historical uncertain rows must not be relabeled from the latest refusal.

The attention item uses the exact authenticated source topic and source message identity, excludes message text and credentials, and has no new action button. Keep distinct source messages distinct; deduplicate repeated reporting of the same source identity. Do not automatically clear the notice merely because another message or a native binding later succeeds. Normal owner acknowledgement remains authoritative. If attention persistence fails, retain the ordinary explicit failure response and an attributed degradation; do not claim the attention item was saved. Use the existing origin-aware outbound sender and inspect its actual acceptance or durable-hold receipt instead of swallowing a rejected promise. A held outbound notice is not delivered. If attention, tracking and outbound custody all fail, record an attributed combined-degradation outcome and return an honest failure to the ingress caller; do not claim the owner was informed or that durable follow-through exists. No architecture can promise persistence while every available durable store is unavailable. Existing outbound custody and notification policy remain in force.

Other injection failures retain their current handling. Non-Telegram callers retain their existing structured/API failure surface and boolean behavior. No new owner, team or peer permission is introduced.

Persist failure follow-through using the existing CommitmentTracker.record path, with source sentinel, type one-time-action, owner agent, verificationMethod manual, beaconEnabled true and the existing default cadence. Its stable externalKey must namespace the exact authenticated source platform/bot identity, topic and message ID; do not include message content or treat a session successor as a different source failure. Use the existing synchronous CommitmentTracker.record externalKey get-or-create behavior as the authoritative in-process deduplication, rather than relying on an asynchronous check-then-create in a caller. Test two concurrent handlers resolving to one active record through readback. This does not add or claim cross-process uniqueness. The commitment asks the agent to establish readiness and report the verified delivery outcome or a concrete supported recovery option; it grants no permission to resend, inject, respawn or mark delivered. The normal commitment owner and pool-read lifecycle remain authoritative. A notice acknowledgement or later identity binding does not complete this commitment; an agent must record actual outcome evidence through the existing tracked workflow. If tracking is unavailable, preserve the attention item and explicit failure surface and report the tracking failure through the existing degradation reporter. If all durable paths are unavailable, disclose that failure and do not claim durable follow-through exists. This core cannot guarantee eventual delivery.

### D6 — No replay or new inbox

Do not move StageB prepare ahead of its guard in this repair. That store defaults to a fresh delivery UUID, and changing its admission would require source-id deduplication and successor design. Do not use the global QueueDrainLoop as a universal standby inbox: it takes custody only on the global holder. Existing valid prepared rows, owner/epoch fences, FIFO, uncertainty states, tombstones and generationless recovery remain unchanged.

## Multi-machine posture

Session and attention state use the existing **proxied-on-read** pool surfaces. Commitment state uses its separate existing **replicated-read** posture, as detailed below. Native bindings remain in the session owner's ordinary StateManager records and are read through `GET /sessions?scope=pool`; this spec adds no second identity store or replication channel. A successor captures its own native ID through the existing incarnation lifecycle, not by copying an old process's identity. Attention items use the existing `GET /attention?scope=pool` merge and remote acknowledgement path. Agent-owned failure commitments use the existing CommitmentTracker store and `GET /commitments?scope=mesh` surface; no second obligation store or cross-machine execution authority is added. The existing route is declared in src/server/routes.ts and mobileOpsRoutes.ts; retain its explicit mesh posture rather than inventing a pool alias. For session and attention reads, preserve the actual existing peer-failure reporting and test missing URLs and unmappable owners; do not infer complete coverage from a successful merge. Commitment mesh reads combine own records and already-stored replicas, not a live owner read. They can return local-only HTTP200 when replication is dark, and an entirely absent replica carries no unavailable-owner marker. Therefore an empty remote mesh view does not establish that no obligation exists. Test available and stale replicas, missing replica, offline owner and unmappable owner, and report these limits rather than adding a new replication system. The local canonical tracking receipt and its owner remain the follow-through evidence; replica availability is qualified, not guaranteed. The Telegram response uses the existing configured owner/transport authority.

The project registration and native trust slots remain physically scoped to the Codex installation whose credential/profile executes the session. They are not copied between machines or personal projects.

- native-hook-installation — machine-local-justification: physical-credential-locality; the project path and its native trust entries belong to that machine's own Codex credential/profile. Capture records and owner notices still use the unified reads above.

## Decision points touched

- Identity-only field and lifecycle validation — invariant; basis: enumerable-domain; evidence: the new mode accepts only the fixed identity event projection and existing safe session reference contract, never message meaning.
- Native binding and rollout baseline — invariant; basis: irreversible-consequence; evidence: typing without the correct incarnation and baseline can create an unprovable physical effect. Existing owner, epoch and physical dispatch fences remain authoritative.
- Reporter receipt budget — judgment-candidate; floor: no captured claim without actual binding evidence, finite completion and no framework denial; arbiter: this bounded design review’s explicit selection of the inherited two-second availability policy, with measured late-response failures reported. The implementation reuses the current two-second overall limit and five-second native registration budget rather than introducing a new configurable threshold.
- Project hook selection and trust — invariant; basis: enumerable-domain; evidence: enabledFrameworks plus existing explicit disabled/path-keyed trust slots enumerate the permitted installation surface; no global discovery or inferred trust is added.
- Invocation-local refusal tag — invariant; basis: irreversible-consequence; evidence: only the exact ordinary pre-prepare baseline branch can prove this invocation had no effect. Original-source history separately governs source-wide outcome wording; this tag alone never permits resend. Unknown effects must never acquire that tag.
- Attention notice and custody wording — invariant; basis: irreversible-consequence; evidence: saying delivered or queued without the corresponding receipt can cause loss or duplicates. Persisted attention does not claim message custody.
- Need for a new inbox, broader identity discovery or replay — judgment-candidate; floor: no historical unknown-effect replay, forged native ID or permission widening; arbiter: the normal design review. This spec chooses none of those changes.

## Failure and Decision Boundaries

| Situation | Required result |
|---|---|
| Valid own native lifecycle event, receiver accepts | Existing binding records the exact ID; guard still requires its real rollout baseline |
| Empty/malformed ID or wrong lifecycle mode | No new binding and no tool/Stop denial |
| Receiver unavailable or non-2xx | Bounded hook completion, no captured claim |
| User-disabled hook | Remains disabled; no forged trust or global fallback |
| Fresh Codex-only or both-framework project | Own reporter and registration exist before first session; Claude-only remains unchanged |
| Ordinary idle ingress missing baseline before prepare | Typed attempt-unsent result, durable attention if available, source-history-qualified topic failure |
| Earlier source attempt unknown, current attempt refused | Current attempt stopped before sending; earlier delivery unknown; no resend advice or source-wide non-delivery claim |
| Matching preRolloutBootstrap pending input | Existing exception unchanged; not tagged as an ordinary baseline refusal |
| Unknown physical effect | Existing uncertain custody, no unsent notice that encourages retry |
| Attention persistence fails | No saved/queued claim; ordinary failure plus attributed degradation |
| Historical unknown row or tombstone | No mutation and no replay |

## Frontloaded Decisions

D1 through D6 above are the intended build decisions. Preserve existing trust slot indices; use an identity-only event; reuse the existing receipt budget; keep native binding observational; report only a proven pre-effect refusal; and add no inbox or replay authority. None is tagged cheap-to-change-after: identity, durable notices and a user-visible failure surface require this review before implementation. If actual native behavior contradicts these choices, revise the design rather than weakening a guard.

## Verify the State, Not Its Symbol

| Observation | Symbol | Claimed state and corroboration | Unmeasurable result |
|---|---|---|---|
| Native identity report | Valid native ID plus accepted hook receiver response | The exact instar session has an observed native binding. The installed proof matches a genuine rollout session_meta and the real same-incarnation injection baseline; the ID alone never proves message acceptance. | Leave unbound or baseline-unavailable; keep physical effects refused and report failure honestly. |
| Registration | Own project hooks file | Only that registration is installed, not that it is trusted or fired. Existing native trust readback and genuine isolated hook execution independently verify those other states. | Registration, arming and execution stay separately unknown or failed. |
| Known unsent refusal | Invocation-local typed tag | That exact guard returned before dispatch. Unit/lifecycle tests instrument physical effects and unknown outcomes to corroborate zero effects; the tag must not be copied from logs or a later snapshot. | Use the existing generic failure, never encourage replay of uncertainty. |
| Attention persistence | Actual store result and authorized readback | The notice is inspectable in the existing owner pool view, not necessarily read or delivered on Telegram. Outbound acceptance remains separate. | No saved or queued claim; ordinary explicit response and attributed degradation remain. |

## Tests and Verification Plan

Unit tests must cover identity-only projection, bounded receipt/non-2xx/timeout, empty and malformed fields, safe IDs, missing credentials, generic reporter parity, path quoting, command-slot stability, custom hooks and disabled trust. Cover exact topic, attention and commitment wording when an earlier same-source outcome is unknown and the current invocation is refused. Cover the observed injection wrapper with nested invocations, exactly one call, missing baseline before effects, ordinary false and unknown-effect outcomes without the unsent tag.

HTTP integration must exercise the actual authenticated hook receiver and existing session binding, and owner-authorized attention readback for a known-unsent message. Cover valid own context and rejected/unknown contexts, real persistence success versus failure, no false delivery confirmation and no raw message content in diagnostic records.

Lifecycle tests must use the actual production init and migration paths, not only refreshHooksAndSettings. Prove fresh Codex-only, both and existing projects get registration before startup; repeated update is idempotent; disabled/custom choices survive. A tool-less first-idle fixture must bind the actual native ID and a real rollout baseline before a later injection is allowed; missing identity still refuses with zero pane effects and the explicit owner notice. The required installed proof uses supported isolated Codex startup, genuine native hook input and actual rollout metadata. Never forge a live native ID or directly reinject through tmux.

The installed acceptance proof must also use a genuine user-role Telegram message on the isolated demo bot and an idle tool-less Codex session, correlating the actual source identity, exact native binding and real rollout baseline with verified delivery to that session. Exercise missing-baseline refusal separately and verify the originating topic receives truthful failure wording and the existing attention and commitment reads retain the failure. No production owner topic or manual tmux reinjection is permitted. This proof requires its own proposed allocation; a synthetic HTTP fixture cannot replace it.

Measure the existing two-second total receipt policy as an inherited availability choice, not a safety floor: compare immediate response, response after the policy deadline, repeated Stop events and concurrent sessions. Report elapsed times and unknown outcomes without inventing a numerical success target. The safety floors are finite completion, no success without actual evidence, and no permission widening.

All tests require an exact Throughput allocation under normal HOME, private actual Node24 dependencies and ordinary enforced shared admission. No test is started by this draft. A complete normal final-head verification remains required. An actual native proof is separate from synthetic unit/HTTP fixtures and no full/live claim may replace it.

## Side Effects, Awareness and Rollback

The identity event may add a small amount of existing hook telemetry; it must not fire Stop consumers or LLM work. Its receipt wait is bounded and applies to identity-only lifecycle events, including repeated Stop events. Record bounded outcome and elapsed-time observations for accepted binding, stored-only response, malformed input, overflow, timeout and transport failure through the existing diagnostics surface, without message text or raw native IDs. Native binding remains observational and cannot relax physical-effect guards. Attention records disclose failure rather than claiming delivery; they contain identifiers and fixed prose, not user content.

Add a normal agent-awareness entry explaining early identity capture, truthful not-delivered notices and the prohibition on replaying unknown effects. Record the installed-file migration and disabled-hook contract. Rollback is a normal source revert/update; it removes only owned identity registration/mode and leaves custom hooks, accepted messages, historical uncertain rows and operator choices intact. Do not delete existing audit evidence on rollback.

## Open Questions

The Chief of Staff resolved scope to the bounded core in message `985daa2a-92a1-4b0c-b27f-718ab78eb903`. This draft receives one authorized review round; it is not yet converged or implementation-approved. The authorized corrected review found remaining defects; these post-review corrections require explicit bounded closure authority rather than being silently called clean. Review the proposed identity-only input cap, actual binding/readback semantics, stable source failure tracking and all retained boundaries. Actual Codex lifecycle execution and installed migration behavior are acceptance requirements, not assumed facts. If real native input cannot satisfy the contract, stop and revise rather than inventing a fallback identity or relaxing a guard.
