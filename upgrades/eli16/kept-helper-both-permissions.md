# Kept Mac desktop helper: one trip to the Mac, not two (ELI16)

## What this is

On a Mac, remote desktop runs a small helper program. macOS gives that program two separate permissions: Screen Recording (so it can see the screen) and Accessibility (so it can move the mouse and type). Instar now keeps one permanent copy of the helper, the "kept copy", so ordinary updates do not wipe those permissions. There is still the older "installed copy" inside the Instar package.

If the installed copy already holds a permission the kept copy does not, Instar keeps using the installed copy so nothing that works stops working. That is the situation this change is about.

## The problem

Say the installed copy has Screen Recording but not Accessibility, and the kept copy has neither. Overall the Mac is missing only Accessibility, so the message told the operator: "allow Accessibility for the kept copy". The operator does that. Now the kept copy has one permission and the installed copy has one. That is a tie, and a tie hands serving back to the kept copy, which still lacks Screen Recording. So the operator has to walk back to the Mac a second time. Meanwhile the guided setup page named the installed copy, while the notice named the kept copy, so the two instructions did not even agree.

## What changes

- While the installed copy is serving because it holds a grant the kept copy lacks, the message now asks for every permission the kept copy is missing (here: Screen Recording and Accessibility), on the kept copy's path.
- Guided setup now names the kept copy too, so the page and the notice say the same thing.
- When the kept copy itself is serving, nothing changes: it still asks only for what is missing.

## Safeguards

Nothing about which copy actually runs changes. No permission is granted or removed by this change; it only changes the words and the path shown to the person at the Mac. A revert fully undoes it.

## What you need to decide

Nothing. This is a wording and pointer fix that saves the operator a second trip.
