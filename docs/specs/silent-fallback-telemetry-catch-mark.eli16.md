# ELI16: why one comment fixes a red main

There is a test that reads the source code and counts places where an error is caught and
quietly ignored. Each one is a spot where something can fail without anyone hearing about it,
so the test refuses to let that count grow. It decides "quietly ignored" with a rough rule: it
looks at the 20 lines after each catch, and if it sees something like `return null` it counts
the catch.

Yesterday's change moved the telemetry-disable route. Its error handler now sits within 20
lines of the next route's `return null`, so the rough rule counted it, and the total went one
over the limit. That turned main red, which blocks every other merge.

The handler is not quiet at all: it replies with a 500 error and the reason. So the fix is to
add the marker the test already understands (`@silent-fallback-ok`) with a short reason. Nothing
about how the server behaves changes; only a comment is added.
