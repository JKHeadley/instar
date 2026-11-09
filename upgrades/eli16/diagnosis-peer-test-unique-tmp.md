# A test that broke because of a leftover folder

One test always used the same folder name in the machine's shared temporary directory. Merge checks run under a separate system account, and one of them left that folder behind. The test's normal account couldn't remove or reuse it, so five of the eight tests in the file failed for anyone else on that machine, even though nothing was wrong with the code.

The test now picks a unique name each time it runs, so a leftover folder can't get in its way. This only changes a test. Nothing in the product behaves differently and nobody has a decision to make. The old folder stays where it is, because it belongs to the other account and is empty. Undoing this is a plain revert.
