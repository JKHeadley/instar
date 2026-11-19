# Owner decisions get delivered — in plain words

## What was wrong

Instar has a "Quiet by Default" filter on Telegram. When the agent sends something automatically (a job report, a background progress line), the filter puts it in a quiet feed on the dashboard instead of pinging the owner, unless the owner asked to see that kind of report. That keeps the owner's phone calm.

Some automatic messages are not reports, though. They are questions only the owner can answer, with a button: "Unpark this project?", "Pause Instar 2.0?" (the owner taps to confirm), "Enrol this machine for maintenance?". These all go out through one sending function, which never said what kind of message it was. The filter treated them as unlabelled reports and filed them in the quiet feed. On Echo, 40 of them were filed quietly in one evening. The owner never saw them, so nothing they were asking could happen.

## What changes

There is a new message kind called "owner decision". The filter always delivers it, like the existing phone-pairing result. The owner cannot switch it to quiet, and it is never redirected somewhere else.

Only the agent's own server code can label a message this way, inside the one function that sends button lists. Nothing that comes in from outside (a request, a session, a script) can claim the label. If a caller already labelled its message (the recommended-services list does), that label is kept and nothing changes for it.

To stop a bug from flooding the owner, at most 10 owner decisions go to one topic in 10 minutes. Anything past that is filed quietly.

## A small extra fix

When the agent asks the owner to pause a project, it cites the owner's own message, including the date it was sent. Until now the date in that citation was not checked. Now a citation with the wrong date is refused, so the citation always names the real message.

## What stays the same

Ordinary automated reports stay quiet, exactly as before. Private-chat buttons to the owner were already delivered and are unchanged. Undoing the change is a plain revert: no stored data changes.

## What to decide

Nothing new. The Chief of Staff approved this as maintainer: buttons only the owner can answer are decisions, not reports, which fits the owner's rule that reports are chosen per job.
