# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

On development agents (dark on the fleet), each outbound tone-gate (MessagingToneGate) decision row in the local judgment provenance log now also keeps the credential-scrubbed dynamic parts of the prompt the check judged (candidate, recent messages, signal sections and the per-call boundary) under the machine-local `_contentFull.replayParts`. It also gets content-free replay identity: `promptSha256`, `replayPromptSha256`, `scrubChanged`, `scrubVersion` and `captureVersion: tone-replay-input-v1`. New pure helpers `scrubToneGatePromptParts`, `buildToneGateReplayCapture` and `assessToneGateReplayEligibility` rebuild the prompt with `renderToneGatePrompt` and refuse truncated, oversize, missing, malformed and unknown-version rows, and rows whose stored parts no longer match their sha. A capture over 40,000 stored bytes is skipped and labelled `capture-oversize`, so the row stays whole. Prompt text, model, parsing and the pass/block verdict are unchanged. Switch: `toneGate.replayInput.enabled` (unset = live on development agents), read live through the tone gate's config getter.

## What to Tell Your User

Nothing changes for you. On development agents, I now keep enough of each message check, on this machine only, to re-run it exactly later and grade whether the check got it right.

## Summary of New Capabilities

Outbound-message checks on development agents can be replayed exactly for decision-quality grading.

## Evidence

tests/unit/tone-gate-replay-input-capture.test.ts covers the switch off (no capture), the switch on (the stored parts rebuild the exact prompt the model saw), a credential scrubbed from the stored copy only, the candidate body and the replay parts sharing the machine-local key, identical verdicts and prompts with the switch on and off, each refusal reason, and a redacted read that never contains the captured text. tests/unit/tone-gate-operator-config.test.ts covers the dev-agent gate both ways. Whole-file runs on the exact code head bfe5479f6 (2026-11-28 00:29 PT, one at a time through the M5's heavy-turn wrapper): these two files plus 13 that pin the tone gate, the dev gate and the ladders, 15 files and 255 tests, all passing.
