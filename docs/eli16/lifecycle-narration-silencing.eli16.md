# ELI16 — Stop telling the user about restarts and fake deaths

## The problem, like you're 16

Imagine your phone texted you "hey, I rebooted, everything's fine, no action needed" every single time it restarted overnight — and ALSO texted "your phone is broken, buy a new one" every 5 minutes about a phone that was actually working fine. That was us, last night, across three Telegram topics.

Two separate mouths were doing it:

1. **The autonomous loop's restart note.** Every time an autonomous session restarted (which under restart churn is *a lot*), it posted "Heads up — my session restarted mid-run… No action needed." The message literally admits it's useless ("no action needed"). Under churn that's a wall of identical notes.

2. **The "conversation too long" death notices.** A monitor (SessionMonitor) watches sessions for the "conversation too long" error. When it sees one, it asks the recovery system to fix it. The recovery system checks first: "wait — this session has active child processes, it's ALIVE and working — I'm not going to kill a живое session," and **defers**. But it reported that deferral as plain `recovered: false`, and the monitor can't tell "I deferred because it's alive" from "I failed because it's dead" — so it told the user the session was dead. Every 5 minutes. About sessions that were fine. One day's log: 68 detections, 29+ deferrals, 0 actual recoveries — almost all false death reports.

## The fix

- **Recovery now says WHY it returned false.** `RecoveryResult` gains a `deferred: true` flag on every work-check veto. Deferral = "the session is alive, leave it alone" — categorically not a death.
- **The monitor shuts up on deferrals.** If recovery deferred, SessionMonitor logs it and emits an internal event — the user hears nothing, because nothing is wrong.
- **Real deaths announce once.** A genuine unrecoverable death now notifies once per session *instance* (a new `topicId → sessionName` episode map), not once per cooldown window. A successful recovery clears the episode so a future real death can speak again.
- **The restart note goes to the audit log, not the user.** The stop-hook still writes its restart-resume JSONL audit record and stderr line — it just no longer posts to Telegram. Existing agents get the silenced hook via a PostUpdateMigrator marker bump (`CLOCK_SEG` → `RESTART_NOTE_SILENT`).
- **The standard is codified.** The Near-Silent Notifications article in the standards registry gains the self-lifecycle clause: *if the message has to say "no action needed," it must not be sent.*

## What did NOT change

- `notify_terminal_stop` (the "autonomous run finished / hit its time limit" notes) still posts — a run ending is a real consequence the user should see.
- The #907 detection-side guard (CLI error framing required) is untouched — that fixed a *different* false-positive source (stale scrollback). This PR fixes the notify-side one.
- The recovery-audit JSONL keeps every restart-resume record; nothing is less observable, it's just not in your chat.
