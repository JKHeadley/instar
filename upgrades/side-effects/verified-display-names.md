# Side-Effects Review — verified display names

**Version / slug:** `verified-display-names`
**Date:** 2026-10-30
**Author:** Echo
**Second-pass reviewer:** independent `identity_review` agent

## Summary of the change

Tier 1, about 36 files and 800 changed lines including this artifact. The change adds a shared channel identity validator, keeps verified Telegram and Slack names attached to IDs, merges topic names across reachable machines, and prevents stale or generated names from replacing real titles. It also sanitizes local, pooled, status, and WebSocket session display fields while retaining unique internal routing keys. It adds migration awareness, unit/integration/lifecycle coverage, and a narrow correction to memory diagnostic sampling found by the full suite. The implementation had two review rounds and two CI-driven followup corrections. The risk signal may suggest Tier 2 because a migration and route are touched. I declare Tier 1 because the migration only appends an awareness sentence to generated guidance, the route is additive, persisted title writes are non-destructive, and a code rollback restores the old behavior without repairing state.

## Decision-point inventory

- `verifiedEntityName` — added — checks whether a candidate is suitable as a display name; it never blocks delivery or actions.
- Telegram and Slack registration — modified — a generated placeholder cannot replace an existing verified title; unknown titles are looked up from the platform.
- `/telegram/topics?scope=pool` — added — returns verified names from local and reachable peer registries, and reports failed peers and unresolved IDs.
- Session status/API/WebSocket projection — modified — verified title or explicit unavailable text replaces a raw routing key. Persisted `telegramTopicId` keeps the pair available even when an adapter session binding is lost.
- Inbound Telegram handoff — modified — resolves a missing title across the pool before session injection or spawn; message delivery remains allowed when the title is unresolved.
- A2A peer-health display — modified — hides a fingerprint or identifier presented as a name.
- Memory diagnostics — modified — derives percentage and tier from one sample.

## 1. Over-block

A legitimate user title that exactly equals its numeric topic ID, `topic-123`, a long hex string, or a Slack-style channel ID will be treated as unresolved. The user could intentionally choose such a title. The effect is loss of a display label, not blocked messaging or action. These forms are indistinguishable from the generated placeholders that caused the observed defect; the platform ID remains available for routing and diagnostics.

## 2. Under-block

A stale but human-looking title in a registry may remain visible if the Telegram holder is unreachable. A misleading ordinary word such as “General” cannot be disproved by the shape validator alone. Pool responses report failed machines, and the holder wins when reachable. This is not a guarantee of fresh platform state during a network partition.

## 3. Level-of-abstraction fit

Adapters and registries own platform ID/title pairs; the pool read joins them at the consumer. The validator checks the narrow structural invariant that an identifier is not a title. It is not a conversational judgment. UI callers use the returned verified name or an explicit unavailable state. The memory diagnostic correction stays in SessionManager, where both values originate.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?** No. The validator never blocks a message, session, credential, or user action. It withholds only an unverified display label, reports unresolved status, and continues the underlying operation. This is hard-invariant validation of an identity field, within the exception described in the principle.

## 4b. Judgment-point check

No static heuristic resolves a competing-signals judgment. The form checks reject known identifier shapes as names. The source registry and serving machine, rather than a keyword score, supply the title.

## 5. Interactions

Telegram startup backfill, standby registration, session platform labels, cross-machine forwarding, Slack channel probes, and A2A peer health all share the same display rule. The holder's title supersedes a standby copy after a rename. Older peers' raw session names are normalized when the pool reads them. Peer URL credential guards still run before pool fetches. Existing routing uses IDs unchanged. The migration appends guidance idempotently, including framework shadow files.

## 6. External surfaces

`GET /telegram/topics` retains its topics list and adds a serving flag. `scope=pool` adds a read-only merged response with `pool.failed` and `pool.unresolved`. Session names and peer health may show an unavailable label where an ID once appeared. Platform metadata lookups may add startup API calls. No outbound user message is generated by this change.

## 6b. Operator-surface quality

The core branch updates the legacy dashboard and console session views so the cross-machine duplicate warning matches the platform and conversation ID after public display names are sanitized. The conversation ID stays internal; the warning and session title show readable text. A reviewer found that matching a session routing key could falsely warn for different conversations that share a key across machines; this was corrected and a negative client test added. The separate console preview branch renders unavailable names plainly and keeps raw IDs in diagnostic details. Phone and desktop mock screenshots were inspected. The live console remains a review surface until the core route is released.

## 7. Multi-machine posture

Topic titles are proxied on read through `/telegram/topics?scope=pool`; local and peer registries are merged, and the Telegram-serving machine takes precedence. Forwarding resolves the title from another reachable machine before an auto-spawn. An unreachable peer is reported as failed rather than silently making a missing title look correct. Topic IDs continue to route across machine boundaries.

## 8. Rollback cost

Revert the release and redeploy. Existing topic registries retain their prior valid names; the new code does not rewrite them to placeholders. The added guidance sentence can remain harmlessly or be removed by a later migration. No data migration or operator repair is required.

## Conclusion

The change addresses the observed identity substitution at source and consumer boundaries. The main residual risk is an old human-looking title during a network partition; the pool response exposes the failed peer so callers can mark the reading partial.

## Second-pass review

**Reviewer:** independent `identity_review` agent
**Independent read of the artifact:** Concur. The review first identified a Secret Drop spawn path, stale standby title precedence, local/status/WebSocket and older-peer pooled session leaks, and a collision if unknown topics shared a generic spawn key. Those were fixed and re-read. The final review found no remaining concern.

**Followup review:** Concur. After CI found that duplicate-session diagnostics still depended on sanitized display names, the reviewer found a possible false warning from matching internal session keys. Both clients now match the server's platform and conversation ID pair. A negative client test covers two topics with the same session key. The Mac M5 Pro local verifier then found two failures in the browser-helper test fixture changed during this branch: it assumed all basic shell tools lived under `/usr/bin`. The fixture now locates each tool under `/usr/bin` or `/bin`, preserving the intended restricted PATH on Linux and macOS.

**Migration followup:** The Mac Mini verifier passed its full unit lane, then found one failure in the existing browser-skill migration integration test. A deterministic probe reproduced the issue: the new verified-name guidance was appended to a minimal legacy `CLAUDE.md` before the legacy browser section was replaced, making that section appear edited and leaving its old heading beside the new one. The browser section replacement now runs before capability bullets are added. The same probe shows one new heading and zero old headings in both `CLAUDE.md` and `AGENTS.md`; the integration test is being rerun.

**Migration followup independent review:** Concur. The exact-text guard and edited-section preservation remain intact; only the order changes, so the shipped legacy section can be recognized before new guidance is appended. The second run remains idempotent.

**Mac verification followup:** The Mac Mini passed 53,393 unit tests (10 skipped) on the migration fix but reported one failed test file each in `review-exchange-routes.test.ts` and `tmux-resilience-slow-stub.test.ts`; its retained log names the files but omits their failed assertions. Both files passed together in a focused local integration run (21/21 tests), then each passed again inside the full local integration suite. The latter suite was still running when this evidence was recorded. Since the verifier will only rerun a failed record after the head moves, this documentation-only revision requests a fresh Mac run without changing implementation or weakening test assertions.

## Evidence pointers

`tests/unit/channelIdentity.test.ts`, `tests/unit/telegram-adapter.test.ts`, `tests/unit/slack-thread-session-routing.test.ts`, `tests/unit/dashboard-duplicateBadge.test.ts`, `tests/integration/telegram-issue-topics-route.test.ts`, `tests/integration/sessions-listing-hygiene.test.ts`, and `tests/e2e/verified-topic-names-lifecycle.test.ts`. Full suite is running; its result will be added to the PR.

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller was changed — not applicable.
