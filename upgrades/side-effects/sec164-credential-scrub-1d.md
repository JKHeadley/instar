# Side effects: the credential sweeper masks live keys in session records and logs where they sit (SEC-164 part 1d)

Spec: `docs/specs/credential-scrub-at-rest.md` §3.1–§3.3, §4.1–§4.4, §5, §6, §8 (converged, approved under option A). Stacked on part 1c (PR 3628), on 1b (PR 3627), on 1a (PR 3621).

## What changes for running agents

Only with `security.credentialScrub.enabled` (dev-gated). The sweeper follows `inPlace`: a count-only dry run until it is `true`, then masking. With `enabled` off it does nothing.

- **`src/core/credentialSweeper.ts` (new).**
  - **The fixed list (§4.1).** This agent's Claude Code project folders only, from every login's config home (`claudeTranscriptRoots`, which includes the subscription pool). A folder must be the exact encoded name, or that name plus `--worktrees-`. At least one of its transcripts must record a `cwd`, and every recorded `cwd` must be inside the project. Inside it: `*.jsonl`, `*/subagents/*.jsonl` and `*/tool-results/*`, never the `memory` link. Codex sessions whose recorded `cwd` is inside the project. The listed logs (`.instar/logs/*.log|*.err|*.jsonl` except its own record, project `logs/*.log|*.jsonl`, `.instar/hook-events/*.jsonl`, `.instar/*.install.log`), Local Verify run logs, and transcript copies.
  - **Refusals.** Symbolic links to files and to listed folders (`lstat` on every listed folder, `O_NOFOLLOW` on open), files with more than one hard link, and the never-touch set (§5), checked by device and inode at run time: the settings file, `security.jsonl`, `state/mandate-audit.jsonl`, `.env*` files, and the secret and vault files in the state folder.
  - **Scanning.** Only complete lines past the checked-through mark. A partial last line is scanned once the file has been idle for 60 seconds, and the checked-through mark stays at that line's start, so a continued line is checked whole. A hash of the checked head notices a file truncated and regrown on the same inode, which is then checked from the start. JSONL lines go through the same-length JSON mask from part 1c; a non-JSON line inside a JSONL file is scanned as text. Plain text is scanned in 1 MB pieces. A slice that is not valid UTF-8 is decoded as Latin-1 (one character, one byte), and every span must map back to exactly its text before it is queued, so an offset can never drift onto other bytes. A line longer than one slice is scanned with a 16 KB overlap: only spans that start before the cut are kept, and the next read starts at the cut. An open PEM block (BEGIN with no END, within 200 lines) holds the checked-through mark at its line, so a later append is masked whole. Plain-text spans keep their line endings.
  - **Safe writes (§3.3).** Positioned same-length writes on one open handle, through a new audited `SafeFsExecutor.safeSameLengthWriteSync`. Before each write, the inode is unchanged, the file has not shrunk, and the bytes at the offset are the original; afterwards they are the replacement. A change in between leaves the file for the next pass. An intent (offset, replacement and a hash of the original, never the original) is recorded durably before each write and cleared after. At start, a pending intent is re-applied only if the file is still the same single-link inode, outside the never-touch set and long enough, and the bytes still hash to the original. Bytes that are already the replacement just clear it. Anything else is left alone, with no guessing about a torn write.
- **`src/core/credentialSweepRunner.ts` (new).** State is in `state/credential-scrub/state.sqlite`: one row per file, written only on change, deleted files pruned, intents in their own table. The interval is `sweepIntervalSeconds` (default 15). Unchanged files are skipped. A new detector revision (pattern source or configured-credential count) rechecks from the start. Switching into masking rechecks from masked-through, as §4.4 says.
  - **Pace (§4.3):** no cap at `ok`, 200 MB per minute at `elevated` or `unknown`, and a 20 MB per minute floor at `saturated` or `impaired`, from the work-admission load verdict.
  - **Brakes:** a per-root retry wait doubling from 15 seconds to 30 minutes and reset by one success, a single report after a root is unreadable for 5 minutes, and a breaker after 5 throwing passes (reported once, retried after 30 minutes or a restart).
  - **The record:** `.instar/logs/credential-scrub.jsonl`, one row per file pass that changed something (or would have), with the root class, a hashed file name and counts by kind. Evidence rows go to `credentialScrub`: fired when masked, held in dry run.
- **`GET /credential-scrub` (token).** Per root class: files checked and changed, masked and would-mask counts by kind, bytes pending. Also the first pass's progress and whether load is holding it back, the oldest unchecked age, unmeasured files by hashed name and reason, the count of short credentials not matched by exact value, and pending intents. It answers 503 when the sweeper did not start. It is an internal prefix in `CapabilityIndex`; the agent learns it from the awareness entry.
- **`HookEventReceiver`.** `receive` masks each event line at write time (same length), and `trimSessionEvents` writes a temporary file and renames it over the old one.
- **Settings (§8).** `security` is not one of the API-patchable blocks, and the single-path bearer write refuses any block outside that list. So `security.credentialScrub` already changes only in the settings file. A test pins this.
- **Awareness.** The `credential-scrub` entry now covers every path, the sweeper, the status route and `inPlace`.
- **Ladder.** The `credentialScrub` plan now says the sweeper and copy scrub write evidence rows.

## Deliberate departures from the spec, said plainly

- **Main thread, not a worker thread (§4.3).** The codebase has no worker-thread precedent, and a worker would have to load a separate built entry. Instead, the pass runs on the server's event loop. Each synchronous call reads at most 4 MB, the pass yields between files, and one pass reads at most 64 MB. The longest synchronous stretch is one 4 MB call, about the cost of the existing token-ledger poller's per-file scan. A worker can replace this without changing the state or the record if the measurements ask for it.
- **The dry-run record holds kinds and counts, not yet field kind, re-read result and placeholder flag per event (§4.4), and there is no review script yet.** Both are needed before the security session flips `inPlace` on any machine, since the flip's evidence floor is reviewed events. They are tracked as the security session's own pre-flip item on the ladder (the dev-agent-live rung's owner step), not a fleet change. Nothing masks in place until then.
- **One Codex home.** The sweeper reads the configured Codex home (`codexHomeFromConfig`), not every home `FrameworkSessionStore` could list.
- **Unmeasured matches are reported in the status, not raised to the work queue.** Integrity-bound fields and literals that do not parse show in `GET /credential-scrub`, which the security session reads.

## Known limits

- Out of reach, as the spec says (§4.2): platform servers, the existing message history (part 2), Apple's message database, the coherence journal, git history, files outside this agent's folders, snapshots, and tmux scrollback.
- A JSONL line longer than one slice is read whole once complete, up to 32 MB; a longer line is reported as unmeasured, and the file is not masked past it. A plain-text line longer than one slice is scanned piece by piece with the 16 KB overlap, so it never stalls the file.

## Signal vs authority

The sweeper changes only a key's bytes in its listed files, never deletes, truncates or rewrites a file, and refuses anything it cannot prove is the same file with the same bytes. Every failure leaves the file as it was and is counted. The only thing ever raised is the sweeper being unable to run.

## Rollback

Set `inPlace` off (back to counting) or `enabled` off (stopped); both are read live. A masked key stays masked by design.

## Class-Closure Declaration

- **unbounded-self-action: guard, bounded by construction.** The sweeper is a timer-driven pass, not a reactive loop. One pass is in flight at a time. The pass reads at most 64 MB, the interval is clamped to between 5 and 3600 seconds, the first pass is paced by load, failing roots back off to 30 minutes, and a breaker stops the sweeper after 5 throwing passes for 30 minutes. A write is attempted once per pass per span, and only on unchanged bytes.

## Second-pass review

**Reviewer:** Claude Sonnet (independent subagent), which read the full diff and the real code paths.
- **Round one: DO NOT CONCUR, with four blocking defects, all fixed with tests:**
  - plain-text offsets drifted when a slice held invalid UTF-8, so innocent bytes could be overwritten. Now decoded as Latin-1, and every span is checked against its text;
  - a plain line longer than one slice stalled the rest of the file. Now scanned with the overlap;
  - the torn-write heuristic in intent re-apply could overwrite changed content. It is removed, and the hard-link, never-touch and size checks are added;
  - a JSONL line was read whole with no cap. Now capped at 32 MB, and longer is unmeasured.
- Its non-blocking notes on directory links, folder confirmation, truncate-and-regrow, and an idle tail splitting a key are fixed too, with tests.
- **Round two: DO NOT CONCUR.** It confirmed the four fixes and the long-line offsets. It found one new defect from the idle-tail change: a file ending in an unterminated line never counted as unchanged, so in dry run it re-recorded the same key every 15 seconds and never finished its first pass. Fixed: the state remembers the size and modification time at which the idle tail was scanned. The runner skips the file while both are unchanged, and that tail does not count as pending. A test shows a dry run records it once across three passes.
- Its non-blocking notes are accepted. A span longer than the 16 KB overlap at a long-line cut is matched truncated, which only an oversized PEM block could hit. A project folder skipped as unconfirmed is not yet listed as unmeasured in the status.
- **Round three: CONCUR.** It confirmed the tail fix. A file is unchanged only when its size and modification time match and the tail was scanned at exactly those values. A switch into masking still re-sweeps, and a grown file rescans the whole tail line. Its one note, that a same-size and same-time content change goes unseen, is the limit the unchanged test always had.

## Tests

- `tests/unit/sec164-sweeper.test.ts` (new, 27 cases): the 19 in the release note, plus eight for the review fixes (invalid UTF-8, a long plain line, the idle-tail mark, truncate-and-regrow, a directory link, folder confirmation, an intent on a never-touch file, and a dry-run idle tail recorded once).
- `tests/e2e/credential-scrub-sweeper-alive.test.ts` (new) was not run on this machine (M5 rule); Local Verify is its first run.
- Unchanged and passing: hook-event-receiver, hook-events-route, feature-ladders-coverage, MaturationLadder, sec164-line-mask, sec164-inbound-mask.
