# Maturation board: an empty measure no longer hides the whole review — ELI16

The maturation board shows every feature Instar is maturing: what stage it is in, what is being measured and how it is doing. It reads the latest saved feature-maturation review. Each feature in a review can carry a small "measure": what is counted, its value now, its target and the value before.

On 27 November the review could not measure 29 features, so it wrote their measures with every field empty. The board treated an empty measure as broken and threw away the whole review because of it. It quietly fell back to the review from four days earlier, so anyone reading the board, people and other agents alike, saw stale numbers without being told.

This change reads a measure whose every field is empty as "no measure", the same as leaving it out. Only a true placeholder counts as empty: the four value fields are empty, the trend is missing or "unknown", and there are no other fields. A measure that is half filled in, one that claims a trend such as "better", or one with unrecognised fields is still treated as broken, because those really are mistakes in the review. Nothing else about the board changes.
