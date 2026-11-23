# Why the locked-screen test failed, and the fix

A new test starts the real agent server with a pretend desktop helper, then asks the server for its locked-screen status. Before it answers, the server asks the helper a quick question: "what permissions and screens do you have?" The pretend helper answered that question with an empty reply. The server treats an empty reply as a broken helper, so the status page answered "unavailable" instead of the normal answer the test expected.

Nothing in the product was wrong. The pretend helper now gives a proper answer that says "no permissions, no screens", so the status page answers normally and the test can go on to check what it was written to check. A small extra check in a faster test makes sure the pretend helper's answer is accepted, so this cannot quietly break again.
