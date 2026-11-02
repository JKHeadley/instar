# Why setup said "Can't reach Mama PC", and the fix (plain English)

## What happened

Each of your machines tells the others several ways to reach it, called ropes: its Tailscale address, its local network address, and its Cloudflare tunnel. When the Studio's Remote Desktop setup page checked Mama PC, it asked for "the best rope" for Mama PC and got only one answer.

The ordinary rule for picking that one rope does not allow plain Tailscale connections, so it skipped Mama PC's Tailscale rope (the one that works) and picked its local network address instead. But Mama PC runs Instar inside WSL on Windows, and the local address it reports is a private address inside Windows that no other machine can reach. The setup page tried only that one dead address, gave up, and said "Can't reach Mama PC", even though Mama PC answered fine over Tailscale.

## What already existed

The remote desktop code already had its own permission check that allows Tailscale when the local Tailscale app confirms the other machine is really on the tailnet. It just never got to use it, because it only ever saw the one rope.

## What is new

- The remote desktop calls (the setup page, the readiness check, and the live remote desktop session itself) now look at every rope the machine reports, in the usual order.
- They skip ropes the permission check refuses, and if a rope cannot even be connected to, they try the next one.
- If a machine answers at all, even with an error, that answer stands. They never resend a request that might already have arrived, because some of these requests make changes on the other machine.
- The whole check still finishes within the same time limits as before (8 seconds for setup, 3 for the others).

## Safeguards

Nothing about who is allowed to connect changes; the same permission check runs on each rope. A machine whose first rope works behaves exactly as before. The live remote desktop stream goes to the rope that actually answered.

## Not fixed here

Mama PC still advertises that unreachable WSL-internal address. The setup now works around it; stopping it from being advertised needs a careful change of its own, so it has been filed as a separate issue.

## What you need to decide

Nothing. This is a small change that a revert fully undoes.
