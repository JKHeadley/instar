/**
 * WorktreeMonitor — Detect orphaned git worktrees after session completion.
 *
 * Addresses the critical gap where Claude Code creates worktrees implicitly
 * (e.g., subagents with `isolation: "worktree"`) and Instar has zero visibility.
 * Work can silently orphan on branches nobody merges.
 *
 * Two modes:
 *   1. Post-session scan: fires after each session completes, checks for new worktrees
 *   2. Periodic health scan: runs on interval, detects stale/orphan worktrees
 *
 * Part of the Claude Code Feature Integration Audit (Item 1: Worktree Support).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Session } from '../core/types.js';

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────

export interface Worktree {
  /** Absolute path to the worktree directory */
  path: string;
  /** Git commit HEAD of the worktree */
  head: string;
  /** Branch name (e.g., "worktree-bright-running-fox") */
  branch: string | null;
  /** Whether this is the main worktree */
  isMain: boolean;
  /** Whether this worktree is bare (detached HEAD) */
  isBare: boolean;
}

export interface WorktreeReport {
  timestamp: string;
  /** All worktrees found (excluding main) */
  worktrees: Worktree[];
  /** Worktrees with commits ahead of main branch */
  withUnmergedWork: WorktreeWithDiff[];
  /** Worktree branches with no active session */
  orphanBranches: string[];
  /** Actions taken (alerts sent, etc.) */
  actions: string[];
}

export interface WorktreeWithDiff {
  worktree: Worktree;
  /** Number of commits ahead of default branch */
  commitsAhead: number;
  /** Files changed vs default branch */
  filesChanged: string[];
}

export interface WorktreeMonitorConfig {
  /** Project directory (git repo root) */
  projectDir: string;
  /** State directory for persisting scan results */
  stateDir: string;
  /** Poll interval for periodic health scans (ms). Default: 300000 (5 min). 0 = disabled. */
  pollIntervalMs?: number;
  /** Max worktree age before flagging as stale (ms). Default: 86400000 (24h). */
  staleThresholdMs?: number;
  /** Callback for sending alerts */
  alertCallback?: (message: string) => Promise<void>;
}

// ── Implementation ─────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL = 300_000;     // 5 minutes
const DEFAULT_STALE_THRESHOLD = 86_400_000; // 24 hours

export class WorktreeMonitor extends EventEmitter {
  private config: WorktreeMonitorConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stateFile: string;
  private lastReport: WorktreeReport | null = null;

  constructor(config: WorktreeMonitorConfig) {
    super();
    this.config = config;
    const stateDir = path.join(config.stateDir, 'worktree-monitor');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    this.stateFile = path.join(stateDir, 'last-report.json');
    this.loadState();
  }

  /** Start periodic health scanning. */
  start(): void {
    const interval = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
    if (interval <= 0 || this.interval) return;
    this.interval = setInterval(() => this.periodicScan(), interval);
  }

  /** Stop periodic scanning. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Get the last scan report. */
  getLastReport(): WorktreeReport | null {
    return this.lastReport;
  }

  /**
   * Post-session scan: check for worktrees after a session completes.
   * Called from the sessionComplete event handler.
   */
  async onSessionComplete(session: Session): Promise<WorktreeReport> {
    const report = await this.scanWorktrees();

    // Copy serendipity findings from worktrees before alerting
    for (const wt of report.worktrees) {
      const copied = this.copySerendipityFindings(wt.path);
      if (copied > 0) {
        report.actions.push(`Copied ${copied} serendipity finding(s) from worktree ${wt.branch ?? wt.path}`);
      }
    }

    if (report.withUnmergedWork.length > 0 || report.orphanBranches.length > 0) {
      const message = this.formatSessionAlert(session, report);
      report.actions.push(`Alert generated for session ${session.name}`);
      await this.sendAlert(message);
    }

    this.saveState(report);
    this.emit('scan', report);
    return report;
  }

  /**
   * Copy serendipity findings from a worktree back to the main project tree.
   *
   * Security hardening:
   * - Rejects symlinks (prevents sandbox escape / arbitrary file read)
   * - Validates files are regular files
   * - Enforces size limits (100KB per file, reasonable for JSON + patches)
   * - Uses atomic copy (write tmp, rename)
   * - Skips duplicates (same filename = same finding ID)
   */
  private copySerendipityFindings(worktreePath: string): number {
    const srcDir = path.join(worktreePath, '.instar', 'state', 'serendipity');
    const dstDir = path.join(this.config.projectDir, '.instar', 'state', 'serendipity');

    if (!fs.existsSync(srcDir)) return 0;

    const MAX_FILE_SIZE = 102_400; // 100KB
    let copied = 0;

    // Ensure destination exists
    fs.mkdirSync(dstDir, { recursive: true });

    let entries: string[];
    try {
      entries = fs.readdirSync(srcDir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      // Only copy .json and .patch files
      if (!entry.endsWith('.json') && !entry.endsWith('.patch')) continue;
      // Skip temp files
      if (entry.endsWith('.tmp')) continue;

      const srcPath = path.join(srcDir, entry);
      const dstPath = path.join(dstDir, entry);

      // Skip if destination already exists (dedup by finding ID)
      if (fs.existsSync(dstPath)) continue;

      try {
        const stat = fs.lstatSync(srcPath);

        // Reject symlinks
        if (stat.isSymbolicLink()) {
          console.error(`[SerendipityCopyBack] Rejected symlink: ${srcPath}`);
          continue;
        }

        // Must be a regular file
        if (!stat.isFile()) continue;

        // Enforce size limit
        if (stat.size > MAX_FILE_SIZE) {
          console.error(`[SerendipityCopyBack] File too large (${stat.size} bytes): ${srcPath}`);
          continue;
        }

        // Atomic copy: read, write to .tmp, rename
        const content = fs.readFileSync(srcPath);
        const tmpPath = dstPath + '.tmp';
        fs.writeFileSync(tmpPath, content);
        fs.renameSync(tmpPath, dstPath);
        copied++;
      } catch (err) {
        console.error(`[SerendipityCopyBack] Failed to copy ${entry}:`, err);
      }
    }

    return copied;
  }

  /**
   * Periodic health scan: detect stale worktrees and orphan branches.
   */
  async periodicScan(): Promise<WorktreeReport> {
    const report = await this.scanWorktrees();

    // Check for stale worktrees (getWorktreeAge is async — resolve ages first, then filter)
    const staleThreshold = this.config.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD;
    const ages = await Promise.all(report.worktrees.map(wt => this.getWorktreeAge(wt)));
    const staleWorktrees = report.worktrees.filter((_wt, i) => {
      const age = ages[i];
      return age !== null && age > staleThreshold;
    });

    if (staleWorktrees.length > 0) {
      const message = await this.formatPeriodicAlert(report, staleWorktrees);
      report.actions.push(`Stale worktree alert: ${staleWorktrees.length} worktree(s)`);
      await this.sendAlert(message);
    }

    this.saveState(report);
    this.emit('scan', report);
    return report;
  }

  /**
   * Core scan: list all worktrees and analyze their state.
   */
  async scanWorktrees(): Promise<WorktreeReport> {
    const report: WorktreeReport = {
      timestamp: new Date().toISOString(),
      worktrees: [],
      withUnmergedWork: [],
      orphanBranches: [],
      actions: [],
    };

    // List all worktrees
    const worktrees = await this.listWorktrees();
    report.worktrees = worktrees.filter(wt => !wt.isMain);

    // Get default branch for comparison
    const defaultBranch = await this.getDefaultBranch();

    // Check each non-main worktree for unmerged work
    for (const wt of report.worktrees) {
      if (!wt.branch) continue;

      const diff = await this.checkUnmergedWork(wt, defaultBranch);
      if (diff && diff.commitsAhead > 0) {
        report.withUnmergedWork.push(diff);
      }
    }

    // Find orphan worktree branches (branches matching worktree-* pattern with no worktree)
    // This can find branches even when no active worktrees exist
    const orphans = await this.findOrphanBranches(worktrees);
    report.orphanBranches = orphans;

    return report;
  }

  // ── Git Operations ─────────────────────────────────────────────

  /**
   * Parse `git worktree list --porcelain` output into structured data.
   */
  async listWorktrees(): Promise<Worktree[]> {
    const output = await this.gitCommand('worktree list --porcelain');
    if (!output.trim()) return [];

    const worktrees: Worktree[] = [];
    const entries = output.split('\n\n').filter(e => e.trim());

    for (const entry of entries) {
      const lines = entry.trim().split('\n');
      const wt: Worktree = {
        path: '',
        head: '',
        branch: null,
        isMain: false,
        isBare: false,
      };

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wt.path = line.slice('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
          wt.head = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          // branch refs/heads/worktree-bright-fox → worktree-bright-fox
          wt.branch = line.slice('branch '.length).replace('refs/heads/', '');
        } else if (line === 'bare') {
          wt.isBare = true;
        }
      }

      // First entry is always the main worktree
      if (worktrees.length === 0) {
        wt.isMain = true;
      }

      if (wt.path) {
        worktrees.push(wt);
      }
    }

    return worktrees;
  }

  /**
   * Check how many commits a worktree branch has ahead of the default branch.
   */
  async checkUnmergedWork(wt: Worktree, defaultBranch: string): Promise<WorktreeWithDiff | null> {
    if (!wt.branch) return null;

    // Count commits ahead
    const countOutput = await this.gitCommand(
      `rev-list --count ${defaultBranch}..${wt.branch}`
    );
    const commitsAhead = parseInt(countOutput.trim(), 10) || 0;

    if (commitsAhead === 0) return null;

    // Get changed files
    const diffOutput = await this.gitCommand(
      `diff --name-only ${defaultBranch}...${wt.branch}`
    );
    const filesChanged = diffOutput.trim().split('\n').filter(f => f.trim());

    return { worktree: wt, commitsAhead, filesChanged };
  }

  /**
   * Find branches matching worktree-* pattern that have no corresponding worktree.
   */
  async findOrphanBranches(activeWorktrees: Worktree[]): Promise<string[]> {
    const branchOutput = await this.gitCommand("branch --list 'worktree-*'");
    if (!branchOutput.trim()) return [];

    const allWorktreeBranches = branchOutput
      .split('\n')
      .map(b => b.trim().replace(/^[*+]\s+/, ''))
      .filter(b => b);

    const activeWorktreeBranches = new Set(
      activeWorktrees
        .filter(wt => wt.branch)
        .map(wt => wt.branch!)
    );

    return allWorktreeBranches.filter(b => !activeWorktreeBranches.has(b));
  }

  /**
   * Get the default branch name (main, master, etc.)
   */
  async getDefaultBranch(): Promise<string> {
    // Try symbolic ref first
    const symbolic = (await this.gitCommand('symbolic-ref refs/remotes/origin/HEAD 2>/dev/null')).trim();
    if (symbolic) {
      return symbolic.replace('refs/remotes/origin/', '');
    }

    // Fallback: check if main or master exists
    const branches = (await this.gitCommand('branch --list main master 2>/dev/null')).trim();
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';

    return 'main'; // default assumption
  }

  /**
   * Get the age of a worktree by checking its HEAD commit timestamp.
   */
  async getWorktreeAge(wt: Worktree): Promise<number | null> {
    if (!wt.head) return null;
    const timestamp = (await this.gitCommand(`show -s --format=%ct ${wt.head}`)).trim();
    if (!timestamp) return null;
    const commitTime = parseInt(timestamp, 10) * 1000;
    return Date.now() - commitTime;
  }

  // ── Alert Formatting ───────────────────────────────────────────

  private formatSessionAlert(session: Session, report: WorktreeReport): string {
    const lines = [`⚠️ Worktree activity detected after session "${session.name}" completed:`];

    if (report.withUnmergedWork.length > 0) {
      lines.push('');
      lines.push('UNMERGED WORK:');
      for (const diff of report.withUnmergedWork) {
        lines.push(`  Branch: ${diff.worktree.branch}`);
        lines.push(`  Commits ahead: ${diff.commitsAhead}`);
        lines.push(`  Files: ${diff.filesChanged.slice(0, 5).join(', ')}${diff.filesChanged.length > 5 ? ` (+${diff.filesChanged.length - 5} more)` : ''}`);
        lines.push('');
      }
    }

    if (report.orphanBranches.length > 0) {
      lines.push('ORPHAN BRANCHES (no active worktree):');
      for (const branch of report.orphanBranches) {
        lines.push(`  ${branch}`);
      }
    }

    lines.push('');
    lines.push('Action needed: merge or delete these branches to prevent work loss.');

    return lines.join('\n');
  }

  private async formatPeriodicAlert(report: WorktreeReport, staleWorktrees: Worktree[]): Promise<string> {
    const lines = ['🔍 Stale worktrees detected:'];

    for (const wt of staleWorktrees) {
      const ageMs = await this.getWorktreeAge(wt);
      const ageHours = ageMs ? Math.round(ageMs / 3_600_000) : '?';
      lines.push(`  ${wt.branch ?? wt.path} — ${ageHours}h old`);
    }

    if (report.orphanBranches.length > 0) {
      lines.push('');
      lines.push('Orphan branches:');
      for (const branch of report.orphanBranches) {
        lines.push(`  ${branch}`);
      }
    }

    return lines.join('\n');
  }

  // ── Internals ──────────────────────────────────────────────────

  /**
   * Run a git command. Uses shell execution to support glob patterns (e.g., worktree-*).
   *
   * ASYNC (was spawnSync): on a repo with many worktrees `git worktree list` can take
   * seconds, and the scans below issue several git calls — running them synchronously
   * blocked the server event loop for seconds per scan (5-min periodic + every
   * session-end), which over a tunnel drops the dashboard websocket. Async `execFile`
   * keeps the loop responsive while git runs. Semantics preserved: returns stdout even
   * on a non-zero exit / timeout (matching the old spawnSync `result.stdout ?? ''`).
   */
  private async gitCommand(args: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `git ${args}`], {
        cwd: this.config.projectDir,
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return stdout ?? '';
    } catch (err) {
      // spawnSync returned stdout even on a non-zero exit / timeout; preserve that.
      const stdout = (err as { stdout?: unknown })?.stdout;
      return typeof stdout === 'string' ? stdout : '';
    }
  }

  private async sendAlert(message: string): Promise<void> {
    if (this.config.alertCallback) {
      try {
        await this.config.alertCallback(message);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        this.lastReport = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      }
    } catch {
      this.lastReport = null;
    }
  }

  private saveState(report: WorktreeReport): void {
    this.lastReport = report;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(report, null, 2));
    } catch {
      // Non-fatal — state persistence is best-effort
    }
  }
}
