# Pairing check for the two rule books, in plain words

Instar 1.x and 2.0 each have a written copy of the rules, and changes to one often never reached the other. This adds the first working part of the requirement Justin asked for.

Any pull request that changes the 1.x rule book now has to carry one line: which matching change it pairs with in 2.0, or why it has none. My merge tool checks that the line is there and that the named change really exists and really touches the other book. If not, it refuses and says exactly what to add. Adding the line doesn't cancel an approval.

It only checks that a pair exists. Whether the two say the same thing, or whether "no pair needed" is honest, stays with the independent review.

Nothing here changes the rule books themselves. Those wordings still need Justin's own approval, and come separately. This also adds a map of how the two books differ today, and corrects one document that wrongly said no rule change could land at all.

Other agents are unaffected: the check does nothing outside these two repositories. To undo it, revert this change. No data needs fixing.
