# Keep macOS package tests from failing on temporary helpers

During the full test suite, one macOS test creates and removes small helper programs inside the folder that another test packages. Packaging can spot a helper just as it disappears and report a missing file. This is a test timing race; the released package does not use those helpers.

The package test had a retry rule for this error, but its quiet npm setting hid the error details, so the rule could not recognize the helper. The test now lets npm show errors and allows up to 17 attempts for that one missing-helper case. Any different packaging error still fails immediately. This gives the temporary helper test time to finish without hiding a real package problem.

The M5 also exposed a separate cleanup issue. When a tmux pane has already died, its newer tmux version may erase the pane's PID. The cleanup code then failed to recognize its own dead session and left it behind. Each new session now carries a random proof attached to that tmux session. A dead pane with the recorded session ID and matching proof can be removed, even without its PID. A replacement with the same name or reused ID has no matching proof and is left alone. A dead pane never causes a process signal; a live one still needs its matching PID.
