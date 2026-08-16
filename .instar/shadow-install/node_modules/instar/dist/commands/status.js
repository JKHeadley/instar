/**
 * `instar status` — Show agent infrastructure status.
 *
 * Checks for: config, tmux, server, sessions, scheduler.
 */
import { execFileSync } from 'node:child_process';
import pc from 'picocolors';
import { loadConfig, detectTmuxPath } from '../core/Config.js';
import { StateManager } from '../core/StateManager.js';
export async function showStatus(options) {
    let config;
    try {
        config = loadConfig(options.dir);
    }
    catch (err) {
        console.log(pc.red(`Not initialized: ${err instanceof Error ? err.message : String(err)}`));
        console.log(`Run ${pc.cyan('instar init')} first.`);
        process.exit(1);
    }
    console.log(pc.bold(`\nInstar Status: ${pc.cyan(config.projectName)}`));
    console.log(`  Project: ${config.projectDir}`);
    console.log(`  State:   ${config.stateDir}`);
    console.log();
    // Server status
    const serverSessionName = `${config.projectName}-server`;
    const tmuxPath = detectTmuxPath();
    let serverRunning = false;
    if (tmuxPath) {
        try {
            execFileSync(tmuxPath, ['has-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
            serverRunning = true;
        }
        catch {
            // not running
        }
    }
    console.log(pc.bold('  Server:'));
    if (serverRunning) {
        console.log(`    ${pc.green('●')} Running (tmux: ${serverSessionName}, port: ${config.port})`);
        // Try to hit health endpoint
        try {
            const resp = await fetch(`http://localhost:${config.port}/health`, {
                signal: AbortSignal.timeout(3000),
            });
            const health = await resp.json();
            console.log(`    Uptime: ${health.uptimeHuman}`);
        }
        catch {
            console.log(`    ${pc.yellow('Could not reach health endpoint')}`);
        }
    }
    else {
        console.log(`    ${pc.red('●')} Not running`);
    }
    // Sessions
    const state = new StateManager(config.stateDir);
    const runningSessions = state.listSessions({ status: 'running' });
    const allSessions = state.listSessions();
    console.log();
    console.log(pc.bold('  Sessions:'));
    console.log(`    Running: ${runningSessions.length} / ${config.sessions.maxSessions} max`);
    console.log(`    Total:   ${allSessions.length}`);
    if (runningSessions.length > 0) {
        for (const s of runningSessions) {
            const age = timeSince(new Date(s.startedAt));
            console.log(`    ${pc.green('●')} ${s.name} (${age}${s.jobSlug ? `, job: ${s.jobSlug}` : ''})`);
        }
    }
    // Scheduler
    console.log();
    console.log(pc.bold('  Scheduler:'));
    console.log(`    Enabled: ${config.scheduler.enabled ? pc.green('yes') : pc.dim('no')}`);
    // Jobs
    try {
        const { loadJobs } = await import('../scheduler/JobLoader.js');
        const jobs = loadJobs(config.scheduler.jobsFile);
        const enabled = jobs.filter(j => j.enabled);
        console.log(`    Jobs: ${enabled.length} enabled / ${jobs.length} total`);
        if (jobs.length > 0) {
            for (const job of jobs) {
                const jobState = state.getJobState(job.slug);
                const icon = job.enabled ? pc.green('●') : pc.dim('○');
                const lastRun = jobState?.lastRun ? timeSince(new Date(jobState.lastRun)) + ' ago' : 'never';
                console.log(`    ${icon} ${job.slug} [${job.priority}] — last: ${lastRun}`);
            }
        }
    }
    catch {
        console.log(`    ${pc.dim('No jobs configured')}`);
    }
    // Recent activity
    const recentEvents = state.queryEvents({ limit: 5 });
    if (recentEvents.length > 0) {
        console.log();
        console.log(pc.bold('  Recent Activity:'));
        for (const event of recentEvents) {
            const age = timeSince(new Date(event.timestamp));
            console.log(`    ${pc.dim(age + ' ago')} ${event.type}: ${event.summary}`);
        }
    }
    console.log();
    // Exit with non-zero if server is not running
    if (!serverRunning) {
        process.exit(1);
    }
}
function timeSince(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}
//# sourceMappingURL=status.js.map