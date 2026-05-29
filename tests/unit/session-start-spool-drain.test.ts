/**
 * Tests for the SessionStart-hook escalation-spool drain (Scope C — drain).
 * The drain runs in a CONSENTED context (a Claude session) — it can read the
 * agent's Documents-resident config.json that the launchd-spawned watchdog
 * cannot on macOS 26, and uses the agent's own Telegram credential to deliver
 * outage pages the watchdog spooled but couldn't autonomously send (the
 * b2lead-before-fix case: no credential armed yet).
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Run bash hook asynchronously so the Node HTTP mock can process incoming
 * requests while bash/python runs. spawnSync would block Node's event loop and
 * the Python urlopen would time out before the mock server could respond.
 */
function runHookAsync(env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('bash', [HOOK_PATH], { env, stdio: 'ignore' });
    child.on('close', (code) => resolve(code));
  });
}

const HOOK_PATH = path.resolve(__dirname, '..', '..', 'src', 'templates', 'hooks', 'session-start.sh');
const itDarwin = process.platform === 'darwin' ? it : it.skip;

describe('session-start hook — spool drain (content checks)', () => {
  const body = fs.readFileSync(HOOK_PATH, 'utf-8');

  it('drain block exists and references the machine-level spool path', () => {
    expect(body).toContain('SPOOL="$HOME/.instar/watchdog-escalations.jsonl"');
  });

  it('fast-path skips Python entirely when no spool / empty spool', () => {
    // `[ -s "$SPOOL" ]` is the cheap test (true only when file exists + non-empty).
    expect(body).toMatch(/if \[ -s "\$SPOOL" \]; then[\s\S]+?python3/);
  });

  it('reads the AGENT config from its projectDir/.instar (consented context can reach Documents)', () => {
    expect(body).toMatch(/cfg_path = os\.path\.join\(project_dir, '\.instar', 'config\.json'\)/);
  });

  it('uses urllib.request (no curl subprocess with token in argv)', () => {
    // Slice precisely to the Python heredoc body (between PYEOF markers).
    const heredoc = body.split("<<'PYEOF'")[1]?.split('PYEOF')[0] ?? '';
    expect(heredoc).toContain('urllib.request');
    // Defensive: no `subprocess` / `curl` invocation inside the drain Python.
    expect(heredoc).not.toMatch(/\bsubprocess\b/);
    expect(heredoc).not.toMatch(/\bcurl\b/);
  });

  it('marks delivered on http 200 and atomically rewrites the spool', () => {
    expect(body).toMatch(/if resp\.status == 200:[\s\S]+?e\['delivered'\] = True/);
    expect(body).toMatch(/os\.replace\(tmp, spool_path\)/);
    expect(body).toMatch(/mkstemp\(prefix='\.spool-', dir=spool_dir\)/);
    expect(body).toMatch(/os\.chmod\(tmp, 0o600\)/);
  });

  it('honors INSTAR_TELEGRAM_API_BASE for testing', () => {
    expect(body).toContain("os.environ.get('INSTAR_TELEGRAM_API_BASE'");
  });

  it('groups undelivered entries by projectDir (open each config.json once)', () => {
    expect(body).toMatch(/by_project\.setdefault\(pd, \[\]\)\.append\(e\)/);
  });

  it('never fails the hook on a drain error (best-effort, non-fatal)', () => {
    // Bash side: `python3 ... 2>/dev/null <<'PYEOF' || true`
    expect(body).toMatch(/python3 - "\$SPOOL" 2>\/dev\/null <<'PYEOF' \|\| true/);
  });
});

describe('session-start hook — spool drain (darwin behavioral, mock Telegram)', () => {
  let fakeHome: string;
  let server: Server;
  let port: number;
  let received: Array<{ url: string; body: string }>;

  beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-drain-'));
    received = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url || '', body: Buffer.concat(chunks).toString('utf-8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"result":{}}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function writeFakeAgent(projectDir: string, token: string, chatId: string): void {
    const instar = path.join(projectDir, '.instar');
    fs.mkdirSync(instar, { recursive: true });
    fs.writeFileSync(
      path.join(instar, 'config.json'),
      JSON.stringify({
        port: 4042,
        authToken: 'irrelevant',
        projectName: path.basename(projectDir),
        messaging: [{ type: 'telegram', token, chatId }],
      }),
    );
  }

  function appendSpool(entry: Record<string, unknown>): string {
    const spoolDir = path.join(fakeHome, '.instar');
    fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const spool = path.join(spoolDir, 'watchdog-escalations.jsonl');
    fs.appendFileSync(spool, JSON.stringify(entry) + '\n');
    return spool;
  }

  itDarwin('delivers an undelivered entry to Telegram and marks it delivered + atomic rewrite', async () => {
    const projectDir = path.join(fakeHome, 'Documents', 'Projects', 'b2lead');
    writeFakeAgent(projectDir, '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789', '5447');
    const spool = appendSpool({
      label: 'ai.instar.b2lead',
      projectDir,
      cause: 'tcc-spawn-blocked',
      firstDetectedDown: 1000,
      remediation: 'run instar relocate or grant FDA',
      ts: '2026-05-28T00:00:00Z',
    });

    const status = await runHookAsync({
      ...process.env,
      HOME: fakeHome,
      CLAUDE_PROJECT_DIR: fakeHome,
      INSTAR_TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
    });
    // The hook may exit 0 OR succeed silently — the assertion is on side effects.
    expect(status === 0 || status === null).toBe(true);

    // Telegram mock received the POST with the right shape.
    expect(received).toHaveLength(1);
    expect(received[0].url).toContain('/bot1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789/sendMessage');
    expect(received[0].body).toContain('chat_id=5447');
    expect(received[0].body).toContain('relocate');

    // Spool was atomically rewritten with delivered:true.
    const remaining = fs.readFileSync(spool, 'utf-8').trim().split('\n').filter(Boolean);
    expect(remaining).toHaveLength(1);
    const parsed = JSON.parse(remaining[0]);
    expect(parsed.delivered).toBe(true);
  });

  itDarwin('skips already-delivered entries (idempotent — re-running the hook does not re-page)', async () => {
    const projectDir = path.join(fakeHome, 'Documents', 'Projects', 'b2lead');
    writeFakeAgent(projectDir, '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789', '5447');
    appendSpool({
      label: 'ai.instar.b2lead',
      projectDir,
      cause: 'tcc-spawn-blocked',
      firstDetectedDown: 1000,
      remediation: 'r',
      ts: '2026-05-28T00:00:00Z',
      delivered: true,
    });

    await runHookAsync({
      ...process.env,
      HOME: fakeHome,
      CLAUDE_PROJECT_DIR: fakeHome,
      INSTAR_TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
    });
    expect(received).toHaveLength(0);
  });

  itDarwin('non-empty spool but no telegram config in projectDir → leaves entry untouched', async () => {
    const projectDir = path.join(fakeHome, 'Documents', 'Projects', 'no-tg');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ projectName: 'no-tg', messaging: [] }),
    );
    const spool = appendSpool({
      label: 'ai.instar.no-tg',
      projectDir,
      cause: 'tcc-spawn-blocked',
      firstDetectedDown: 2000,
      remediation: 'r',
      ts: 't',
    });

    await runHookAsync({
      ...process.env,
      HOME: fakeHome,
      CLAUDE_PROJECT_DIR: fakeHome,
      INSTAR_TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
    });
    expect(received).toHaveLength(0);
    const remaining = JSON.parse(fs.readFileSync(spool, 'utf-8').trim());
    expect(remaining.delivered).toBeUndefined();
  });
});

// Suppress the now-unused spawnSync import warning when only spawn is used.
void spawnSync;
