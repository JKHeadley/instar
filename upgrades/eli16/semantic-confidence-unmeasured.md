# Empty semantic memory no longer has a zero-percent confidence

Semantic memory stores facts, lessons, and other entities with confidence
scores. Its statistics show the average confidence, while the decay command
shows the minimum, maximum, and average after aging or expiring entries.

Previously, an empty store reported a zero-percent average. A decay run that
processed entries but expired all of them reported zero for all three
confidence values. Those numbers look like measurements of very low-quality
knowledge, even though no active entity remained to measure.

The statistics now return null when the store is empty. Decay reports return
null confidence values when their active-entity denominator is empty, whether
the run started empty or removed every expired entry. The CLI prints “n/a” and,
for the all-expired case, names that no active entities remain. Counts, expiry,
decay, search, and storage behavior are unchanged.

The tests deliberately enter both empty shapes and retain the existing measured
average case. Restoring the zero fallbacks makes all three new assertions fail.
