/**
 * Top-process listing for the overload self-help notice
 * (trustworthy-machine-load C4). Async `ps` (never spawnSync — the machine is
 * already overloaded and the event loop must not stall), bounded output,
 * best-effort: any failure yields an empty list.
 */
import { execFile } from 'node:child_process';

export interface TopProcess {
  pid: number;
  ppid: number;
  cpuPct: number;
  rssBytes: number;
  command: string;
  owner: 'agent' | 'external';
}

/** Parse `ps -Ao pid=,ppid=,pcpu=,rss=,comm=` output. Exported for tests. */
export function parsePsOutput(out: string): Array<Omit<TopProcess, 'owner'>> {
  const rows: Array<Omit<TopProcess, 'owner'>> = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const command = m[5].split('/').pop()!.slice(0, 80);
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuPct: Number(m[3]), rssBytes: Number(m[4]) * 1024, command });
  }
  return rows;
}

/**
 * The union of the top `n` by CPU and the top `n` by memory, each marked
 * agent-owned when it descends from this agent server's pid.
 */
export function rankTopProcesses(rows: Array<Omit<TopProcess, 'owner'>>, agentPid: number, n = 5): TopProcess[] {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const isAgent = (pid: number): boolean => {
    let cur: number | undefined = pid;
    for (let i = 0; i < 64 && cur !== undefined && cur > 1; i++) {
      if (cur === agentPid) return true;
      cur = parent.get(cur);
    }
    return false;
  };
  const byCpu = [...rows].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, n);
  const byMem = [...rows].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, n);
  const seen = new Set<number>();
  const out: TopProcess[] = [];
  for (const r of [...byCpu, ...byMem]) {
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    out.push({ ...r, owner: isAgent(r.pid) ? 'agent' : 'external' });
  }
  return out;
}

export function listTopProcesses(opts: { agentPid: number; n?: number; timeoutMs?: number }): Promise<TopProcess[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,ppid=,pcpu=,rss=,comm='], { timeout: opts.timeoutMs ?? 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve([]); return; } // @silent-fallback-ok: the notice says the list is unavailable
      resolve(rankTopProcesses(parsePsOutput(String(stdout)), opts.agentPid, opts.n ?? 5));
    });
  });
}
