/**
 * mcpProcessReaperDeps — production signal sources for {@link McpProcessReaper}.
 *
 * Kept out of the reaper class so the classifier stays unit-testable without a
 * real process table, tmux, or kill(2). This factory supplies the ps/tmux/
 * SessionManager/kill/audit implementations.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  mcpGrepAlternation,
  matchMcpSignature,
} from './mcpProcessSignatures.js';
import type {
  McpProcessReaperDeps,
  McpProcessInfo,
  McpReapAuditEntry,
} from './McpProcessReaper.js';

function shellExec(cmd: string, timeout = 8000): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Parse an `etime` field (`[[dd-]hh:]mm:ss`) into milliseconds. */
function parseElapsedMs(etime: string): number {
  const s = etime.trim();
  let days = 0;
  let rest = s;
  if (rest.includes('-')) {
    const [d, r] = rest.split('-');
    days = parseInt(d, 10) || 0;
    rest = r;
  }
  const parts = rest.split(':').map((p) => parseInt(p, 10) || 0);
  let h = 0, m = 0, sec = 0;
  if (parts.length === 3) [h, m, sec] = parts;
  else if (parts.length === 2) [m, sec] = parts;
  else if (parts.length === 1) [sec] = parts;
  return (((days * 24 + h) * 60 + m) * 60 + sec) * 1000;
}

interface SessionLister {
  listRunningSessions: () => Array<{ tmuxSession: string }>;
  listKnownTmuxSessions: () => Set<string>;
}

export function makeMcpProcessReaperDeps(opts: {
  sessionManager: SessionLister;
  tmuxPath: string;
  auditPath: string;
  now?: () => number;
}): McpProcessReaperDeps {
  const { sessionManager, tmuxPath, auditPath } = opts;

  return {
    listMcpProcesses(): McpProcessInfo[] {
      const uid = process.getuid?.() ?? 0;
      const out = shellExec(
        `ps -u ${uid} -o pid=,ppid=,etime=,command= 2>/dev/null | egrep -i '${mcpGrepAlternation()}' | grep -v egrep`,
      ).trim();
      if (!out) return [];
      const procs: McpProcessInfo[] = [];
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/);
        if (!m) continue;
        const command = m[4];
        const sig = matchMcpSignature(command);
        if (!sig) continue; // second-stage precise match — never a broad node/npm hit
        procs.push({
          pid: parseInt(m[1], 10),
          ppid: parseInt(m[2], 10),
          elapsedMs: parseElapsedMs(m[3]),
          command: command.slice(0, 300),
          signatureId: sig.id,
        });
      }
      return procs;
    },

    getProcessTree(): Map<number, number> {
      const tree = new Map<number, number>();
      const out = shellExec(`ps -axo pid=,ppid= 2>/dev/null`).trim();
      if (!out) return tree;
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) tree.set(parseInt(m[1], 10), parseInt(m[2], 10));
      }
      return tree;
    },

    getTmuxPaneMap(): Map<number, string> {
      const map = new Map<number, string>();
      const out = shellExec(`${tmuxPath} list-panes -a -F "#{session_name}||#{pane_pid}" 2>/dev/null`).trim();
      if (!out) return map;
      for (const line of out.split('\n')) {
        const [session, pidStr] = line.split('||');
        const pid = parseInt(pidStr, 10);
        if (session && !isNaN(pid)) map.set(pid, session);
      }
      return map;
    },

    getLiveSessions(): Set<string> {
      try {
        return new Set(sessionManager.listRunningSessions().map((s) => s.tmuxSession).filter(Boolean));
      } catch {
        return new Set();
      }
    },

    getInstarSessions(): Set<string> {
      try {
        return sessionManager.listKnownTmuxSessions();
      } catch {
        return new Set();
      }
    },

    killProcess(pid: number): void {
      // SIGTERM (graceful). The proc's session is already dead/stale, so there is
      // nothing to coordinate with — a clean terminate is sufficient.
      process.kill(pid, 'SIGTERM');
    },

    audit(entry: McpReapAuditEntry): void {
      try {
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n');
      } catch {
        // Audit must never break the reap loop.
      }
    },

    now: opts.now,
  };
}
