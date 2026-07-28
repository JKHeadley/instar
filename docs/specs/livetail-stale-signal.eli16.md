# ELI16 — The conversation-copier admits when it's falling behind

## The problem

When Echo runs on two machines, the awake one continuously copies recent
conversations to the standby so a takeover feels seamless. Earlier today we
gave that copier proper retry manners (back off when the other machine rejects
an update, up to one try per 5 minutes, forever — "forever" is right, because
the copy should catch up whenever the other machine recovers). But one piece of
the new loop standard was still missing: if a conversation's updates kept
failing for hours, nothing ever said so. The standby's copy of that
conversation would just quietly go stale — and if a machine takeover happened
during that window, the conversation would resume from an old snapshot with no
warning that this was even possible.

## The fix

When a conversation's updates have been failing for 30+ minutes, the copier
records ONE note per outage in the standard housekeeping channel (the
degradation log — not a Telegram ping): which conversation, how long, how many
failed tries. Then it keeps quietly retrying. When the updates succeed again,
the note re-arms for any future outage. Even if EVERY conversation went stale
at once, the alerting layer's built-in cooldown means at most one alert — never
a flood.

## What changes for you

Nothing day-to-day. On the bad day, "the standby's copy was stale during that
outage" becomes a recorded, checkable fact instead of an invisible surprise.
