# Side-Effects Review — Durable session presentation

**Version / slug:** session-presentation
**Date:** 2026-11-05
**Author:** Echo
**Second-pass reviewer:** Codex review_session_names (independent SMALL review)

## Summary of the change
Tier 1 reversible presentation fix. Shared sessionPresentation resolver reads conversation-owned titles for dashboard WebSocket, app HTTP, status, and pool rows. Meaningful session/peer names survive missing adapter caches. Negative app/Slack aliases resolve through ConversationRegistry. No lifecycle, dispatch, or routing changes. 13 files, about 450 added/changed lines including tests and artifacts. One independent review round; verification reads confirmed all corrections. Commit/gate attempts recorded in the PR.

## Decision-point inventory
No judgment or block/allow surface. Title selection is a display-data derivation over enumerated sources. No new authority or behavioral constraints.

## 1. Over-block
No block/allow surface — over-block not applicable. Existing identity validation still hides routing identifiers and placeholders.

## 2. Under-block
No block/allow surface — under-block not applicable. A title genuinely absent from every record remains explicitly unavailable; the resolver cannot invent platform evidence.

## 3. Level-of-abstraction fit
Read presentation belongs at the shared server serialization layer. Conversation records own titles; adapter reverse maps alone cannot represent their lifetime. Both consumers use the same resolver, rather than repairing dashboard HTML independently.

## 4. Signal vs authority compliance
Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).
No block/allow surface. No detectors or smart gates changed.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Choosing a title from its explicit owning record is display derivation, not a liveness or ownership judgment.

## 5. Interactions
No shadowing, double-fire, or feedback loop: no actions are emitted. Registry files are read once per listing. Atomic writer replacement yields one complete snapshot; missing/corrupt registry falls through to other existing sources. A new read observes renames without mutating adapter maps. Slack thread titles can use the parent channel registry. Retained positive Telegram ids survive replacement bindings. Negative aliases remain machine-local and are not resolved against a different machine's registry during pool reads.

## 6. External surfaces
Dashboard and app session rows now retain known human titles. Existing routing ids, tmux names, and session ids remain stable. No persistent writes or external API calls. No operator-facing actions are added. The phone receives the corrected existing GET /sessions response.

## 6b. Operator-surface quality
Primary session selection remains in its existing position. Human conversation titles replace unavailable labels; opaque routing identifiers stay hidden. No changes to stop/delete emphasis, layout, tap targets, or widths: both consumers render the existing name/platformName fields. Titles remain escaped by the dashboard renderer.

## 7. Multi-machine posture
Proxied-on-read: GET /sessions?scope=pool merges each machine's presentation. Peer names survive reformatting; pool-wide Telegram ids can be named from the reader's durable catalog. App/Slack negative aliases are interpreted only on their owner. No durable state, notices, or URLs are added; no topic-transfer stranding or one-voice emission applies. /status session list names use the same resolver and remain machine-local detail; no health/capabilities/channels verdict changes.

## 8. Rollback cost
Revert and ship a patch. No migration, state repair, or data loss. Old display fallback behavior returns until corrected again.

## Class-Closure Declaration (display-only mirror)
No agent-authored-artifact defect — not applicable. No self-triggered controller changed.

## Conclusion
Known titles are read from conversation records independently of transient reverse bindings and retained through aggregation. No new action authority or lifecycle coupling.

## Second-pass review
**Reviewer:** Codex review_session_names
**Independent read of the artifact: concur**
Concur with the review. Corrected numeric app-channel alias resolution, retained identity precedence over stale reverse maps, Slack identifier masking, source lookup failure isolation, and invalid peer platformName masking. Each correction has regression coverage. No remaining concrete concerns. Review was read-only, with no sessions or tests started.

## Evidence pointers
Unit: sessionPlatform, session-presentation, WebSocketManager. Integration: sessions-listing-hygiene. E2E: session-presentation-lifecycle (real AgentServer and WebSocket, no session launches). Full CI is the regression authority; no session-launching suites are run on the laptop.
