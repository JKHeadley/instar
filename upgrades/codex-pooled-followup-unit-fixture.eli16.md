# Keep the pooled Codex unit tests independent of shell timing

The unit test creates a temporary Codex account and a transcript on disk. It used to start a tiny shell script to read the account setting. On a busy test machine, the script can exceed the same two-second limit used in production. That makes a healthy temporary account look unavailable.

The unit test now supplies the shell response directly and still reads the real temporary transcript. It also checks that a timed-out account lookup refuses delivery. The integration and end-to-end tests still start the shell.
