# Delight the User — in plain words

## What this is

Instar's rule book (the constitution, `docs/STANDARDS-REGISTRY.md`) gets a new rule called **Delight the User**. It says every Instar screen a person sees, in the Mac, iPhone and Android apps, the dashboard and the website, should be a pleasure to look at and easy to take in at a glance. People should enjoy using it for its good design, not just be able to use it.

The rule spells out five checks:

1. **Clear visual hierarchy.** One thing is plainly first. Size, weight and colour show what matters, instead of a wall of same-size text.
2. **One obvious next action.** The main button is visible right away, full size, with its whole label (no "…").
3. **Calm spacing and type.** Room between groups, readable text, nothing crammed.
4. **No internal ids or raw formatting.** No hashes, wait ids, UTC timestamps, stray backslashes or code-like values on screen. Times read the way a person says them ("since yesterday, 2:15 PM").
5. **Polish matched everywhere.** The same screen gets the same care on Mac, iPhone, Android and the dashboard.

Every screen change is checked against a screenshot from before the change and one from after.

## Why

There is already a rule for screens, *Operator-Surface Quality*. It makes sure a screen is reachable, plain and works on a phone. On 2026-11-18 the Work Board card in the Mac app was, in Justin's words, "pretty terrible": a wall of small grey text with leaked ids and tiny cut-off buttons. The leaked ids and tiny buttons already broke the old rule. The bigger problem, that everything looked the same so nothing told your eye where to start, broke no rule at all, because no rule asked whether a screen is nice to use. Justin asked for this new rule, Echo proposed the exact wording, and Justin said "yes" (topic 134088, 20:12 PST). The new rule sits under the old one: the old one is the floor, this one is the bar above it.

## What already exists

Every change to Instar's own code goes through a check when it is committed. The author writes a "side-effects review" answering set questions. One existing question already asks about screen quality. But that whole check skipped commits that only touched dashboard files, so the screen questions never ran on pure screen changes.

## What is new

- Commits that touch a screen file (dashboard code, styles, images and fonts; pairing pages; website pages, styles and images; the feedback page; approval pages) now always go through the check.
- The review gains a section, **6c. Delight the user**. The author writes how the screen reads against the five checks, and names a "Before:" and an "After:" screenshot. A brand-new screen says "none — new screen" for the before picture, and a removed screen says "none — screen removed" for the after picture. A change that touches two screens gives a pair for each. A change that moves nothing on screen says "no visible change" and why.
- When something on screen changes, a second reviewer has to look at the before and after pictures and name them in the review. Screen-only changes otherwise have no second reader, so without this "reviewed against screenshots" would only mean the author said so.
- The commit is refused if that section is missing, the answer is empty or just "yes" or "n/a", a named screenshot file does not exist, or the before and after are the same file.

## Safeguards and limits

The check only makes sure the answer and the screenshots are there. It does not judge taste: whether the screen really delights is decided by whoever reviews the change, and by Justin. The native apps live in their own code folders that this check cannot reach, and those folders have no review checklist to add it to, so they are held by their builders following the same five checks. The rule says that openly rather than pretending a check exists there, and adding a review prompt inside the app folders is handed to the session that builds the apps.

## What you need to decide

Nothing new. Justin already approved the rule's wording. Because the rule book is protected, the pull request needs his approval on GitHub before it can merge.
