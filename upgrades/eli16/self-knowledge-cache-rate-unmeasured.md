# Self-knowledge cache rates now require a cache lookup

The self-knowledge tree caches source content so repeated searches can avoid
reading the same source again. Its cache hit rate is the number of hits divided
by all hits and misses.

Previously, the cache reported zero percent before any lookup. A search that
could not even load the tree returned the same value. Those states were
indistinguishable from a real first lookup that missed the cache, even though
only the real miss has a denominator.

The cache rate is now null until a hit or miss occurs. A real first miss still
reports numeric zero, and one hit plus one miss still reports one-half. A
degraded search with no loaded tree also reports null. The validation route and
search response pass that value through; caching, lookup, invalidation, and
source gathering behavior are unchanged.

The tests enter all three states. Restoring the old zero fallbacks makes the two
no-evidence assertions fail directly, while the measured zero and one-half
assertions remain numeric.
