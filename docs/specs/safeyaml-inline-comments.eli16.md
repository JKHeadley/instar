# YAML Inline Comments — Plain-English Overview

## The problem in one breath

Instar specs carry a little block of settings at the top of the file, and one of those
settings is `approved: true`. Several gates read that setting to decide whether a spec has
been signed off. If you write a note on that same line explaining *who* approved it and
*when* — the most natural thing in the world to do — the gate stops seeing the spec as
approved at all. **The comment that records the approval is what voids it.**

## What already exists

Instar reads those settings blocks with a small, deliberately narrow YAML parser
(`src/core/SafeYaml.ts`). It was written to avoid pulling in a large third-party YAML
library for what is a handful of simple key/value lines, and that trade-off is still the
right one. It handles booleans, numbers, strings, and simple lists.

What it did not handle was a comment at the end of a line. Real YAML lets you write:

```yaml
approved: true  # operator preapproval, topic 11960, 2026-07-11
```

and the value is the boolean `true`, with everything after the `#` discarded as a note for
humans. Instar's parser kept the whole rest of the line, so the value became the *string*
`"true  # operator preapproval, topic 11960, 2026-07-11"`.

That string is not `true`. Every gate that checks `approved === true` — correctly, and
exactly as designed — concluded the spec was not approved. The file visibly says
`approved: true` on screen, so the failure reads as a mystery: the gate insists the flag is
missing while you are looking straight at it.

## What this adds

One helper function, `stripInlineComment`, and two call sites that use it.

Before a value is interpreted, a trailing comment is removed. That is the whole change —
about 39 lines including its explanatory comment.

## The new pieces

**`stripInlineComment(raw)`** walks the value one character at a time and cuts at the first
`#` that begins a comment. It is applied in two places, because the same defect exists in
both: ordinary values (`key: value  # note`) and list items (`- item  # note`).

The interesting part is what it deliberately does *not* cut, because YAML's rule is
narrower than "remove everything after a `#`":

- A `#` that is **not preceded by a space** is part of the value, not a comment. So
  `url: http://host/page#section` keeps its fragment intact.
- A `#` **inside quotes** is content. So `title: "sharp # sign"` is left alone.

Both of those would be silent data corruption if we got them wrong — quietly truncating
someone's URL or title — which is why the conservative half of the behaviour is tested just
as heavily as the fix itself.

## The safeguards

**Prevents the fix from eating real data.** Five of the thirteen new tests exist purely to
assert that things which are *not* comments survive untouched: URL fragments, `#` inside
double quotes, `#` inside single quotes, a `#` with no space before it, and values with no
comment at all. These five pass both before and after the change — they are regression
guards, not proof of the fix.

**Prevents the fix from being fake.** The other eight tests fail against the old parser and
pass against the new one. That was verified by reverting the source, re-running the suite,
and confirming 8 failures — a test that passes without the fix would prove nothing.

**Prevents the same defect from surviving in its sibling.** The identical bug existed for
list items. Fixing only the value case would have left the class half-open, so both call
sites are fixed and both are tested.

## What ships when

This ships immediately and on by default. There is no flag and no dark period, for one
reason: today's behaviour is unambiguously a bug, and no correct spec can be relying on an
approval flag being silently ignored. Anything currently mis-parsing starts parsing
correctly.

The visible effect is that a small number of specs — nine on `main` at the time of writing,
out of 522 carrying an `approved:` line — stop being invisibly unapproved. Those nine are
not random: they are the specs whose approvals were documented most carefully, which is
what made this worth fixing rather than working around.

## What you actually need to decide

Nothing, unless you disagree with the conservative rule.

The one judgement call is what counts as a comment. This change follows the YAML
specification: a `#` starts a comment when it is at the start of the value or preceded by
whitespace, and never inside quotes. The alternative — stripping every `#` — would be
simpler and would corrupt URLs, so it was rejected.

If you would rather see the nine affected specs edited by hand instead of the parser fixed,
that is a legitimate call and this change can be reverted with no cleanup. It is not the
recommendation, because hand-editing fixes nine files while the parser fix closes the class
for every spec written from now on.
