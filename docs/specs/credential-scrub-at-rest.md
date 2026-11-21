---
title: "Live credentials are redacted where the agent keeps text, part 1 of 2: transcripts, logs, copies between machines and every new incoming message (SEC-164)"
slug: "credential-scrub-at-rest"
author: "echo"
date: 2026-11-21
tier: 2
parent-principle: "Structure beats Willpower"
parent-principle-fit: "Today a key that lands in a transcript, a log or a message is handled by willpower: an agent notices it and a person is told to deal with it, again and again. This spec replaces that with structure: one shared detection, applied at the first point the agent writes text and swept where other programs write it, so a key stops resting there and nobody has to be told."
binding-standards:
  - "What Persists Must Be Clean (docs/specs/durable-output-hygiene-standard.md): one shared detection module, never a second pattern list"
  - "Security Fixes Keep the Experience Whole: masking changes only a key's characters; every record stays readable and parseable; a team member whose key was removed gets a one-tap way to send it safely; a masked message keeps its author and its verified origin"
  - "Verify the State, Not Its Symbol: every sweep records what it checked; an unreadable or unscannable file is reported as unmeasured, never as clean"
eli16-overview: credential-scrub-at-rest.eli16.md
approved: true
approved-by: "the Chief of Staff, message 3d4ab7c7-2cb1-4972-8173-3ff49c49731e (2026-11-21): option A, build part 1 now; not a constitution or protected-list change"
review-convergence: "2026-11-21T19:28:55.340Z"
review-iterations: 6
review-completed-at: "2026-11-21T19:28:55.340Z"
review-report: "docs/specs/reports/credential-scrub-at-rest-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 2
contested-then-cleared: 11
---

# Spec: live credentials are redacted where the agent keeps text (SEC-164, part 1 of 2)

Requested by Justin on 2026-11-21 and relayed by the Chief of Staff (message 43c02af4): "bot keys: this happens way too frequently. I would rather have a robust way to scrub them from the logs so you don't have to keep telling me." From that request:
- cover the session transcripts that sync between machines, the server logs and the Claude Code project transcripts
- use the outbound credential wall's detection
- scrub the existing copies
- never ask anyone to rotate a key

The Chief of Staff's decisions that shape it:
- **d2060363:** the message history is in scope, with every copy. The Telegram servers are out of reach.
- **3d4ab7c7 (option A):** saving a key into the vault is taken out of part 1 and gets its own design (CMT-030, after part 2). In part 1 every key is masked, and a team member is told plainly, with a one-tap Secret Drop link.
- **19aa907f:** the work is split into two parts. A masked message must keep its author and its verified origin. Strangers' keys are masked, not kept.

**Part 1, this spec:** Claude Code and Codex transcripts, the agent's logs, transcript copies between machines, and every new incoming message, masked before anything stores it. The existing copies of all of these are cleaned too.

**Part 2:** the message history that already exists, and copies part 1 cannot change. That is:
- the app conversation store's signed records
- topic memory, with its sources in order
- the agent-to-agent message store's signed envelopes, and masking received ones with a receipt attestation
- the conversation embeddings
- the authorship hashes of old messages
- the coherence journal's checkpoint entries, and the replicated streams that carry message text

It is tracked as CMT-029, due 2026-11-26, with its own design. Until part 2 lands, keys already sitting in the message history stay there. New messages are clean from part 1 on.

Build order: after SEC-151 (PR 3613), whose operator-only table this spec adds a row to (§8).

## 1. Problem statement

A key reaches durable text the agent keeps in these ways:
1. **Tool output in a session.** Claude Code writes every tool result into the session's transcript, under `<config home>/projects/<project>/`. That covers `<session>.jsonl`, `<session>/subagents/*.jsonl` and `<session>/tool-results/*`. Codex writes its own files under `~/.codex*/sessions`. The agent does not write these files.
2. **The agent's own output and logs.**
   - Under the lifeline, the server's standard error is copied by `tee -a` into `.instar/logs/server-stderr.log` (`ServerSupervisor.ts`).
   - A directly installed server writes `.instar/logs/server-launchd.log` and `.err`, and the lifeline writes `lifeline-launchd.log` and `.err`.
   - Other logs live in the project `logs/` folder, in `.instar/logs/` and in `.instar/hook-events/`.
   - Telegram client errors print the API address, `bot<id>:<secret>`, which the current pattern misses.
3. **A message someone sends.** A pasted key flows into the lifeline queue, the Telegram log, topic memory, the input ledger and onward.
4. **Copies between machines.** Transcript copies (`state/transcript-checkpoints/`) carry session rows to other machines.

On the M5 Pro on 2026-11-21, a count of kinds only, never values, matched a wall pattern in 6 of 236 files. Review found most of the transcript matches to be placeholder- or test-shaped, which is why masking starts with a reviewed dry run.

## 2. What is detected

There is one shared function in `durableSecretScrub.ts`: `findWallCredentialSpans(text, options)`. It returns `{kind, start, end}` spans:
- **Kinds.** Only `HARD_WALL_CREDENTIAL_KINDS`, the outbound wall's provider-prefixed kinds. The label-proximity kinds (`labeled-secret`, `bearer-token`, `jwt`) stay excluded, for the wall's documented reasons.
- **Invisible characters.** The same stripping of invisible interleave characters the wall uses, with an index map, so a key with zero-width characters inside it yields its full original span.
- **The agent's own credentials, by exact value.** This is opt-in per caller, and never used by the outbound wall. It covers only an explicit list of credential paths: the bot token, the API token and the tunnel token. Chat ids, machine ids and every other value in the secret store are never matched. The matcher holds a short prefix, the length, and a keyed hash of each value, not the value itself. A prefix match is confirmed by hashing exactly that length. A test asserts that the Telegram chat id and a machine id are never matched.

One fix to the shared patterns: the Telegram bot token pattern becomes `(?<![A-Za-z0-9])(?:bot)?\d{6,12}:[A-Za-z0-9_-]{30,}`, so the `bot<id>:<secret>` form inside an API address matches. Tests pin the address form, the bare form, and that `robot<digits>` does not match. The outbound wall gets this pattern fix and nothing else. Whether the secret part has an uppercase letter, or is all hexadecimal, is recorded as a review flag only, never as an exclusion: no provider guarantee says a real token must have either property, and the outbound wall must not narrow. The common `<process id or time>:<hash>` shape in logs is lowercase hex, so the flag lets the dry-run review see that false positive and narrow it later on evidence. The secret part stays unbounded at the end, as it was, so a key followed by extra key-like characters is still found and masked whole; a bound there would let padding hide a key from the outbound wall, and a test pins that a bot token followed by 40 more key characters is still found by the wall and the sweeper. The accepted false positive is an identifier of the form `<digits>:<30 or more characters>` that is not a bot key, and the dry run measures it.

The sweeper, the wrapper, the copy scrub and the inbound mask all call this one function. A test asserts each does.

At the source, the Telegram client's own error path stops printing its request address. The lifeline's and the server's Telegram calls log the method name only (`routes.ts`, `TelegramLifeline.ts`), so the most common source stops producing these log lines at all.

## 3. What text is scanned, and how it is changed

### 3.1 The scanning unit

The sweeper scans complete lines. A partial last line is held back until it ends. A file whose modification time has not changed for 60 seconds counts as finished, so its final line without a newline is then scanned too. That pending tail is scheduled by its own deadline, not by the file changing. Its checked-through mark stays at the start of the line, so if the writer later adds to it, the whole line is scanned again. `GET /credential-scrub` reports bytes still pending and the age of the oldest unchecked data. That age, not the 15-second interval, is the real measure of how long a key can rest unmasked.

- **JSON lines** (`*.jsonl`) are read with a streaming tokenizer. It yields every string literal with its raw byte offsets, including a literal that `JSON.parse` would hide behind a later duplicate key.
  - Each literal is decoded and scanned on its own, and matches are mapped back to its raw bytes. A match never crosses a literal or the JSON structure, so no key name is ever changed.
  - Integrity-bound fields are not changed: a thinking block's text when it carries a `signature`, and encrypted reasoning content. A match there is reported as unmeasured, and raised once to the security session's work queue. Changing it could make the provider reject the block when the session resumes.
  - A strict-base64 string inside an image or document block whose decoded first bytes match a known media signature is skipped, so image data cannot be masked by mistake. It is still checked for the agent's own credentials.
  - A long line needs no ceiling. The tokenizer streams it and holds one literal at a time. A literal longer than 1 MB is scanned in 1 MB pieces with a 16 KB overlap, so memory stays bounded whatever the line's size.
- **Plain-text files** (`*.log`, `*.err`, `*.txt`, `tool-results/*`) are scanned as text, in 1 MB pieces with a 16 KB overlap. A PEM block spread over lines is detected across them, from its BEGIN line to its END line within 200 lines. Its body characters are masked and its line endings are kept. While a BEGIN line has no END yet, the checked-through mark stays at the BEGIN line, so a block finished by a later append is still masked whole after a restart. A block past 200 lines is reported as unmeasured. Several patterns have no upper length, so a match that touches the end of a piece is carried into the next piece and masked whole, up to the 1 MB piece size. A key longer than that would be cut, but none exists.

### 3.2 The same-length mask

Every change is made in place, at the same length, inside the bytes of the match:
- **A span of 20 bytes or more** gets `[credential removed]`, padded with spaces to the span's length.
- **Every inbound and sweeper mask uses the same marker,** `[credential removed]`: in full where the agent writes the text, padded or cut to the match's length in place.
- **A shorter span** has every byte replaced by `*`, so even a value made only of punctuation is fully overwritten.

The markers differ from the sibling standard's `[REDACTED:<kind>]` on purpose: the Chief of Staff chose them (d2060363 and c4d7fe66), a name that reveals no kind follows their condition, and the same-length form has to fit inside the bytes of the match.

Inside a JSON literal the mask never writes a backslash or a quote, and an escape sequence inside the span is replaced with plain characters. The tokenizer then re-reads the line. The line must have the same structure and the same keys, with only that literal changed; otherwise nothing is written, and the line is reported as unscannable.

The file keeps its size, and readers' byte offsets stay valid. The token ledger re-reads a file whose first 256 bytes changed. That is harmless, because its rows are deduplicated, and a test pins it.

### 3.3 A safe write

The sweeper writes with positioned writes on one open file handle. It checks that the inode and the matched bytes are unchanged both before and after each write, and that the file has not shrunk. It does not require the size to be unchanged, because appends past the match are safe and would otherwise stall the busiest files. A file that changed in between is left for the next pass.

**Crash safety.** Before each write, the sweeper records a write intent in its state: file identity, offset, length and the replacement bytes. The intent never holds the original value. After a restart, pending intents are re-applied, still checking that the bytes at the offset are either the original match shape or already the replacement, before any progress mark advances. So an interrupted write can never leave half a key behind that a later scan no longer recognises. A test interrupts a write midway, including inside a JSON escape. Writes go through `SafeFsExecutor`'s audited funnel; a new same-length positioned-write operation is added to it.

The listed writers only append, or rotate by writing a temporary file and renaming it over the old one:
- Claude Code, Codex, the JSONL logs and the tee'd error log append.
- `HookEventReceiver.trimSessionEvents` rewrites in place, and is changed to write a temporary file and rename it. `ServerSupervisor`'s trim of the error log stays as it is, an in-place truncate. That is deliberate: `tee -a` holds the file open with append mode, so after a truncate its next line lands at the new end of the same file, while a rename would leave `tee` writing to the old, unlisted file. The sweeper sees the shrink and checks the file again from the start. `MessageLogger` rotation already writes a temporary file and renames it.
  - A sweeper that sees a file's inode change re-checks the new file from the start.
  - `HookEventReceiver.receive` also runs the inbound mask at write time.

### 3.4 What the agent writes itself

- **The server's and the lifeline's standard output and error.** A wrapper is installed only in the `server start` and `lifeline start` command handlers, never by an import. The MCP stdio server and `--json` commands stay unwrapped, and a test pins that. The wrapper:
  - buffers by line, so a key split across two writes is caught. It flushes at a newline, at 64 KB, or after one second, and writes any remainder synchronously on exit and in the existing crash handlers, so the last line of a crash is never lost
  - handles Buffer chunks, encodings and callbacks
  - passes text straight through when `enabled` is off

  Known bypasses: a multi-line PEM block, which spans lines; Node's own fatal print before the handlers exist, the boot wrapper's first lines, child processes that inherit the output, and the tmux pane's scrollback, which lives in memory and is never saved by the agent. The sweeper is the backstop for anything that reaches a file.
- **Transcript copies.** On the source, the wall-kind mask runs inside `redactRow` in `transcriptCheckpoints.ts`, before the chunk's offsets and hash are computed. It skips the same integrity-bound fields and media data as the sweeper (§3.1), and reports them as unmeasured. On receipt, after `assemble` has checked a chunk's length, hash and start offset, the same-length mask is applied before the copy is written to `copy.jsonl`. The chunk files are deleted after assembly. Chunks waiting behind a gap are base64, so the sweeper decodes them to measure them and reports them as unmeasured until they are assembled.

### 3.5 Every new incoming message, masked before anything stores it

A key in an incoming message is masked before the first side effect that keeps the text: a queue, a log, a receipt, a ledger row, an authorship hash or a session's input. Every later copy then holds only the masked text.

There is one function, `maskInbound(text, sender)`. Each way in calls it at the point named here. Four checks enforce the list:
- the table's entry functions are listed in the test
- a source check that in each of them `maskInbound` comes before the first known sink: `appendToLog`, `logger.append`, `logInboundMessage`, `enqueue`, `decideIngress` and the trust-account receipt
- every class implementing `MessagingAdapter`, plus both lifelines, must appear in the list
- a canary test for each way in drives a test key through the real path, then searches the whole temporary state folder for it, which catches a store nobody listed

| Way in | Where `maskInbound` runs |
|---|---|
| Telegram, the lifeline polling | The lifeline does not mask. It forwards the raw text to the server in memory, as today (`TelegramLifeline.ts`, the forward path), and the server masks first thing (next row). For a forward that fails, see the lifeline rule below. |
| Telegram, the server's forward handler | Right after the text is read (`routes.ts`, `text = fwdMedia.text`), before the trust-account ingest, `logInboundMessage` (which feeds the authorship classifier, the topic rows and the tail cache) and the ledger claim. |
| Telegram, the server polling itself (no lifeline poll owner) | `TelegramAdapter.processUpdateDelivered`, before the trust-account receipt and `handleUnknownUser`. |
| Telegram captions (photos and documents) | The same points, applied to the caption text. |
| Slack | `SlackAdapter._handleMessage`, before the trust-account receipt, the ring buffer and the log. History-recovery replays go through the same function. |
| The app, at ingress | The app's ingress callers (`mobileConversationRoutes`, `mobileSlackRoutes`, `mobilePairingRoutes` and `scrubServerTranscript`) call `maskInbound(text, <the paired device's person>)` explicitly, after the device signature is checked and before `removeAuthorityTokens`. They feed the found kinds into `removedKinds`, so a signed record gets its redaction attestation. On a machine with no identity signer, the record reads `unknown`, as it does today for any removal. |
| The app, read and file-name paths | `removeAuthorityTokens` also masks the wall's kinds, so the read path (`AppConversationService.transcriptForDelivery`) and file names (`mobileMediaSend`) never show a key. These paths only mask; they never save, because no message is arriving there. |
| WhatsApp, iMessage | Their adapters' inbound handlers, before the inbound `logger.append` (WhatsApp has three append sites; the inbound ones are named at build). |
| Agent-to-agent, outbound | The Threadline send path that sees the plaintext, before it is encrypted, signed and written to the local thread log. The build names the exact function, and the inventory test enforces it. The local message router (`src/messaging/MessageRouter.ts`, between the agent's own sessions) masks in `send` before it saves. A queued envelope is never rewritten. |
| Voice transcripts, edited messages | Each goes through the same point as its channel's text: a transcript before it is logged, an edit as a new message. |
| Agent-to-agent, inbound | Out of reach in part 1. A received envelope carries its sender's signature over the text and travels on with it, so it cannot be changed. Masking it on receipt with an attestation is part 2. |

**The lifeline rule when the server cannot take a message.** The operator's channel fails toward delivery.
- When the lifeline's forward fails, it runs `maskInbound` itself before queueing, so it queues the masked text, exactly the text the server would have written.
- The raw text never reaches the queue or the dropped-messages file.
- The queued entry carries a flag that a key was removed, and its kinds, never the value. So when the server delivers it, the server can send the team-member notice (§4.5).
- It reads `security.credentialScrub` fresh for each queued message, because it loads its settings only once at start.
- The message is delivered when the server returns.
- The Slack lifeline queue follows the same rule.

**The author stays attached.** The classifier hashes the logged text (`AspInboundClassifier.ts`), which is now the masked text, so the hash covers exactly what is stored, and `AspAuthorshipJoin` resolves the message as before. A test sends an owner message with a key and asserts that it still resolves to the owner's classification, and that the ledger snapshot, the log and the hash all see the same text. The join's key is the channel and message id; the text hash only checks integrity. So two different senders whose messages both mask to `[credential removed]` keep their separate authors, and a test asserts this for two senders across a replay.

**App messages keep their verified origin.** The device signature is checked first. Then `removeAuthorityTokens` masks, and `buildSignedOrigin` signs a redaction attestation over the stored text instead of keeping the raw body. A test sends a signed app message with a key and asserts that the stored text is masked, the record verifies through its attestation, and the raw body is not kept.

**If `maskInbound` itself fails.** It falls back to `findWallCredentialSpans` in patterns-only mode, with no identity, vault or team-file access, because those are what can fail. That mode still returns spans, so it can still mask. If that also fails, the message is delivered unchanged, because the operator's channel fails toward delivery and a check that cannot run must never block it. The failure is reported once through the degradation report and counted. The sweeper later masks any copy that reaches a listed log, and part 2 covers the message history. Here the operator-channel standard deliberately outranks the sibling standard's fail-safe-toward-redaction rule, and the spec records why. A test drives both failures and asserts the message is delivered.

**Replay gives identical text.** Every key masks to the same `[credential removed]`, whoever sent it and on whichever machine, so a replayed or re-forwarded message masks to the same text, and the SEC-106 check (`row.inputSnapshot === text`) still holds. A ledger row written by a server from before the upgrade holds unmasked text, so its one re-forward after the upgrade loses the carried sender label once; and a later narrowing of a pattern can change the text of a message replayed across it, which is stated as a recurring but rare cost.

The earlier decision for the app's operator chat (mobile-native-conversations §4.2 and §4.9), which left credential-shaped text as the operator's choice and only flagged it, is superseded for storage by the Chief of Staff's decision (d2060363): the key is masked.

## 4. Where it reaches, and what it keeps

### 4.1 The fixed list for the sweeper

The sweeper works only inside this list. Symbolic links are never followed (`lstat`, `O_NOFOLLOW` where available). A file with more than one hard link is skipped and recorded. Every resolved path must stay inside its entry, and its device and inode are checked at run time against the never-touch set (§5).

- **Claude Code transcripts.** In each config home, only this agent's project folders. Each must match exactly the encoded name of the agent's project folder, or that name followed by `--worktrees-`, and be confirmed by the `cwd` recorded in its first lines. Inside them: `*.jsonl`, `*/subagents/*.jsonl` and `*/tool-results/*`. The `memory` link is never entered.
- **Codex transcripts.** In each Codex home `FrameworkSessionStore` lists, only session files whose recorded working directory is inside this agent's project folder.
- **Logs:**
  - `.instar/logs/*.log`, `*.err` and `*.jsonl`
  - the project `logs/*.log` and `*.jsonl`
  - `.instar/hook-events/*.jsonl`
  - `.instar/*.install.log`
  - Local Verify run logs, `state/local-verify/**/*.log`
- **Transcript copies:** `state/transcript-checkpoints/copies/*/*/copy.jsonl`.

### 4.2 Out of reach, said plainly

- **Messages on Telegram's, Slack's or the app relay's own servers.** A key someone sent stays in that chat on the platform's side until they delete the message there.
- **The existing message history.** That is part 2 (CMT-029).
- **Apple's own message database** (`~/Library/Messages`), which the iMessage adapter reads. That source copy is out of reach, like Telegram's servers.
- **The version-skew window.** Until the lifeline restarts onto the new build, which happens after the server, a failed forward still queues raw text, and the server masks it only on replay. The Slack lifeline has the same window. `GET /credential-scrub` reports each lifeline's version, so the window is visible. The shadow install's `secret-set` command also runs without the new lock until its own copy updates.
- **The coherence journal's entries.** These are base64 transcript checkpoints, and other replicated streams that carry message text. They are measured, by decoding, and reported as unmeasured. Pruning them is part 2.
- **The state folder's git history and remote,** for agents that sync state through git.
- **Files outside this agent's folders:** `~/.instar/logs`, other agents' homes, and the person's other projects.
- **Snapshots taken inside the sweep window,** such as Time Machine or cloud-synced folders, and the tmux scrollback. Masking is hygiene, not a recall.

### 4.3 The sweep's pace and brakes

The scan runs in a worker thread, in slices of about 1 MB.

Every 15 seconds it checks only files whose modification time or size changed. The first pass follows the in-process load verdict (`machineLoadReport.ts`, which the session placer uses):
- **`ok`:** no cap.
- **`elevated` or `unknown`:** at most 200 MB per minute.
- **`saturated` or `impaired`:** paused, with a floor of 20 MB per minute.

The status route shows when load is holding the first pass back.

The state lives in `state/credential-scrub/state.sqlite`, with one row per file: identity, size, checked-through, masked-through, mode and the detector revision it was checked with. It is written only on change, and deleted files are pruned. The detector revision changes only when the shared patterns change, or when a new configured credential (the bot, API or tunnel token) is added. Files checked with an older revision are then checked again from the start, at the first-pass pace, with changes that arrive during a rescan merged into it. A chat-saved key does not change the revision. It was found by a wall pattern in the first place, so the patterns already find its older copies. Its own exact value gets a targeted search instead: by prefix and hash, over only the files that changed from shortly before its message arrived, which is the only place another copy can be.

The brakes:
- **Retries:** each root's retry wait doubles from 15 seconds to 30 minutes, and one success resets it.
- **Reporting:** a root unreadable for 5 minutes is reported once.
- **Breaker:** 5 throwing passes in a row stop the sweeper. It reports once, and retries after 30 minutes or a restart.

A unit test with a simulated clock covers all three.

### 4.4 Modes, for every writer

| Writer | `enabled` off | `enabled` on, `inPlace` `dry-run` | `enabled` on, `inPlace` `on` |
|---|---|---|---|
| Stdout and stderr wrapper (§3.4) | passes text through | masks | masks |
| Inbound, any key (§3.5) | off | masks and counts; a team member gets the notice (§4.5) | masks and counts; a team member gets the notice |
| Transcript copy scrub (§3.4) | off | counted only | masks |
| Sweeper (§4.1) | off | records what it would mask, writes nothing | masks |

An incoming key is masked as soon as `enabled` is on, from anyone. Leaving it unmasked during a trial would write it into the message log and the message store, and the Chief of Staff's condition (c4d7fe66) is that counting is a number, never a copy. A team member loses nothing they cannot resend in one tap (§4.5). The cost is the accepted residual in §4.5: a non-key that matches a wall pattern loses those characters. The sweeper's and the copy scrub's dry runs, which do follow `inPlace`, measure how often each pattern fires on real text, so a noisy pattern is found and narrowed early. The wrapper masks only the agent's own log output from the start; a false positive there costs a few characters of a log line.

`inPlace` is resolved in code from a shipped constant, not written into the config defaults, so a release can change the fleet default for every agent that has not set it.

- **`maskInbound` records counts too**, as numbers by kind and placeholder flag, never values and never surrounding text. A pattern that fires on ordinary incoming text shows up there. No path writes a stranger's key into a new log line or store during any trial (Chief of Staff, c4d7fe66).
- **In dry run**, the sweeper records each would-mask match without its value. The record holds:
  - the kind, and the field kind: JSON literal, plain text, integrity-bound field, or media
  - whether the line re-reads with the same structure
  - a placeholder-shape flag: `${…}`, `xxx`, `example`, `pass`, or low entropy

  It advances only its own `checked-through` mark.
- **When the mode becomes `on`**, every file is checked again from the start, against `masked-through`. A restart between modes cannot skip the backlog the dry run saw.

### 4.5 A key someone meant the agent to have

Part 1 never keeps a key from a message. Every key is masked with `[credential removed]`, and saving keys into the vault is its own design (CMT-030, after part 2), per the Chief of Staff (3d4ab7c7).

**A team member is told at once, with a one-tap way to send it safely.** When a masked message comes from a verified member of the agent's team, the agent sends them one notice in the same conversation. It is fixed wording, written by the server, not by a session:

> "I removed a key from your message, to keep it out of the conversation. Nothing else happened to it: it was not saved or used. If you meant me to have it, send it here instead: <Secret Drop link>"

The link is a fresh Secret Drop request, minted through the existing `POST /secrets/request` route, so the resend is one tap and the key goes straight into the vault the way Secret Drop already does. On the lifeline path, the server sends the notice when it delivers the queued message (§3.5). If the link cannot be made, the notice says so and asks the person to try again in a minute.

**Strangers get no notice** (3d4ab7c7). Their key is masked and not kept. The accepted residual, recorded as the cost of the Chief of Staff's decisions (d2060363, 19aa907f and 3d4ab7c7), stating Justin's intent that keys stop resting anywhere they can leak: a string from an outside sender that matches a wall pattern without being a key loses those characters for good. The sweeper's dry run measures how often each pattern fires on real text. A pattern that fires on ordinary text is narrowed in the shared module, which then protects the inbound path too.

**Who counts as a team member.** One pure function, `isTeamSender(channel, senderId)`, decides only whether the notice is sent:
- the owner id from the config
- `users.json`, through the existing static reader (`UserManager`), using its Telegram and Slack id bindings and its member permission
- for the app, the person bound to the paired device that signed the message

On Telegram it uses only `from.id`, never a forwarded message, a message posted as a chat, an anonymous admin or `via_bot`. On Slack it is a full member of the agent's own workspace, never a guest or an external Slack Connect user. If the files cannot be read, only the owner counts. A wrong answer here costs at most one notice, because nothing is saved.

**The session is told too.** The session that receives the masked message also sees a one-line note that a key was removed, and that the person was given a Secret Drop link. So it does not ask them to paste the key again in the conversation.

## 5. Never touched

These are each outside every list entry, and are checked at run time by device and inode:
- `.instar/config.json`
- the secret store and the vault
- `.env` files
- the agent's source tree
- git objects
- the hash-chained ledgers: `security.jsonl` and `state/mandate-audit.jsonl`

A unit test asserts that no list entry resolves to one of these, and that a symbolic or hard link to one of them, placed inside a list entry, is refused.

## 6. What is recorded, and who is told

- **The record.** `.instar/logs/credential-scrub.jsonl` gets one row per file pass that changed something, or would have in dry run. Each row holds the root class, a hashed file name, and counts by kind and field kind, never a value. A match of the agent's own credential is recorded by credential name, never by value. The record is written after the mask.
- **The status route.** `GET /credential-scrub` (token) returns, per root class:
  - files checked and files changed
  - matches masked or would-mask, by kind
  - the first pass's progress, and whether load is holding it back
  - bytes pending
  - unmeasured files, by hashed name and reason: unreadable, unscannable, linked, integrity-bound, or base64
  - how many short credentials (under 12 characters) are not matched by exact value
- **Nobody is told about a masked key.** The awareness entry says:
  - keys in transcripts, logs, copies and new messages are masked automatically
  - a key in its proper home, the settings file or the vault, is not a finding
  - never raise a masked key with the person, and never ask for a rotation
  - a key found somewhere not covered goes to the security session's work queue, not to the person
- **What is still raised:** only the sweeper being unable to run (§4.3), through the existing degradation report.

## 7. Multi-machine posture

- **Behaviour:** unified by build.
- **The sweeper's state and record:** machine-local. `machine-local-justification: hardware-bound-resource`: the state describes this disk's files. The pool view is each machine's `GET /credential-scrub`, read by the security session.
- **Copies:** masked on the source before hashing, and on receipt after verification.
- **The team-member notice (§4.5):** sent once by the machine that delivers the message, which is the lease holder, so it is never sent twice.
- **Windows:** links are refused by `lstat`, file identity uses the file index, and log names follow the Windows supervisor's.

## 8. Configuration

`security.credentialScrub` has three settings, all read live:
- **`enabled`:** dev-gated (`resolveDevAgentGate`). It is on for the development agent, and off on the fleet until the fleet step.
- **`inPlace`:** resolved in code. It starts at `dry-run`.
- **`sweepIntervalSeconds`:** default 15.

They change only in the settings file: `security.credentialScrub` joins SEC-151's operator-only table.

## Decision points touched

- Redact a match of the wall's kinds or the listed own credentials: invariant; basis: irreversible-consequence; evidence: a key at rest is readable by every later reader and every copy, while a false positive costs only a masked string in a record of past work or a message, never data the agent needs, because a team member whose key was removed gets a one-tap way to resend it safely (§4.5), the author and origin are kept (§3.5), and the agent's live keys sit in files never touched (§5). Placeholders are masked too: sparing placeholder-shaped values would let a real key that looks like one through, and the flag is a dry-run measure for the reviewer.
- Exclude the label-proximity kinds: invariant; basis: enumerable-domain; evidence: the three kinds the wall excludes, for its documented false positives on prose.
- Touch only listed files, never through a link: invariant; basis: irreversible-consequence; evidence: masking a key in the settings file or the secret store would break the agent.
- Write only if identity, size and bytes still match: invariant; basis: enumerable-domain; evidence: equal or not equal.
- Never drop an incoming message for holding a key: invariant; basis: irreversible-consequence; evidence: the operator channel fails toward delivery; a message is always delivered with its key masked, on the lifeline path too, and a team member gets the one-tap resend notice.
- Mask a new message at its first write, before any hash: invariant; basis: irreversible-consequence; evidence: masking after a hash or a signature is recorded breaks the author join (AspAuthorshipJoin) and the app's verified origin.
- Send the team-member notice only to a verified team member: invariant; basis: enumerable-domain; evidence: the owner id, the user bindings and the paired-device person are closed lists; a stranger gets nothing, per the Chief of Staff (3d4ab7c7).
- Switch a machine's sweeper from dry run to masking: judgment-candidate. Floor: the pre-flip evidence in the maturation plan. Arbiter: the security session, for the development agent's machines. Fallback: stay in dry run.
- Turn it on for the fleet: judgment-candidate. Floor: the post-flip evidence in the maturation plan. Arbiter: Justin, on a decision packet delivered through the Chief of Staff, as the sibling standard's Decision 4 requires for an irreversible fleet redaction. Fallback: the fleet stays dark.

## 10. Fixed limits

- **15-second sweep interval.** A setting. It bounds how long a key rests in a transcript, and it is cheap because unchanged files are skipped.
- **60 seconds idle before a final unterminated line is scanned.** Claude Code writes a tool result whole, so a minute without change means the file is finished.
- **1 MB pieces with a 16 KB overlap.** The overlap is above the longest pattern's maximum length, so a key that crosses a piece boundary is still found whole. A 1 MB piece keeps the worker's memory small on any machine.
- **200 MB per minute when elevated, and a 20 MB per minute floor when saturated.** 200 MB per minute is under 2% of a slow spinning disk's sequential read, so it cannot crowd out the agent's own reads. 20 MB per minute finishes a 5 GB backlog in about four hours on a machine that stays saturated. An idle machine has no cap.
- **Retry waits from 15 seconds to 30 minutes, a report after 5 minutes, and a breaker after 5 throwing passes.** The cap limits a dead root to two reads an hour. Five minutes rides out a lock or a remount. A single file's fault does not throw the pass, so five throwing passes mean the sweeper itself is broken.
- **The 20-byte marker threshold.** The marker is 20 characters long.
- **25 reviewed events across two machines, and one per kind that occurs.** A floor, not the decision. The 25 comes from the sibling standard's Decision 4. The two machines and the per-kind sample are SEC-164's own, stricter addition, because masking rewrites files another program owns. The reviewer can extend the dry run.

## 11. Verify the State, Not Its Symbol

- **Symbol: zero matches in a pass.** Claimed state: no covered key is in the file. Corroboration: the pass read the file through its size, literal by literal. Unmeasurable: unreadable, unscannable, linked, integrity-bound and base64 files are listed as unmeasured, never as clean.
- **Symbol: a masked match.** Claimed state: the bytes are masked and the line is intact. Corroboration: the checks before and after the write, and the re-read with the same structure.
- **Symbol: a masked message.** Claimed state: the author and origin are kept. Corroboration: the authorship join and the app attestation verify, tested per channel.
- **Symbol: a quiet dry run.** That is not evidence. The pre-flip floor needs reviewed events.

## Maturation plan

- **dark-window:** dark on the fleet from merge (enabled is dev-gated and inPlace resolves to dry-run); at most 14 days from merge to the fleet packet, which the security session raises to the Chief of Staff through its tracked commitment rather than letting it lapse.
- **test-agent-live:** on a throwaway agent with the sweeper on, a session prints a test key in each form (alone, after an escaped newline, inside a Telegram API address, in a PEM block, inside a tool-results file); with an idle worker, each completed line is masked within one interval, every line re-reads with the same structure, file sizes are unchanged, the server's error log shows the key masked, a transcript copy sent to a second throwaway arrives masked, a test-chat message from the owner with a key is stored masked, still resolves to its author, and the owner receives the fixed notice with a working Secret Drop link, while a stranger's message gets no notice, a signed app message with a key is stored masked with a verified attestation, and the settings file still holds its real key.
- **dev-agent-live:** the development agent turns enabled on, so new messages and logs are masked from day one (those live paths are covered by known-answer fixtures checking the delivered text, the team-member notice and its link, and that the surrounding text is unchanged, and by their counts, not by the reviewed sample, which covers the sweeper and the copy scrub), and its sweeper runs in dry run until the pre-flip evidence holds (at least 25 reviewed would-mask events across at least two machines, at least one per kind that occurs, zero that should not be masked, every masked line re-reading with the same structure); the security session then switches each machine's sweeper on, and the first pass cleans the existing copies.
- **fleet:** after one week with the sweeper on and the post-flip evidence holding, the security session delivers the packet; on Justin's yes, a release turns enabled on for the fleet and moves the shipped inPlace default to on.
- **graduation criterion:** pre-flip, as in dev-agent-live; post-flip, one week with no session resume, tool, reader or author join broken by a mask, the first pass finished on every development machine, and every unmeasured file accounted for by reason. A false positive that matters means a masked value that was neither a credential nor a placeholder for one. The review script shows each event's kind, field kind and placeholder flag, and the surrounding structure with the value masked, never the value. When that is not enough to judge an event, its verdict is unknown, and unknown events do not count toward the floor.
- **ladder:** credentialScrub, a new entry in src/data/feature-ladders.json added at build, whose flag is inPlace and whose metric is the criterion above.

## Frontloaded Decisions

- No key is rotated, and nobody is asked to rotate.
- No notice is sent when a key is masked.
- The work is split into two parts (19aa907f). Part 2, the existing message history, is CMT-029, due 2026-11-26.
- A new message is masked at its first write, so its author hash and app attestation cover the masked text.
- Saving keys into the vault is not in part 1 (3d4ab7c7); it is CMT-030. A team member whose key was masked gets a one-tap Secret Drop link. Strangers get no notice and their key is not kept.
- The fixed list in §4.1 is the whole reach of the sweeper. Adding a place is a reviewed change.
- The fleet turn-on is Justin's decision on the evidence packet (the decision points).

## Open questions

*(none)*

## 15. Rollback

Set `security.credentialScrub.enabled` to `false`, or `inPlace` to `dry-run`, in the settings file. Both are read live. Masked text stays masked.

## 16. Tests

- **Unit:**
  - **Detection:**
    - `findWallCredentialSpans` returns only the wall's kinds and the listed own credentials.
    - It finds a key after an escaped newline, in a Telegram address, in a PEM block inside JSON, and with zero-width characters inside it.
    - The chat id and machine ids are never matched.
    - The wall is unchanged apart from the Telegram pattern.
    - Every caller uses this one function.
  - **Scanning:**
    - The streaming tokenizer never crosses a literal and finds a literal hidden behind a duplicate key.
    - Integrity-bound fields are reported, not changed.
    - Media base64 is skipped by its signature, not by its field name.
    - A literal over 1 MB is scanned in pieces, and a key across a piece boundary is found.
  - **The mask:**
    - the marker form, the stars form, and a punctuation-only value fully overwritten
    - escapes inside the span handled
    - the line re-reads with the same structure
    - the byte offset is right after multibyte characters
  - **Writing safely:**
    - the identity, size and byte checks before and after the write
    - the three agent writers now write a temporary file and rename it
    - a final unterminated line is scanned after the idle time
    - links are refused, and the never-touch set is refused
  - **Reach:**
    - The project-folder filter matches exactly and confirms by `cwd`.
    - Codex files outside the project are excluded.
  - **Modes and brakes:**
    - The mode table holds for every writer.
    - The backlog from dry run is masked after a restart between modes.
    - The retry waits, the report and the breaker work, with a simulated clock.
  - **The wrapper:** line buffering, Buffer chunks, and no wrapping for MCP stdio or `--json`.
  - **Inbound:**
    - A team member's message is masked and they receive the fixed notice with a Secret Drop link; the session sees the one-line note.
    - A forwarded message or a `sender_chat` message is not treated as a team member's.
    - A stranger's key is masked and not kept, and no notice is sent.
    - If the Secret Drop link cannot be made, the notice says so.
    - The same message masks to identical text on replay.
  - **Kept attached:**
    - An owner message with a key still resolves to its author.
    - A signed app message with a key verifies through its attestation.
  - **Ledger:** the token ledger's re-read leaves its counts unchanged.
- **Integration:**
  - A real server's error print reaches its log masked.
  - A transcript copy arrives masked, including from a raw older-build source.
  - The lifeline queue, the Telegram log, topic memory and the input ledger all hold only the masked text of a new owner message, and its authorship resolves.
  - An app message is stored masked with a verified origin.
  - `GET /credential-scrub` reports counts and unmeasured files.
- **E2E:** under the production init path, the sweeper runs in its worker, the status route answers 200, and with `inPlace` on, a planted test key in a transcript under a temporary config home is masked.

## 17. Awareness

`src/data/awareness/credential-scrub.md` covers:
- what is masked automatically
- a team member whose key was removed already has a Secret Drop link; never ask them to paste the key in the conversation
- a key in its proper home is not a finding
- never raise a masked key or ask for a rotation
- a key found somewhere not covered goes to the security work queue
- sessions pass each other vault names, never key values
- `GET /credential-scrub` answers "were any keys found"
