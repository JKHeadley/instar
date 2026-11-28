# Side-effects review: tone gate replay input

**Slug:** `tone-gate-replay-input`
**Tier:** 1 (dev-gated observability; a revert fully undoes it). About 9 files, roughly 400 lines including tests. One build pass. The commit happens on a Studio turn because of the M5 disk hold.
**Authority for defaulting on for development agents:** the Chief of Staff's decision of 2026-11-27 12:21 PT, on four conditions, each met below. The owner's words, quoted exactly (Telegram topic 29723, message 35966, 2026-07-26 18:32 UTC; the origin of docs/specs/decision-replayability-standard.md): "I've noticed the pattern here where we tend to not record data for the sake of "privacy". However, this is against the EXO 3.0 fundamentals which requires everything to be fully auditable.  This is not a privacy issue. It's a safety and coherence issue and all the data needs to be recoverable so that the situation could be fully replayed and reevaluated." The precedent it mirrors is the stop-check replay capture (PR 3944, CMT-2204).
**Driven by:** benchmark Milestone 1 (topic 33368, due 2026-12-05): real tone-gate decisions captured in full, replayed exactly, and bulk-judged by a Claude and a GPT judge. It is the twin of the stop-gate replay input (PR 3944, CMT-2204).

## What changes

- `src/core/MessagingToneGate.ts`: `buildPrompt` becomes `buildPromptParts`, which returns the same `ToneGatePromptParts` it used to pass to `renderToneGatePrompt`. `review()` renders the prompt from those parts, so the prompt bytes are unchanged. When `toneGate.replayInput.enabled` resolves true, `buildToneDecisionContext` adds content-free replay identity (`promptSha256`, `replayPromptSha256`, `scrubChanged`, `scrubVersion`, `captureVersion: tone-replay-input-v1`) and puts the parts, credential-scrubbed by `scrubForStore` through `scrubToneGatePromptPartText`, under `_contentFull.replayParts`, next to the existing opt-in `candidateBody`. New pure exports: `TONE_REPLAY_CAPTURE_VERSION`, `TONE_REPLAY_SCRUB_VERSION`, `scrubToneGatePromptParts`, `buildToneGateReplayCapture`, `assessToneGateReplayEligibility`. `resolveToneGateOperatorConfig` resolves `replayInput.enabled` through `resolveDevAgentGate`, the same way as `advisoryMigration`.
- `src/core/types.ts`: the `toneGate.replayInput` config type.
- `src/core/devGatedFeatures.ts`: the `toneGateReplayInput` entry.
- `src/data/feature-ladders.json`: `toneGate.replayInput`, composed into `toneGate.advisoryMigration` (same authority).
- `src/data/awareness/tone-gate-replay-input.md`: a three-line feature note, kept short for the CLAUDE.md core headroom.
- Tests: `tests/unit/tone-gate-replay-input-capture.test.ts` (new) and `tests/unit/tone-gate-operator-config.test.ts` (exact-shape assertions gain `replayInput`, plus dev-gate cases).
- `src/commands/server.ts` is unchanged: its live getter already routes the whole `toneGate` block through `resolveToneGateOperatorConfig`.

## 1. Over-block

No issue identified. Nothing here blocks or allows anything. The capture runs after the prompt is built and only adds fields to the provenance context.

## 2. Under-block

Not a blocking change. On coverage: a capture over 40,000 bytes as stored (`TONE_REPLAY_MAX_CAPTURE_BYTES`, measured as the UTF-8 bytes of the serialized parts, so escaping and multi-byte text count; mostly a very long candidate or a large B26 waiting-ask section) is skipped and labelled `capture-oversize`. It keeps only the prompt sha, so the row stays under the provenance log's 64 KB clamp (the rest of a tone row is at most about 19 KB) and keeps its other fields. A row clamped for any other reason is reported `row-truncated`. Either way it counts as not replayable rather than being replayed wrongly. Recent messages are bounded already (last 6, each capped at `TONE_CONTEXT_MESSAGE_CHARS`). The verdict is still read from `rawResponseHead`; the row's `decision` field stays as the settlement seam writes it.

## 3. Level-of-abstraction fit

Right layer. The gate is the only place the exact parts exist, and the provenance seam already carries a machine-local field for content. The pure renderer `renderToneGatePrompt` was extracted earlier so the template could be hashed. Reusing it for the rebuild means the replay and the live call share one renderer, so they cannot drift apart.

## 4. Signal vs authority compliance

Compliant (docs/signal-vs-authority.md). The change produces data for later grading and holds no authority. The tone gate remains the single outbound authority, and its prompt, model, parsing and verdict are unchanged. Tests assert the verdict and the prompt (boundaries aside) are identical with the switch on and off.

## 5. Interactions

- `recordCandidateBody`: both write under `_contentFull`, as the sibling fields `candidateBody` and `replayParts`. A test covers both on at once. The replay capture stores the full candidate text inside its parts even when `recordCandidateBody` is explicitly `false`: on a development agent with `replayInput` on, body capture is no longer opt-in through that setting alone. It stays machine-local and is stripped from every served or merged read.
- The settlement seam and census: the tone gate stays `budget:500` and `content-bearing`. The content goes only to the machine-local `contextFull`, which `readRedacted` strips. The census text says "identity only" about the served row, which stays true. It is the same posture the stop gate took in PR 3944 without a census edit.
- `readDeferralPatternObservations` reads `candidate.sha256` and `deferralShapeDetected` from `contextFull`. A row over 64 KB would lose both to the clamp, which is why an oversize capture is skipped (above) instead of stored. The static B17 sub-clause text (about 8 KB) sits in `agentReachSection` on every row, which is counted toward that bound.
- Jev signal live and shadow: the gate-signal section is captured as rendered, whichever source produced it.
- Capture failure returns `{ captureVersion: 'capture-failed' }`, which never touches the verdict path, and eligibility reports it as `unknown-capture-version`.
- Tests assert the verdict, and the prompt with every random boundary stripped, are identical with the switch on and off.

## 6. External surfaces

`GET /judgment-provenance` gains the content-free identity fields on tone-gate rows on development agents; the captured text is never served (the redacted-read test checks it). There are no new routes, messages, settings pages or egress. Disk: on development agents, each tone-gate row grows by the size of its prompt's dynamic parts. That is bounded by the 64 KB row clamp, the 500-row-a-day budget and the 14-day retention, at most about 32 MB a day and in practice much less. Prompt shas carry several random per-call boundaries, so they cannot be reversed by guessing. The served `scrubChanged: true` reveals only that some prompt part held a credential shape, the same kind of fact the existing `bodyRedactionKinds` already serves. The sha check is an integrity check, not authentication: it catches a stored part edited without its sha, in a machine-local file.

## 7. Multi-machine posture

Machine-local BY DESIGN: the capture lives in `contextFull`, which is excluded from the cross-machine allowlist. Each machine replays its own rows. The content-free identity fields travel with the redacted row as the other context fields do. No notices, so no one-voice gating is needed.

## Scrub before storage

Every stored part goes through `scrubForStore`, the durable scrubber the tone gate's candidate-body capture uses. Encoded strings are decoded first: each JSON string literal in a part is decoded, scrubbed as raw text and re-encoded, and then the whole part is scrubbed. JSON encoding turns a quote into \" and a newline into \n, which hides a labelled key or a multi-line private key from the patterns. Tests cover both: a labelled key inside JSON in the candidate, and a multi-line private key in a recent message. Decoding goes one level deep. A secret inside JSON that the message itself carries already escaped (for example a pasted log line) stays as hidden as it is in the existing candidate-body capture. A part the scrubber withholds wholesale (its oversize or error marker) makes the row `part-withheld`, so it is never replayed as if it were the message.

## Retention and size (stated numbers)

- **Size cap:** each capture is at most 40,000 bytes as stored. A larger one is not stored and is labelled `capture-oversize`. The whole provenance row is capped at 64 KB, and the tone gate keeps at most 500 rows a day (census `budget:500`).
- **Age limit:** rows are deleted after 14 days, which is the provenance log's `retentionDays` default. The log unlinks day files older than that.
- **Never served:** the parts sit only in the machine-local `contextFull`. `readRedacted` strips it, `GET /judgment-provenance` never returns it, and it is outside the cross-machine allowlist.
- **Development agents only:** the switch resolves through `resolveDevAgentGate`. On any other agent it is off unless explicitly set, and the ladder entry keeps fleet rollout on the maturation path.

## 8. Rollback cost

Set `toneGate.replayInput.enabled: false`; it is read live, so no restart is needed. Or revert the commit. Rows already written age out under the 14-day retention. No migration and no state repair.

## Second-pass review

Required: the change touches the outbound messaging gate. The reviewer's response is appended below.

**Reviewer:** an independent Claude Opus 5.5 reviewer sub-agent with a fresh context that did not write the change, reading the whole PR diff (1d2c1ea885..bfe5479f6) on the exact head on 2026-11-28 00:28 PT. **Concur with the review.** No blocking finding: the live prompt and verdict are unchanged, a failed capture cannot block a send, the captured text never reaches a served, logged or merged read, the size bound counts stored bytes, and the merge of main touched none of the gate's files. Minor points taken in this artifact: the `recordCandidateBody` interaction (section 5), the old test's failure mode (below), and the counter's `captured` figure (below). Minor points left as stated: a credential cut by the 320-character recent-message bound can leave a fragment under the scrubber's minimum length in the local copy (the prompt as sent, not new exposure), and an adversarial row can still hit the 64 KB clamp, which is refused as `row-truncated`.

Earlier passes, in order:

**Reviewer (independent second pass, 2026-11-27):** Concern raised, now addressed. (1) BLOCKING: the prompt-equality test's boundary regex missed `CTX_BOUNDARY_`. Fixed: it now matches any `*_BOUNDARY_` or `ASK_LINKS_` token. (2) A long candidate or a B26 section could push a row over the 64 KB clamp and drop the identity fields the deferral sentinel reads. Fixed: a capture over 40,000 stored bytes is skipped as `capture-oversize`. Tests cover it, including multi-byte text and a heavily escaped capture whose escaping is counted. (3) Artifact wording corrected: the recent-message bound, the deferral-reader interaction, `scrubChanged` being served, and the sha being an integrity check, not authentication. Verified by the reviewer with no issue: the live prompt and verdict are unchanged, the 11 parts fully determine the prompt, no captured text reaches a served or cross-machine surface, the nesting is consistent, the test API use and scrub pattern are right, and the existing resolver, dev-gate, ladder and enrollment tests are unaffected. Re-check of those fixes: Concern raised. The first bound counted characters, while the clamp counts UTF-8 bytes after escaping. Fixed: the bound is now in stored bytes (`TONE_REPLAY_MAX_CAPTURE_BYTES`), with the multi-byte and near-bound tests above. The count script now refuses a bad `--days` and states that `captured` is a lower bound. Final re-check: **Concur with the review.** The byte bound measures exactly what the row stores, and the new tests' arithmetic holds. Still open: the CLAUDE.md core headroom check needs a run on the Studio.

**Chief of Staff's reviewer (2026-11-27, on the staged patch): DISSENT on the scrub, now addressed.** The parts were scrubbed after JSON encoding, so a labelled key inside a JSON config snippet and a multi-line private key were missed once encoded (caught raw, missed encoded). Fixed: `scrubToneGatePromptPartText` decodes each JSON string literal, scrubs it raw and re-encodes it, then scrubs the whole part. A test feeds exactly those two inputs and asserts neither value reaches the stored context. A second test shows a clean encoded part is unchanged byte for byte. A standalone probe with the same patterns confirmed raw-caught, encoded-missed, and caught after the fix.

**Second pass on the scrub fix (2026-11-27 12:35 PT): Concur.** The literal pairing holds for every place data enters a part, the two inputs match raw and miss encoded, the tests pass as written, nothing is stored raw, and the sha logic holds. Both NITs were taken: the one-level decoding is now stated, and a wholesale-withheld part is refused as `part-withheld`, with a test. The `part-withheld` refusal was added after this concur.

**Follow-up after merging main (2026-11-27 18:40 PT).** Two changes, neither touching runtime behaviour. (1) The prompt-equality test read a field the capture never sets, so `strip(undefined)` threw and the test failed (the earlier "tests pass as written" was not based on a run of that file); it now asserts both captured prompts are strings and compares them, boundaries aside. (2) The replay counter's header now names its governing standard, which the backreference lint merged in #4024 requires of any file named like a gate. Over-block, under-block, interactions and rollback: no change from the review above.

The counter's `captured` figure also counts `capture-oversize` and `capture-failed` rows, which hold no parts, and a retried review writes a second row: `captured` is therefore not a lower bound on replayable rows, and `rows` and `verdicts` count attempts, not reviews. The replay step filters on `captureVersion` itself, so these counts are for sizing only.
