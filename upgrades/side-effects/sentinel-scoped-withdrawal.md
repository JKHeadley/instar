# Clarify conversational withdrawals in the stop detector

The classifier prompt now shows how to handle a bare withdrawal, an ordinary correction and an urgent stop that happens to follow a withdrawal. It retains the preference for stopping when a message plausibly expresses an urgent stop. Exact and custom stop commands, capacity handling and repeated-message deduplication stay on the existing paths.

The model can still misclassify a conversational message. The deterministic test verifies the prompt carries the distinction and preserves routing for each simulated verdict. It cannot establish how a live model will classify every wording. The effect is limited to model judgments on messages that reach the existing classifier. Rollback restores the previous prompt.

## Second-pass review

**Reviewer:** Independent stop-detector reviewer.
**Result:** Concur after preserving the preference to honor plausible urgent stops and removing a proposed structural pass-through. Live model accuracy remains a separate check.
