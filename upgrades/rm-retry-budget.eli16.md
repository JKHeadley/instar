# ELI16 — a cleanup step gave up after a third of a second

When a test finishes, it deletes its temporary folder. Deleting a folder can fail if something is
still writing into it, so the delete is retried — three times, a tenth of a second apart. About a third
of a second of patience in total.

That is fine on an idle machine. It is not fine when the folder contains a real git repository and the
machine is busy: git's own background work can hold the folder for longer than that, the retries run
out, and the cleanup fails with "directory not empty". The test suite goes red for a reason that has
nothing to do with the code being tested.

That happened on main today, twice in one evening across two different tests — both while four builds
were competing for the same machines.

**What I changed:** the patience, from about a third of a second to about one second. Nothing else.

**What I want to be honest about:** I cannot prove one second is enough. Nobody can — it depends on how
loaded the machine is. This makes the failure much less likely; it does not make it impossible. A
delete that was always going to fail now takes a second longer to say so, which costs nothing.

The deeper fix for the git case is making sure git has actually finished before the cleanup starts, and
that belongs with the tests rather than here.

**Also added: two tests for behaviour that had none.** The retry logic had never been tested at all,
which is how it reached a state where it was running and simply too small. They check that a retry
budget is applied when the caller doesn't specify one, and that a caller who *does* specify one is never
overridden. They deliberately don't assert the specific numbers — those are expected to be tuned, and a
test that just repeats a constant tells you nothing.
