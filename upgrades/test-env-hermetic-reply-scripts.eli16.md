# Tests stop failing just because a real agent is running them

Three of our tests check the little script that delivers my chat replies. Each test builds a fake miniature server, points the script at it, and watches what the script does. The problem: when those tests run inside a LIVE agent work session (instead of a clean CI machine), the session environment carries the agent's REAL access token in an environment variable — and the script is designed to prefer that variable when it exists. So the script walks up to the fake test server holding the real token, the fake server's door check rejects it (wrong token), and the test fails with a confusing "the script never called the server" error — even though nothing is actually broken.

This bit us tonight: the full test suite went red on my machine for exactly this reason, while the same tests pass everywhere else. The "fix" each time would have been to shrug and re-run on CI — which trains everyone to distrust local test runs, the opposite of what a test suite is for.

The change is three one-line edits: each test now explicitly blanks that environment variable when launching the script, so the script falls back to reading the token from the test's own config file — the path the tests were always meant to exercise. A fourth sibling test already did this correctly (it builds a minimal clean environment from scratch), which is how we knew the pattern. Comments at each site explain why, so the next person who writes a test like this copies the safe pattern.

Nothing about the real script changes. Production behavior is untouched — this only makes the tests honest about what environment they run in. Tests now pass identically on a clean CI box and inside a live agent session.
