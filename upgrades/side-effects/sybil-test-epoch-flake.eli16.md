# Plain overview: a test that failed for ten minutes at a time

One test checks that a proof-of-work answer made for one network address is refused for another. The answer depends on the current 10-minute window, and the check was so easy that roughly once every 256 windows the same answer happened to work for the other address too. During that window every test run failed, for every pull request, even though nothing was wrong. The test now uses a harder check, so this happens about once in 65,536 windows instead. Nothing outside the test changes.
