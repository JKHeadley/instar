# Feedback executor, phase 2 (ELI16)

Phase 1 taught the agent to sort feedback reports into "work on it", "hold" and "set aside". This change adds the worker that actually fixes the "work on it" items.

For each item, the worker makes two fresh copies of the code. One is a sandbox where a Claude session tries to reproduce the problem with a test and then fix it. The sandbox has no internet, no keys or passwords, and cannot read anything outside its own copy. Before every attempt, a quick self-test checks that the sandbox really holds; if it does not, the worker stops.

When the session finishes, trusted code (which never runs anything inside the sandbox) reads the changed files, refuses anything that touches build tooling or looks like a secret, re-runs the tests inside the sandbox to confirm the test failed before the fix and passes after it, and then publishes the change from the second copy to the agent's own fork of the repository, as a pull request marked "hold". Because the pull request comes from a fork, the repository's automated checks run without any of its secrets.

Nothing merges until the repository owner approves that exact version on GitHub. If anything changes after the approval, the merge is refused. A fix only counts as done once it has shipped in a release and no new reports arrive for 30 days. The worker starts switched off, in a practice mode that only records what it would do.
