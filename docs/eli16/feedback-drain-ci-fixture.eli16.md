# Feedback drain test fixture: keep each run's failure record separate

The feedback drain integration test runs the installed job script several times against a temporary local server. The script writes a failure file when the fake server refuses a request. The test previously named that file after the server's temporary port. Operating systems can give a later test run the same port. In that case, a failure file from an earlier case was still present, and the later case looked failed even though its own script run succeeded.

This change gives each test invocation a new random failure-file name. The installed job script and the real feedback drain remain unchanged. A failing case still has to write its own failure record; a successful case now starts with a path that cannot contain a previous case's record. The affected integration test and the full merge gates check the correction. The change is limited to the test harness and can be reverted without migrating agent state.

The PR's first GitHub pass also found that the API reference had fallen below its route-documentation floor. The reference now explains the four bounded Codex continuation endpoints. The documentation check passes again; this does not change those endpoints.
