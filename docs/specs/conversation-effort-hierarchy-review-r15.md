# Conversation and Effort Hierarchy — Narrow Verification Round 15

**Status:** tenth GPT/Claude pair reviewed the frozen post-round-14 sample. GPT-6 Astra returned `PASS` within the named sample flows; Claude Opus 5.5 returned `CHANGES_REQUIRED` with three medium findings and one low finding. The corrections below followed the frozen packet and passed a focused Chromium walkthrough. This is not a production sign-off.

## Provenance

- [Exact frozen input](review-evidence/conversation-round15-input.txt), SHA-256 `8b4c7f776fe23d84a2fcff0089b0e75eaa8475849c274ccb1739d1b531e04a11`.
- GPT-6 Astra through Codex CLI, high reasoning, read-only: [result](review-evidence/conversation-round15-gpt-astra-raw.txt). Zero findings in the narrow scope; static inspection, no browser execution.
- Claude Opus 5.5 through Claude Code, medium effort, no tools, session `12b8fbf7-443d-4755-8be9-fe107cb6f4ef`: [parsed result](review-evidence/conversation-round15-claude-opus.json), [raw envelope](review-evidence/conversation-round15-claude-opus-raw.json). Static inspection only.

## Claude findings and post-packet corrections

1. Canceling a pending re-source could miss a confirmed answer operation created earlier in the same queue. The sample now scans every waiting answer on that occurrence, converts it to `Answer needs linking`, and keeps the sent reference. A focused test cancels re-source with the answer before it and verifies wake does not certify the erased source.
2. Sent references were retained only on one wake path. A single terminal recorder now carries the occurrence, sent reference, and override bit through awake Mark sent, awake linking, and sleeping answer/link certification. A focused test verifies the linked answer's sent reference remains after wake.
3. `Why here?`, local-only Pending rows, Forget, and Wake announcements could name the wrong blocker when the witness was missing. They now use the same witness-state label as the persistent sync banner; a focused test verifies `Sync setup needed` in the placement explanation.
4. The lower-severity Wake announcement could falsely claim an uncertain answer was confirmed. It now names remaining answer review/linking, refused work, or no pending work accurately.

The installed 94-standard advisory check still has one possible conflict: a sleeping installed machine cannot already hold newly captured pending information. The design's witnessed pending repair and all-member acknowledged commit are unchanged. No claim of zero-flag conformance or real distributed implementation is made.
