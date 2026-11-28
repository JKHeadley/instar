# How The Proposed Answer Review Works

We need to tell whether shorter context preserves the decisions an agent should make. Checking that an answer has the right JSON fields cannot tell us whether it understood your instructions or invented an approval. The proposed judging contract describes that second kind of review. It is a design, not a running comparison service.

An answering session would receive only the inputs assigned to its comparison arm. Separate judges would receive the original sources, the captured answer and criteria fixed before the trial. Each judge would explain whether each criterion passed, failed or remained disputed. A judge would check all answer fields, including limitations, so an unsupported claim could not hide outside the main answer.

Disagreements and errors would remain visible. A critical failure raised by either judge would block qualification until the agreed independent process resolved it. The original finding would never disappear. A judge timeout would be recorded as a judge error, rather than silently becoming a passing answer. All attempts would count toward cost.

This work does not run models, expose private reference answers, activate shorter instructions or qualify an existing reduction. The next implementation needs to enforce these boundaries and test malformed records, invented citations, conflicting authority and failed judging. The governing evidence and release checks still apply. This overview explains the design for review; there is no operator decision or permission request attached to it.

The installed schema checker now compiles both contracts in strict mode and passes thirteen synthetic checks of field requirements and conditional rules. These checks cover document shape, not whether a real answer is correct, whether sources are authentic or whether labels stay hidden. The ordinary commit hook is a separate verification step; this record does not turn earlier unverified commits into approved ones.

The replay preparation script also has a release note that explains its limits. It prepares fixed comparisons and scores imported records; it does not perform the model comparison itself. The offline general answer validator remains separate work until its tests, review and shared verification are complete.
