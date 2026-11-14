# Conversation and Effort Hierarchy — Focused Frontier Review Round 12

**Status:** seventh GPT/Claude pair complete; both returned `CHANGES_REQUIRED`. The exact reviewed packet is frozen. The changes below happened after the packet and still need a focused verification. This remains an unshipped design.

## Provenance

- GPT-6 Astra: Codex CLI 0.164.0, high reasoning, read-only, session `01a1a90e-3c53-7143-8c9f-f47d4f1880fb`. [Exact packet](review-evidence/conversation-round12-input.txt), [result](review-evidence/conversation-round12-gpt-astra.json). Eight medium sample findings; it reproduced several transitions with a lightweight DOM stub, not a browser or distributed service.
- Claude Opus: Claude Code 2.1.318, medium effort, no tools, resolved model `claude-opus-5-5`, session `63692b28-0fd3-4aac-a04a-ceef6f129707`. [Exact packet](review-evidence/conversation-round12-input.txt), [parsed result](review-evidence/conversation-round12-claude-opus.json), [raw stream](review-evidence/conversation-round12-claude-opus-stream.jsonl). One high answer-proof finding, twelve medium spec/sample findings. It traced the source statically; no browser or distributed implementation was tested.

## Spec changes

- The answer operation table now distinguishes a cancelable **pre-dispatch** claim from a dispatch-started or ambiguous attempt. Cancel-first fences the gateway token and records positive no-send; dispatch-first refuses Cancel. `mark-answer-not-sent` requires positive fenced gateway no-dispatch proof, never an owner's impression or an absent platform message.
- Source erasure and gateway dispatch are serialized at the witness. Erasure-first prevents a platform call and purges the unsent payload; dispatch-first leaves an ambiguous/sent attempt blocked from automatic retry. The new gateway has a defined failure domain, isolated transient plaintext custody, erasable payload key/ciphertext, protected credentials, no plaintext logs, and an erasure inventory entry. The witness remains plaintext-blind.
- The dashboard/app Overview, visible-label table, rollups, archived attention, and overflow now use one rank: Conflict; Answer needs linking; Answer needs review; Checking answer; Decision/Question; Source needed; Possible decision; Partial. `Removed here · Sync unavailable` names local-only suppression during witness outage or missing setup; it does not claim a fleet tombstone.

## Sample changes and evidence

- An ambiguous answer survives wake and blocks ordinary Answer. `Answer needs review` requires an exact sent-message ref for Mark sent and a simulated positive gateway no-dispatch proof for Mark not sent; Send again keeps a possible-duplicate warning. Unresolved owner actions are disabled while the witness is missing/unreachable. Wake during outage leaves queued changes and Cancel requests pending until recovery.
- Transcript fixtures are now conversation-scoped. Forgetting a message in one conversation cannot mutate the Design coordination source or its Updates. The exact dependent update is removed when its own source is erased. Re-source/link actions require a surviving agent-authored alternative source and are absent if it was forgotten.
- Answer attention and Pending route to the exact occurrence even after its active-question flag clears. Queued Resolve participates in provisional cycle/front-door checks while the conflict stays visible. Front-door changes serialize per effort across both entry points and exclude pending move-away targets. A canceled pending re-source converts any dependent confirmed answer to `Answer needs linking`; it cannot cancel that answer. Undo is blocked during a placement conflict.
- The headless Chromium script passes the 320 px and desktop walkthrough and added targeted cases for wake during witness outage, exact source identity, unavailable alternative source, answer-state routing, cross-subject dependency refusal, and conflict/Undo.

## Remaining gate

These are design and mock-behavior checks. A real `GraphWitnessService`, `AnswerSendGateway`, source erasure, platform send, and screen-reader integration remain implementation gates. The installed 94-standard advisory check still flags the disclosed sleeping-machine survivability tradeoff. No zero-flag or production-validation claim is made. A narrow post-change model check is still needed before the design review can be called converged.
