---
title: "Resume Follows the Account — a topic conversation survives a subscription-pool account change"
slug: "resume-follows-account"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "resume-follows-account.eli16.md"
status: "converged"
approved: true
approved-by: "Justin (operator), 2026-09-16 14:48 PDT, in the Echo session handling this incident: \"please proceed with the permanent fix, but make sure it follows the 80/20 principle\""
review-deviation: "Operator directive 2026-09-16 14:48 PDT: 'proceed with the permanent fix, but make sure it follows the 80/20 principle. We've been spending way too many tokens and time on reviews for minor issues.' v4 is scoped to the three root defects; rounds 1-3 findings outside that scope are recorded as tracked residuals rather than designed in."
lessons-engaged:
  - "P20 Verify the State, Not Its Symbol — pane-dead fact instead of session existence; transcript presence in the launch home instead of anywhere; no newest-file guess"
  - "TopicResumeMap §8 park-not-delete — this change adds no pointer deletion"
  - "ACT-1278 — ThreadResumeMap is not changed"
  - "ACT-1281 — no per-poll synchronous tmux call is added; the dead-pane check replaces the existing heartbeat probe and runs at most every 2 s during startup"
  - "User-Facing Fixes Ship Live — ships live with one kill switch"
review-convergence: "2026-09-16T23:10:34.288Z"
review-iterations: 4
review-completed-at: "2026-09-16T23:10:34.288Z"
review-report: "docs/specs/reports/resume-follows-account-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Resume Follows the Account

**Parent principle — "Verify the State, Not Its Symbol."** Three symbols stood in for three states: a tmux
session existing stood for "Claude is running"; a transcript existing somewhere stood for "this login can
open it"; the newest `.jsonl` in a folder stood for "this topic's conversation".

## 1. Problem

On 2026-09-16 the Telegram topic "GCI MCP servers" (topic 32175) on the `sagemind` agent (Luna,
instar 1.3.1241, the current release) became unusable. Every inbound message produced the same
sequence: `✓ Delivered` → `🔄 Session restarting — message queued` → `Session respawned` → 16 seconds
later Claude exited → five minutes later the presence proxy posted "The session appears to have
stopped." The operator's message was never read. This repeated on three consecutive messages
(09:47, 10:34, 10:47 PDT) and would have repeated on every future message.

### 1.1 Forensic chain (all four links verified on the live machine)

**Link 1 — the resume transcript is not in the account home the respawn used.**
The topic's real conversation (`56f6396f…`, 4,736-7,190 lines, two compactions) was recorded
under pool account `sagemind-adriana`, so its transcript lives at
`~/.claude-followme-sagemind-adriana/projects/<slug>/56f6396f….jsonl` (plus an older copy under
`~/.claude-followme-sagemind-justin`). That account reached 100% of its seven-day window. The
respawn placed the topic on `sagemind-dawn` (seven-day 71%) and ran
`claude --resume 56f6396f…` with `CLAUDE_CONFIG_DIR=~/.claude-followme-sagemind-dawn`, whose
projects directory has no such file. Claude printed
`No conversation found with session ID: 56f6396f…` and exited with status 1.

Instar already knows this failure class and already has the fix for it:
`ensureResumeTranscriptInConfigHome(uuid, targetConfigHome)` (`src/core/SessionRefresh.ts`) copies
the transcript into the target home before a `--resume`. Its doc comment describes this exact
symptom. It is wired only into the account-SWAP refresh path; the topic spawn/respawn path that
chooses an account by quota headroom never calls it.

**Link 2 — the dead pane defeats the resume-failure fallback.**
Topic sessions are created with tmux `remain-on-exit failed`, so a Claude process that exits
non-zero leaves a dead pane and a live tmux session. `SessionManager.handleReadyAndInject` decides
between "startup crash — retry fresh without --resume" and "alive but prompt not seen — inject
anyway" using `tmuxSessionExists()`. A dead pane answers "exists", so every failed resume takes the
second branch: the fresh-spawn fallback never runs, `resumeFailed` is never emitted, the stored
resume UUID is never cleared, and the user's message is typed into a pane with no process
(`alive after primary timeout` → `attempting injection anyway`).

**Link 3 — the resume-map heartbeat re-poisons the pointer every minute.**
`TopicResumeMap.refreshResumeMappings` (60 s) treats a topic as active when `tmux has-session`
succeeds — true for the dead pane. With exactly one "active" topic session and no hook-confirmed
transcript, it takes the `mtime-fallback`: the newest `*.jsonl` in `~/.claude/projects/<slug>`.
That directory is dominated by internal one-shot `claude -p` calls (UnjustifiedStopGate,
TopicIntentExtractor, arc extractor…) — 27,556 files, 6.8 GB, 1,155 written in the last 24 hours
on this agent — so the "newest" transcript is always an internal classifier call. The map stored
`ca1f96f4…` (stop gate), then `56d9d1c9…` (stop gate), then `2b504fa0…` (arc extractor), each with
provenance `mtime-fallback`. Each subsequent respawn resumed an unrelated three-line classifier
transcript, which also does not exist in the account home, so link 1 repeated.

**Link 4 — a resume attempt is recorded as hook-confirmed.**
A failed `claude --resume X` still reports `session_id: X` to the hook bridge before it exits (the
hook-event file `.instar/hook-events/56d9d1c9….jsonl` was created and then unlinked two seconds after
the 17:47:31Z spawn, per `.instar/audit/destructive-ops.jsonl`). The bridge writes X onto the session
record, and the 8-second proactive save re-persists it with `(source: hook)`. "Hook provenance"
therefore proves only that the launch asked for X, not that X is the conversation running.

**Claude's lookup rule, measured.** Run against the real `claude` 2.1.273 binary with a throwaway
`CLAUDE_CONFIG_DIR` holding no credentials (so no model call can happen): a transcript placed under
project folder A was found when launched from cwd A *and* from an unrelated cwd B (both printed
`Not logged in`, meaning the conversation was located); an id absent from the home printed
`No conversation found with session ID` and exited with status 1 in under one second. Claude
therefore finds a resume transcript by id across every project folder of the config home it runs
under, and never outside that home. Two more measurements, with a fake `HOME` and an invalid API key so no
model call could bill: `CLAUDE_CONFIG_DIR=` (empty) did **not** find a transcript that the unset case found,
and `CLAUDE_CONFIG_DIR=<HOME>/.claude` set explicitly made Claude look for its global settings file inside
that folder instead of in `HOME`. An unpinned launch must therefore leave the variable unset.

**Aggravator — a local patch widened the existence check.** Luna carries a locally re-applied patch
(`repatch-resume-homes.mjs`, upstream feedback fb-ad42e220) that makes `TopicResumeMap.jsonlExists`
search every `~/.claude-followme-*` home. Upstream checks only `~/.claude`. Either version answers
"does this file exist anywhere", never "can the account this spawn will use open it". Upstream's
answer is wrong for every pooled account; the patch's answer is wrong across an account change.

### 1.2 Why this is the root and not a symptom

Killing the dead tmux session and deleting the map entry by hand would unblock this one topic. It would
not stop the next account change from doing the same thing to any topic, on any agent that pins
sessions to a subscription pool (`subscriptionPool.pinSessionsToPool`). The account resolver runs on
every interactive spawn and every headless spawn, and it never considers where the resume transcript
lives. The loop is guaranteed whenever (a) the topic's last account is walled and (b) the agent has a
steady stream of internal one-shot calls, which every agent has.

## 2. Scope (80/20)

Fix the three defects that turned one account change into a permanent loop, with the smallest change to
each. Out of scope, tracked: Threadline agent-to-agent resume (ACT-1275, ACT-1278); the Codex archive walk
(ACT-1280); one-shot transcript accumulation (ACT-1283); the triage "newest file" signal (ACT-1282); nested
process hook rotation (ACT-1284); cross-machine transcript carriage (ACT-1285).
<!-- tracked: ACT-1275, ACT-1278, ACT-1280, ACT-1282, ACT-1283, ACT-1284, ACT-1285 -->

## 3. Design

### 3.1 Place the conversation in the login the launch uses

`src/core/SessionRefresh.ts` already has `ensureResumeTranscriptInConfigHome(uuid, targetConfigHome)`, which
copies a transcript into a target login folder. It is used only by the account-swap path. It gains an async
sibling in a new module `src/core/claudeResumeTranscript.ts`:

```ts
export type PlacementOutcome = 'present' | 'copied' | 'replaced' | 'forked' | 'one-shot' | 'not-found' | 'error';
export async function placeResumeTranscript(uuid: string, targetConfigHome: string, homeDir?: string): Promise<PlacementOutcome>;
```

- **Where it looks.** `~/.claude`, every `~/.claude-*` folder (the set the existing helper already scans),
  and the target login itself, every project folder under each. The uuid must be canonical 8-4-4-4-12 hex before any path is built.
  Regular files only; symlinks are ignored.
- **Which copy.** The copy whose last parseable record `timestamp` is latest (read backwards, at most 500
  lines); ties and missing timestamps fall back to size.
- **One-shot refusal.** If that copy's first record carrying `cwd` (within 64 KiB) has
  `"entrypoint":"sdk-cli"`, return `one-shot`. Placement runs only for Telegram and Slack topic sessions, which
  instar always launches as interactive Claude sessions (`entrypoint: cli`), so an `sdk-cli` transcript cannot be
  the topic's conversation; on sagemind every such transcript was an internal classifier call.
  (Measured: first line never carries `cwd`; the first `cwd` record is at line 2-6; interactive transcripts
  say `cli`, one-shots say `sdk-cli`.)
- **Placing it without losing a turn.**
  - Target has no copy: copy to a temp file beside it (`COPYFILE_FICLONE`, mode `0600`), rename into place.
    `copied`.
  - Target has the chosen copy already (same or later timestamp): `present`.
  - Target has an older copy that is a byte-prefix of the chosen one: copy to temp, rename over. `replaced`.
    Nothing is lost because every byte of the old copy is in the new one. The target's size and mtime are
    re-checked immediately before the rename; if either changed, the copy is left alone (`present`).
  - Target has an older copy that is not a byte-prefix: rename it to `<uuid>.jsonl.forked-<timestamp>`, then
    copy as above. `forked`. The divergent copy is kept, never deleted.
  - Any other copy of the id in another project folder of the target login is renamed aside the same way, so
    exactly one copy remains that Claude can open.
  - The sibling `<uuid>/` attachment folder is copied without overwriting existing files.
- Any error returns `error`; nothing is thrown.

The account-swap path in `SessionRefresh` now calls `placeResumeTranscript` instead of the older
`ensureResumeTranscriptInConfigHome` (kept, deprecated, for existing callers), so it stops picking a stale
first-found copy.

**Where it runs.** In `SessionManager.spawnInteractiveSession`, after the account home is resolved and before
the launch command is built, when all hold: framework `claude-code`, a resume id, a resolved config home
(caller-supplied or pool-pinned), and a Telegram topic or Slack channel binding.

| Placement result | Launch |
|---|---|
| `present`, `copied`, `replaced`, `forked`, `error` | with `--resume` (an `error` keeps today's behaviour; §3.2 recovers a crash) |
| `not-found`, `one-shot` | without `--resume`; the initial message gains one leading sentence: "Your earlier conversation in this topic could not be reopened, so you only have the recent topic messages below." |

The resume id actually used replaces `options.resumeSessionId` for everything later in the spawn (the build
context note, origin binding, ready timeout, pending-inject record, and the readiness handler).
`not-found`, `one-shot` and `forked` each log one line and file one `DegradationReporter` event whose text
names only the outcome.

Unpinned launches (no config home) are unchanged: they run under the default login, where the transcript
already lives unless an account change happened, and account changes only happen through the pool.

### 3.2 Treat an exited Claude process as exited

Topic panes use tmux `remain-on-exit failed`, so a crashed Claude leaves a dead pane inside a live tmux session.

- New `SessionManager.isPaneDead(tmuxSession): boolean` — one `display-message -t =<name>: -p '#{pane_dead}'`
  with a 5 s timeout; `true` only when the output is exactly `1`. Any error or other output is `false`, which
  keeps today's behaviour.
- `waitForClaudeReady` / `waitForClaudeReadyWithRetry`: every fourth poll (2 s), if the pane is dead, return
  `false` at once instead of waiting out 120 s + 15 s.
- `handleReadyAndInject`: `stillAlive` becomes `tmuxSessionExists && !isPaneDead`. A dead pane after a resume
  therefore takes the existing branch: emit `resumeFailed`, kill the tmux session, retry once without
  `--resume`. Before killing, the last 20 pane lines and the exit status are logged. The retry now also passes
  the original `framework`, `cwd`, `defaultModel`, `thinkingMode`, `effort`, and a caller-supplied `configHome`
  and `subscriptionAccountId`, and prepends the same in-band note as §3.1. A dead pane without a resume
  takes the existing "fresh startup crash" branch, which now also kills the dead tmux session so the next
  message spawns cleanly instead of reusing it.
- `spawnInteractiveSession` reuse check: a same-name session whose pane is dead is killed and the spawn
  proceeds, instead of injecting into it.

### 3.3 The resume pointer never guesses

In `src/core/TopicResumeMap.ts`:

- `refreshResumeMappings` no longer uses the `mtime-fallback` branch; `findClaudeSessionUuid` is no longer
  called in production (kept for its existing tests). A topic is recorded only from the hook-reported
  `claudeSessionId` whose transcript exists.
- `get()` and `getForFramework()` return `null` for an entry with `provenance: 'mtime-fallback'` (checked
  before any filesystem access). Such entries are left to expire.
- The heartbeat's liveness probe becomes `display-message -p '#{pane_id}||#{pane_dead}'` (5 s timeout)
  instead of `has-session`. A non-zero exit, an empty pane id (measured: tmux answers a missing session with
  exit 0 and empty fields), or `pane_dead` `1` skips the topic. One call replaces one call.
- `jsonlExists` for Claude also looks for `projects/<this project slug>/<uuid>.jsonl` under every
  `~/.claude-*` folder before falling through to the Codex and Gemini checks. This upstreams the TopicResumeMap
  half of sagemind's local `repatch-resume-homes` patch and stops pooled Claude ids reaching the Codex walk.

### 3.4 Kill switch

`sessions.resumeFollowsAccount.enabled` (default `true`) gates §3.1 placement and §3.2's dead-pane checks. It
is loaded with the rest of the session settings, so a change applies on the next server restart. §3.3 has no
switch: it only removes a guess.

## 4. Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| D1 Launch with or without `--resume` (§3.1) | invariant | Whether a non-one-shot copy exists; a filesystem fact. |
| D2 Replace, keep or set aside an existing copy (§3.1) | invariant | Timestamp order plus a byte-prefix comparison; nothing is deleted. |
| D3 Pane dead (§3.2) | invariant | tmux's `pane_dead` flag; any probe failure keeps today's behaviour. |
| D4 Record a pointer (§3.3) | invariant | Hook-reported id with an existing transcript; the guessing branch is removed. |

## 5. Verify the State, Not Its Symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
|---|---|---|---|---|
| Transcript placed | file at `<home>/projects/<slug>/<uuid>.jsonl` | the login can open it | measured Claude lookup rule (§1.1); a failed open exits at once and §3.2 recovers | `error`: launch as today |
| One-shot | first `cwd` record `entrypoint: sdk-cli` | internal classifier call | measured on 316 interactive and 30 one-shot transcripts | field absent: not refused |
| Pane dead | `pane_dead=1` | Claude exited | the logged pane tail and exit status | probe error: treated as alive (today) |

## Multi-machine posture

- **Transcript placement** — machine-local.

machine-local-justification: physical-credential-locality permanence=permanent impossible-because="a Claude Code process opens resume transcripts only from the projects folder of the CLAUDE_CONFIG_DIR its login runs under on this machine"

- **Dead-pane checks and the resume map** — no state is added; the map keeps its existing per-machine posture.

## Frontloaded Decisions

1. Placement only for pool-pinned or swap-pinned Claude topic and Slack launches.
2. Never delete a transcript copy: replace only a byte-prefix, set a divergent copy aside.
3. Refuse `sdk-cli` transcripts as resume targets.
4. Dead-pane check every 2 s during startup and once at the readiness decision.
5. Legacy `mtime-fallback` entries ignored, not deleted.
6. One kill switch, default on.

## Maturation plan

Ships under **User-Facing Fixes Ship Live**: it repairs a path that leaves pooled agents' topics unable to
answer. The kill switch is the rollback.

- **test-agent-live:** `/test-as-self` with two fake login folders: the transcript only in folder A, the spawn
  pinned to folder B; confirm the copy lands in B and the launch carries `--resume`; confirm a dead-pane
  startup is detected and retried.
- **dev-agent-live:** after release, sagemind: the next message in each of its five saved topics resumes
  (log shows placement `present` or `copied`), and no `No conversation found` appears.
- **fleet:** the same release.
- **graduation criterion:** 48 hours on sagemind with zero `No conversation found` startup exits and zero
  `mtime-fallback` writes.
- **dark-window:** none; the kill switch restores today's behaviour for §3.1 and §3.2.

## 6. Testing

- **Unit** `tests/unit/claude-resume-transcript.test.ts`: freshest by timestamp; byte-prefix replaced;
  divergent copy set aside with its bytes intact; attachments copied without overwrite; `sdk-cli` refused;
  not found; invalid uuid.
- **Unit** `tests/unit/topic-resume-map-no-guess.test.ts`: no guess without a hook id; `mtime-fallback` entry
  ignored; hook entry honoured; dead, missing and empty-field panes skipped; transcript under `~/.claude-*`
  counts as existing, one under another project folder does not.
- **Unit** `tests/unit/resume-follows-account-dead-pane.test.ts`: pane-dead parsing; dead pane after resume takes
  the retry with the session shape and note; unprobeable pane and kill switch keep the old behaviour; dead
  fresh pane removed; dead same-name session not reused.
- **Integration** `tests/integration/resume-follows-account-spawn.test.ts`: a pinned topic spawn with the
  transcript only in another login folder carries `--resume` and the copy lands; with no transcript it
  launches without `--resume` and with the note; unbound spawns and the kill switch are unchanged.
- **E2E** `tests/e2e/resume-follows-account-dead-pane-e2e.test.ts`: against real tmux on a private socket, a pane
  that exits non-zero under `remain-on-exit failed` still reports as an existing session, is reported dead,
  and is skipped by the heartbeat, while a running pane is recorded and a missing session is skipped.

## 7. Acceptance criteria

1. A pinned topic spawn whose transcript is only in another login folder resumes it.
2. No placement ever deletes or truncates a transcript copy.
3. A resume that crashes at startup reaches the existing fresh retry within about 3 seconds.
4. `TopicResumeMap` never writes or returns an `mtime-fallback` entry.

## Open questions

*(none)*
