# Side effects: one shared credential detection; the server's and lifeline's logs are masked (SEC-164 part 1a)

In plain words: keys that end up in the agent's own logs are blanked out before they are written. This is the first of four slices of SEC-164 part 1 (spec `docs/specs/credential-scrub-at-rest.md`, converged and approved under the Chief of Staff's option A). The next slices cover new incoming messages, copies sent between machines, and session records.

Tier 2, spec-driven. Size:
- source files: `src/messaging/outbound-credential-guard.ts`, `src/core/durableSecretScrub.ts`, `src/core/outputCredentialScrub.ts` (new), `src/commands/server.ts`, `src/cli.ts`, `src/core/devGatedFeatures.ts`, `dashboard/console/credential-shape.js`
- 1 awareness entry, 1 new unit test file, 4 new parity fixtures

## What changes for running agents
- **One shared detection.** `findWallCredentialSpans` returns each key of the wall's kinds as a start and end position, never the value. Raw and invisible-character-stripped text are both scanned, by code point, so tag characters are stripped exactly as before. `maskCredentials` replaces each span with `[credential removed]` and reports only the kinds.
- **The outbound wall decides exactly as before.** `detectOutboundCredential` keeps its own loop, unchanged, so its decision and the kind it names are the same. A test checks that it detects exactly when the shared finder finds a span, and the browser parity test checks the dashboard copy.
- **The Telegram bot-key pattern** now also matches the `bot<id>:<secret>` form inside a Telegram address, which the wall used to miss. Its trailing word boundary is dropped, so padding after a key cannot hide it. The only new match is digits and a colon followed by thirty or more dashes. `robot<digits>` and `msg_<digits>` are still not matched. The pattern uses no lookbehind, so the dashboard copy still parses on older Safari.
- **The server's and lifeline's own output.** On `server start` (the tmux launch runs the foreground path) and `lifeline start`, standard output and error are line-buffered and masked before they are written. Pending output is kept as bytes and split only at newline bytes. When nothing is masked, the original bytes are written untouched. The underlying write's return value is kept, and the remainder is flushed on exit. The server's own `logs/server.log` stream is masked the same way. Nothing else is wrapped: the MCP stdio server and `--json` commands use standard output as a protocol, and a test pins that only the two start handlers install the wrapper.
- **The switch.** `security.credentialScrub.enabled`, dev-gated: on for the development agent, off elsewhere unless set. It is read live, every 5 seconds at most. When off, output passes through unchanged.

## Known limits (the sweeper in part 1d is the backstop)
- A private-key block spread over several lines is not joined.
- Node's own uncaught-exception print writes to the descriptor directly.
- Child processes that inherit the descriptors are not wrapped.
- A key split across a pause of more than a second is not joined.
- SIGKILL or out-of-memory can lose up to the buffered second of output.
- Partial lines, such as prompts and progress bars, can appear up to a second late.

## Not in this slice
- **Matching the agent's own credentials by exact value** (the bot token, the API token and the tunnel token). `OwnCredentialMatcher` is built and tested but not yet wired. The API token and tunnel token have no wall pattern, so they can still reach the logs as they do today. This slice does not make that worse. Wiring is part of the next slice (1b, incoming messages), which the security session builds next, before slices 1c and 1d.
- Incoming messages, copies between machines and session records come in slices 1b to 1d.

## Source fix
The Telegram calls already log the method name only, never the request address. A unit test pins the direct case: no log statement formats the address inline. The four bot-key-shaped matches found in this machine's logs on 2026-11-21 were version stamps in a notification-preferences log, not keys. That is the false positive the sweeper's dry run exists to catch before anything is masked.

## 6b. Operator-surface quality

The only operator-surface file touched is `dashboard/console/credential-shape.js`, and only its Telegram bot-key pattern changed, to match the server's wall: the form inside a Telegram address is now recognised. Nothing renders differently. No markup, label, layout or action changes, so each criterion is unchanged from today:
1. **Leads with the primary action?** Yes, unchanged. No surface layout is touched.
2. **Zero raw internals as primary content?** Yes. The change only decides which pasted text the console treats as a key; it adds nothing that is shown.
3. **Destructive actions de-emphasized?** Not applicable. No action is added or moved.
4. **Plain language and phone width?** Unchanged. No text or layout is touched, and the parity test keeps the browser and server decisions in step.

## Signal vs authority
It adds no authority, and it blocks nothing. The wall's behaviour is unchanged.

## Rollback
Set the switch off, or revert the commit. No state is written.

## Second-pass review
**Reviewer:** Claude Opus 5.5 (claude-opus-5-5), an independent subagent that read the real code paths and ran probes over two rounds.
- **Round one** found one blocking defect: the rebuilt invisible-character stripping tested one UTF-16 unit at a time, so Unicode tag characters were no longer stripped and the wall missed a key smuggled with them. It also found six should-fix items:
  - the log-file masking ignored the switch
  - the wall could name a different kind
  - the finder was slow on clean text
  - a lookbehind would break the dashboard on older Safari
  - own-credential wiring was missing
  - the wrapper mishandled split characters and encodings

  All were fixed, except own-credential wiring, which is deferred as stated above.
- **Round two** confirmed every fix, including the blocking one, and agreed the slice can ship. It found two byte-handling edge cases: latin1 strings were altered, and a held half-character was lost when the switch turned off. It also found two inaccurate claims in the release note. All four are fixed: the wrapper now works on bytes throughout, and tests cover each case.

## Tests
- `tests/unit/sec164-credential-spans.test.ts` (new, 16 cases):
  - each key form: alone, in a Telegram address, padded, with a zero-width or tag character inside, a private-key block, and a decoded JSON string
  - ordinary text is left alone
  - the wall agrees with the shared finder
  - own-credential matching never keeps values
  - masking is the same every time
  - the switch reader
  - the wrapper: a split key, callbacks, the off switch, split characters, latin1 and non-UTF-8 bytes
  - the wrapper is installed only by the two start handlers
- `tests/unit/console-credential-shape-parity.test.ts`: 4 new fixtures; the server and the browser agree on all of them.
- Unchanged and passing on the M5: `durableSecretScrub`, `outbound-credential-wall-modern-formats`, `tone-gate-advisory-migration`, `app-media-reply-files`, `mobileConversationListPaging`, `pipeErrorGuard`, `devGatedFeatures-wiring`, `lint-dev-agent-dark-gate`, and the awareness-registry tests.

## Follow-up: maturation ladder entry
Local Verify (16:04 PST) failed two cases in `tests/unit/feature-ladders-coverage.test.ts`: the new `security.credentialScrub.enabled` switch had no ladder entry, and the spec's ladder line was a sentence rather than an entry id. Added the `credentialScrub` entry to `src/data/feature-ladders.json` (sensitive, default-on final, dev-agent-live and fleet rungs read featureEvidence fired rows (masks) and error rows (failed checks), inPlace as an alias). Those rows are not emitted yet; a later SEC-164 slice adds them, so the entry is deliberately state needed. Wrong masks are judged by the review script, not by the error rows, and that verdict gates each owner-driven step. The spec's ladder line now names the id alone. No runtime code changed. An independent reviewer (Claude Sonnet subagent) first declined to concur because the plan described evidence rows as already written and named the failed-check measure as a wrong-mask rate; both were corrected. The ladder tests (coverage, MaturationLadder, MaturationLadderService, plan gate, registered features, recovery ladder) pass.
