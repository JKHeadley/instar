# Empty benchmark windows no longer look perfectly attributed

The benchmark-divergence summary reports what share of recorded decisions did
not identify the model that made them. That share is useful only when the
matured analysis window actually contains decisions.

Previously, an empty window returned zero. A reader could reasonably interpret
that as “zero percent of decisions are missing model attribution,” even though
there were no decisions to inspect. The same value therefore represented both
perfect attribution and no evidence.

The summary now returns null when its decision denominator is empty. Once any
decisions exist, it keeps the existing calculation: missing decisions divided
by all decisions. Verdict counts and unanalyzed-loss reporting are unchanged.

The regression enters a genuinely empty matured window and asserts both the
empty verdict map and the null share. Restoring the old zero fallback makes that
test fail directly, while the existing half-missing measured case remains
numeric at one-half.
