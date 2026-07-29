# Self-knowledge health no longer invents perfect performance

Instar records a trace whenever the self-knowledge tree answers a search. Its
health surface summarizes cache hit rate, average latency, and errors so an
operator can see whether that search path is useful and reliable.

Previously, a missing trace file, an empty file, a fully unreadable file, and a
real set of zero measurements all produced the same three numbers: zero cache
hits, zero milliseconds, and zero errors. Two of those numbers look ideal even
though the system had measured nothing. A search that performed no cache
operation also reported a zero-percent hit rate instead of saying the rate had
no denominator.

The three trace-derived health fields are now null when no valid search sample
exists. When searches exist but none touched the cache, only the cache hit rate
is null; latency and error rate remain measured from the search count. The HTTP
health response passes those values through. The machine diagnostic prints “no
search samples” or “cache hit n/a” rather than formatting an invented zero.

The regressions cover both absence shapes and assert the sample counts beside
the null fields. Restoring the old fallback produces two direct failures. Tree
search, caching, validation, coverage scoring, and error handling are unchanged;
only the read surface now distinguishes evidence from absence.
