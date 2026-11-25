# Side-effects review

Tier 1. The change is a small, reversible diagnostic in the release workflow. With the repository variable unset, the wrapper immediately hands control to the original npm command. When enabled, it keeps the command output visible and uses a private temporary file to check the error. It returns npm's exit status and deletes the temporary file.

The hint grants no authority and starts no job. The existing workflow condition and npm credential input are carried forward. The message links to the existing development release instructions. It is emitted once and remains in the existing workflow log. No agent config, stored state, installer, or migration changes.

Three November 8 publish runs showed the same npm code and account suspension response. Tests simulate this response, unrelated errors, and a successful publish. They also verify the exact command is invoked once. Roll back by clearing the repository variable or reverting the change.
