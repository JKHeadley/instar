# Side-effects review for launch-local Codex startup barrier

The generated native hook lives under the protected worker home and publishes one launch-bound session receipt. The launcher releases the same native identifier only after the existing reservation and native binding succeed. Wrong or duplicate releases are refused. The fixture installs the hook configuration inside the protected home and verifies that no model request occurs while the server holds the startup receipt. Rejected launch cancellation also produces no model requests.

The independent review covers a live supervising launcher. The hook's own finite timeout has not been verified to abort the first native turn if the launcher disappears. Production requires unattended timeout proof or an independent first-input or provider gate. No production launcher, new deployed hook, or flag change is included.

## Second-pass review

**Reviewer:** managed_startup_barrier_review, independent Instar second-pass agent

Concur for the live-parent release and rejection paths. Shell arguments are quoted as POSIX literals. The unattended timeout remains outside the concurrence and outside the activation boundary.
