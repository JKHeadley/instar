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
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { GitStateManager } from '../core/GitStateManager.js';
function loadGitManager(dir) {
    const config = loadConfig(dir);
    const gitConfig = config.git || {};
    const manager = new GitStateManager(config.stateDir, gitConfig);
    return { manager, config };
}
export async function gitInit(opts) {
    const { manager, config } = loadGitManager(opts.dir);
    // Block project-bound agents
    if (config.agentType === 'project-bound') {
        console.log(pc.red('Git state tracking is only supported for standalone agents.\n' +
            'Project-bound agents live inside an existing git repository — ' +
            'commit your .instar/ identity files directly to the parent repo.'));
        process.exit(1);
    }
    if (manager.isInitialized()) {
        console.log(pc.yellow('Git tracking is already initialized.'));
        return;
    }
    manager.init();
    console.log(pc.green('Git tracking initialized.'));
    console.log(pc.dim('Auto-generated .gitignore excludes secrets and runtime state.'));
    console.log(pc.dim('Use `instar git remote <url>` to configure a remote for sync.'));
}
export async function gitStatus(opts) {
    const { manager } = loadGitManager(opts.dir);
    const status = manager.status();
    if (!status.initialized) {
        console.log(pc.dim('Git tracking is not initialized.'));
        console.log(pc.dim(`Initialize with: ${pc.cyan('instar git init')}`));
        return;
    }
    console.log(pc.bold('\n  Git State\n'));
    console.log(`  Branch:    ${pc.cyan(status.branch)}`);
    console.log(`  Staged:    ${status.staged > 0 ? pc.green(String(status.staged)) : pc.dim('0')}`);
    console.log(`  Modified:  ${status.modified > 0 ? pc.yellow(String(status.modified)) : pc.dim('0')}`);
    console.log(`  Untracked: ${status.untracked > 0 ? pc.red(String(status.untracked)) : pc.dim('0')}`);
    if (status.remote) {
        console.log(`  Remote:    ${pc.dim(status.remote)}`);
        if (status.ahead > 0)
            console.log(`  Ahead:     ${pc.green(`+${status.ahead}`)}`);
        if (status.behind > 0)
            console.log(`  Behind:    ${pc.yellow(`-${status.behind}`)}`);
    }
    else {
        console.log(`  Remote:    ${pc.dim('none')}`);
    }
    console.log();
}
export async function gitPush(opts) {
    const { manager } = loadGitManager(opts.dir);
    if (!manager.isInitialized()) {
        console.log(pc.red('Git tracking is not initialized. Run `instar git init` first.'));
        process.exit(1);
    }
    const config = manager.getConfig();
    // First-push confirmation gate
    if (config.lastPushedRemote !== config.remote && !opts.confirm) {
        console.log(pc.yellow(`First push to ${config.remote}.`));
        console.log(pc.yellow('This will send all committed agent state to the remote.'));
        console.log(pc.dim(`Re-run with --confirm to proceed, or use the API with { "force": true }.`));
        process.exit(0);
    }
    try {
        const result = manager.push();
        if (result.firstPush) {
            console.log(pc.green(`First push to ${config.remote} successful.`));
        }
        else {
            console.log(pc.green('Pushed to remote.'));
        }
    }
    catch (err) {
        console.log(pc.red(`Push failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
    }
}
export async function gitPull(opts) {
    const { manager } = loadGitManager(opts.dir);
    if (!manager.isInitialized()) {
        console.log(pc.red('Git tracking is not initialized. Run `instar git init` first.'));
        process.exit(1);
    }
    try {
        manager.pull();
        console.log(pc.green('Pulled from remote.'));
    }
    catch (err) {
        console.log(pc.red(`Pull failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
    }
}
export async function gitLog(opts) {
    const { manager } = loadGitManager(opts.dir);
    if (!manager.isInitialized()) {
        console.log(pc.dim('Git tracking is not initialized.'));
        return;
    }
    const entries = manager.log(20);
    if (entries.length === 0) {
        console.log(pc.dim('No commits yet.'));
        return;
    }
    console.log(pc.bold('\n  Git Log\n'));
    for (const entry of entries) {
        console.log(`  ${pc.yellow(entry.hash)}  ${entry.message}  ${pc.dim(entry.date)}`);
    }
    console.log();
}
export async function gitRemote(url, opts) {
    const { manager } = loadGitManager(opts.dir);
    try {
        manager.setRemote(url);
        console.log(pc.green(`Remote set to: ${url}`));
        console.log(pc.dim('Use `instar git push` to push state to this remote.'));
    }
    catch (err) {
        console.log(pc.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
    }
}
export async function gitCommit(message, opts) {
    const { manager } = loadGitManager(opts.dir);
    if (!manager.isInitialized()) {
        console.log(pc.red('Git tracking is not initialized. Run `instar git init` first.'));
        process.exit(1);
    }
    try {
        manager.commit(message || '[instar] manual commit');
        console.log(pc.green('Committed.'));
    }
    catch (err) {
        console.log(pc.red(`Commit failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
    }
}
//# sourceMappingURL=git.js.map