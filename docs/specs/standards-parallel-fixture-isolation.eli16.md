# Keep the standards test from editing the shared checkout

One test checks a useful failure case: someone changes the source standards document after the published copy was built. The audit must report that the two no longer agree, even though the published document and its own fingerprint still match each other. That check remains necessary.

The test created this situation by temporarily adding an article to the real source document and restoring it afterward. Unit test files run in parallel. Another test can therefore read the source document during that temporary edit while its command-line counterpart reads the restored copy. The result was an inconsistent count of 102 versus 103 articles in a complete unit run. The standalone reader suite passed when run without that concurrent mutation.

The correction gives the changed source document its own private temporary directory. Unchanged guard files are available there through read-only use of symbolic links to the checkout. The audit must select that fixture as the matching source tree, and the test explicitly asserts that it does. It then checks the same refusal for the changed authored document. It also verifies the real checkout document stayed unchanged while the fixture was edited.

This is a reversible test correction. No standards text, audit policy, integrity requirement or runtime implementation changes. The test still requires the stale build to be unverified and still confirms that the published document’s own fingerprint remains valid. The two adjacent suites run together to verify the corrected parallel behavior. Complete normal verification remains required before merge.
