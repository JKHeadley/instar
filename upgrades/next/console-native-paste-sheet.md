## What Changed

The console Sessions page has a native "Paste to a session" sheet over the existing `/pastes` routes, replacing the trip to the legacy Send content tab: a button under the list (target asked, most recently active preselected) and "Paste long text" in a local session's "⋯" menu (target fixed). It shows a live character and token count, says delivered / waiting / failed in words (a failed send keeps the text), follows live delivery events, and lists Recent pastes on this machine with an asked-once delete. A session on another machine is offered as "Open that session" instead, since a stored paste only reaches this machine. No server change.

## Evidence

Before: the Sessions page had no paste control; the old Send content tab lived only in the legacy dashboard. After (tests/integration/console-paste-sheet-routes.test.ts, tests/unit/console-paste-sheet.test.ts): the body the sheet builds, POSTed to the real `/pastes` routes, is delivered to the named running session (its notification reaches that session), waits when the session is gone, lists in Recent and deletes once; the jsdom run of the shipped console shows the sheet, the live delivery line, and "Open that session" for another machine.

## What to Tell Your User

You can paste long text to a conversation straight from the Sessions page now: tap "Paste to a session", pick the conversation, paste, and it tells you whether it was delivered.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Paste long text to a session from the console | Sessions page → "Paste to a session", or a session's "⋯" → "Paste long text" |
