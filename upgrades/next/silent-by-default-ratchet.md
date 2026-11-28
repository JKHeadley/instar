# New notification senders stay quiet unless a reviewed list says otherwise

## What Changed

Instar's rule is that new notification senders ship quiet and opt in to reaching a person, never the reverse. Until now nothing checked that when a sender was built: it rested on review noticing. Now a unit test computes, from the shipped code, every notification category that reaches a person by default while the Quiet by Default gate is enforcing (it pushes, or is delivered rather than held quiet), every registered sender that writes into one, and every place in the code that writes a loud notice inline, and compares them with a reviewed list, docs/notification-default-posture-baseline.json, where each entry carries its reason. A new sender into a quiet category passes untouched. A new loud default, or a new sender into a loud category, fails the unit suite until the list is widened in the same change, which puts it in front of review. Nothing about delivery changes.

## What to Tell Your User

Nothing changes in what reaches you. New features now have to be quiet by default unless someone deliberately decides otherwise, so your phone should not start buzzing because of a feature nobody meant to be loud.

## Summary of New Capabilities

No new capability. A build-time ratchet keeps new notification senders silent by default.

## Evidence

Before: no check of a new sender's default posture (standards registry, "Notices Route to the Alerts Topic", sub-obligation silent-by-default-emitters, named unenforced). After: tests/unit/notification-silent-by-default-ratchet.test.ts passes against today's 11 loud categories, 7 loud registered senders and 22 inline loud literals in 7 files; two probes (a new sender into the owner-decision category, and an inline owner-decision literal) each failed it and were reverted.
