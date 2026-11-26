# Resume heartbeat no longer walks the Codex archive — Plain-English Overview

> The one-line version: a once-a-minute bookkeeping check was sending Claude session ids into a scan of every Codex session file on the machine, freezing the agent for about 25 seconds a minute; now each session is checked only in its own framework's files, and the Codex lookup itself can no longer freeze anything.

## The problem in one breath

Every 60 seconds the agent's server refreshes a small table that says "conversation X can be resumed from transcript Y". For each live session it checks that transcript Y still exists. When a Claude session's recorded transcript was missing, the check did not stop at Claude's folders: it fell through into "maybe it is a Codex session" and searched the whole Codex archive for it, reading the metadata of every one of 286,984 files, on the server's main thread. Two live Claude sessions with stale ids did this every minute. The server stopped answering for ~25 seconds each time, its health checks timed out, and its supervisor restarted a healthy server three times in one morning (2026-10-13, Mac Studio).

## What already exists

- **The topic resume map** — remembers which Claude transcript each Telegram topic (or Slack channel) resumes from, so a restarted session picks up where it left off instead of starting cold.
- **The thread resume map** — the same idea for agent-to-agent conversation threads.
- **The 60-second heartbeat** — refreshes the topic map from the ids the live sessions reported through their hooks. It only ever records an id whose transcript it can see; it never guesses.
- **The Codex rollout lookup** — finds a Codex session's file by its id. Codex stores these in date folders (`year/month/day`). The old version read every entry's metadata before looking at its name, with no cap and no pause.
- **A session's record already knows its framework** (Claude, Codex, Gemini...). The transcript check simply never used that.

## What this adds

The check now uses the framework. A session known to run on Claude is checked in Claude's transcript folders only, never in the Codex or Gemini archives; a Codex session is checked in the Codex archive only; a Gemini session in Gemini's. A missing transcript stays an honest "not found": the existing table entry is kept, nothing is deleted, and no other transcript is substituted for it. Only a session whose framework is genuinely unknown still tries every layout, and that path is now cheap too.

Secondary changes:

- The heartbeat's logic moved out of the big server file into a small module, so the tests run exactly the code production runs.
- Every place that saves a resume id before a session is closed also passes the framework.
- The agent-to-agent thread map asks the session registry which framework a thread's session runs on.

## The new pieces

- **The bounded Codex lookup** — the same function, rebuilt so it can never freeze the server. In order: (1) a remembered exact path, confirmed with one metadata read; (2) a remembered "not here" answer, valid for a minute and dropped the moment the newest day folder changes; (3) a date hint: Codex ids carry their creation time inside them, so the lookup reads just that day's folder (and its two neighbours) by name; (4) for an id with no date, a scan by name only, capped at twenty thousand names; (5) anything beyond that cap is read in the background, pausing regularly so the server keeps answering, with a hard upper bound on the work. The sync caller gets an honest "not found" right away and the next call reads the settled answer. File names are always tested before any metadata read.
- **A tick module** — `runResumeHeartbeatTick`: gathers the live sessions, their ids and frameworks, and hands them to the map. It is what the server's timer calls.

## The safeguards

**Prevents the freeze from coming back through any caller.** The fix is not just "skip Codex for Claude": the Codex lookup itself can no longer stat its way through the archive, so a future framework-blind caller is bounded as well. Counters on the lookup let the tests prove that a Claude session caused zero archive reads and that a missing id on a 25,000-file synthetic archive cost bounded work with the event loop responsive.

**Prevents a wrong resume.** Nothing is substituted. A missing transcript keeps the existing mapping and answers "no resume id"; the next message then falls back to the conversation history exactly as before. A Codex session's real file is still found (through its date folder) on the first call.

**Prevents a stale answer.** A remembered miss is forgotten after a minute, whenever the newest day folder changes, and explicitly when a Codex resume mapping is saved. A remembered hit is re-confirmed with one metadata read and dropped if the file is gone.

## What ships when

One pull request, one patch release. No configuration, no migration, no change to any stored file format. The change takes effect at the next server restart through the normal update path; the running server on the affected machine is not touched by this PR. The separate boot-time delay in the project map generator (synchronous Git calls per worktree) is NOT in this change; it is tracked as evolution action ACT-109 (registered 2026-10-13 from the same forensic report).

## What you actually need to decide

Nothing beyond reviewing the PR: it is a bug fix with no new capability and no new setting. The question for the reader is only "is checking each session in its own framework's files, with a bounded Codex lookup, the right shape?" — yes or no.

## Addendum (2026-10-24)

If the check for a Claude session's transcript file fails for a reason other than "the file is not there" (the folder cannot be read, the list of login folders cannot be enumerated), the server now records that as a degradation it can report, instead of quietly treating it as a missing transcript. The decision is the same as before (a failed check still counts as a miss, and nothing is deleted); the difference is that the failure is visible, because a live session wrongly read as missing could lose its resume entry.
