# Decision Completeness — Round 2 Resumed

**Verdict: SERIOUS ISSUES.** Read-only review by inherited Codex; no approval, runtime proof or family-diversity claim.

Counts: `frontloaded-decisions: 18` inventoried (not 18 complete); `cheap-tags: 0`; `contested-then-cleared: 10`; `contested-rejected: 1`; `open-user-decisions: 0`. Remaining decisions below are author-answerable.

## Findings

1. **DESIGN / medium — Slack outcome remains unspecified** (Provider Outcomes/D13). The closed `replyMirror` success permits only Telegram, while the new route/capability promises `slack-v1`. Existing `src/messaging/slack/SlackAdapter.ts:550–555` sends to its registered thread, not an arbitrary selected-message quote. Decide whether Slack linkage is explicitly unsupported or supplies a separately verified native outcome; freeze its exact result and acceptance case without changing destination.

2. **DESIGN / medium — Required native work has no concrete handoff** (Outcome/D18/Completion). “Apple app owner” supplies menus/releases, and actual app proof gates readiness, but no named session, acknowledged brief, or run boundary is specified. Name `echo-instar-apple-app-rebuild`, its acceptance handoff and evidence destination; end the server run at a concrete accepted handoff or include coordinated app completion. Do not leave single-run completion dependent on an unnamed owner.

3. **DESIGN / medium — Global suite exclusion lacks a floor** (Testing: “No competing suite runs”). Counterexample: independent suites on separate idle hosts without shared resources. Replace global exclusion with normal per-host admission and exact shared-resource custody; the verification owner arbitrates scheduling, deterministic admission is the fallback. No replacement numerical cap.

## Independent Invariant Contest

All ten Decision-points rows were contested. Signed selectors, typed identity, actor/ACL, reservation equality, proof versions, immutable evidence, private projection, independent provider facts and mounted capability have **enumerable-domain** bases: canonical request/receipt bytes (`AppRecordSignatures.ts:70–83,260–327`), durable hash/state (`MobileChatRequests.ts:81–109`), duplicate identity (`AppConversationStore.ts:739–743`), and sibling App-link acknowledgments. Exact-stop priority has **irreversible-consequence** basis: quote failure must not prolong an authenticated stop. No legitimate counterexample to these floors found; implementation defaults are not thereby invariants.

## Fixed-Limit Inventory

One selected reference and finite versions/selectors are protocol domains, not history quotas. Inherited 128-character identity and signature schemas remain compatibility boundaries. Inherited 20/minute sends, 2,000 reservations, 24-hour/five-minute request window, 4,000-character text, 10 files, 50/64-MiB media and bounded previews are existing policies, not proved physical maxima; legitimate larger workloads exist. Preserve ordinary typed refusals/defaults, never infer source absence, and route tuning through existing owners. The only new qualitative quota is finding 3.

The conformance signals were checked independently, not adopted as conclusions. App links remain the sibling prerequisite, not current main.
