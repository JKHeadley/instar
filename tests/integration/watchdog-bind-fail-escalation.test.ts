/**
 * Integration test for the fleet-watchdog bind-failure escalation pipeline.
 *
 * Spec: docs/specs/watchdog-bind-failure-probe.md
 *
 * What this tests:
 *
 * Simulates the AI-Guy-stuck-behind-codex pattern: two agents configured for
 * the same port, the wrong one bound it first. After 3 consecutive probe
 * cycles (the spec's escalate-after threshold), the watchdog escalates via
 * the existing /attention path with a conflict-aware summary.
 *
 * Like the PR #245 integration tests, darwin-gated — the bash source-trick
 * harness doesn't survive Linux strictly-set-e environments and the
 * production target is macOS launchd only.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const WATCHDOG_PATH = path.resolve(__dirname, '..', '..', 'src', 'templates', 'scripts', 'instar-watchdog.sh');
const itDarwin = process.platform === 'darwin' ? it : it.skip;

interface CapturedRequest {
  url: string | undefined;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

interface MockServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
  requests: CapturedRequest[];
}

async function startMock(opts: {
  /** Project name returned on /health (for the bind-probe target). */
  project: string;
  /** HTTP code for /attention. */
  attentionCode?: number;
}): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      requests.push({ url: req.url, body, headers: req.headers });
      if (req.url === '/health') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', project: opts.project }));
        return;
      }
      if (req.url === '/attention' && req.method === 'POST') {
        res.statusCode = opts.attentionCode ?? 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'created', status: 'OPEN' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad address');
  return {
    server,
    port: addr.port,
    close: () => new Promise<void>((r) => server.close(() => r())),
    requests,
  };
}

interface BashRun { status: number | null; stdout: string; stderr: string; }
async function runBash(script: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<BashRun> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', script], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', status => resolve({ status, stdout, stderr }));
    const killer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    proc.on('close', () => clearTimeout(killer));
  });
}

describe('watchdog — bind-fail → handle_bind_fail → escalate_via_peer pipeline', () => {
  let peerMock: MockServer;
  let targetMock: MockServer;
  let tmp: string;
  let sandboxLaunchAgents: string;
  let sandboxStateDir: string;
  let sandboxLogFile: string;
  let aiGuyDir: string;
  let peerDir: string;

  beforeAll(async () => {
    // Peer agent (healthy, will receive /attention POST)
    peerMock = await startMock({ project: 'peer-fixture' });
    // Target's port is held by a "wrong" project — simulates the collision.
    targetMock = await startMock({ project: 'codex-server-smoke' });
  });
  afterAll(async () => {
    await peerMock.close();
    await targetMock.close();
  });

  beforeEach(() => {
    peerMock.requests.length = 0;
    targetMock.requests.length = 0;

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-fail-int-'));
    sandboxLaunchAgents = path.join(tmp, 'LaunchAgents');
    sandboxStateDir = path.join(tmp, 'state');
    sandboxLogFile = path.join(tmp, 'watchdog.log');
    fs.mkdirSync(sandboxLaunchAgents, { recursive: true });
    fs.mkdirSync(sandboxStateDir, { recursive: true });

    // Set up ai-guy project dir + config pointing at the collision port
    aiGuyDir = path.join(tmp, 'ai-guy');
    fs.mkdirSync(path.join(aiGuyDir, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(aiGuyDir, '.instar', 'config.json'),
      JSON.stringify({ port: targetMock.port, authToken: 'x' })
    );

    // Set up peer project + config (with its own port + auth)
    peerDir = path.join(tmp, 'peer-fixture');
    fs.mkdirSync(path.join(peerDir, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(peerDir, '.instar', 'config.json'),
      JSON.stringify({ port: peerMock.port, authToken: 'peer-auth-token' })
    );

    // Plists for both agents (so escalate_via_peer can discover the peer)
    fs.writeFileSync(
      path.join(sandboxLaunchAgents, 'ai.instar.ai-guy.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict>
  <key>Label</key><string>ai.instar.ai-guy</string>
  <key>WorkingDirectory</key><string>${aiGuyDir}</string>
</dict></plist>`
    );
    fs.writeFileSync(
      path.join(sandboxLaunchAgents, 'ai.instar.peer-fixture.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict>
  <key>Label</key><string>ai.instar.peer-fixture</string>
  <key>WorkingDirectory</key><string>${peerDir}</string>
</dict></plist>`
    );
  });

  function envSandbox(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmp,
      INSTAR_WATCHDOG_LAUNCH_AGENTS_DIR: sandboxLaunchAgents,
      INSTAR_WATCHDOG_STATE_DIR: sandboxStateDir,
      INSTAR_WATCHDOG_LOG_FILE: sandboxLogFile,
    };
  }

  function sourceTrick(rest: string): string {
    return `
      tmp_src=$(mktemp)
      awk '/^recovered=0$/{print "return 0"; exit} {print}' "${WATCHDOG_PATH}" > "$tmp_src"
      source "$tmp_src"
      rm -f "$tmp_src"
      set +e
      ${rest}
    `;
  }

  itDarwin('three consecutive bind-fails trigger conflict-aware peer escalation', async () => {
    // Seed the counter at 2 so the third bind-fail triggers escalation.
    fs.writeFileSync(
      path.join(sandboxStateDir, 'ai.instar.ai-guy.consecutive-heal-fails'),
      '2'
    );
    fs.writeFileSync(
      path.join(sandboxStateDir, 'ai.instar.ai-guy.bind-fail-conflict'),
      'codex-server-smoke'
    );

    const r = await runBash(sourceTrick(`
      escalate_via_peer "ai.instar.ai-guy" 3
      echo "EXIT=$?"
    `), envSandbox());

    // One POST to the peer's /attention
    const posts = peerMock.requests.filter(req => req.url === '/attention');
    expect(posts.length).toBe(1);

    const payload = JSON.parse(posts[0].body);
    expect(payload.category).toBe('degradation');
    expect(payload.priority).toBe('HIGH');
    // Conflict-aware copy mentions both parties
    expect(payload.summary).toMatch(/ai-guy/);
    expect(payload.summary).toMatch(/codex-server-smoke/);
    expect(payload.summary).toMatch(/using its port/);
    expect(payload.description).toBe('Want me to dig in?');

    // No B12 jargon in the summary
    const lower = (payload.summary as string).toLowerCase();
    expect(lower).not.toMatch(/\blifeline\b/);
    expect(lower).not.toMatch(/\blaunchd\b/);
    expect(lower).not.toMatch(/\bpid\b/);
    expect(lower).not.toMatch(/crash[- ]loop/);

    // Counter reset on successful 201
    expect(fs.existsSync(path.join(sandboxStateDir, 'ai.instar.ai-guy.consecutive-heal-fails'))).toBe(false);
    // Bind-fail conflict file cleared too
    expect(fs.existsSync(path.join(sandboxStateDir, 'ai.instar.ai-guy.bind-fail-conflict'))).toBe(false);

    expect(r.stdout).toContain('EXIT=0');
  });

  itDarwin('without conflict context, escalation falls back to generic offline copy', async () => {
    fs.writeFileSync(
      path.join(sandboxStateDir, 'ai.instar.ai-guy.consecutive-heal-fails'),
      '2'
    );
    // No bind-fail-conflict file → no conflict context

    const r = await runBash(sourceTrick(`
      escalate_via_peer "ai.instar.ai-guy" 3
      echo "EXIT=$?"
    `), envSandbox());

    const posts = peerMock.requests.filter(req => req.url === '/attention');
    expect(posts.length).toBe(1);
    const payload = JSON.parse(posts[0].body);
    // Generic copy, no port-conflict language
    expect(payload.summary).toMatch(/offline for about/);
    expect(payload.summary).not.toMatch(/using its port/);
    expect(r.stdout).toContain('EXIT=0');
  });
});
