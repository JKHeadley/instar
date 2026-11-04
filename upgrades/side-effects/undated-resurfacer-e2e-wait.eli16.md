# Plain overview: a test that checked too early now waits

Instar has an automatic helper that brings forgotten to-do items back to attention. One end-to-end test starts a test server and then checks, after just three hundredths of a second, that the helper has already done its first pass. On a busy computer running many tests at once, the first pass sometimes comes a little later, so the test failed even though nothing was broken. That failure blocked an unrelated change, the new native session screen for the phone app, from merging.

The test now waits for the first pass, checking every tenth of a second for up to ten seconds, and then makes exactly the same checks as before. Nothing in Instar itself changes. If the helper ever truly failed to run, the test still fails, just after ten seconds instead of at once.
