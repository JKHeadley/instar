# Side-effects review: three silent gates get an alarm

Changes: (1) `HeldForwardItemCollapser` item ids are episode-scoped (`telegram-origin-held:<topic>:<episodeStart>`, aggregate `telegram-origin-held:aggregate:<burstStart>`), and the expiry item id is per operation (`heldExpiryItemId`); (2) `classifyProtectedWait` protects a `sleep N` while elapsed ≤ N + 60 s (inside the existing 2 h protected-wait bound), and server.ts injects one first-party notice into the session whose process the watchdog first signalled (`formatWatchdogSessionNotice`, deduped per session+pid); (3) `FeedbackTriageService` keeps a `since` on the quota pause and raises one `feedback-triage:quota-paused:<since>` item when a pause reaches 6 h with candidates waiting.

Principle check: all three are signals. None blocks, retries, restarts or changes any authority. The watchdog sleep floor narrows when the watchdog acts (it can only make the watchdog act less), consistent with the existing protected-wait floors.

1. **Over-block** — (2) a genuinely hung process named `sleep N` is protected for at most N + 60 s and never past 2 h; `sleep` cannot hang in a way that matters before its own deadline. No other command is affected.
2. **Under-block** — (1) a restart resets the in-memory collapser, so a hold continuing across a restart can raise a second item for the same episode (bounded: one per restart). Items are not auto-resolved when a hold clears (unchanged). (2) The notice reaches a session only through tmux injection; a session that is mid-turn sees it after its turn, which is what the stand-down notice already does. A poll loop whose wait is not `sleep` (e.g. `gh run watch` is already protected; a custom `read -t`) is not covered by the floor, but its owner is now told when it is interrupted. (3) Quota pauses shorter than 6 h stay silent by design; the status route already shows them.
3. **Level of abstraction** — (1) fixed in the id producer rather than the attention store, because store-wide "re-raise a closed id" semantics would change every caller. (2) the notice is produced beside the existing user-facing formatter, from the same event. (3) inside the triage tick, which is where the pause is decided.
4. **Signal vs authority** — signals only (docs/signal-vs-authority.md): no new blocking authority. The sleep floor removes authority from the watchdog for a narrow, deterministic case.
5. **Interactions** — (1) the aggregate's `supersedes` list is returned but no caller resolves items with it (checked). (2) the watchdog's existing user-facing message (SIGKILL/session kill only) is unchanged; the session notice fires on the first targeted SIGINT, which never reached anyone before. The 60 s outcome check and the audit log are unchanged. (3) the triage quota check is unchanged; only a `since` field is added to the existing `quota_pause` meta row (readers that ignore it are unaffected; `GET /feedback-factory/triage/summary` now also shows `since`).
6. **External surfaces** — new attention item ids and one new item class (triage quota pause); one new first-party injected line into sessions after a watchdog interruption.
7. **Multi-machine posture** — machine-local by design: holds, watchdog interventions and the triage quota reading are each owned by the machine that has them; triage runs only on the canonical owner.
8. **Rollback cost** — revert the commit. No data migration; old open items keep their old ids.

Second-pass review: required (watchdog). Not run in this session: it was produced by a forked worker that cannot spawn a reviewer. Flagged to the coordinating session; the PR carries the hold label until a reviewer concurs.

## Class-Closure Declaration

- defectClass: `unbounded-self-action`
- closure: `n/a`
- reason: no loop is added. Each new emission fires at most once per hold episode, once per interrupted process (bounded 500-entry dedupe set) or once per triage quota pause, driven by an external event, never by its own output.
