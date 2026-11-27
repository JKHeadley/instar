# Verdict recovery review

Six independent Codex reviews examined a verdict skipped during lease movement. They identified the need to preserve publication fencing, isolate replacement admission from status projection, retain the queue through restart, handle delayed or out-of-order responses, and distinguish delivery of two successful verdicts for the same head on different bases.

At 10:20:43 PST on November 24 Chief chose explicit priority admission when the old attempt cannot be identified. This implementation uses the existing operator front control for the changed base. The ordinary periodic status pass already recovers the reusable outcome under the current lease. The implementation introduces no automatic admission based on an ambiguous GitHub status. A queued replacement suppresses the older success for the current lookup until verification completes. Existing release and repository safety checks remain authoritative.

The regression reproduced a stored success being returned by the priority control after the base moved. The original epoch-change test already passed on unchanged source. Full review responses, including the unresolved identity question before Chief decided, are preserved in the project report directory.
