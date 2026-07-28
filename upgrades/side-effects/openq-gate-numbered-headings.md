# Side effects — open-questions gate: numbered-heading recognition

## What this change can affect

`write-convergence-tag.mjs` is the structural gate for `/spec-converge`. Widening
heading recognition changes which specs the gate can SEE, so both directions were
checked rather than only the one being fixed.

## Newly-visible sections (the intended effect)

A spec whose `Open questions` section is numbered was previously invisible to the
gate; it is now parsed. **Consequence to state plainly: a spec that would have been
stamped before may now be REFUSED — correctly — because it carries a live
unresolved question that the gate could not previously see.** That is the point of
the fix, and it is a behaviour change for any such spec mid-flight.

## Not changed, deliberately

- A genuinely ABSENT `Open questions` section still yields "nothing parked on the
  user". Whether an absent section should instead fail closed is a separate argued
  decision; smuggling it in here would be a semantic change hiding inside a
  matcher fix. Tracked, not silently taken.
- Resolution semantics are untouched: `*(none)*`, `(none)`, `None`, `N/A`,
  blockquote commentary and horizontal rules still count as resolved, including
  under a numbered heading (explicitly tested, so the fix cannot become
  "refuse every numbered spec").
- `GRANDFATHERED_SLUGS` is untouched and remains empty.

## The decision-points gate

That sibling previously refused a numbered heading with `missing-section`. That is
a FALSE refusal — the section was present, merely numbered — so it now recognises
the same shapes. This makes the gate less likely to block a conforming spec; it
does not weaken it, because an actually-missing section still refuses.

## Blast radius and rollback

Two files: one script, one test file. No route, no config key, no persisted state,
no migration. Rollback is a revert.

## Honest limit

The matcher tolerates a bounded set of section-label shapes. An exotic heading
(e.g. a roman numeral, or an emoji prefix) would still be invisible, and the
underlying design remains "match a heading by name". A structurally stronger
answer — a declared anchor rather than a heading regex — was NOT attempted here
and is a larger change than this repair.
