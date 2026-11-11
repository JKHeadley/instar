# Conversation and Effort Hierarchy — Frontier Review Round 9

**Status:** fourth GPT pass and targeted Claude Opus retry complete; both returned `CHANGES_REQUIRED`. Draft revisions are under a focused final check. Convergence remains pending.

## Provenance

- GPT-6 Astra: Codex CLI 0.164.0 reported `model: gpt-6-astra`, high reasoning, read-only; session `01a1a8e4-f299-71e1-88f6-2ad0b50d7c60`. [Exact full input](review-evidence/conversation-round9-input.txt), [result](review-evidence/conversation-round9-gpt-astra.json), [transcript](review-evidence/conversation-round9-gpt-astra-transcript.txt). Verdict `CHANGES_REQUIRED`: two design and three precision findings.
- Claude Opus: the original full-packet invocation produced no answer before watchdog interruption, so it is diagnostic only. A targeted retry used `--model opus --effort medium`, no tools, streaming JSON, session `688adb8c-0975-4f23-9af2-79d145b3bbdf`; its response identified `claude-opus-5-5` and returned `CHANGES_REQUIRED` with ten findings. [Exact retry input](review-evidence/conversation-round9-claude-retry-input.txt), [raw result](review-evidence/conversation-round9-claude-opus.json), and [stream provenance](review-evidence/conversation-round9-claude-opus-stream.jsonl).

## GPT findings and revisions

| Finding | Current revision |
|---|---|
| Witness hosted on an installed peer could vanish with all other peers | The witness is now a managed remote service outside the installed-machine loss set. Acknowledged state remains locally complete on each installed machine. Saved pending recovery explicitly depends on witness durability; corrections stay disabled when provisioning fails. |
| Canceling a confirmed answer could reopen a worker question | `cancel-pending` is restricted to unsent proposals. A confirmed answer send is not cancelable; its pending decision transition continues to certification. The UI says `Answer sent · syncing`. |
| Sample omitted pending transition for an existing decision | Sleeping-machine answer now produces a persistent pending answer for existing and new questions; a global Pending action remains available on Overview, All, and phone detail. Browser script covers the route. |
| Sample forgot a whole transcript rather than one source | The More sheet now chooses an exact numbered source message and removes only that Instar-held copy; other messages remain. Browser script checks two unrelated messages remain. |
| Imported project/task link authority contradicted operation table | Historical imported links are candidates until owner acceptance; only owner correction or authenticated live delegation can authoritatively place. |

The sample remains a behavior probe with mock data. It does not prove real send outcomes, source erasure, or screen-reader behavior.

## Claude findings and current draft response

| IDs | Change |
|---|---|
| F1 | Answer send intent is keyed to logical occurrence and made witness-durable **before** send. Without a reachable witness, structured Answer/Dismiss are unavailable; an ambiguous send stays non-retriable until origin outcome resolution. Confirmed send shows `Answer sent · syncing` in Pending. |
| F2, F6, F7 | Sample keeps existing and new question occurrences separate, opens a chooser when both exist, hides the original answer action once answered, gives conversation-level interactive cues, and adds Open source to the exact sample message. Pending Dismiss has its own type and Cancel path. |
| F3, F4 | Sample now routes sleeping Resolve, Undo, suggestion review, and front-door changes through ordered Pending. Conflict stays visible until certified. Overview/child/All markers, row-level Cancel, source-erasure Pending, and `Why here?` distinguish proposed from last agreed placement. |
| F5 | A pending typed request is labeled `Question`, ranked with Decision. Machine sync stays in Pending/details; the cue remains distinct from a committed DecisionRecord. |
| F8 | Front-door Move refusal offers Change or Clear. A sleeping member keeps that change pending; Move remains refused until certification. |
| F9 | All conversation rows open the authorized Instar transcript first. Telegram/Slack observed-window context and external Open action sit in More. Search/source links have a safe unavailable state in the spec. |
| F10 | A visible label table, one Archive path under effort More, and root-effort-only Overview tiles normalize copy and structure. |

The Claude retry used targeted spec excerpts and a complete sample, not the complete spec, and explicitly left witness-operator privacy unjudged. The current draft now states encrypted witness bundles, per-member sealed key envelopes, and no plaintext content keys at the witness. Production proof remains open.

The installed 94-standard advisory gate still flags one physical conflict with single-machine survivability: a machine asleep during a new source/answer cannot already hold that information locally. The design keeps all acknowledged state on every installed machine and independently preserves Saved pending state, but that sleeping machine must repair pending items from the witness on wake. This is an explicit design decision requiring operator adjudication before calling the design fully standards-conformant.
