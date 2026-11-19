# Side effects: reviewer verdict code and stricter verdict reading (SEC-097)

## What changes for running agents
- Feedback executor (independent gate): reviewer prompts carry a verdict code. A reviewer that ignores the requested line gets UNKNOWN. That reply is re-asked on the existing unparseable schedule and is then close-eligible. It is never admitted. A model that habitually drops the line would raise refusals; the PR comment shows each reviewer's raw body, so this is visible.
- Other cross-model review paths (spec-converge and PR review): some reply shapes that used to parse now read as UNKNOWN or SERIOUS, for example a prose verdict line that also mentions "serious". That is fail-closed and means a re-read, not a wrong pass.
- No stored data or config changes.

## Signal vs authority
The reviewer's coded line is the authority for its verdict. The general reader's "severity signals" only block a milder verdict and never create one.

## Rollback
Revert the commit. Rows judged under the code keep their recorded verdicts.

## Not covered here
A reviewer model that is itself convinced by injected text to write a coded CLEAN is a model-level attack. The verdict code does not address it; the two-family requirement does. The general reader still cannot read verdicts written under other label words ("Assessment:", "Result:"). Those read as UNKNOWN, or are blocked by a signal, and never as a pass on the executor gate, which reads only the code.

**Reviewer:** three independent adversarial rounds (fresh context, read-only). Round 1 (first-line and quote handling, ReDoS) and round 2 (fence swallow, HTML, list continuation, unknown labels) both objected. Every input they found is now a regression test. Round 3 objected with four more shapes. Two are fixed in the reader with tests; the other two (other label words, split table header) are closed for the executor gate by the verdict code, which this round introduced because shape-matching kept producing new gaps. A fourth round reviewed the code design. It found no way for the reviewed data to know or forge the code, and confirmed that every family path passes the full reply. Its objection was one existing test whose fixture body contradicted its verdict field; that is fixed, and `NOT CLEAN` under the code now declares nothing.
