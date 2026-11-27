<!-- internal-only -->
# Member-loss integration test split

## What Changed

The verifier can schedule the bounded-reader checks separately from the source-inventory and interrupted-runtime checks. Both files retain the existing 120-second case timeout and share the original fixture setup.

## Evidence

The three suite bodies match the original file byte for byte. Its 36 expanded case names form the comparison baseline for the focused run.

The focused Vitest report marked all 36 cases passed. It recorded 34.227 seconds for the reader file and 33.038 seconds for the source file. The wrapper failed while formatting the receipt after the tests finished, before storing the child exit code. Full verification with cold and established duration history will determine the effect on overall runtime.
