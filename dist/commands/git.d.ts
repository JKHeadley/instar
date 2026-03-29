/**
 * `instar git` — Git-backed state tracking for standalone agents.
 *
 * Commands:
 *   instar git init             Initialize git tracking (standalone only)
 *   instar git status           Show tracked vs untracked state
 *   instar git push             Push to remote
 *   instar git pull             Pull from remote
 *   instar git log              Show commit history
 *   instar git remote <url>     Set remote URL
 *   instar git commit [message] Manual commit
 */
interface GitOptions {
    dir?: string;
    confirm?: boolean;
}
export declare function gitInit(opts: GitOptions): Promise<void>;
export declare function gitStatus(opts: GitOptions): Promise<void>;
export declare function gitPush(opts: GitOptions): Promise<void>;
export declare function gitPull(opts: GitOptions): Promise<void>;
export declare function gitLog(opts: GitOptions): Promise<void>;
export declare function gitRemote(url: string, opts: GitOptions): Promise<void>;
export declare function gitCommit(message: string, opts: GitOptions): Promise<void>;
export {};
//# sourceMappingURL=git.d.ts.map