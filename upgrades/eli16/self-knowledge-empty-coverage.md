# An empty knowledge tree no longer reports zero-percent coverage

Self-knowledge coverage is the number of valid tree nodes divided by the total
number of nodes. A tree can be syntactically valid while containing no nodes,
so there is no denominator for that calculation.

Previously, validation returned zero in that case. The HTTP health response
published the zero, and the machine check displayed “0% coverage” beside “0
nodes.” That sounds like a measured poor score even though no coverage
population exists.

Validation now returns an explicit unknown value for a zero-node tree. The
coverage audit keeps totalNodes and validNodes at zero while preserving the
unknown score. The HTTP response serializes it as `null`, and the machine check
says `coverage n/a`. Trees with one or more nodes still return the same numeric
ratio.

Tests construct a valid empty tree and cover validation plus audit propagation.
Reintroducing the old fallback makes the validation test fail.
