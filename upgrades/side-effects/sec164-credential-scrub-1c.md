# Side effects: live keys are masked in transcript copies between machines; the app gets the removed-key notice (SEC-164 part 1c)

Spec: `docs/specs/credential-scrub-at-rest.md` §3.1, §3.2, §3.4 and §4.5 (converged, approved under option A). Stacked on part 1b (PR 3627), which is stacked on part 1a (PR 3621).

## What changes for running agents

All of this sits behind `security.credentialScrub.enabled` (dev-gated). The copy scrub also follows `security.credentialScrub.inPlace`, read live by the new `credentialScrubModeReader`: off when `enabled` is off, a count-only dry run while `inPlace` is not true, and masking once it is `true`.

- **`src/core/credentialLineMask.ts` (new): the same-length JSON line mask.** It is shared with the slice 1d sweeper.
  - A small byte tokenizer finds every string literal and its raw byte range. A literal that `JSON.parse` would hide behind a later duplicate key is still scanned.
  - Each value literal is decoded with a map from each decoded character back to its raw byte, then scanned with the shared detection.
  - Each match is overwritten in place with `[credential removed]` padded with spaces, or with `*` per byte when it is shorter than 20 bytes. An escape inside the span becomes plain characters, and no backslash or quote is written.
  - Key names are never changed. Signed thinking text, encrypted reasoning, redacted thinking data and media base64 with a known image signature are never changed; a match there counts as unmeasured.
  - The masked line must re-parse with the same structure. Otherwise nothing changes, and the line counts as unscannable.
- **Copy source** (`TranscriptCheckpointSource.tick`): each row goes through the mask before the existing token-and-PIN redaction, and so before the chunk's offsets and hash are computed.
- **Copy receipt** (`TranscriptCopyStore.assemble`): after the chunk's length, hash and start offset check out, the same-length mask runs before the copy is written. The body's length never changes, so the manifest offsets hold. This cleans copies from an older build that did not mask at its source.
- **Evidence:** the copy scrub records `credentialScrub` evidence by side and mode, at most once per ten minutes per side and mode, with the counts it stands for. Applied masks are `fired`, dry-run counts are `held`. Only kinds and counts are recorded, never a value.
- **Carried from 1b: the app conversation notice and session note.** `createRoutes` sets `ctx.appCredentialNotice`, which posts the fixed notice with a fresh Secret Drop link as a server-written agent message. Its event id derives from the message id, so a replay appends nothing. The app conversation route calls it for the owner, a team member or an owner device from before people existed, and passes a one-line `sessionNote` through `dispatchStoredAppMessage`. The note goes to the session only and is never stored.
- **Carried from 1b: the agent's own keys.** Incoming masking now also uses an `OwnCredentialMatcher` built from the API token, the Telegram bot token, the Slack bot and app tokens and the tunnel token. It keeps only a keyed hash and a short prefix, and is rebuilt at most once a minute.

## Closed open item

- **Slack lifeline kinds:** `SlackLifeline` is never started, and `/internal/slack-forward` refuses every request (slack-outbound-robustness §2.7). So no queued Slack message is replayed through it today. Its queue is still masked (part 1b). The kinds field belongs with Phase 2.2, which makes that route deliver.

## Known limits

- A literal over 1 MB is scanned whole, not in pieces. A transcript row is bounded by one checkpoint (larger rows are withheld with a marker), so this does not arise for copies. The sweeper in 1d adds the piece-wise scan its files need.
- A source row that does not parse as JSON is counted unscannable and left to the existing redaction, which rewrites it as text.
- Integrity-bound matches are counted as unmeasured. They are not yet raised to the security session's work queue; the sweeper's status route (1d) reports them.

## Signal vs authority

The mask changes only a key's bytes inside a copy, never refuses or delays a copy, and every failure keeps the row or chunk unchanged (the sweeper is the backstop). The notice is information only.

## Rollback

Set `security.credentialScrub.inPlace` off (back to counting) or `enabled` off (no scrub at all); both are read live.

## Class-Closure Declaration

- **unbounded-self-action: n/a.** The app notice is one fixed message per incoming message, keyed by message id and never retried. The copy scrub runs inside the existing copy pass and adds no trigger of its own.

## Second-pass review

**Reviewer:** Claude Sonnet (independent subagent), which read the full diff and the real code paths.
- **Round one: CONCUR, no blocking defect for this slice.** It confirmed several things. Source offsets and the hash are computed after the mask. The receipt masks only after the length, hash and offset check, and falls back to the original on any length change. Every failure keeps the row or chunk. A stranger or a replay cannot trigger the app notice, and the session note is never stored.
- It asked for one fix before merge, because the sweeper in 1d reuses the module: guard `protectedValues` against a pathologically deep line. That is done, with a test.
- Two cheap notes are also done: the signature string itself is now protected, and the own-key matcher also uses the live API token, since the config may hold only a placeholder after pairing.
- Its other notes are accepted as stated. A key split across a field name and its value cannot be found, by design. Invalid UTF-8 can only cause a missed span, never a broken line. Blank or partial lines inflate the unscannable count. Each pasted key mints one Secret Drop token, bounded by the per-device rate limit.

## Tests

- `tests/unit/sec164-line-mask.test.ts` (new, 16 cases), listed in the release note, plus a pathologically deep line that must not throw.
- `tests/integration/mobile-native-signed-records.test.ts` now checks the notice and the session note. It was not run on this machine (M5 rule); Local Verify is its first run.
- Unchanged and passing: transcriptCheckpoints, transcriptCopies-awareness-migration, app-conversation-service, app-conversation-identity, app-conversations-pool, mobileConversationListPaging, sec164-inbound-mask, sec164-credential-spans.
