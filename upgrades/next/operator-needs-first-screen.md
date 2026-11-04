<!-- bump: patch -->

## What Changed

Everything that needs the operator now has one list, `dashboard/console/needs-model.js`, built from each page's own model: merging stopped, pull requests waiting for approval, feedback decisions, sign-ins, agents waiting, permission approvals, plans waiting on them, passwords requested, and spending limits that are on but not enforcing. Home's "What needs you" count and headline include all of it, and say "Nothing needs you that I can see" rather than a confident all-clear when one of those reads failed. Each page leads with its need and the control to act on it. Costs gets a new lead card, Development gets a button that opens Shipping when a pull request waits for approval, and the Agents pairing switch moves above the lists. Page wording no longer says "below". A warning that an invite leaked now offers "Make a new invite".

A new advisory outbound rule, `B22_SURFACE_REFERRAL`, nudges an agent whose message sends the operator to a page without a direct link, the exact on-screen words, or having loaded the page at the operator's screen size first. It is a nudge with a recorded override, never a wall. After loading the page, the agent resends with `--tone-complied B22_SURFACE_REFERRAL`.

## What to Tell Your User

Anything that needs you now shows on your home page and at the top of its own page, with the button right there. When I send you to a page, my message comes with a direct link and the exact words to look for, and I check the page first.

## Summary of New Capabilities

- One registry of what needs the operator, feeding Home's count and headline.
- A test that fails the build when a page buries a need, offers no action for it, or points at a place in its wording.
- `B22_SURFACE_REFERRAL`: an outbound nudge for sending the operator to a page.

## Evidence

Each of the nine states was put on its real page through a proxy that refuses all writes, in a real browser at 1280x728 and 390x844: all 18 runs show the action on the first screen with no scrolling and no sideways scroll, and screenshots were read. Home named "Automatic merging is stopped" with a link to it when that state was on. `tests/unit/console-needs-first-screen.test.ts` renders the shipped pages and carries negative controls. A dashboard opened on another machine sees merging, approvals and password requests only for that machine, as those pages do today.
