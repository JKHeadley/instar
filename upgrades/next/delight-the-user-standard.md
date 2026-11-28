<!-- bump: patch -->

## What Changed

The constitution gains a ratified article, *Delight the User*, under *Operator-Surface Quality*: every Instar screen a person sees should be a pleasure to look at and easy to take in at a glance (clear visual hierarchy, one obvious next action, calm spacing and type, no internal ids or raw formatting, polish matched across Mac, iPhone, Android and dashboard), and every screen change is reviewed against before and after screenshots. The instar-dev commit gate enforces it for changes to this repository: screen files (dashboard, pairing pages, website pages, styles and images, the feedback page, approval and secret-drop pages) are now in the gate's scope, and a screen change must carry a written answer in its side-effects review (§6c) with a before and after screenshot per screen and a recorded second-pass review naming them, or a reasoned "no visible change". The existing screen-quality question (§6b) no longer accepts an unanswered copy of the template. The bundled side-effects template carries the new §6c.

## What to Tell Your User

Nothing changes in how you use your agent. Instar's own rule book now says every screen should be a pleasure to use, and changes to Instar's screens are checked against before and after pictures before they land.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Delight the User standard and its commit check | Automatic for anyone changing Instar's own screens; answer §6c of the side-effects review with Before/After screenshots. |

## Evidence

Unit tests drive the real commit hook in a sandbox repository through refused and accepted screen commits (no trace, no §6c, a missing screenshot, css-only and image-only changes, no second reader, a review that does not name the pictures, a deleted screen, a complete reviewed answer, "no visible change", and an untouched non-screen change). Pure-check tests cover both sides of every rule, including path aliases, identical bytes, unreadable pictures and shared file names.
