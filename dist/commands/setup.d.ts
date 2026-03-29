/**
 * Interactive setup wizard — the one-line onboarding experience.
 *
 * `npx instar` or `instar setup` walks through everything:
 *   1. Project detection + naming
 *   2. Secret management (Bitwarden / local encrypted / manual)
 *   3. Telegram setup (primary communication channel)
 *   4. User setup (name, email, permissions)
 *   5. Scheduler + first job (optional)
 *   6. Start server
 *
 * Launches a Claude Code session that walks you through setup
 * conversationally. Claude Code is a hard requirement — Instar's
 * entire runtime depends on it.
 *
 * No flags needed. No manual config editing. Just answers.
 */
/**
 * Launch the conversational setup wizard via Claude Code.
 * Claude Code is required — there is no fallback.
 */
export declare function runSetup(): Promise<void>;
/**
 * Install auto-start so the agent's lifeline process starts on login.
 * macOS: LaunchAgent plist in ~/Library/LaunchAgents/
 * Linux: systemd user service in ~/.config/systemd/user/
 *
 * Returns true if auto-start was installed successfully.
 */
export declare function installAutoStart(projectName: string, projectDir: string, hasTelegram: boolean): boolean;
/**
 * Remove auto-start for a project.
 */
export declare function uninstallAutoStart(projectName: string): boolean;
/**
 * Create or update a stable node symlink at .instar/bin/node.
 *
 * The plist references this symlink instead of a hardcoded node path.
 * This way, when node moves (NVM switch, homebrew upgrade), we only
 * need to update the symlink — not regenerate the entire plist.
 *
 * Returns the symlink path.
 */
export declare function ensureStableNodeSymlink(projectDir: string): string;
interface NonInteractiveOptions {
    name?: string;
    user?: string;
    telegramToken?: string;
    telegramGroup?: string;
    whatsappBackend?: string;
    whatsappPhone?: string;
    whatsappPhoneNumberId?: string;
    whatsappAccessToken?: string;
    whatsappVerifyToken?: string;
    scenario?: string;
}
/**
 * Run setup without the LLM wizard. Requires all necessary flags.
 * Returns exit code 0 on success, throws on failure.
 */
export declare function runNonInteractiveSetup(opts: NonInteractiveOptions): Promise<void>;
export {};
//# sourceMappingURL=setup.d.ts.map