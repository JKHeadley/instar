# Locked-proof test cleanup: plain overview

A test added with the locked-screen fixes writes a small stand-in helper program into the build folder, then deletes it afterwards. Instar has a safety guard that refuses to delete files inside a copy of its own source code. When tests run in the special copies the merge checker makes, a test has to tell the guard that this copy is one of those throwaway copies. Two sibling tests do that with a tiny helper called cleanupScope. The new test copied the rest of their pattern but missed that helper.

So on a machine where the checker's copy looks like a real source tree, the guard correctly refused the delete, the test's cleanup threw, and two tests failed. On the Studio the same file passed, because the copies tested there sit under an agent's state folder, which the guard treats differently. That made it look like a flaky failure. It was not: the M5 Pro failed it every time, which held up other people's pull requests.

The fix adds the same helper to the new test and passes it to the delete call. Nothing in the product changes, and the guard itself is not touched. There is nothing to decide; this only stops a false failure in the merge line.
