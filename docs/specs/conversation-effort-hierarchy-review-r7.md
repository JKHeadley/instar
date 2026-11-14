# Conversation and Effort Hierarchy — Frontier Model Re-review

**Status:** GPT and Claude second passes completed; revisions drafted, next check pending. The owner requires independent frontier GPT and Claude review and a very simple default UI that preserves the current app/dashboard feel.

## Reviewer provenance

- GPT-6 Astra: Codex CLI 0.164.0, high reasoning, read-only, session `01a1a8c4-5194-7ec3-8af3-16cb3819936d`; second pass returned `CHANGES_REQUIRED` with five design findings and one sample precision finding. Raw [result](review-evidence/conversation-round7-gpt-astra.json) and [transcript with exact input](review-evidence/conversation-round7-gpt-astra-transcript.txt).
- Claude Opus: Claude Code 2.1.318 invoked with `--model opus --effort high`, no tools, stream output; session `1fe784c1-8070-4dec-994b-8c9935dd1aab`. The response identified `claude-opus-5-5` and returned `CHANGES_REQUIRED` with eleven design and two precision findings. Exact [input](review-evidence/conversation-round7-claude-input.txt), raw [result](review-evidence/conversation-round7-claude-opus.json), and [stream provenance](review-evidence/conversation-round7-claude-opus-stream.jsonl). First pass was separately recorded in round 6.

## GPT findings and response

| Finding | Draft response | Verification |
|---|---|---|
| Final commit proof absent from a surviving third machine | The final `commitCertificate` binds the signed membership epoch, all durable member receipts, source chain, lease, and independent witness. Each installed member must persist it before API success. Prepared intents do not enter the canonical tree. | Three-machine interruption and writer/witness-loss fixture is now an explicit build gate. |
| Pending move dismissal could commit later | Local dismissal leaves a persistent Pending entry. A real Cancel requires an all-member durable cancellation certificate before commit certification; otherwise a committed move offers Undo. | Reconnect sleeping member after dismiss/cancel race. |
| Sleeping member prevents urgent decision cue | Explicit observed owner questions may show `Needs sync` attention with exact source while the transition is pending, without notice or committed claim. The occurrence key merges it with the later decision. | Sleeping-member source question and reconnection dedupe fixture. |
| Captured-source forget omitted | Typed source/version erasure tombstones now cover replicated segments, recoverable backups/keys, indexes, search, digests, and re-ingestion barriers. Platform-side deletion authority remains separate. | Offline peer, crash, repair, and replay fixture. |
| Two decisions in one message collapse | Stable occurrence identity and explicit edit/supersession mapping distinguish independent questions of the same kind. | Two same-kind questions, one answer, edit, and cross-link fixture. |
| Sample conflict not reflected on Overview | Sample now derives attention from active descendant conflict state, ranks it, renders a root cue, and opens the conflict. | Chromium path added to the 320 px/desktop script; passes. |

The owner also requested visual consistency. The sample now uses the installed dashboard's dark/green fallback palette; the spec requires the shipped surfaces to reuse host dashboard/app components and theme tokens rather than sample CSS.

## Claude findings and draft response

Finding IDs below follow the ordered raw result array. These are design changes in the current draft, not implemented product claims.

| Finding | Draft response | Remaining proof |
|---|---|---|
| C1 — sleeping peer stalls ordinary work | One durable ordered pending queue validates against earlier intents; effort/header/move dependencies and replacement are explicit. Owner sees read-your-writes overlay and one screen-level waiting state; Cancel precedes certificate and Undo follows it. | 24-hour sleeping-member sequence and 320 px pending walkthrough. |
| C2 — urgent questions and answers stall | Source-linked `Needs sync` attention and `Answered, syncing` local answer state are D-gated. A time-bound explicit question may use one-voice private notice from independently durable capture, keyed by stable occurrence. | Sleeping worker question, answer, and no-duplicate reconnection. |
| C3 — evidence completeness conflated with replication | Separate `evidenceCoverage` from `replicationState`; only missing evidence produces tile Partial. Replication delay is one screen-level state. | Complete evidence with sleeping peer versus missing source. |
| C4 — no witness/recovery ceremony | Independent witness is setup prerequisite; owner-authenticated membership recovery fences lost peers and transfers from any survivor/backup. No witness means corrections disabled; stolen-device erasure is not falsely promised. | One-machine, witness loss, dead writer, stolen member, lone survivor. |
| C5 — orphaned writes after failover | Successor reconciliation redistributes certified events or adopts/aborts prepared intents, binding idempotency across epochs and terminal status. One fenced witness is normative. | Kill writer at every certification stage and compare final event sets. |
| C6 — offline serving versus erasure | Forget is locally suppressed immediately but only called complete after all installed members apply tombstone or an authenticated membership transition removes a lost member. Offline peer may serve until then; status names waiting peer. | Offline/rejoin, crash, and permanent peer loss with truthful status. |
| C7 — derived/quoted copies and forget authority | Finite forget operations, all-source-version tombstones, erasable derived artifacts, source-dependency index, re-captured generated/structured quote purge, erased coverage reason, and platform-copy limit. | Edited message + quoted reply + sent rollup + peer crash/replay. |
| C8 — audience check too late | Service reads are bound to verified destination audience before owner content enters model context; shared sessions get pointer-only capability. | Prompt-injection canary in shared topic. |
| C9 — audience oracle impossible as written | V1 rich chat reports only in owner one-to-one DM or app. Normal Telegram/Slack groups get neutral pointers; MSP history readers and later joiners count in audience. | Telegram/Slack/MSP/later-joiner matrix. |
| C10 — Telegram capture loss detection | Fenced single-consumer capture ledger with offset handoff, independently durable update before confirmation, downtime/retention gaps, outgoing capture and bot-visibility facts. | Poller crash and update-retention fixtures. |
| C11 — decision ingestion/answer contract | Typed `decision-request`, deterministic explicit prose threshold, candidate review, stable occurrence, threaded/selected/confirmed answer, and finite answer/dismiss/supersede operations. | Real-topic two-question and unrelated-reply pilot. |
| C12 — mobile/sample gaps | 44 px buttons, Path and Front door actions, pending sample flow, heading before phone list, focus after overflow, detail-origin search return, and unassigned placement behavior. | Browser script passes; production screen-reader proof open. |
| C13 — drift | Normalized installed-machine term and beta sequence, updated production open item, removed extra Overview Open chat control. | Fresh consistency/model pass. |

## Convergence

Pending independent re-review of the changed design. The current 94-standard advisory pass and scripted Chromium sample pass; these do not establish production behavior or accessibility. The design remains unshipped.
