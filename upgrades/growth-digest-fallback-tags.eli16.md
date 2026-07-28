# ELI16 — labelling two error handlers that were already doing the right thing

There is a test that counts every place the code catches an error and carries on. The count is
allowed to go down but never up, so nobody can quietly add a place where a failure disappears.

Refreshing this pull request against current `main` pushed the count from 495 to 497. Both new ones
belong to this branch — the counter was written after this code was, so it had never been measured.

Neither of them actually hides anything:

- One catches a failure while writing an audit record. It reports the failure and carries on, because
  a broken audit log should not abort the thing it is merely recording.
- The other catches a failure while reading a config switch. It reports the failure and returns
  "off" — so if it cannot tell whether a new delivery mode is enabled, it uses the old one. The
  comment above it already promised exactly that behaviour.

Both were reporting through the same error channel the rest of the file uses. The counter just could
not tell the difference between "reports and continues safely" and "swallows".

So they are now labelled as deliberate, each with its reason written next to it.

**I did not raise the limit.** That was the tempting option and it would have made the test stop
meaning anything. The limit stays at 495.

Finding which two out of 497 was the only fiddly part: I compared per-file counts between `main` and
this branch instead of reading the list, because line numbers move between branches and the list does
not tell you what is new.
