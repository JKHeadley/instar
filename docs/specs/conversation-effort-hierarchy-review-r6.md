# Conversation and Effort Hierarchy — Model Review Round 6

**Status:** first frontier GPT and Claude passes completed; design revisions are being re-reviewed. **Scope:** v3 spec and clickable HTML sample. **Owner direction:** keep the default UI extremely simple, with short labels and explanation on demand.

## Reviewer provenance

| Reviewer | Verified invocation | Result |
|---|---|---|
| Frontier GPT | Codex CLI 0.164.0 reported `model: gpt-6-astra`, high reasoning, read-only; session `01a1a8a8-2afa-75e1-b8a0-db9b2416d31c`. | 7 findings, `CHANGES_REQUIRED`. |
| Claude | Claude Code 2.1.318 invoked with `--model opus --effort high`, no tools, no session persistence; session `ae04cec1-c61a-4c94-973e-c11fe9641dee`. The response identified `claude-opus-5-5`; the CLI JSON did not include a separate resolved-model field, so `Opus` is the verified selection. | 28 findings, `CHANGES_REQUIRED`. |

The exact first-pass input is [round 6 input](review-evidence/conversation-round6-input.txt), SHA-256 `84a05894a5ada322553e35ea67ee99e2d894967cb328d73ae8d47ee8455e447b`. Raw findings are [GPT-6 Astra](review-evidence/conversation-round6-gpt-astra.json) and [Claude Opus](review-evidence/conversation-round6-claude-opus.json). DAWN's earlier peer review is separate; her runtime model was not established. The installed 94-standard conformance gate is a code-backed advisory check, not a third model review.

## First-pass findings and design response

Finding IDs refer to the ordered raw result arrays (`G` for GPT, `C` for Claude). “Addressed” means the current draft now states a design and acceptance test; it does not claim an implementation or a successful second review.

| Findings | Design response in revised v3 | Status |
|---|---|---|
| G1, C4, C10 — shared-channel privacy and chat confirmation | Separate requester identity from reply audience. Owner-scoped detail is private or explicitly audience-authorized; shared/unknown-audience chats get a neutral app pointer. Agent text creates only a proposal; an adapter-verified owner callback commits. Generated rollups cannot become their own evidence. | Addressed in draft; re-review pending. |
| G2, C6, C7, C17 — failover tail, old epochs, standby dashboard | Success requires fsynced source on every installed machine in a signed membership epoch plus an independent durable witness. A sleeping member keeps the correction pending; membership removal requires authenticated decommission/replacement. Successor compares its local tail to the witnessed watermark; valid delayed historical events replay under immutable proof, while new fenced writes fail. Standby dashboard requires re-unlock; pending writes have status lookup. | Addressed in draft; integration proof open. |
| G3, C8 — erasure versus immutable hashes | Opaque IDs and immutable text-free graph events; separately encrypted, erasable effort headers with signed tombstones and a rejoin read barrier. | Addressed in draft; crash/offline-peer proof open. |
| G4, C9 — stale epoch wording and global revision conflicts | Old epoch alone does not invalidate a historical event. Moves compare subject heads; cursors use short-lived authorized snapshots and survive unrelated edits. | Addressed in draft. |
| G5, C12 — canonical fallback and authority cycles | Canonical projection derives from event DAG only; local retained snapshot is separately labeled. Lower-authority cycle participants are held out before owner heads. | Addressed in draft. |
| G6, C20, C21 — mobile navigation and sample accuracy | Phone detail hides list/search above transcript. Back restores origin and search state. The sample filters invalid move parents, shows Undo directly, and offers Keep last agreed in conflict. | Browser exercised at 320 px; screen-reader proof open. |
| G7, C13 — five-tile overflow | Conflict/decision rank above pins; one compact overflow link opens all remaining attention, including unassigned items. Global stale state is one screen cue, not a badge on every tile. | Browser exercised with seven urgent roots and an unassigned decision. |
| C1 — missing live delegation ingress | A narrow dispatch/spawn service path creates only authenticated `delegates-to` edges; bearer prose cannot. Agent edges cannot replace user heads. | Addressed in draft. |
| C2 — empty launch and laborious placement | A captures live delegation; B remains dark diagnostic; C adds manual placement; D adds optional candidate/batch review. Owner-facing beta waits for a useful real-topic tree. | Addressed in draft; real inventory pilot open. |
| C3 — decision lifecycle | Source-backed, witnessed `DecisionRecord` transitions with stable key, explicit open/answer/supersede/expire rules, dedupe, and correction. No decision cue before D. | Addressed in draft. |
| C5 — Telegram history assumptions | Telegram Bot API is treated as observed-only with no general history backfill; loss recovery uses replicated capture. Slack history fetch requires verified scopes, retention, pagination, and rate limits. | Addressed in draft; platform integration proof open. |
| C11, C23, C24, C25 — evidence, wire schema, Initiative and links | Added typed source evidence and outcome rules; one discriminated NodeRef and operation vocabulary; one primary Initiative; Instar authorization and honest platform-link labeling. | Addressed in draft. |
| C14, C18, C19 — UI operations, project compatibility, MSP prefs | Finite operation/reducer table, explicit project-scope compatibility, and flat-inventory-only MSP preferences. | Addressed in draft. |
| C15, C16 — notice and digest authority | Nearest authorized front door or app fallback, one-voice delivery ledger, budget overflow visibility, native-ping metric, write-admitted digest generation and replicated viewer-scoped cache. | Addressed in draft. |
| C22, C26, C27, C28 — wording and provenance | Distinguishes explicit-worker Overview omission from gated inferred hiding; uses write-admitted-machine terminology, `catchUpReadProofs`, and latest common causal placement. | Addressed in draft. |

Post-revision standards passes exposed the difference between a read-serving subset and the constitutional single-machine-survivability outcome. The design now requires every installed machine to hold the full acknowledged graph and necessary local context before success; a sleeping installed machine keeps a correction pending instead of being timed out of membership. A machine can leave only through authenticated decommission/replacement with state transfer. The current 94-standard pass flagged zero possible violations. This is advisory, and the second GPT/Claude round must still inspect the revised body.

## Current UX check

The HTML sample now opens with one headline, two tabs, search, and at most five named tiles. Quiet rows have no explanatory paragraph or status filler; a decision is a separate source action. Detail screens put child names or the original transcript first, with summaries, path, provenance, and moves in `Updates`/`More`. A scripted Chromium pass at 320 px and desktop exercised deep navigation, Back to search, move/undo, conflict, optional suggestion review, seven urgent roots plus an unassigned decision, and no horizontal overflow. It uses sample data and is not a screen-reader or production authorization test.
