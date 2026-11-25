# Side-effects review for the Studio recovery release verifier

The verifier is a manually invoked diagnostic. It reports post-install observations and has no authority over the existing shortening gate.

1. **Over-block.** Exits pending when a hook, native record, or matching Codex acknowledgment is missing from the recent window.
2. **Under-block.** Both native records must match the target machine and postdate installation. Codex also requires the same epoch and carrier in the marker.
3. **Abstraction.** The sentinel owns recovery observations. The Codex route owns acknowledgments. The verifier compares their evidence.
4. **Signal and authority.** The existing canary retains sole shortening authority. The verifier emits diagnostic status.
5. **Interactions.** The read-only check leaves observed counts and deployment configuration intact.
6. **External surfaces.** Only loopback GET requests and local reads. Output contains check results and omits credentials, transcripts and session identifiers.
7. **Multiple machines.** The expected machine and local project scope all checks. Run directly on the machine being verified.
8. **Rollback.** Remove the diagnostic file or revert its commit. No migration or state cleanup is needed.
