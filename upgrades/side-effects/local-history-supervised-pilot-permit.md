# Side effects of supervised disposable permit delivery

The parent supervisor accepts an explicit synchronous first-permit callback only for the named disposable test state and built-in synthetic artifact. It sends the registered worker token through private framed input, then checks the returned permit's exact run, destination and plan before sending one commit message while the worker holds its writer lock.

The callback owns durable persistence and ambiguous commit handling. The supervisor checks live pre-commit authorization, then retains the issued attempt across the prepared-to-applying transition. Deadline, process and protocol checks still apply. Errors stop the child and wait for actual close before releasing caller-owned resources. A lost message never authorizes retry. The fixed worker independently verifies the committed row and consumes at most one claim.

The fixture uses the normal supervisor, real disposable child, committed SQLite slot and measured ledger reservation. Ordinary preview and discard paths keep their existing protocol. This checkpoint adds no signed apply route or production copy authority. Reverting parent pilot delivery has no persisted format effect.

Independent review concurred. It verified that the issued attempt keeps its deadline and process checks even after the operation leaves prepared state. The test covers successful commit and delivery. Post-commit send failure remains an uncertain coordinator outcome and is outside this fixture.
