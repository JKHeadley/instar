/**
 * `instar server start|stop` — Manage the persistent agent server.
 *
 * Start launches the server in a tmux session (background) or foreground.
 * Stop kills the server tmux session.
 *
 * When Telegram is configured, wires up message routing:
 *   topic message → find/spawn session → inject message → session replies via [telegram:N]
 */
interface StartOptions {
    foreground?: boolean;
    dir?: string;
    /** When false, skip Telegram polling (used when lifeline owns the Telegram connection).
     *  Commander maps --no-telegram to telegram: false. */
    telegram?: boolean;
}
export declare function startServer(options: StartOptions): Promise<void>;
export declare function stopServer(options: {
    dir?: string;
}): Promise<void>;
/**
 * Restart the agent server — handles launchd/systemd lifecycle correctly.
 *
 * When autostart (launchd/systemd) is active, simply stopping the server causes
 * the service manager to respawn it with the OLD binary within seconds. This
 * makes it impossible to apply patches. The restart command handles this by:
 *   1. Temporarily disabling the autostart service
 *   2. Stopping the running server
 *   3. Re-enabling autostart (which starts the server with the new binary)
 *
 * Without autostart, falls back to stop + start.
 */
export declare function restartServer(options: {
    dir?: string;
}): Promise<void>;
export {};
//# sourceMappingURL=server.d.ts.map