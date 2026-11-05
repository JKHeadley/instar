# Conversation and Effort Hierarchy — Review Round 1

**Reviewed:** `conversation-effort-hierarchy-v0.md`, 2026-11-03. **Reviewers so far:** Echo architecture/UX inspection and Instar's standards-conformance checker (93 standards). **DAWN review:** requested over Echo's awake Mac Studio Threadline relay in thread `9b2059bb-b3fc-493e-9157-13d558c91ac3` on 2026-11-03; peer-health reported delivery and acknowledgement, response pending. This is an initial review, not a convergence verdict.

## Resolved in draft

1. **P1 — Offline peer could erase the visible tree.** The first draft allowed a partial tree when a machine was unavailable. Revised to replicate durable relationships and source pointers to every machine. Only fresh platform metadata and unsynced messages can be partial, marked with freshness and affected nodes. Standard: An Instar Agent Is Always a Multi-Machine Entity.
2. **P1 — Routine worker updates could flood the parent.** The first draft allowed blocker and changed-outcome chat notices. Revised so these update digests; parent chat notices require a concrete operator decision or usable completed result, with a hard attention budget. Standard: Near-Silent Notifications.
3. **P1 — Constitutional fit was implicit.** Added the parent rule Structure beats Willpower and its causal fit, with The Body and the Mind governing semantic inference. The conformance checker now reports no possible violations.
4. **P2 — The app requirement needed a concrete conversation flow.** Added Overview, effort detail, conversation detail, and All conversations states, with breadcrumbs, why-placed evidence, move preview, undo, archive, and partial-state language.
5. **P2 — Topic history coverage was assumed.** Added complete/partial/unavailable coverage and in-band disclosure to inference and rollups. No confident relationship or complete summary can derive from missing load-bearing history.

## Open design risks for next review

1. **P1 — Canonical store choice and multi-machine conflict merge.** Compare TaskFlow, Initiative replication, AppConversationStore, and ConversationRegistry before selecting the graph event log. The spec needs exact event schema, identity keys, replay order, and conflict precedence. A mock in one process would not prove convergence.
2. **P1 — Multi-person access semantics.** Define whether a relationship can be shared when the child conversation is private to one person. The current rule filters before counts and summaries; tests need owner/MSP and cross-project cases in both dashboard and mobile reads.
3. **P1 — Parent notification threshold.** “Usable result” and “decision needed” need a measurable contract and a burst ceiling. Use actual worker-topic histories before setting numbers; avoid a threshold chosen only for convenience.
4. **P2 — Effort and Initiative mapping.** The draft chooses a separate Effort record with derived Initiative status where linked. Review migration and update ownership so neither store becomes an unnoticed second source of truth.
5. **P2 — App interaction and accessibility.** Prototype deep navigation, search paths, correction and undo on a narrow phone screen. Test with at least one real multilevel effort; a desktop tree alone is insufficient.
6. **P2 — DAWN's topic-history evidence.** Ask her for real cases where concise topic history replaced session history, where it failed, and the format that made delegation summaries valuable. Incorporate her findings with attribution before calling the spec converged.

## Review gates before implementation

- DAWN's response captured and reflected in a revised spec.
- Independent architecture, UX, privacy, and multi-machine review of the actual draft.
- Event schema, API examples, and migration mapping made exact; existing consumer compatibility demonstrated.
- Standards conformance rerun after revisions; current round: **93 checked, zero possible violations**.
- Pilot data and metrics chosen for top-level noise, inference correction rate, and source citation coverage.
