# Side-Effects Review — Slack Session Reply Relay

**Version / slug:** `slack-session-reply-relay`  
**Date:** `2026-07-19`  
**Author:** `Instar-codey`  
**Second-pass reviewer:** `continuation_side_effects_review` (independent delegated reviewer)

## Summary of the change

This closes the WS3 failure where a correctly spawned Slack thread session was instructed to call an absent Claude-only reply helper. It adds a bind-token-scoped session route, a destination-free helper mode, one SHA-provenance installer for neutral and compatibility copies, neutral initial/recovery/compaction/context prompts, and runbook postflight checks. The raw-destination route remains for system/legacy callers.

## Decision-point inventory

- `POST /slack/session-reply` destination admission — **add** — accepts a negative conversation id authenticated by the session bind token and resolves its local-origin tuple.
- Slack helper mode — **add** — negative `INSTAR_CONVERSATION_ID` selects source-bound mode; legacy invocations retain explicit-channel behavior.
- Relay reconciliation — **add** — exact SHA provenance separates current, known-shipped and customized bytes.
- Generated reply instructions — **modify** — the neutral destination-free command replaces the Claude-specific raw target.
- Tone and duplicate authorities — **pass-through** — the bound route enters the existing `handleSlackReply` path.

## 1. Over-block

The route refuses requests with a missing token, positive or foreign id, replicated-only entry, malformed tuple, caller-specified channel/thread, metadata override, or any unknown body key. Those are intended capability/type refusals. Legacy system callers retain `/slack/reply/:channelId`. A customized canonical helper is preserved with a `.new` candidate and blocks only actual initial/recovery spawn through the exact packaged-byte readiness check; existing live-session injection stays ahead of readiness so inbound work is not discarded.

## 2. Under-block

Two independent model invocations mint distinct delivery ids and can send twice; exactly-once is claimed only for one invocation and deliberate same-id retry. The implementation relies on local-origin registry refusal rather than adding an adapter proxy. Transport failure before an HTTP result is conservatively ambiguous, while a response-attempt id is not journaled across a whole session restart.

## 3. Level-of-abstraction fit

Source binding sits at the HTTP edge where the same bootstrap capability is already verified for commitments. It reuses `verifyConversationBind`, `ConversationRegistry`, shared identifier regexes, and the existing Slack tone/dedup/send handler. File reconciliation is a single core primitive shared by init refresh and post-update migration.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Deterministic blocking authority is limited to the principle's hard-invariant exemptions: capability membership, identifier grammar, local-origin ownership and transport idempotency.

Message meaning continues through the existing context-rich outbound tone authority. Regexes and SHA comparisons never judge conversational content.

## 4b. Judgment-point check

Every added static decision has a closed enumerable domain: token MAC and set membership, registry origin, identifier grammar, or byte equality. Competing live signals are absent from these decisions, while semantic content remains with the existing arbiter.

## 5. Interactions

- **Shadowing:** exact body-schema and binding checks run before tone review because a spawned caller cannot gain system metadata overrides or target a foreign destination; accepted text then follows the unchanged reviewer.
- **Double-fire:** the session facade calls `handleSlackReply` exactly once and never also invokes another delivery funnel.
- **Races:** exclusive same-directory temporaries, fsync/chmod and atomic rename protect installers; delivery-id LRU behavior remains unchanged.
- **Feedback loops:** ambiguity exits nonzero with an explicit non-redrive instruction; the helper contains zero retry loop.
- **Migration:** the shared SHA reconciler supersedes the Slack marker call site. Telegram and WhatsApp migration paths remain intact, verified by adjacent suites.

## 6. External surfaces

Spawned Codex, Claude and Gemini Slack sessions now receive `.instar/scripts/slack-reply.sh` without a raw target. Slack users gain thread-exact replies. HTTP 408 becomes nonzero ambiguity for this helper. Persistent filesystem effects are executable copies, backups for known shipped replacements, and candidates for custom files; credentials and message bodies stay out of installer state.

Slack DMs move from the shared lifeline to isolated 1:1 bound sessions, because the lifeline intentionally carries no single conversation identity. The changed paths add neither a dashboard renderer nor an approval/grant form. Customized-file reconciliation is documented operational maintenance rather than a new permission action.

## 6b. Operator-surface quality

Dashboard, approval-page and grant-form files are untouched, so the four rendering criteria are outside this change's surface.

## 7. Multi-machine posture

**Machine-local BY DESIGN — physical credential locality.** The helper and HTTP route execute beside the Slack credential/socket. A local-origin conversation record is required; replicated-only evidence returns `slack-adapter-authority-unavailable`. Recovery receives a fresh bind token. Owner-dark and off-authority execution refuse instead of claiming success or flattening to channel root.

The change emits zero independent user notice, stores zero new durable conversation record, and generates zero URL. Existing ownership machinery remains authoritative.

## 8. Rollback cost

Rollback order is prompt/hooks first, then restoration of known-shipped helper backups or neutral-file removal after references disappear. Custom files and `.new` candidates remain preserved. Database and Slack-side migrations are absent. A source-only unordered revert could recreate the handset outage, hence the runbook postflight and prompt ratchet.

## Conclusion

The review removed the initial raw channel/thread authority and replaced it with source binding. Independent review then caught four widening/lifecycle gaps: metadata overrides, advisory-only canonical degradation, shared-lifeline DMs without a 1:1 binding, and readiness placed before live-session injection. The route now accepts exactly `conversationId` plus `text`; initial and recovery spawn require executable packaged-identical bytes; DMs receive isolated bound sessions; and live-session injection precedes readiness. The result is thread-exact, migration-safe, bounded on ambiguity, and composed with the existing semantic authority. Independent-invocation duplication and absence of an adapter proxy remain explicit contract boundaries rather than implied guarantees. The artifact proceeds to reviewer recheck.

CI migration-fixture review tightened the admission boundary once more: the post-update migrator now checks that an enabled Slack configuration exists before resolving the packaged helper. A missing config or a non-Slack agent is a strict no-op, so an unused adapter cannot degrade unrelated migrations; an enabled Slack agent still treats a missing packaged template as an error.

The write-domain conformance gate also made the route's physical authority explicit. `POST /slack/session-reply` is machine-local with a `per-machine-path` convergence story: it can resolve only a ConversationRegistry row originated on this machine, emits through this machine's Slack credentials, refuses replicated/foreign-origin evidence, and mutates no git-synced store. The silent-fallback ratchet exposed two pre-existing best-effort stall-notice sends after line movement; both boundaries now log failures explicitly and carry narrow advisory exemptions, restoring the ratchet to its 494 baseline without widening it.

## Second-pass review (if required)

**Reviewer:** `continuation_side_effects_review`  
**Independent read of the artifact:** **CONCUR.** Slack DMs receive isolated conversation-bound sessions; live-session injection precedes relay readiness; actual initial and recovery spawns remain readiness-gated. The route-level DM canary and lifecycle ratchet cover both contracts, and the artifact accurately reflects authority, lifecycle, migration, multi-machine, and signal-vs-authority effects.

## Evidence pointers

- `tests/integration/slack-session-reply-route.test.ts`
- `tests/unit/slack-reply-relay-installer.test.ts`
- `tests/unit/slack-session-relay-prompt-census.test.ts`
- Adjacent Slack migration/reply suites: 91 targeted assertions green.

## Class-Closure Declaration (display-only mirror)

`defectClass: prompt-parser-contract-drift`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/slack-session-relay-prompt-census.test.ts, howCaught: the census fails whenever a shipped Slack prompt renders the obsolete Claude-only helper or interpolates a raw destination, catching the WS3 drift shape at test time. }`
