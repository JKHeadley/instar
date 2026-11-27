# Conversation and Effort Hierarchy — Frontier Review Round 13

**Status:** eighth GPT/Claude pair complete. Both returned `CHANGES_REQUIRED` on the frozen packet. The corrections below followed that review and passed a focused Chromium walkthrough; no reviewer has signed off on the corrected packet. This is a design and behavioral sample, not a shipped feature.

## Provenance

- Frozen [review packet](review-evidence/conversation-round13-input.txt), SHA-256 `ca634b0ffb7a61394b29e5487eb670792952574d3f173fb687a6047b9805188b`.
- GPT-6 Astra, Codex CLI 0.164.0, high reasoning, read-only, session `01a1a91c-5d46-7f62-aee2-b20a66e329b9`: [result](review-evidence/conversation-round13-gpt-astra.json). Eight medium sample findings.
- Claude Opus 5.5, Claude Code 2.1.318, medium effort, no tools, session `028df02c-7853-4d92-9926-3e934e7ff626`: [result](review-evidence/conversation-round13-claude-opus.json), [raw stream](review-evidence/conversation-round13-claude-opus-stream.jsonl). Three high and four medium findings.

## Disposition

1. **Answer recovery and erasure.** The spec now refuses an override send after source tombstone or payload purge until the owner supplies a new exact source, new answer text, a fresh audience preview, and possible-duplicate acknowledgement. The sample now retains exact sent references, keeps Mark sent pending while a member sleeps, turns a sent answer with an erased source into `Answer needs linking`, holds linking resolution pending until wake, and creates a distinct retry attempt with an uncertainty outcome. `Send again` is absent while the source is erased.
2. **Forget and Cancel ordering.** Forget remains waiting when a later Cancel withdraws a move or front-door change. Source invalidation is independent of whether a Dismiss/Supersede currently hides the occurrence; canceling the dismissal restores `Source needed`, not an answerable erased question. An outage Cancel shows `Canceling · Waiting for sync` in the header, item banner, and Pending, without a repeat Cancel control.
3. **Pending projection.** The sample front-door chooser includes a conversation moved into the effort by an earlier pending placement, records that dependency, and refuses the choice if the enabling placement fails. An unrelated move/undo cannot clear another conversation's conflict. Resolution excludes descendant destinations and checks cycles on admission.
4. **Attention and evidence.** The source conversation owns the decision occurrence; ancestor cues follow its current path and child rows surface descendant conflict. The old effort loses the cue if the source moves out. Sample updates are shown only in their contributing effort and a worker's own assertion is labeled `Reported` rather than `Verified`.
5. **Exact target routing.** An explicit decision occurrence remains explicit; the chooser only lists actionable items with their actual states. Pending opens the exact occurrence, including `Answer needs linking`.

## Focused evidence and limits

The standalone fallback was aligned after this packet to the installed console navy/slate/teal tokens, including its light theme; product screens still inherit host components. The headless Chromium script passes at 320 px and desktop size. Added cases cover sleeping-member Mark sent and linking, erased-source review with no retry, a new override attempt, cancellation while the witness is unavailable, pending Dismiss → Forget → Cancel, Move → Forget → Cancel, and a decision source moved out of its former effort. The script exercises sample behavior with fixture state; it is not a distributed gateway, Telegram/Slack send, authorization, or screen-reader test.

The installed 94-standard advisory gate still reports one possible conflict: a sleeping installed machine cannot already possess new pending information captured while it slept. The design keeps all acknowledged graph state on every installed machine and witness-durable pending state for repair. This physical liveness tradeoff remains unresolved. Convergence and production approval remain open.
