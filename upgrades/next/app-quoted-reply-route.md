# Reply to a specific App message

## What Changed

The App server can accept a signed reply to a specific message. It stores the link to the original with the reply and binds it into the machine receipt. It checks access to the original at send time and gives the same answer for a missing or inaccessible original. Retrying the same request keeps the same target and does not send another reply. Ordinary history and sync do not include the link yet.


## What to Tell Your User

Reply is off by default while the server and native menu are being verified. When it ships, Reply will let you point to the exact message you are answering.


## Summary of New Capabilities

A default-off App Reply route that accepts an exact original message and records that relationship, signed, alongside the reply. Showing the quoted original, or that it is unavailable, in history is not part of this change.


## Evidence

Not reproducible in dev — the earlier server had no signed quoted Reply action to exercise. In a disposable agent, the enabled candidate accepted a signed reply to a visible original, returned the same recorded outcome on retry, and stored one reply. A denied or missing original returned the same unavailable response. Native acceptance remains pending.
