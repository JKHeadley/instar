# Side-effects review for Codex project setup hook registration

The named-project and existing-directory init handlers already compute the selected frameworks and install the shared scripts. Both now call the existing native Codex hook registrar when that selection includes Codex. The shared hook installer materializes the prompt script using the same generator as the update path. This repairs both the missing registration and its missing executable.

1. **Over-block.** The registrar combines custom hook groups with Instar groups. The default Claude-only selection keeps its existing behavior. The native Codex trust flow continues to decide when registered hooks can run.
2. **Under-block.** A registered hook still needs the ordinary Codex trust approvals. The existing CLI trust semantics and update behavior apply.
3. **Abstraction.** Each init entry point owns framework selection. The existing registrar owns merge and write behavior.
4. **Signal and authority.** The explicit framework selection controls what is installed. The change adds no detector, gate logic, or trust authority.
5. **Interactions.** Both paths install the shared shell scripts before writing registration. Existing Codex custom groups are preserved.
6. **External surfaces.** The new writes are project-local hook files. Native arming still belongs to the existing refresh and update paths.
7. **Multiple machines.** The hook file is generated per project for the local checkout and its paths. The update path already refreshes it.
8. **Rollback.** Reverting restores the previous init behavior. The generated hook file is the same file the ordinary post-update route would write, so an agent that received it needs no state migration.
