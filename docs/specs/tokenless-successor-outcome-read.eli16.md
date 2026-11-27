# "Was it sent?" now follows a reply that was re-sealed on its way out

## What this is

When an agent runs on more than one machine, only one of them actually talks to Telegram (the "lease holder"). The other machines hand their replies to it. If that machine is briefly unreachable, a standby that has no Telegram key keeps the reply safe and hands it over once the holder is back. When it does, it makes a fresh copy of the reply with a new identifier, so the old and new copies can never both be sent. The new identifier is the old one plus a short suffix such as "~r1-0a1b2c3d".

## What went wrong

The session that wrote the reply keeps the first identifier and can ask "was it sent?". The check is supposed to follow the link from the old copy to the new one. Three places that validate identifiers only allowed letters, digits and dashes, and the "~" in the suffix made them treat the link as invalid. The check therefore stopped at the old copy and answered "can't confirm", even though Telegram had accepted the reply. We saw this in the live two-machine test on 2026-11-15: the reply arrived, but the check still said unknown.

## What changes

The three checks now share one pattern that also accepts "~". The outcome check follows the link to the new copy and reports "delivered" with the Telegram message id. The same fix applies when another machine reports the link, and when a held reply's own style-check reference contains the suffix. The route that returns a held reply's text accepts the suffix too.

## What keeps it safe

Nothing is sent or blocked differently. This only changes what the check reads and reports. Values that are not identifiers, such as a space, a slash, or a link that points back to itself, are still refused. The check still never says "safe to resend" unless the old rules say so.

## What you need to decide

Nothing. It is a narrow bug fix that a revert fully undoes.
