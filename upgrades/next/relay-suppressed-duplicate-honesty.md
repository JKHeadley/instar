<!-- bump: patch -->

## What Changed

**When the server suppresses a duplicate message, the relay now says so instead of reporting it
as sent.** Instar drops an exact repeat of a message already delivered to a topic recently — that
guard works and is unchanged. What was broken is what the agent was told afterwards.

The server answers that case with HTTP **200** and `suppressedDuplicate: true` in the response
body: 200 because a suppressed send is not an error from the server's side, with the real outcome
carried in the body. `telegram-reply.sh` branched only on the status line and discarded the body,
so it printed `Sent N chars to topic N` and exited **0**.

The exit status is the only delivery signal most callers check, which made a suppressed send
indistinguishable from a delivered one. The agent ticked the reply off and moved on; the user
received nothing. There was no error, no retry, and no log entry — the failure was silent in the
worst direction, because the agent was confident.

The relay now reads the field it was already being sent. On a genuine suppression it prints
`NOT SENT — suppressed duplicate for topic <id>; an identical message was already delivered to
that topic recently` (naming the delivery id when the server supplies one) and exits **1**.

The check is deliberately strict rather than generous, because the opposite mistake is worse: a
false `NOT SENT` would make an agent re-send a message the user already has. It requires the value
to be exactly boolean `true` (the string `"true"` does not count), and a missing field, an
explicit `false`, an unparseable body, or a missing `python3` all fall through to the previous
behaviour. Every uncertain input resolves toward the old path, never toward a false alarm.

**Existing agents receive this, not just newly created ones.** Instar agents update in place, so a
template change alone would have reached only agents created after it. The pre-fix script's
sha256 is now registered in the migrator's known-shipped set, which is what lets it recognise a
deployed copy and upgrade it. Without that entry the migrator would classify every agent in the
field as locally-modified, drop a `.new` file beside the old script, and every existing agent would
keep the mis-reporting version. A locally-customised script is still never overwritten — it keeps
its place and gets the new version alongside for the operator to reconcile.

## Evidence

- **Unit (8 tests)** — drives the real script against a stubbed transport: suppression reported and
  non-zero exit, delivery id named when present and omitted when absent, plus the fail-open
  guards (string `"true"`, explicit `false`, non-JSON body, and a 408 that must keep its existing
  AMBIGUOUS branch). Verified to fail for the right reason: against the pre-fix template the 3
  detection tests fail while the 5 no-regression guards pass in both directions.
- **Integration (8 tests)** — runs the real `migrateScripts()` against a pre-fix script already on
  disk in both deployed locations; asserts the upgrade, the backup, executability, double-run
  idempotency, and that a customised script is preserved with a `.new` candidate. Verified
  load-bearing: removing only the registered sha fails 4 of the 8, including the one asserting a
  deployed script is actually patched.
- **E2E (8 tests)** — stands up an agent that already exists on the pre-fix relay, confirms it
  exhibits the defect, runs the real public `migrate()`, then executes that agent's own upgraded
  script and asserts it reports the suppression honestly. Both the `.claude/` and the
  framework-neutral `.instar/` copies are covered, and a genuine send still succeeds.
- The patched template is byte-identical to a version proven in live operation before being
  carried upstream.

## What to Tell Your User

- **Some replies you never received were reported to me as sent — this fixes the reporting, and
  you don't need to do anything.** If I tried to send you the same text twice in quick succession,
  the second copy was dropped on purpose (that part is a feature). The bug was that I was told the
  drop had succeeded, so I believed I had answered you when nothing had arrived. I now find out,
  and can tell you or send something different instead.
- **This reaches agents that already exist, not just new ones**, so no reinstall is needed — it
  arrives with your next update.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Suppressed duplicates reported as `NOT SENT` with a non-zero exit | Automatic. `telegram-reply.sh` reads `suppressedDuplicate` from the 200 response instead of discarding it. |
| The fix reaches agents that already exist | Automatic on update. The pre-fix script's sha256 is registered in the migrator's known-shipped set, so deployed copies are recognised and upgraded (a customised script is preserved with a `.new` candidate). |
