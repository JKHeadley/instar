## What Changed
- **Completion-claim checks can now be replayed exactly (development agents only).** The completion-claim verifier's model prompt is built only from the already-scrubbed message, the already-bounded tool evidence, and one prompt-variant switch. On a development agent each completion-claim decision row in the local judgment provenance log now keeps those two inputs under the machine-local `_contentFull` field, plus content-free replay identity in the served context: `promptSha256`, `includeGeneral`, `scrubVersion: claim-scrub-v1`, `captureVersion: claim-replay-input-v1`, and `incumbentLabelsRecorded: false` (the row does not carry the model's per-clause labels; a grader must not assume it does).
- **Parity is checked, never assumed.** New pure helpers `rebuildClaimArbiterPromptFromCapture` and `assessClaimReplayEligibility` rebuild the prompt from a stored row and compare its sha with the recorded one. A row cut by the 64 KB row clamp, a missing or malformed capture, an unknown capture version, or a sha mismatch is reported as not replay-eligible with a fixed reason.
- **Nothing the verifier does changes.** Prompt text, model, timeout, verdicts and what `routeActionClaim` consumes are unchanged; the prompt is now built once and the same string is sent and hashed.
- **Switch.** `monitoring.completionClaimVerification.recordReplayInput` (dev-gated: on for development agents, off on the fleet, where rows stay byte-identical). Registered in the dev-gated feature list and as a composed ladder entry under completion claim verification.

## What to Tell Your User
Nothing changes in how I check my own "done" claims. On development agents I now keep the exact scrubbed input of each check on this machine, so we can later re-run past checks and prove the re-run saw the same thing.

## Summary of New Capabilities
- Exact replay input for completion-claim decisions, kept machine-local and never served.
- A sha parity check that marks rows that cannot be replayed exactly.

## Evidence
- `tests/unit/claim-replay-input-capture.test.ts`: capture on puts the scrubbed message and evidence under `_contentFull` and the rebuilt prompt's sha equals the recorded sha for both prompt variants; the served `contextRedacted` from a real JudgmentProvenanceLog has no message text while the local row still passes parity; capture off leaves the context byte-identical to the pre-feature context and the prompt unchanged; truncated, missing, malformed, unknown-version and tampered captures are all reported not eligible.
- `tests/integration/claim-replay-input-provenance.test.ts`: a real arbiter call through a real IntelligenceRouter and decision-quality recorder; `GET /judgment-provenance` never returns the captured message or `_contentFull`, and the machine-local row passes parity.
- `tests/e2e/claim-replay-input-lifecycle.test.ts`: on the real AgentServer boot path, `POST /completion-claim/observe` on a development agent writes a row whose capture passes parity; on a fleet agent the same path writes a row with no capture.
