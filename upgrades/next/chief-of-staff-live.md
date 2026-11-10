<!-- bump: patch -->
## What Changed

The fifth piece of the Chief of Staff (docs/specs/chief-of-staff-topic.md §1.3, §3, §4, §6, Migration): the loose ends before its pilot. The daily note and the cap on urgent messages are now kept as records in the shared store, and the "needs you" lines are worked out fresh from the records each time, so a restart or a machine hand-over can neither drop a line nor send the note twice. When the lease moves to another machine, the new holder can now close out an action the old one left half-done once enough time has passed, and the record says whose it was. Confirming "done" from a note button now re-checks the automatic items at that moment, needs a live check-in, and writes the verified close before the project is closed. The owner's phone can check in from the app. And the first-run triage list exists: one PIN-gated tap renders a private page recommending keep, review or archive for each active project with the reason from the record itself, so the pilot starts from a reviewed list rather than everything at once.

Dev-gated like the earlier pieces; nothing changes on an agent where the feature is off.

## What to Tell Your User

Nothing yet on a normal agent. On a development agent: the Chief of Staff keeps its notes straight across restarts, you can check in from the app as well as the dashboard, and when you are ready to start the pilot it will hand you a triage page of your current projects to approve.

## Summary of New Capabilities

- `note` records: the note cadence and the immediate-message cap fold from the store; Needs-you items derived at note time.
- Failover settle: the current holder settles a previous holder's stale intent (outcome names the prior holder).
- Verified close: `confirm-done` requires a live lease, re-checks deterministic items, records `done-verified` (owner-confirmed).
- `POST /mobile/chief-of-staff/check-in` (owner phones); `POST /chief-of-staff/triage` (PIN) → a private triage view; `ChiefOfStaffTriage` (pure).
- Live-proof fixes: the holder's own machine proves lease freshness with its own live lease (actions no longer stall at `claimed` on the holder); the start-run executor accepts the register route's real reply (restarts no longer abort as `register-failed:200`); `getChatMemberCount` / `getChatAdministrators` classified at the Telegram egress door (the one-reader rule and memory-privacy reader count can run).
- `POST /chief-of-staff/projects` (PIN): the owner binds a conversation as a project (confirmed binding + tree link); `POST /chief-of-staff/projects/:key/tap` (PIN): Unpark / Confirm-done from the dashboard.

## Evidence

- `tests/unit/ChiefOfStaffLoop.test.ts`: parked project reaches the note from the fold with a fresh instance; note cadence from records across instances; immediate cap from records; unknown streak derived; confirm-done ignored when paused / when a check fails (note names it) / closes and mirrors when all pass.
- `tests/unit/ChiefOfStaffActionProtocol.test.ts`: the holder's own machine executes and settles with no peer-observed renewal; previous-holder settle — non-holder unknown, fresh claim unknown, older claim settled with the prior holder named.
- `tests/unit/chief-of-staff-triage.test.ts`: floors, tunables, ordering, counts, escaping, empty tracker.
- `tests/integration/chief-of-staff-app-surface.test.ts`: the owner's paired phone checks in; a Bearer caller is refused; feature off ⇒ 503.
