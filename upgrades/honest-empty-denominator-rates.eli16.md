# Honest rates when there is nothing to measure

Two internal reports were displaying `0%` when they had no observations at all.
One summarizes how often dispatch decisions are accepted. The other summarizes
how often recorded job runs succeed. In both cases, an empty history was being
turned into the number zero.

Zero is a real measurement: it says observations existed and none succeeded.
An empty history is different. It means the system has no denominator and
cannot calculate a rate yet. Treating those states as identical makes a new or
unused component look confidently unsuccessful, just as treating an empty
history as 100% would make it look confidently perfect.

The reports now return `null` for those two rates when the corresponding count
is zero. As soon as at least one decision or run exists, their calculations are
unchanged. Existing non-empty values still range from zero to one.

The command-line pattern summary also understands the nullable shape. It never
performs arithmetic on an unavailable rate and labels that state as unavailable
if it reaches the formatter. The ordinary no-records path still gives its
existing plain-language message.

Focused tests cover both empty histories and the existing non-empty
calculations. This is a reporting correction only: it changes no dispatch
decision, job outcome, scheduling behavior, stored record, or blocking gate.
