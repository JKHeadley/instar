# What survives a failed verification run

When a verification run fails, its temporary test reports are cleaned up. Previously, the retained checkout could tell you which assertion failed but could lose the process error or the message explaining why a whole test file failed to load.

The checkout's private failure report now has room for recent error output from failed commands, messages from failed test files, and the error reporter's count. It distinguishes a reporter that counted zero errors from one that produced no usable report. These details help the person investigating decide what evidence to look at next.

The file reserves 64 KiB for the original failure summary and another 64 KiB for diagnostics. Long messages and older entries may be omitted. Recognized credential formats are masked before diagnostic text is shortened. The file still needs private handling because arbitrary sensitive text may appear in test output. Access and cleanup follow the existing failed checkout.
