---
slug: update-relevance-gate
review-convergence: converged
approved: true
approved-by: justin (topic 18250, "yes, A please") + standing build-and-ship pre-approval
eli16-overview: update-relevance-gate.eli16.md
parent-principle: "Near-Silent Notifications"
iterations: 1
---

# Update-Relevance Gate

**Status:** converged + approved · **Ships:** LIVE fleet-wide, default-on (ratified by Justin 2026-06-04: a UX bug fix to a user-facing surface ships live, not dark — shipping it dark would hide the fix from exactly the users who reported the noise)
**Parent principle:** Structure > Willpower · Near-Silent Notifications
**Earned from:** Justin, 2026-06-04 (topic 18250). After PR #698 shipped silent-by-default + maturity-tagged announcements, the user STILL saw update messages referencing internal features they have no clue about ("Apprenticeship cycle recording (stricter)", "Sibling Agent Server Control", "I can now record manual overseer review cycles…"). #698 fixed the *opt-in framing*; it did not enforce *relevance*.

## The gap #698 left

#698 made user-facing update announcements opt-in (`user_announcement: audience: user`) and maturity-tagged. But two leaks remain:

1. **Authoring is willpower.** The upgrade-guide path only fires when an author tags a change `audience: user`, but NOTHING independently checks whether the content is genuinely user-relevant or jargon-free. An author (often an agent composing release notes) who over-marks internal plumbing as user-facing, written in jargon, sails straight through. The maturity framing controls *tone*, not *relevance*.

2. **The self-narration path has no relevance gate at all.** When an agent narrates its own ship via `POST /telegram/post-update` ("I can now restart other agents' servers…"), it passes only the tone/junk gate (`checkOutboundMessage` → `MessagingToneGate`, rules B1–B14 — literal CLI/path/jargon patterns). None of those rules ask "would a non-technical user notice or care about this?". #698 never touched this path.

## The structural fix

A single **user-relevance gate** at the chokepoint both leak paths already share. Investigation (this repo, v1.3.246):

- `server.ts:5524` documents that **every** update-class emitter (AutoUpdater, AutoDispatcher, the restart handshake, `/telegram/post-update`) routes to the **`agent-updates-topic`**, and `UpgradeNotifyManager.notifyTopicId` is that same topic.
- Both leak routes flow through `checkOutboundMessage`: `/telegram/post-update` (routes.ts:6465) and `/telegram/reply/:topicId` (routes.ts:6200, used by the spawned upgrade-notify session).
- `matchesSystemTemplate` already lets genuinely-critical fixed system messages bypass the gate.

So the chokepoint is: **any discretionary message destined for the Agent Updates topic.** Gate there → every emitter is covered with none of them needing to remember (Structure > Willpower).

### Behavior

`UpdateRelevanceGate.review(text)` → one of:

- **`internal`** → `deliver:false`. The message is purely agent-facing plumbing (sentinels, gates, validation hardening, apprenticeship cycles, sibling-server control, internal refactors) that a non-technical user has no path to notice, use, or care about. **Suppressed** — withheld from the user, recorded to the audit trail. The route responds `200 {ok:true, suppressed:true, reason}` (suppression is a SUCCESS, never an error → the caller does not retry/escalate).
- **`jargon`** → `deliver:true` with a plain-language `plainText` rewrite. The change is genuinely user-relevant but written in internal jargon; the rewrite (plain "here's what you can now do" language) is sent instead of the original.
- **`user-relevant`** → `deliver:true`, original sent as-is.
- **error / timeout / gate unwired** → **fail-open**: original sent, `failedOpen:true`. An emitter already decided to send it; an LLM hiccup must never swallow a possibly-important update. (The gate only governs discretionary update-class messages — critical system templates bypass it entirely — so fail-open noise during an LLM outage is bounded and safe.)

### Scope guarantees

- **Strict no-op off the Updates topic.** `applyUpdateRelevanceGate` early-returns for any `topicId !== agent-updates-topic`, so the normal user-conversation reply path is byte-identical.
- **One-place policy.** The logic lives in a single helper (`applyUpdateRelevanceGate`, mirroring `checkOutboundMessage`); the two update routes just invoke it.
- **Nothing vanishes silently.** Every deliver/suppress/rewrite decision is appended to `logs/update-relevance.jsonl`. A suppressed capability is still LEARNED by the agent (the upgrade-notify Step-2 MEMORY update is independent of the Step-1 user message).

### Wiring & rollout

- New gate `src/core/UpdateRelevanceGate.ts` — LLM-backed (`IntelligenceProvider`), mirrors `MessagingToneGate` (fail-open, `model:'fast'`, `temperature:0`, prompt-injection boundary, `/metrics/features` attribution `component:'UpdateRelevanceGate'`).
- Instantiated in `server.ts` beside `MessagingToneGate`, injected into the route context.
- **Default-ON fleet-wide:** `config.monitoring?.updateRelevanceGate?.enabled ?? true`, **no config migration needed** (runtime fallback against the shipped default). Rationale ("User-Facing Fixes Ship Live"): this is a UX bug fix, not a new capability — the dark/developmentAgent gate exists for changes whose failure could break something, and this gate cannot (fail-open, strict no-op off the Updates topic, fully audited; worst case = one borderline note withheld, visibly logged). Originally drafted dark-on-fleet; Justin flagged that a dark UX fix is invisible on exactly the agents whose noise he reported, and ratified the live flip 2026-06-04.
- Off-switch / tuning: `.instar/config.json` → `monitoring.updateRelevanceGate.enabled`.

## Testing (all three tiers)

- **Unit** (`tests/unit/UpdateRelevanceGate.test.ts`) — both sides of the decision boundary with realistic inputs: internal-plumbing texts → `internal`/suppress; genuine user news → `user-relevant`/deliver; jargony-but-relevant → `jargon` + rewrite; provider throw → fail-open. Mocked `IntelligenceProvider`.
- **Integration** (`tests/integration/update-relevance-gate.routes.test.ts`) — `POST /telegram/post-update` with internal text → `200 {suppressed:true}`, not sent; with user-relevant text → sent. Gate disabled → byte-identical passthrough. Reply to a NON-updates topic → never gated.
- **E2E** (`tests/e2e/update-relevance-gate-lifecycle.test.ts`) — production init path: the gate is wired (not null) with NO explicit enablement (the default-on path every fleet agent runs), and the update-class chokepoint is alive.

## Agent Awareness

- CLAUDE.md template (`src/scaffold/templates.ts`): the Agent-Updates-topic section gains a note that update-class messages now pass a relevance gate, with the off-switch + audit-trail location, so agents understand why a self-narrated update may be silently withheld.
