# Report-Backed Converging Audit — Plain-English Overview

## The one-sentence version

Fix the broken check that's supposed to confirm a design doc was properly reviewed,
and make "properly reviewed" mean the review actually ran (and left its report) — not
that someone just typed a tag.

## Why we need it

Before any design (a "spec") turns into shipped code, it's supposed to go through a
converging review — multiple angles, until no new problems turn up. Two separate
guards are supposed to enforce that. Grounding the work against the real code turned
up a genuine, quietly-broken guard:

- The **formal** guard checks for a review tag that equals the word `true`. But the
  actual review tool writes a **timestamp** instead. A timestamp isn't the word
  `true`, so the formal guard **rejects every properly-reviewed spec** — it's been
  broken.
- The **commit-time** guard isn't broken, but it's loose: it accepts any review tag at
  all, even one a person typed by hand with no real review behind it.

So one guard is broken, the two disagree, and neither confirms the review *actually
happened*.

## How it works

1. **Fix the broken guard.** Accept the timestamp the real tool writes (and still
   accept the old `true`, so nothing else breaks). One tiny shared definition of "the
   review tag is present," used everywhere and tested against every form.
2. **Make it mean something.** Add an opt-in switch: when it's on, both guards also
   require the review's **report file** to exist — the proof the review actually ran,
   not just a tag. That makes the real, report-backed review the default standard.
3. **Keep the two guards honest with each other.** The commit-time guard is a script
   that runs before the code is even compiled, so it can't share code with the formal
   guard. Instead a test feeds the same examples to both and fails the build if they
   ever disagree — so they can't quietly drift apart.

## What changed for users

Almost nothing, unless you turn the switch on — it ships **off by default**, and with
it off, today's commit workflow behaves exactly as before. The only unconditional
change is the bug fix, which only makes the formal guard accept the reviews it should
always have accepted. Turn the switch on and the standard tightens: a spec counts as
reviewed only when its review report is actually there.

## The main tradeoffs

- **Don't break the thing that ships everything.** The commit guard runs on every
  commit, so a mistake there could block all work. The report requirement is behind an
  off-by-default switch, and there's an end-to-end test proving the default path still
  commits cleanly.
- **Two guards, one truth.** They can't literally share code (one runs before
  compilation), so a test enforces that they always agree — structure, not willpower.
- **Surface, don't force.** Whether an outside model also reviewed the spec is shown,
  not required — forcing it would block anyone whose outside-model tool isn't logged
  in, which isn't the point.
