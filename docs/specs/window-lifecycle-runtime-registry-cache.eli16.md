# Faster window lifecycle checks

Instar's window lifecycle test repeatedly reads and parses the same obligation ledger while checking one synchronous tick. The ledger can contain many obligations, making this test one of the slowest end-to-end files.

The route now passes the ledger it already loaded into the runtime registry and builds the obligation lookup once for that evaluation. Running sessions, commitment state, driver files, message evidence, and evidence rechecks still read their live sources. No pass or block rule changes.

On main commit `eebab6341` (the base at measurement time), two isolated M5 baseline runs passed in 194 and 193 seconds. The final candidate passed in 229, 147, and 145 seconds. In a full-suite run the file passed in 159 seconds. The first candidate run was an outlier in the wrong direction; the other runs were about 18–24% faster than the steady baseline. This is a small, variable sample for one test file, not a measured whole-suite gain. A broader experiment reached 128 seconds on an older checkout, but it cached evidence rechecks and was removed to preserve authority semantics.

The full M5 suite passed: 53,836 unit, 4,991 integration, and 3,622 end-to-end tests. One unrelated detector health integration test had timed out on an earlier loaded run despite passing alone. Its polling now uses a 500 ms interval and gives the real canary more scheduling room; the final full run observed its actual pass in 62 seconds. This preserves the pass requirement rather than accepting a pending detector.

This is a reversible code change with no setting, migration, API, or operator action.
