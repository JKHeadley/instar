/**
 * `instar dashboard open` — the one-time local dashboard link (docs/specs/identity-security-piece1a-local-link.md).
 *
 * Mints a single-use link against this agent's own server on 127.0.0.1, authenticated both ways by
 * the private local-access key, then opens the browser through a private launch document (the
 * secret never appears in a process argument), or prints the link for an SSH forward.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectProjectDir } from '../core/Config.js';
import { LOCAL_ACCESS_DIR } from '../core/LocalAccessStore.js';
import { LAUNCH_SUBDIR, LOCAL_ACCESS_PREFIX, hmac, mintProofText, mintResponseText, readListenerKey, sha256Hex } from '../server/localAccessRoutes.js';

export interface DashboardOpenOptions {
  dir?: string;
  print?: boolean;
  port?: string | number;
}

interface Resolved { projectDir: string; stateDir: string; port: number; agentName: string; tunnelUrl: string | null }

const hasConfig = (d: string): boolean => fs.existsSync(path.join(d, '.instar', 'config.json'));

/** The agent folder: --dir, else the enclosing agent folder, else the only standalone agent. */
export function resolveAgentDir(dir: string | undefined, cwd = process.cwd(), home = os.homedir()): { dir: string } | { error: string } {
  if (dir) return hasConfig(path.resolve(dir)) ? { dir: path.resolve(dir) } : { error: `No agent found at ${dir}.` };
  const detected = detectProjectDir(cwd);
  if (hasConfig(detected) && path.resolve(detected) !== path.resolve(home)) return { dir: detected };
  const agentsDir = path.join(home, '.instar', 'agents');
  let agents: string[] = [];
  try { agents = fs.readdirSync(agentsDir).map((n) => path.join(agentsDir, n)).filter(hasConfig); } catch { agents = []; } // @silent-fallback-ok — no standalone agents folder
  if (agents.length === 1) return { dir: agents[0] };
  if (agents.length === 0) return { error: 'No agent found here. Run this inside an agent folder, or pass --dir <agent folder>.' };
  return { error: `More than one agent on this computer. Choose one with --dir:\n${agents.map((a) => `  ${a}`).join('\n')}` };
}

function readAgent(projectDir: string): Resolved {
  const stateDir = path.join(projectDir, '.instar');
  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8')) as { port?: unknown; projectName?: unknown; tunnel?: { url?: unknown } };
  const port = Number(cfg.port ?? 4040);
  return { projectDir, stateDir, port, agentName: String(cfg.projectName ?? 'agent'), tunnelUrl: typeof cfg.tunnel?.url === 'string' ? cfg.tunnel.url : null };
}

/** `session` when run with a session environment or without a terminal; telemetry only. */
export function detectStartedBy(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): 'terminal' | 'session' {
  if (env.INSTAR_SESSION_ID || env.INSTAR_AUTH_TOKEN || !isTty) return 'session';
  return 'terminal';
}

export async function mintLink(a: Resolved, browserPort: number, fetchFn: typeof fetch = fetch): Promise<{ ok: true; id: string; secret: string; launchName: string; origin: string; expiresAt: number } | { ok: false; message: string }> {
  let key: Buffer;
  try { key = readListenerKey(a.stateDir); } catch {
    return { ok: false, message: 'The local link is not set up on this agent yet (it is created when the agent starts with the feature on).' };
  }
  const timeMs = Date.now();
  const clientNonce = crypto.randomBytes(18).toString('base64url');
  const startedBy = detectStartedBy();
  const proof = hmac(key, mintProofText(a.agentName, a.port, browserPort, startedBy, timeMs, clientNonce));
  let res: Response;
  try {
    res = await fetchFn(`http://127.0.0.1:${a.port}${LOCAL_ACCESS_PREFIX}/mint`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browserPort, startedBy, timeMs, clientNonce, proof }),
    });
  } catch {
    return { ok: false, message: `The agent is not answering on 127.0.0.1:${a.port}. Is it running?` };
  }
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { body = {}; }
  if (res.status === 404) return { ok: false, message: 'The local link is not turned on for this agent.' };
  if (res.status === 503) return { ok: false, message: body.reason === 'not-listening-on-127.0.0.1' ? 'This agent does not listen on 127.0.0.1, so the local link is off.' : 'The local link is not available right now.' };
  const origin = `http://127.0.0.1:${browserPort}`;
  const id = String(body.id ?? ''); const secret = String(body.secret ?? ''); const launchName = String(body.launchName ?? '');
  const expiresAt = Number(body.expiresAt);
  const expected = hmac(key, mintResponseText(clientNonce, id, sha256Hex(secret), expiresAt, launchName, String(body.origin ?? '')));
  const proofOk = typeof body.responseProof === 'string' && body.responseProof.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(body.responseProof), Buffer.from(expected));
  if (!res.ok || !proofOk || body.origin !== origin || !/^[A-Za-z0-9_-]{22}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret) || !/^[A-Za-z0-9_-]{22}$/.test(launchName)) {
    return { ok: false, message: 'Something other than your agent answered on its local address, so no link was made. Another program may be using that address.' + (a.tunnelUrl ? ` You can still sign in at ${a.tunnelUrl}/dashboard.` : '') };
  }
  return { ok: true, id, secret, launchName, origin, expiresAt };
}

function launchDocument(url: string): string {
  const u = JSON.stringify(url).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening your dashboard</title></head><body><script>location.replace(${u});</script></body></html>\n`;
}

export async function dashboardOpen(opts: DashboardOpenOptions): Promise<number> {
  const where = resolveAgentDir(opts.dir);
  if ('error' in where) { console.error(where.error); return 1; }
  const a = readAgent(where.dir);
  const signIn = `http://127.0.0.1:${a.port}/dashboard`;
  if (opts.print) {
    if (!process.stdout.isTTY) { console.error('Print mode needs a terminal, so the link is never written to a log.'); return 1; }
    const browserPort = Number(opts.port);
    if (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535) { console.error('Print mode needs --port <the forwarded port on your own machine>.'); return 1; }
    const m = await mintLink(a, browserPort);
    if (!m.ok) { console.error(m.message); return 1; }
    console.log(`\nOpen this on the machine you are forwarding from (private, works once, for 15 minutes):\n\n  ${m.origin}${LOCAL_ACCESS_PREFIX}/open#${m.id}.${m.secret}\n`);
    console.log(`Forward with: ssh -L 127.0.0.1:${browserPort}:127.0.0.1:${a.port} <this computer>\n`);
    return 0;
  }
  // identity-security-piece1g: inside WSL, print the link for the owner's Windows browser. It arrives
  // through WSL's localhost forwarding (loopback) or a Windows port forward (the WSL gateway).
  if (process.platform === 'linux' && runningUnderWsl()) {
    if (!process.stdout.isTTY) { console.error('This needs a terminal, so the link is never written to a log.'); return 1; }
    const browserPort = opts.port === undefined ? a.port : Number(opts.port);
    if (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535) { console.error('--port needs the Windows-side port number.'); return 1; }
    const m = await mintLink(a, browserPort);
    if (!m.ok) { console.error(m.message); return 1; }
    console.log(`\nOpen this in your Windows browser (private, works once, for 15 minutes):\n\n  ${m.origin}${LOCAL_ACCESS_PREFIX}/open#${m.id}.${m.secret}\n`);
    console.log('If your Windows machine forwards this port to other computers, they can reach the page but not without this link.\n');
    return 0;
  }
  if (process.platform !== 'darwin') {
    console.error(`Opening a browser from here is not supported on this system yet. Over SSH use --print --port <forwarded port>, or sign in at ${signIn}.`);
    return 1;
  }
  const m = await mintLink(a, a.port);
  if (!m.ok) { console.error(m.message); return 1; }
  const launchDir = path.join(a.stateDir, LOCAL_ACCESS_DIR, LAUNCH_SUBDIR);
  const file = path.join(launchDir, `${m.launchName}.html`);
  try {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, launchDocument(`${m.origin}${LOCAL_ACCESS_PREFIX}/open#${m.id}.${m.secret}`)); } finally { fs.closeSync(fd); }
  } catch {
    console.error(`Could not prepare the link. Sign in at ${signIn}.`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    const child = spawn('open', [file], { stdio: 'ignore', detached: true });
    child.on('error', () => resolve());
    child.on('spawn', () => { child.unref(); resolve(); });
  });
  console.log('Opening your dashboard in the browser. The link works once and for 15 minutes; you still enter your PIN.');
  return 0;
}

/** identity-security-piece1g: whether this process runs inside WSL. */
export function runningUnderWsl(env: NodeJS.ProcessEnv = process.env, read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(read('/proc/version')); } catch { return false; /* @silent-fallback-ok: not provably WSL */ }
}
