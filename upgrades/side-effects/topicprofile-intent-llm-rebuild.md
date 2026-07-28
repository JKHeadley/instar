# Side-Effects Review — topicprofile-intent-llm-rebuild

**Change:** Replace the FRAMEWORK/MODEL/THINKING keyword regexes in
`parseProfileTrigger` with an LLM-with-context recognizer (`ProfileIntentClassifier`),
per the standard "Intelligence Infers, Keywords Only Guard" (keyword-intent audit offender #1).
Dev-gated dark + dry-run-first; fail-open.

**Spec:** `docs/specs/topicprofile-intent-llm-rebuild.md` (converged, approved)

## Phase 1 — Principle check (signal vs authority)

Yes — this is a decision point (it gates whether an inbound message actuates a topic-profile write
vs passes through to the agent). It is designed as a **signal producer**: the classifier's only
power is to move a message from "actuate a write" toward "pass through" (fail-open). The authority —
`TopicProfileWriteSurface.applyWrite` — is unchanged and independently re-validates every field
against the closed enums. No brittle check holds blocking authority; the classifier can never
actuate a value the write surface would reject.

## The 8 questions

1. **Over-block (rejects legitimate inputs it shouldn't).** The grounding guard requires the
   resolved value to appear in the LATEST message, so a purely context-resolved command ("yeah go
   with that") is intentionally NOT actuated — it passes through to the agent. This is a deliberate
   safety choice (a respawn off stale context is the harm). The cost is cheap: the operator restates
   ("switch to gemini") or the agent handles it. Not a defect.

2. **Under-block (failure modes it still misses).** A genuinely-intended change the LLM classifies
   as `isChange:false` is a MISS — cheap by design (fail-open; the operator restates). The prefilter
   is drop-only and inclusive, so it does not cause misses beyond the LLM's own judgment. A cross-
   framework model id the classifier passes is refused at the write surface with a named reason (no
   wrong respawn).

3. **Level-of-abstraction fit.** Correct layer: the recognizer's DECISION moves from regex to LLM;
   the actuator (write surface, validation, respawn debounce, confirm slots) is untouched. It feeds
   the existing authority rather than paralleling it. The command kinds + effort/escalation stay in
   `parseProfileTrigger` (structural / explicit-mandate forms, not framework/model/thinking intent).

4. **Signal vs authority compliance.** Compliant — see Phase 1. Fail-open (never actuates on doubt),
   `gating:true` (swap-provider-before-fail, no silent heuristic drop), independent write-surface
   re-validation.

5. **Interactions (shadow / shadowed / double-fire / race).** Runs ONLY when `parseProfileTrigger`
   returns null, so it never shadows or double-fires with the deterministic command kinds (readout /
   undo / clear / reapply / switch-now / confirm) or the retained effort/escalation writes. Bare
   affirmatives ("yes", "do it") are consumed by `parseProfileTrigger`'s `confirm` kind and the
   armed-slot machinery BEFORE the classifier — the classifier never competes with the confirm-slot
   ordering/TTL guards. The grounding guard specifically prevents the classifier from re-introducing
   the confirm-slot-bypass an unconstrained context window would open.

6. **External surfaces.** Adds no HTTP route. Writes a dev-agent-only, machine-local soak log
   (`logs/profile-intent.jsonl`) with NO raw message content (enum fields + length only). The LLM
   call is one bounded fast-tier call per candidate message, attributed to `/metrics/features` as
   `ProfileIntentClassifier` (gate). On the fleet it is dark (no external surface changes at all).

7. **Multi-machine posture (Cross-Machine Coherence).** Machine-local BY DESIGN
   (`physical-credential-locality`): the recognizer runs on the topic-owning machine's Telegram
   inbound path and gates a session that lives on that machine; there is no shared state to
   replicate. `unified` would be infeasible (nothing to replicate). The one operational note:
   graduation evidence is read from the auto-aggregated `/metrics/features` surface, not by hand-
   unioning per-machine logs. No user-facing notice (one-voice) concern — the only user-facing
   output is the write surface's existing disclosure reply, unchanged. No durable state strands on
   topic transfer (the classifier holds none). No generated URLs.

8. **Rollback cost.** Trivial and doubly-inert: `enabled` is omitted (dev-gate dark on the fleet),
   `dryRun:true` default (never actuates), and the whole topic-profile WRITE layer is separately
   dev-gated + dryRun. Flipping `topicProfiles.intentClassifier.enabled:false` (or reverting the
   commit) fully removes it; no data migration, no state repair. On the fleet, framework/model/
   thinking conversational pins simply pass through to the agent, as they would with the feature
   absent.

## Phase 5 — Second-pass review (required: inbound-message gate)

This change gates inbound messaging, so a dedicated adversarial + integration review was run
(two independent reviewer passes + two cross-model external passes) during spec convergence. The
one MATERIAL adversarial finding — context-referential affirmatives bypassing the confirm-slot
guards to actuate directly off stale context — was found and CLOSED with the deterministic
`valueGroundedInLatestMessage` grounding guard (the value must be named in the latest message to
actuate), proven by the `guard-context-only-value` corpus case and unit tests. All minor findings
(symmetric untrusted-data delimiting, scrubbed log, cleared timeout, context dedupe, `gating:true`
swap-first) were folded in. The multi-machine reviewer confirmed machine-local-by-design is
correct.

**Concur with the review.** The final design holds no brittle blocking authority, fails open to the
more-capable agent on every uncertainty, and the write-surface authority + confirm-slot ordering
guards are unchanged. The single new actuation trigger (a paraphrase the old anchored regex missed)
is strictly gated by the grounding guard + enum guardrail + confidence gate + dev-gate + dryRun.
No residual concern.
