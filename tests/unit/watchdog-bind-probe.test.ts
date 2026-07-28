/**
 * Unit tests for the fleet-watchdog bind-failure probe
 * (docs/specs/watchdog-bind-failure-probe.md).
 *
 * The probe surface is the new `probe_server_identity` function in
 * src/templates/scripts/instar-watchdog.sh. It detects the failure mode
 * where launchd reports a healthy lifeline but the agent's server is
 * locked out of its configured port — the exact pattern that kept
 * AI Guy offline for two days post-2026-05-17.
 *
 * Tests run the bash function in isolation via source-tricks. They are
 * darwin-gated for the same reason the PR #245 integration tests are
 * (Linux CI's strictly-set-e environment doesn't survive the source-trick
 * pattern). Linux still gets the template-content unit tests below.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const WATCHDOG_PATH = path.resolve(__dirname, '..', '..', 'src', 'templates', 'scripts', 'instar-watchdog.sh');
const itDarwin = process.platform === 'darwin' ? it : it.skip;

// ── Template-content unit tests (cross-platform) ─────────────────────

describe('watchdog template — bind-probe content', () => {
  function read(): string {
    return fs.readFileSync(WATCHDOG_PATH, 'utf-8');
  }

  it('defines probe_server_identity', () => {
    expect(read()).toContain('probe_server_identity()');
  });

  it('reads port from agent config.json via node argv (no shell interpolation)', () => {
    const body = read();
    // Pattern: `node -e "...process.argv[1]..." "$config_file"`
    expect(body).toMatch(/probe_server_identity[\s\S]+?node_bin.*process\.argv\[1\][\s\S]+?config_file/);
  });

  it('sends Authorization: Bearer header when authToken is configured', () => {
    const body = fs.readFileSync(WATCHDOG_PATH, 'utf-8');
    const m = body.match(/probe_server_identity\(\)\s*{([\s\S]+?)\n}/);
    expect(m).not.toBeNull();
    // The probe must read authToken alongside port — without the header,
    // /health omits the `project` field server-side and the probe can't
    // distinguish wrong-project from old-version (reviewer catch 2026-05-19).
    expect(m![1]).toMatch(/authToken/);
    expect(m![1]).toMatch(/Authorization: Bearer/);
  });

  it('uses a short curl timeout (does not stall the 5-min watchdog cycle)', () => {
    const body = read();
    // Extract the probe function body
    const m = body.match(/probe_server_identity\(\)\s*{([\s\S]+?)\n}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/--max-time\s+5/);
  });

  it('treats lifeline-only agents (no port in config) as healthy/skipped', () => {
    const body = read();
    const m = body.match(/probe_server_identity\(\)\s*{([\s\S]+?)\n}/);
    expect(m).not.toBeNull();
    // After resolving port, empty port → return 0 (skip).
    expect(m![1]).toMatch(/\[\s+-z\s+"\$port"\s+\][\s\S]{0,60}return 0/);
  });

  it('returns distinct codes for unreachable (3) vs wrong-project (2)', () => {
    const body = read();
    const m = body.match(/probe_server_identity\(\)\s*{([\s\S]+?)\n}/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('return 2');
    expect(m![1]).toContain('return 3');
  });

  it('emits structured probe-output (kind\\tconflict) on BIND-FAIL', () => {
    const body = read();
    const m = body.match(/probe_server_identity\(\)\s*{([\s\S]+?)\n}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/printf 'unreachable/);
    expect(m![1]).toMatch(/printf 'wrong-project/);
  });

  it('handle_bind_fail uses the same escalation pipeline as crash-loop', () => {
    const body = read();
    const m = body.match(/handle_bind_fail\(\)\s*{([\s\S]+?)\n}/);
    expect(m).not.toBeNull();
    // Same heal + counter + escalate machinery — no parallel path.
    expect(m![1]).toMatch(/try_self_heal/);
    expect(m![1]).toMatch(/bump_fail_counter/);
    expect(m![1]).toMatch(/escalate_via_peer/);
    expect(m![1]).toMatch(/should_attempt_heal/);
  });

  it('escalate_via_peer uses conflict context when stashed by the bind-fail path', () => {
    const body = read();
    const m = body.match(/escalate_via_peer\(\)\s*{([\s\S]+?)\n}/);
    expect(m).not.toBeNull();
    // Reads the conflict hint and builds a more specific summary
    expect(m![1]).toContain('bind-fail-conflict');
    expect(m![1]).toContain("using its port");
  });

  it('escalation payload remains B12-jargon-free', () => {
    const body = read();
    // The summary_text branches + the JSONEOF payload must not introduce jargon
    const heredoc = body.match(/<<JSONEOF\n([\s\S]*?)\nJSONEOF/);
    expect(heredoc).not.toBeNull();
    const payload = heredoc![1].toLowerCase();
    expect(payload).not.toMatch(/crash[- ]loop/);
    expect(payload).not.toMatch(/\blifeline\b/);
    expect(payload).not.toMatch(/\blaunchd\b/);
    expect(payload).not.toMatch(/\bpid\b/);
    expect(payload).not.toMatch(/\bshadow[- ]install/);

    // The summary_text variants too
    const wireSummary = body.match(/summary_text="([^"]+)"/g) || [];
    for (const s of wireSummary) {
      const lower = s.toLowerCase();
      expect(lower).not.toMatch(/crash[- ]loop/);
      expect(lower).not.toMatch(/\blifeline\b/);
      expect(lower).not.toMatch(/\blaunchd\b/);
      expect(lower).not.toMatch(/\bpid\b/);
    }
  });

  it('reset_fail_counter clears both counter and bind-fail-conflict state', () => {
    const body = read();
    const m = body.match(/reset_fail_counter\(\)\s*{([\s\S]+?)\n}/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('consecutive-heal-fails');
    expect(m![1]).toContain('bind-fail-conflict');
  });
});

// ── Behavioural tests via shell harness (darwin-gated) ────────────────

interface CapturedRequest {
  url: string | undefined;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

interface MockAgent {
  server: Server;
  port: number;
  close: () => Promise<void>;
  requests: CapturedRequest[];
  setProject: (name: string) => void;
  setHealthCode: (code: number) => void;
}

async function startMockAgent(initialProject: string): Promise<MockAgent> {
  const requests: CapturedRequest[] = [];
  let project = initialProject;
  let healthCode = 200;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      requests.push({ url: req.url, body, headers: req.headers });
      if (req.url === '/health') {
        res.statusCode = healthCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', project }));
        return;
      }
      if (req.url === '/attention' && req.method === 'POST') {
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'created', status: 'OPEN' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad address');

  return {
    server,
    port: addr.port,
    close: () => new Promise<void>((r) => server.close(() => r())),
    requests,
    setProject: (n) => { project = n; },
    setHealthCode: (c) => { healthCode = c; },
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

describe('probe_server_identity — behaviour', () => {
  let mockAgent: MockAgent;
  let tmp: string;
  let projectDir: string;
  let sandboxStateDir: string;
  let sandboxLogFile: string;

  beforeAll(async () => { mockAgent = await startMockAgent('ai-guy'); });
  afterAll(async () => { await mockAgent.close(); });

  beforeEach(() => {
    mockAgent.requests.length = 0;
    mockAgent.setProject('ai-guy');
    mockAgent.setHealthCode(200);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-probe-'));
    projectDir = path.join(tmp, 'ai-guy');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    sandboxStateDir = path.join(tmp, 'state');
    sandboxLogFile = path.join(tmp, 'watchdog.log');
    fs.mkdirSync(sandboxStateDir, { recursive: true });
  });

  function envSandbox(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmp,
      INSTAR_WATCHDOG_LAUNCH_AGENTS_DIR: path.join(tmp, 'LaunchAgents'),
      INSTAR_WATCHDOG_STATE_DIR: sandboxStateDir,
      INSTAR_WATCHDOG_LOG_FILE: sandboxLogFile,
    };
    // Ambient-credential hygiene: agent shells export the REAL INSTAR_AUTH_TOKEN,
    // and the probe under test prefers that env var over the fixture config's
    // authToken — so the Authorization-header assertions failed on any agent box
    // while passing in CI (2026-06-05 suite triage). The sandbox must not inherit it.
    delete env.INSTAR_AUTH_TOKEN;
    return env;
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

  itDarwin('returns 0 when project matches expected (healthy path)', async () => {
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ port: mockAgent.port, authToken: 'x' })
    );
    const r = await runBash(sourceTrick(`
      probe_server_identity "${projectDir}" "ai.instar.ai-guy"
      echo "RC=$?"
    `), envSandbox());
    expect(r.stdout).toContain('RC=0');
    expect(mockAgent.requests.some(req => req.url === '/health')).toBe(true);
  });

  itDarwin('sends Authorization: Bearer <token> with /health probe', async () => {
    // The /health endpoint gates the `project` field behind auth — without
    // the header, the probe cannot distinguish wrong-project from old-version.
    // Reviewer regression catch from 2026-05-19.
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ port: mockAgent.port, authToken: 'secret-token-xyz' })
    );
    const r = await runBash(sourceTrick(`
      probe_server_identity "${projectDir}" "ai.instar.ai-guy"
      echo "RC=$?"
    `), envSandbox());
    expect(r.stdout).toContain('RC=0');
    const healthReq = mockAgent.requests.find(req => req.url === '/health');
    expect(healthReq).toBeDefined();
    expect(healthReq!.headers['authorization']).toBe('Bearer secret-token-xyz');
  });

  itDarwin('omits Authorization when config has no authToken (still probes)', async () => {
    // Some agents may not be configured with an authToken yet. The probe
    // should still attempt the request — server may then respond without
    // `project` and the probe will fail-open per spec.
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ port: mockAgent.port })
    );
    const r = await runBash(sourceTrick(`
      probe_server_identity "${projectDir}" "ai.instar.ai-guy"
      echo "RC=$?"
    `), envSandbox());
    const healthReq = mockAgent.requests.find(req => req.url === '/health');
    expect(healthReq).toBeDefined();
    expect(healthReq!.headers['authorization']).toBeUndefined();
    // Still healthy because mock returns project='ai-guy' unconditionally.
    expect(r.stdout).toContain('RC=0');
  });

  itDarwin('returns 2 (wrong-project) when /health reports a different project', async () => {
    mockAgent.setProject('codex-server-smoke');
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ port: mockAgent.port, authToken: 'x' })
    );
    const r = await runBash(sourceTrick(`
      probe_server_identity "${projectDir}" "ai.instar.ai-guy"
      echo "RC=$?"
    `), envSandbox());
    expect(r.stdout).toContain('RC=2');
    expect(r.stdout).toContain('wrong-project');
    expect(r.stdout).toContain('codex-server-smoke');
    const logBody = fs.readFileSync(sandboxLogFile, 'utf-8');
    expect(logBody).toContain('BIND-FAIL');
    expect(logBody).toContain('owned by codex-server-smoke');
    expect(logBody).toContain('expected ai-guy');
  });

  itDarwin('returns 3 (unreachable) when /health is non-200', async () => {
    mockAgent.setHealthCode(503);
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ port: mockAgent.port, authToken: 'x' })
    );
    const r = await runBash(sourceTrick(`
      probe_server_identity "${projectDir}" "ai.instar.ai-guy"
      echo "RC=$?"
    `), envSandbox());
    expect(r.stdout).toContain('RC=3');
    expect(r.stdout).toContain('unreachable');
    const logBody = fs.readFileSync(sandboxLogFile, 'utf-8');
    expect(logBody).toContain('BIND-FAIL');
    expect(logBody).toContain('unreachable while lifeline alive');
  });

  itDarwin('returns 0 (skip) when config has no port (lifeline-only agent)', async () => {
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ authToken: 'x' })
    );
    const r = await runBash(sourceTrick(`
      probe_server_identity "${projectDir}" "ai.instar.ai-guy"
      echo "RC=$?"
    `), envSandbox());
    expect(r.stdout).toContain('RC=0');
    // No log entry — silent skip is the spec
    expect(fs.existsSync(sandboxLogFile) ? fs.readFileSync(sandboxLogFile, 'utf-8') : '').not.toContain('BIND-FAIL');
  });

  itDarwin('returns 0 when project field is absent (old instar versions — fail-open)', async () => {
    // Mock that omits project field entirely
    const noProjectAgent = await startMockAgent('');
    try {
      fs.writeFileSync(
        path.join(projectDir, '.instar', 'config.json'),
        JSON.stringify({ port: noProjectAgent.port, authToken: 'x' })
      );
      noProjectAgent.setProject('');  // empty string → omitted-by-truthy-check
      const r = await runBash(sourceTrick(`
        probe_server_identity "${projectDir}" "ai.instar.ai-guy"
        echo "RC=$?"
      `), envSandbox());
      expect(r.stdout).toContain('RC=0');
    } finally {
      await noProjectAgent.close();
    }
  });
});

// Cleanup
afterAll(() => {
  // no per-test tmp to clean — handled by tests/.tmp lifecycle if vitest provides it
});
void SafeFsExecutor;  // silence import — present for migration-parity import check
