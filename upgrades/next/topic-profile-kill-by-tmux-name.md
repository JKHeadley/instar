# Topic-profile framework switch actually switches

## Summary of New Capabilities

- Pinning a topic to a different framework or model now genuinely restarts that topic's session onto the pin, instead of reporting success while the old session kept running.
- A profile respawn that cannot complete is recorded as a failure and retried, and settles loudly at the circuit breaker rather than silently claiming it applied.

## What Changed

- Both topic-profile kill ports in the server composition root, and the `restart sessions` command, now call `SessionManager.killSessionByTmuxName()` instead of `killSession()`. `killSession()` resolves by session id; all three call sites were handing it a tmux name, so the lookup missed, the kill returned `false`, and nothing was killed.
- `TopicProfileOrchestrator` now reads the kill's return value. A failed kill aborts the respawn — previously the boolean was discarded and the spawn ran against a still-live session, which injected into it rather than launching, leaving the framework unchanged while the audit recorded `respawn-applied`.
- An aborted fresh respawn restores what it had already changed: the surviving session's resume entry is un-parked and its suppression marker cleared.
- A failed kill is a new breaker-attributable failure class (`kill-failed`), so a session that will not die bounds at the breaker threshold and reverts loudly instead of re-attempting on every idle window.
- After a respawn, the framework the spawn reports landing on is compared against the framework the pin resolved to. A mismatch writes `respawn-profile-mismatch` to the profile audit log instead of `respawn-applied`. This is signal only — it blocks nothing.

## What to Tell Your User

If you have ever pinned a conversation to a different framework — "use codex here", or a framework change through the topic command — and it seemed to take effect but the session kept behaving like the old one, that was a real bug and it is fixed. The switch was preparing correctly and then failing to stop the old session, so the new setting was never actually launched, while the log recorded it as applied. Pins now take effect on the next idle moment, and a switch that cannot complete tells you so instead of quietly claiming it worked.

## Evidence

- Before: on a live topic pinned to `codex-cli`, `GET /topic-profile/:id` resolved `framework: codex-cli` from `profile-pin` while `GET /sessions` still reported `claude-code` / `claude-opus-5` for that topic, with the tmux session's original creation time unchanged and no kill line in `logs/server.log`. `logs/topic-profile-changes.jsonl` recorded `respawn-applied` for that swap, and the user-facing handoff notice named the framework it had actually landed on ("Claude door") — the two disagreed and nothing compared them.
- After: five tests pin the behavior, each verified to fail against the unpatched code before passing. Four in `tests/unit/TopicProfileOrchestrator.test.ts` cover the abort on failed kill, the resume-entry restore, the bounded breaker settle, and the mismatch record; one in `tests/unit/topic-profile-server-wiring.test.ts` pins the composition root so neither kill port can be re-wired to the id-resolving kill.
