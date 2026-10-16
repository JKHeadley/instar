/**
 * The terminal fallback for hosts that cannot ask the person (spec threadline-standalone-pairing D5).
 *
 * The running server listens on a Unix socket in its state dir (0600). `threadline-mcp pair open`
 * (or `finish`) connects to it, and the server runs the SAME PairTools with an `elicit` that asks
 * over the socket; the CLI shows each question on the terminal and sends back the person's answer.
 * One process owns the relay connection and the pairing state, so nothing is duplicated or raced.
 *
 * This boundary is COOPERATIVE: an agent with shell access and a terminal could run the command
 * too. The tool text and the README say so.
 *
 * Wire: newline-delimited JSON.
 *   client → server  {cmd:'open'|'finish'|'status', iid?}   then {answer: {...} | null} per question
 *   server → client  {ask: message, fields}                  per question, then {result: ToolResult}
 */

import net from 'node:net';
import fs from 'node:fs';
import readline from 'node:readline';
import type { Elicit, PairTools, ToolResult } from './pairTools.js';

type Fields = Parameters<Elicit>[1];

/** How long a terminal may sit on one question before the server gives up on it. */
export const PAIR_SOCKET_IDLE_MS = 15 * 60_000;
/** At most this many terminals at once; more are refused by the OS backlog/close. */
export const PAIR_SOCKET_MAX_CONNECTIONS = 4;
/** The terminal protocol version; a client and server that disagree refuse, naming both (spec D5). */
export const PAIR_SOCKET_PROTOCOL = 1;
/** Unix socket paths longer than this fail or are silently truncated on macOS (104 bytes with the NUL). */
export const PAIR_SOCKET_MAX_PATH_BYTES = 103;

/** Why this path must not be used as the pair socket, or null. Never follows a symlink. */
export function pairSocketPathProblem(sockPath: string): string | null {
  if (Buffer.byteLength(sockPath) > PAIR_SOCKET_MAX_PATH_BYTES) return `the socket path is ${Buffer.byteLength(sockPath)} bytes, longer than the ${PAIR_SOCKET_MAX_PATH_BYTES} a Unix socket allows; use a shorter THREADLINE_STATE_DIR`;
  try {
    const st = fs.lstatSync(sockPath);
    if (st.isSymbolicLink()) return `${sockPath} is a symlink; refusing to use it for pairing`;
    if (!st.isSocket()) return `${sockPath} exists and is not a socket; refusing to replace it`;
  } catch { /* absent: fine */ }
  return null;
}

function lines(sock: net.Socket, onLine: (msg: Record<string, unknown>) => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { onLine(JSON.parse(line)); } catch { sock.destroy(); return; }
    }
  });
}
const send = (sock: net.Socket, msg: unknown) => { if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n'); };

/** Serve the pair socket. `toolsFor(elicit)` builds PairTools that ask through the connected terminal. */
export async function servePairSocket(sockPath: string, toolsFor: (elicit: Elicit) => PairTools, opts: { idleMs?: number } = {}): Promise<net.Server> {
  // Never take the socket from a live server on the same state dir; only clear a stale one.
  const early = pairSocketPathProblem(sockPath);
  if (early) throw new Error(early);
  const live = await new Promise<boolean>((resolve) => {
    const probe = net.connect(sockPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  const problem = pairSocketPathProblem(sockPath);
  if (problem) throw new Error(problem);
  if (live) throw new Error('another threadline-mcp is already serving terminal pairing for this state directory');
  try { if (fs.lstatSync(sockPath).isSocket()) fs.unlinkSync(sockPath); } catch { /* none */ }
  const server = net.createServer((sock) => {
    let pendingAnswer: ((a: Record<string, string> | null) => void) | null = null;
    let started = false;
    const elicit: Elicit = (message, fields) => new Promise((resolve) => {
      if (sock.destroyed) return resolve(null);
      pendingAnswer = resolve;
      send(sock, { ask: message, fields });
    });
    sock.on('close', () => { pendingAnswer?.(null); pendingAnswer = null; }); // a closed terminal answers nothing
    sock.on('error', () => { /* handled by close */ });
    // A connection that goes quiet is closed, which answers any pending question with nothing.
    sock.setTimeout(opts.idleMs ?? PAIR_SOCKET_IDLE_MS, () => sock.destroy());
    lines(sock, async (msg) => {
      if (pendingAnswer && 'answer' in msg) {
        const a = msg.answer && typeof msg.answer === 'object'
          ? Object.fromEntries(Object.entries(msg.answer as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : null;
        const r = pendingAnswer; pendingAnswer = null; r(a);
        return;
      }
      if (started) return;
      started = true;
      if (msg.v !== PAIR_SOCKET_PROTOCOL) {
        send(sock, { result: { ok: false, error: `This threadline-mcp speaks terminal protocol ${PAIR_SOCKET_PROTOCOL}; the command you ran speaks ${msg.v === undefined ? 'an older one' : String(msg.v)}. Run the threadline-mcp that your app runs (${process.argv[1] ?? 'unknown'}).` } as ToolResult });
        sock.end();
        return;
      }
      const tools = toolsFor(elicit);
      let result: ToolResult;
      if (msg.cmd === 'open') result = await tools.open();
      else if (msg.cmd === 'finish') result = await tools.finish({ iid: typeof msg.iid === 'string' ? msg.iid : undefined });
      else if (msg.cmd === 'status') result = tools.status();
      else result = { ok: false, error: 'Unknown command. Use open, finish or status.' };
      send(sock, { result });
      sock.end();
    });
  });
  server.maxConnections = PAIR_SOCKET_MAX_CONNECTIONS;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort; the state dir is 0700 */ }
      server.off('error', reject);
      resolve(server);
    });
  });
}

export interface CliIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

/** Lines typed on the terminal, in order. A pasted invite spans several lines, so lines are queued, not dropped. */
class LineReader {
  private queue: string[] = [];
  private waiters: Array<(l: string | null) => void> = [];
  private closed = false;
  constructor(rl: readline.Interface) {
    rl.on('line', (l) => { const w = this.waiters.shift(); if (w) w(l); else this.queue.push(l); });
    rl.on('close', () => { this.closed = true; while (this.waiters.length) this.waiters.shift()!(null); });
  }
  next(): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }
}

/** Ask one question on the terminal. Choices are numbered; free text ends at an empty line. */
async function askOnTerminal(lines: LineReader, out: NodeJS.WritableStream, message: string, fields: Fields): Promise<Record<string, string> | null> {
  out.write(`\n${message}\n`);
  const answer: Record<string, string> = {};
  for (const [key, f] of Object.entries(fields)) {
    if (f.enum?.length) {
      f.enum.forEach((c, i) => out.write(`  ${i + 1}) ${c}\n`));
      out.write(`${f.title} [1-${f.enum.length}, empty to cancel]: `);
      const raw = ((await lines.next()) ?? '').trim();
      if (!raw) return null;
      const n = Number(raw);
      const pick = Number.isInteger(n) && n >= 1 && n <= f.enum.length ? f.enum[n - 1] : f.enum.find((c) => c === raw.toLowerCase());
      if (!pick) { out.write('Not one of the choices, so nothing was decided.\n'); return null; }
      answer[key] = pick;
    } else {
      if (f.description) out.write(`(${f.description})\n`);
      // A pasted invite is several lines with blank lines inside, so a blank line alone cannot end it.
      // It ends at the line holding the invite code, or at two blank lines in a row; Enter first cancels.
      out.write(`${f.title}. Paste it, then press Enter (Enter alone cancels): `);
      const got: string[] = [];
      let blanks = 0;
      for (;;) {
        const l = await lines.next();
        if (l === null) break;
        if (!l.trim()) { if (!got.length || ++blanks >= 2) break; continue; }
        blanks = 0;
        got.push(l);
        if (/tlinv1:\S+/.test(l)) break;
      }
      if (!got.length) return null;
      answer[key] = got.join('\n');
    }
  }
  return answer;
}

/**
 * `threadline-mcp pair <open|finish|status> [iid]`. Returns the process exit code.
 * Refuses without a terminal: the point is that a person answers.
 */
export async function runPairCli(args: string[], sockPath: string, io: CliIO): Promise<number> {
  const [cmd, iid] = args;
  const out = io.output;
  if (!cmd || !['open', 'finish', 'status'].includes(cmd)) {
    out.write('Usage: threadline-mcp pair open | finish [iid] | status\n');
    return 2;
  }
  if (cmd !== 'status' && !io.isTTY) {
    out.write('This asks you, the person, to decide, so it needs an interactive terminal. Run it yourself in a terminal window.\n');
    return 2;
  }
  const pathProblem = pairSocketPathProblem(sockPath);
  if (pathProblem) { out.write(`Not done: ${pathProblem}\n`); return 1; }
  const sock = net.connect(sockPath);
  const rl = readline.createInterface({ input: io.input, output: out, terminal: io.isTTY });
  const typed = new LineReader(rl);
  try {
    return await new Promise<number>((resolve) => {
      let done = false;
      const finish = (code: number) => { if (!done) { done = true; resolve(code); } };
      sock.on('error', (e: NodeJS.ErrnoException) => {
        out.write(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
          ? 'Nothing is listening for terminal pairing. Terminal pairing is off unless THREADLINE_PAIR_TERMINAL=1 is set for threadline-mcp in your app\'s config, and threadline-mcp must be running (start your app). Then try again.\n'
          : `Could not reach threadline-mcp: ${e.message}\n`);
        finish(1);
      });
      sock.on('close', () => finish(1));
      sock.on('connect', () => send(sock, { cmd, v: PAIR_SOCKET_PROTOCOL, ...(iid ? { iid } : {}) }));
      lines(sock, async (msg) => {
        if ('ask' in msg) {
          const a = await askOnTerminal(typed, out, String(msg.ask), msg.fields as Fields);
          send(sock, { answer: a });
        } else if ('result' in msg) {
          const r = msg.result as ToolResult;
          out.write('\n' + (r.ok ? JSON.stringify(r, null, 2) : `Not done: ${r.error}`) + '\n');
          finish(r.ok ? 0 : 1);
          sock.end();
        }
      });
    });
  } finally {
    rl.close();
    sock.destroy();
  }
}
