# A zero-total credit pot is no longer treated as known

The cost-state tracker records how much of an SDK credit pot has been consumed.
That percentage needs a positive total credit amount.

Previously, a provider snapshot with total credit equal to zero still produced
a “known” object. Its consumed fraction became zero, which looked like a fresh,
unused budget, while the same object also said the remaining amount was at or
below its zero-dollar safety margin. The HTTP comparison route already treated
a non-positive total as unknown, so two routes disagreed about the same input.

The tracker now returns its existing unknown state when total credit is not a
finite positive number or remaining credit is non-finite. A real zero remaining
balance with a positive total stays valid and reports fully consumed.

Tests cover both sides. Restoring the old object for a zero total makes the new
boundary test fail.
