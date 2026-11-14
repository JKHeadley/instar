# ELI16 — see which files caused a feedback design to be rejected

The feedback system sometimes asks an agent to write a design document before it starts changing code. That first step has a strict safety rule: the attempt may add exactly one design file. If any other file changes, the executor rejects the attempt and removes its temporary working folder.

An October 26 attempt was rejected because the folder showed seven changes. The final message gave us the count but not the file names. Once the folder was removed, we could not tell whether those changes were source edits, generated files, or a workspace setup problem. That made the next attempt a guess.

The executor now writes each changed relative path and its change type to the feedback audit just before it removes a rejected folder. It does not record file contents. It still rejects the same attempts under the same one-file rule. The extra record is evidence for diagnosing the failure, not permission to publish a broader change.

The branch also stabilizes two tests that were sensitive to timing and reused local HTTP connections during the full test run. Those test changes do not alter the feedback pipeline's behavior. The full unit, integration, and end-to-end suites passed with zero failures before publication.
