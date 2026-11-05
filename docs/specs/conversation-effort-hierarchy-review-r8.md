# Conversation and Effort Hierarchy — Frontier Model Review Round 8

**Status:** third independent model passes completed; draft changes are being rechecked. **Input:** [exact packet](review-evidence/conversation-round8-input.txt), SHA-256 `14e03f23f73163e4568751b4b0990942967d6010e032257ec430468e549b744a`. Both reviewers returned `CHANGES_REQUIRED`.

## Reviewer provenance

- **GPT-6 Astra:** Codex CLI 0.164.0 reported `model: gpt-6-astra`, high reasoning, read-only, session `01a1a8d7-d804-7061-94a8-804558312fad`. It found two medium precision issues. [Raw result](review-evidence/conversation-round8-gpt-astra.json); [full transcript](review-evidence/conversation-round8-gpt-astra-transcript.txt).
- **Claude Opus:** Claude Code 2.1.318 invoked with `--model opus --effort high`, no tools, streaming JSON, session recorded in the raw stream. The response identified `claude-opus-5-5` and found nine design and six precision issues. [Raw result](review-evidence/conversation-round8-claude-opus.json); [stream provenance](review-evidence/conversation-round8-claude-opus-stream.jsonl).

## Finding dispositions in the revised draft

| IDs | Revision | Remaining proof |
|---|---|---|
| GPT 1 | Notice identity now uses stable logical decision occurrence plus kind/audience, independent of current parent/destination. | Two questions in one source, edit/move after first notice. |
| GPT 2; Claude R3-15 | Sample now has an ordered pending list, proposed/old parent labels, witness-confirmed cancel state, persistent pending answer, and wake certification of unanswered questions. It shows a row marker, Pending sheet, phone/desktop focus behavior, and tests two same-subject moves. | Production queue and screen-reader proof. |
| Claude R3-1 | One fenced witness atomically decides cancel versus commit for each idempotency key. Cancel can finish while another member sleeps; witness outage shows Canceling. The sample assumes a reachable witness and labels the confirmed cancel. | Commit/cancel race and reconnect fixture. |
| Claude R3-2 | Witness-durable queue intake is required before `Saved` or a hidden answer cue; `Saving` precedes it. Owner pending-list API works across devices and failover. | Kill writer immediately after Saved. |
| Claude R3-3 | New always-on GraphWitnessService on a distinct failure domain, with signing key, atomic fence, durable pending/source store, and erasure support. Agent-owned provisioning and explicit disabled state on failure. | Fresh one-machine install and invalid-provider fixtures. |
| Claude R3-4 | Telegram capture continues locally during witness outage, marking range local-only and evidence-partial until backfilled; loss becomes a named gap. | Multi-batch outage and poller failover fixture. |
| Claude R3-5 | Window-covering attestation separates a sleeping unique source holder from a replica-only sleeper. Examples identify MacBook as a unique source holder. | Unique worker log versus replica-only sleep. |
| Claude R3-6 | Answer sheet collects content/typed choice and sends through existing conversation path with audience preview and one-voice outcome. Cue hides only after confirmed send and witness-durable transition. | Sleeping worker receives one answer; failed send retains cue. |
| Claude R3-7 | Forget is a priority control operation, halts ingress/serving/notices, purges queued bundles and dependent copies, and names TopicMemory, session, memory, active-context, and external limits. | Offline peer + live session + queued decision erasure fixture. |
| Claude R3-8 | Owner app reports live in a viewer-bound panel outside MSP-readable transcript; read-time filtering covers list, transcript, search, sync, deep link, later grant, and final pre-send recheck. | Later MSP grant canary. |
| Claude R3-9 | Pending delegation shows a labeled owner overlay, routes attention through proposed parent, and includes pending placement in digest input hash. | Sleeping-member dispatch/question fixture. |
| Claude R3-10 | The pending cue itself never triggers notice; independently durable typed, time-bound source occurrence may. | One notice across failover/certification. |
| Claude R3-11 | New agent asks automatically emit typed requests. A deterministic high-confidence rule surfaces legacy untyped asks as `Possible decision` without committing or notifying; ambiguous prose stays optional. Ambiguous edits keep prior occurrence open for owner review. | Fixed real-topic corpus. |
| Claude R3-12 | `sourceInvalidated` flag gives open decisions a `Source needed` cue and re-source/dismiss/supersede paths. | Erased-only evidence fixture. |
| Claude R3-13 | Source/header More sheet offers forget with precise target, platform-copy limit, pending status; API defines owner and verified non-owner erasure proof. The sample includes a More-path Instar-copy removal preview. | 320 px owner/unauthorized UI/API fixture. |
| Claude R3-14 | Current front door cannot move/unlink until reassigned or cleared through a certified front-door action; sample explains refusal. | Cross-surface preview and replay fixture. |

The latest standards gate flagged one possible conflict against the exact single-machine-survivability article: pending locally observed decisions cannot be present on a sleeping installed machine before it wakes. The design treats them as explicitly unacknowledged local/witness-backed state and keeps the last all-machine acknowledged state coherent; a physically disconnected machine cannot know a new event until reconnect. This is a disclosed liveness/survivability boundary, not a production proof.

The third pass explicitly accepted the main final-certificate, canonical reducer, read-time shared-session boundary, and simple host-theme direction. It did not validate production code. A fourth model pass on the changed body remains required before convergence.
