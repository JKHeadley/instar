/**
 * `instar nuke <name>` — Completely remove a standalone agent.
 *
 * Cleans up ALL artifacts:
 *   1. Stop the running server (tmux session)
 *   2. Remove auto-start (launchd/systemd)
 *   3. Push any uncommitted changes to git remote (if configured)
 *   4. Remove from agent registry
 *   5. Delete the agent directory
 *
 * Safety:
 *   - Requires explicit confirmation (unless --yes)
 *   - Pushes to git remote before deletion (preserves cloud backup)
 *   - Shows exactly what will be removed before proceeding
 *   - Only works on standalone agents (not project-bound)
 */
interface NukeOptions {
    skipConfirm?: boolean;
}
export declare function nukeAgent(name: string, options?: NukeOptions): Promise<void>;
export {};
//# sourceMappingURL=nuke.d.ts.map