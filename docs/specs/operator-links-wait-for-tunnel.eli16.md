# Operator links wait for the tunnel instead of sending localhost

## What this change is

When the agent needs the operator to do something, it sends a notice with a link to the right dashboard page. The operator reads those notices on a phone. A link only works on the phone if it uses the tunnel's public address. A `http://localhost:4042/...` address only opens on the machine the agent runs on.

Several notices built their link the same way: use the tunnel's address if it is up, otherwise use localhost. Right after a server restart the tunnel takes a little while to come up. On 2026-11-09 at 20:40 PST the sign-in repair reminder ran during that window and sent the operator a localhost link his phone could not open. The rule it broke: every warning needs a path to act, and a link must open on his phone.

## What already exists

- The sign-in repair reminder (added the same day), which reminds once about a repair waiting for approval.
- The sign-in repair notices themselves (approval needed, needs you, repair ended), sent through a delivery queue that retries on failure.
- The feedback factory's daily "things that need you" list, which marks each item as shown once it goes out.
- The "ratify these deferrals" message during autonomous runs, which always used localhost even when a tunnel was up.

## What is new

One shared helper decides which address a notice link uses:

1. Tunnel up: the public address.
2. Agent has no tunnel at all: localhost, because that is the only address it has.
3. Tunnel configured but not up yet: wait. The notice is not sent now and is tried again on the next pass.
4. Tunnel still down after 30 minutes: localhost, so a broken tunnel never hides a notice forever.

Each notice that carried the old pattern now uses it. The reminder skips this pass and tries again in 15 minutes. The sign-in repair notices go back to their queue's normal retry. The feedback list waits without marking anything as shown. The ratify message leaves the link out while the tunnel starts, because replying "yes" to it still works.

## The safeguards

- The urgent "tap Yes on your phone" sign-in prompt has no link and is never held.
- Closing a finished repair's notice never waits on the tunnel.
- A held notice is not counted as sent, so it cannot be lost by being marked delivered.
- The 30-minute ceiling means a tunnel that never comes up delays a notice but never swallows it.

## What the reader needs to decide

Nothing. It is a bug fix. To undo it, revert the change. It stores nothing new.
