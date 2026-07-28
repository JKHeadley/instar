# TokenLedger scanAllAsync deterministic yield test

TokenLedger has a background scan that reads token-usage transcript files. The
async version is supposed to pause briefly between batches so the rest of the
server can keep responding while a large scan is running.

The old test tried to prove that pause by starting a one-millisecond timer and
checking whether that timer fired before the scan finished. That sounds
reasonable, but it is not deterministic. JavaScript has several event-loop
queues, and `setImmediate` does not guarantee that a one-millisecond interval
will fire before a very small scan completes. On a fast local run, the scan can
do the right thing and the timer can still stay at zero.

The fix is to test the behavior directly. TokenLedger now accepts an optional
async yield function. Normal production code does not pass this option, so it
still uses the same `setImmediate` yield as before. The unit test passes a small
function that increments a counter whenever the scan yields. That gives the test
a direct, reliable signal: if the counter went up, the async scanner yielded.

This does not change how TokenLedger scans files in the real server. It only
removes the unit test's dependency on wall-clock timer scheduling. The behavior
under test is the same behavior users care about: scanAllAsync should process
all files, insert all events, and yield during the scan so it does not monopolize
the event loop.

The practical result is a quieter development loop. A developer can run the
TokenLedger unit test locally and trust the result. If it fails after this
change, it should point to a real scanner problem instead of a timer callback
that happened not to fire quickly enough.
