# Windows desktop secret pipe side effects

- Scope: the Windows WSL interactive scheduled-task bridge for the two stdin-only input commands. The direct path still writes to driver stdin.
- Authority: the current profile, foreground, and page checks still own admission. The pipe has a restrictive operating-system ACL and a random name.
- Over-block: inputs above 8,192 bytes are refused. An interactive task that cannot connect to its pipe fails before driver launch.
- Under-block: an already-compromised Windows account remains outside the protection of a same-user pipe. The browser can retain its own navigation history.
- Interactions: PID/start-time fencing, task cleanup, and the unknown-outcome latch remain in the normal path. Driver stdout and stderr are drained for secret calls, with a fixed success marker and numeric exit code.
- Migration: the existing always-overwrite browser-script installer updates the wrapper on init and upgrade. The older bridge-file sweeper removes leftover legacy input paths.
- Multi-machine: the pipe is local to the Windows host and carries no replicated state.
- Rollback: replace the wrapper with a corrected build. Keep secret bridge input out of use if the older file-backed wrapper must temporarily be restored.

The Windows driver also preserves a one-item field list at both its listing and indexed typing entry points. It uses the existing page-subtree selection and focus checks.
