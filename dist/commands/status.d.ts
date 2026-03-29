/**
 * `instar status` — Show agent infrastructure status.
 *
 * Checks for: config, tmux, server, sessions, scheduler.
 */
interface StatusOptions {
    dir?: string;
}
export declare function showStatus(options: StatusOptions): Promise<void>;
export {};
//# sourceMappingURL=status.d.ts.map