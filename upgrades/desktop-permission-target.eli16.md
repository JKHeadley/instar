# Desktop permission prompt on every target: plain English overview

## What this change is

Remote desktop on a Mac needs two macOS permissions. A helper route asks the Mac
to show its permission prompts so a person sitting there can allow them. That
route was broken on every machine except the one chosen as the front door for
the dashboard, which is backwards: the other machines are the ones you connect
to, so they are the ones that need the prompt.

## What already exists

Each machine builds its own desktop target object. The server only hands that
object to its web routes on the front machine, so that the routes which admit a
browser and control a screen exist in one place. The permission route used the
same handle, so everywhere else it reported that remote desktop was off, even
though the target was running. On 1 November the Mini, the Laptop and the M5 Pro
all showed this.

## What is new

A small helper splits the target into two things: the full handle, given only to
the front, and a single function that shows the permission prompts, given to any
machine that built a target. The permission route uses that function. Nothing
else moves.

## Safeguards

All browser admission, target-list, cursor, ticket and revoke routes stay
front-only, and a test checks each one still refuses on a non-front target. The
permission route keeps its token, its intent header and its limit of once a
minute. It grants nothing: a person must still allow the prompt at the Mac. A
machine with no desktop target still answers 503.

## What you need to decide

Nothing. A revert restores the old behaviour.
