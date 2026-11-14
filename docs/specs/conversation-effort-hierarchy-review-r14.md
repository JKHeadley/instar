# Conversation and Effort Hierarchy — Focused Verification Round 14

**Status:** ninth independent GPT/Claude pair reviewed a frozen post-round-13 packet. Both returned `CHANGES_REQUIRED`. The sample corrections below were made afterward and passed Chromium checks; they have not been independently re-reviewed. The normative design remains a draft.

## Provenance

- [Exact frozen input](review-evidence/conversation-round14-input.txt), SHA-256 `be147dbfbbf98aece8ddae52ef7c1eb2268949411a5a6aad495d71d5860b69d3`. It includes relevant v3 excerpts and the full sample script, excludes styling, and explicitly asks only for material behavior defects in the corrected flows.
- GPT-6 Astra through Codex CLI, high reasoning, read-only: [result](review-evidence/conversation-round14-gpt-astra-raw.txt). Five medium findings. The reviewer reported `GPT-6 (Codex)`; invocation selected `gpt-6-astra`. Static inspection only.
- Claude Opus 5.5 through Claude Code, medium effort, no tools, session `cad34228-5847-478d-b8df-67a3ae5ceee5`: [parsed result](review-evidence/conversation-round14-claude-opus.json), [raw response envelope](review-evidence/conversation-round14-claude-opus-raw.json). One high and seven medium findings. Static inspection only.

## Corrections after the frozen packet

1. A confirmed answer waiting on a sleeping member now suppresses ordinary Decision/Question attention and remains in Pending as `Answer sent · syncing`. Wake applies the answered transition to the exact occurrence, stores its sent reference and override flag in sample history, then removes the pending operation. A simulated `Review delivery` control advances an uncertain attempt to owner review without waking the member.
2. An erased source in `Answer needs review` now names `Source removed` and offers a surviving exact alternative. Re-source preserves the uncertain original attempt; any later retry requires new text and possible-duplicate acknowledgement. A pending link remembers its exact target, and forgetting that target withdraws the resolution before wake.
3. Cancel cascades only within the same operation family. A front-door choice shares an effort ID with an effort move but no longer disappears when that move is canceled. Explicit placement dependencies still refuse an invalid front-door choice.
4. Screen-level and operation-level sync labels now name witness outage or missing setup. Canceling retains its own waiting label. Refused and canceled Pending rows can be dismissed after review, while an audit copy remains in the sample; a forgotten question has a source-removal outcome rather than a placement outcome.
5. The Conflict cue now opens one history entry; on the conflicted detail it focuses Resolve. Decision cues and exact source actions follow the current ancestor path instead of hardcoded effort IDs. The sample checks cycles against queued resolutions before accepting a move.

The headless Chromium script passes at 320 px and desktop width, including new focused cases for sent-answer wake, erased-source re-source, forgotten link target, cross-family Cancel, witness status, refused-row dismissal, ancestor attention, queued-cycle guard, and one-step Conflict Back. This is sample interaction evidence, not a real platform, gateway, distributed store, permission, or screen-reader proof.

The 94-standard advisory check remains at one possible conflict over sleeping-machine possession of newly captured pending information. Convergence and production approval remain open.
