# Try a fifth integration test process

When the test line checks a change, it runs unit, integration, and end-to-end tests at the same time. Verification finishes when the last group finishes. Integration tests finished last in all 25 successful Studio runs sampled on November 24, with a median of about 22 minutes. The other groups each took about 16 minutes.

The Studio already uses four integration processes. This change lets an operator choose five on a machine with spare capacity. The test line still runs every test and uses the same rules to decide whether a change passed. The setting applies to the next run on that machine.

Using recorded file timings, splitting the same work five ways puts about 20 percent less estimated work in each integration process. A live comparison is needed to see how much time that actually saves. An extra process can also create competition for memory and disk access. If wall time or reliability gets worse, the operator can set the count back to four for the next run.
