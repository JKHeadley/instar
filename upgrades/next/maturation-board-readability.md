## What Changed

The maturation board page (`/dashboard/maturation/` and the console's Feature maturation page) is
redesigned for a glance: one plain answer sentence ("182 features: 69 working, 97 need attention"),
a coloured square per feature, and plain groups (Broken, Stuck, Not measured, On its way, Working,
Being retired) in place of the review's verdict words. Rows show a human name, a plain area, one
short line and one chip (Nobody on it / Fix underway / Fix assigned / Can't tell); evidence, ids and
live records are folded under "Technical details". The filter dropdowns are replaced by one search
box and one "nobody on it" switch. Review files may now carry three optional plain-language fields,
`area`, `summary` and `nextStep`, which the board shows when present.

## What to Tell Your User

The feature maturation page is much easier to read on a phone: one sentence, one picture, and plain
groups, with the details one tap away.

## Summary of New Capabilities

- Glanceable maturation board layout (plain groups, square map, human names).
- Optional `area`, `summary`, `nextStep` fields in `maturation-review/1` review files.

## Evidence

Operator feedback on the first served version (2026-10-30, "impossible to digest"). Screenshots of the
served redesign read at 1280 px and 390 px, light and dark. View-model and jsdom tests rewritten (16)
including "no ids on the first screen" and text-only rendering; builder test for the new fields.
