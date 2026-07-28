/**
 * `instar dev:profile-node [pid]` — CPU-profile a RUNNING node process and print
 * the hottest JS functions (function + file:line + self-time %).
 *
 * Why this exists: macOS `sample` (and lsof snapshots, `gh run --log`, etc.) can't
 * symbolicate a node process's JS frames — they show only native/V8 frames, so a
 * busy node server's actual hot *function* stays invisible. This wraps the
 * technique that DOES see it: SIGUSR1 opens node's inspector on the running
 * process, then a CDP CPU profile over the inspector websocket reports the exact
 * JS call frames. (This is how the StateManager.listSessions hot-loop was pinned —
 * 30% of CPU in readFileUtf8 under listSessions, invisible to every other tool.)
 *
 * Side effect: SIGUSR1 opens the inspector on 127.0.0.1 (localhost-only) for the
 * life of the process; it closes when the process restarts. The command says so.
 * Read-only otherwise — it samples, it never mutates the target.
 */
import { execFile } from 'node:child_process';
import pc from 'picocolors';

export interface CdpCallFrame { functionName?: string; url?: string; lineNumber?: number; }
export interface CdpProfileNode { callFrame?: CdpCallFrame; hitCount?: number; }
export interface CdpProfile { nodes?: CdpProfileNode[]; }
export interface InspectorTarget { webSocketDebuggerUrl?: string; title?: string; }
export interface HotFrame { label: string; selfPct: number; samples: number; }

export interface ProfileNodeOutput { write(text: string): void; error(text: string): void; }

/** Injectable boundary so the command is unit-testable without a real process. */
export interface ProfileNodeDeps {
  /** Send SIGUSR1 to a pid (opens node's inspector). Throws if the pid is gone. */
  signalUsr1(pid: number): void;
  /** GET `http://127.0.0.1:<port>/json/list` → the first inspector target, or null. */
  fetchInspectorTarget(port: number): Promise<InspectorTarget | null>;
  /** Connect to the CDP websocket + capture a CPU profile over `durationMs`. */
  captureCpuProfile(wsUrl: string, durationMs: number): Promise<CdpProfile>;
  /** Resolve the hottest `node` pid for the no-arg form (or null). */
  hottestNodePid(): Promise<number | null>;
  /** Sleep (injected so tests don't actually wait). */
  sleep(ms: number): Promise<void>;
}

export interface DevProfileNodeOptions {
  pid?: string;
  durationSec?: number;
  top?: number;
  output?: ProfileNodeOutput;
  deps?: ProfileNodeDeps;
}

const INSPECTOR_PORTS = [9229, 9230, 9231, 9232, 9233, 9234, 9235];
const DEFAULT_TOP = 15;
const DEFAULT_DURATION_SEC = 5;

/**
 * Pure: aggregate a CDP CPU profile's self-time (per-node `hitCount`) by JS call
 * frame, returning the top-N frames as `function  src/file.js:line` + self %.
 * The biggest non-idle entry IS the hot loop. Idle/native frames (`(idle)`,
 * `(program)`, GC) are kept — seeing "48% idle, 30% readFileUtf8" is the signal.
 */
export function aggregateHotFrames(profile: CdpProfile, topN: number = DEFAULT_TOP): HotFrame[] {
  const self = new Map<string, number>();
  for (const n of profile.nodes ?? []) {
    const f = n.callFrame ?? {};
    const fn = f.functionName && f.functionName.length > 0 ? f.functionName : '(anonymous)';
    const loc = f.url ? `${f.url.replace(/^.*\/(dist|src)\//, '$1/')}:${(f.lineNumber ?? -1) + 1}` : '';
    const key = loc ? `${fn}  ${loc}` : fn;
    self.set(key, (self.get(key) ?? 0) + (n.hitCount ?? 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  return [...self.entries()]
    .map(([label, samples]) => ({ label, samples, selfPct: Math.round((1000 * samples) / total) / 10 }))
    .sort((a, b) => b.samples - a.samples)
    .slice(0, topN);
}

/** Probe the inspector ports for the target opened by SIGUSR1. First hit wins. */
export async function findInspectorTarget(deps: ProfileNodeDeps): Promise<InspectorTarget | null> {
  for (const port of INSPECTOR_PORTS) {
    try {
      const t = await deps.fetchInspectorTarget(port);
      if (t?.webSocketDebuggerUrl) return t;
    } catch { /* try the next port */ }
  }
  return null;
}

/**
 * Orchestrate: resolve pid → SIGUSR1 → find inspector → CDP CPU profile →
 * aggregate → print. Returns an exit code (0 ok, 1 operational failure).
 */
export async function runDevProfileNode(opts: DevProfileNodeOptions): Promise<number> {
  const out = opts.output ?? { write: (t) => process.stdout.write(t), error: (t) => process.stderr.write(t) };
  const deps = opts.deps ?? productionDeps();
  const durationMs = Math.max(1, opts.durationSec ?? DEFAULT_DURATION_SEC) * 1000;
  const topN = opts.top ?? DEFAULT_TOP;

  let pid: number | null = null;
  if (opts.pid && /^\d+$/.test(opts.pid)) {
    pid = parseInt(opts.pid, 10);
  } else {
    pid = await deps.hottestNodePid();
    if (pid == null) { out.error(pc.red('No running node process found to profile.\n')); return 1; }
    out.write(pc.dim(`No pid given — profiling the hottest node process: ${pid}\n`));
  }

  try { deps.signalUsr1(pid); }
  catch { out.error(pc.red(`Could not signal pid ${pid} (is it alive? is it a node process?).\n`)); return 1; }

  // The inspector takes a moment to bind after SIGUSR1.
  await deps.sleep(800);
  const target = await findInspectorTarget(deps);
  if (!target?.webSocketDebuggerUrl) {
    out.error(pc.red(`pid ${pid} did not expose a node inspector on 127.0.0.1:9229-9235.\n` +
      `It may not be a node process, or the inspector is already bound elsewhere.\n`));
    return 1;
  }

  out.write(pc.dim(`Profiling ${pid} for ${durationMs / 1000}s via the inspector…\n`));
  let profile: CdpProfile;
  try { profile = await deps.captureCpuProfile(target.webSocketDebuggerUrl, durationMs); }
  catch (err) { out.error(pc.red(`CPU profile failed: ${err instanceof Error ? err.message : String(err)}\n`)); return 1; }

  const frames = aggregateHotFrames(profile, topN);
  if (frames.length === 0) { out.error(pc.yellow('Profile captured but no samples — try a longer --duration.\n')); return 0; }

  out.write(pc.bold(`\nHottest JS frames (self-time) for pid ${pid}:\n`));
  for (const f of frames) {
    const pct = `${f.selfPct.toFixed(1)}%`.padStart(6);
    out.write(`  ${pc.cyan(pct)}  ${f.label}\n`);
  }
  out.write(pc.dim(`\n(The biggest non-idle frame is the hot path. SIGUSR1 left the inspector ` +
    `open on 127.0.0.1 for pid ${pid}; it closes on the process's next restart.)\n`));
  return 0;
}

/** Production deps: real SIGUSR1, http inspector probe, ws CDP profile, ps. */
export function productionDeps(): ProfileNodeDeps {
  return {
    signalUsr1(pid) { process.kill(pid, 'SIGUSR1'); },
    async fetchInspectorTarget(port) {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const list = (await res.json()) as InspectorTarget[];
      return Array.isArray(list) && list.length > 0 ? list[0] : null;
    },
    async captureCpuProfile(wsUrl, durationMs) {
      const { WebSocket } = await import('ws');
      return await new Promise<CdpProfile>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { maxPayload: 512 * 1024 * 1024 });
        let id = 0; const pending = new Map<number, (r: unknown) => void>();
        const send = (method: string, params: Record<string, unknown> = {}) =>
          new Promise<unknown>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const fail = (e: Error) => { try { ws.close(); } catch { /* noop */ } reject(e); };
        const timer = setTimeout(() => fail(new Error('inspector timed out')), durationMs + 15000);
        ws.on('message', (m: Buffer | string) => {
          const o = JSON.parse(m.toString()) as { id?: number; result?: unknown };
          if (o.id != null && pending.has(o.id)) { pending.get(o.id)!(o.result); pending.delete(o.id); }
        });
        ws.on('error', (e: Error) => { clearTimeout(timer); fail(e); });
        ws.on('open', () => { void (async () => {
          await send('Profiler.enable');
          await send('Profiler.setSamplingInterval', { interval: 100 });
          await send('Profiler.start');
          await new Promise((r) => setTimeout(r, durationMs));
          const stop = (await send('Profiler.stop')) as { profile?: CdpProfile };
          clearTimeout(timer);
          try { ws.close(); } catch { /* noop */ }
          resolve(stop.profile ?? {});
        })().catch(fail); });
      });
    },
    async hottestNodePid() {
      return await new Promise<number | null>((resolve) => {
        execFile('ps', ['-Aceo', 'pcpu,pid,comm'], { timeout: 5000 }, (err, stdout) => {
          if (err) { resolve(null); return; }
          const hot = stdout.split('\n').map((l) => l.trim().match(/^([\d.]+)\s+(\d+)\s+(.+)$/))
            .filter((m): m is RegExpMatchArray => !!m && m[3] === 'node')
            .sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]))[0];
          resolve(hot ? parseInt(hot[2], 10) : null);
        });
      });
    },
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },
  };
}
