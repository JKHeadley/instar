/**
 * Integration test for the fleet-watchdog peer-escalation path.
 *
 * Spec: docs/specs/lifeline-shadow-install-self-heal.md
 *
 * What this tests:
 *
 * The watchdog's `escalate_via_peer` function discovers a healthy peer agent
 * by scanning LAUNCH_AGENTS_DIR plists, probes each one's /health endpoint,
 * and POSTs to the first healthy peer's /attention endpoint with
 * category=degradation. The receiving server's /attention route is already
 * fully tested for tone-gate B12-B14 wiring elsewhere; here we verify the
 * watchdog actually produces the right shape of request that reaches it.
 *
 * No real launchd, no real macOS. We use the script's env-var hooks
 * (INSTAR_WATCHDOG_LAUNCH_AGENTS_DIR, INSTAR_WATCHDOG_STATE_DIR,
 * INSTAR_WATCHDOG_LOG_FILE) to point the script at a tmpdir sandbox, then
 * source the script and invoke `escalate_via_peer` directly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface MockPeer {
  server: Server;
  port: number;
  close: () => Promise<void>;
  requests: CapturedRequest[];
  setHealthCode: (code: number) => void;
  /** Set a fixed response code for /attention. */
  setAttentionCode: (code: number) => void;
  /** Queue a sequence of response codes for /attention; later requests fall back to the fixed code. */
  setAttentionSequence: (codes: number[]) => void;
}

async function startMockPeer(): Promise<MockPeer> {
  const requests: CapturedRequest[] = [];
  let healthCode = 200;
  let attentionCode = 201;
  let attentionSequence: number[] = [];

  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.url === '/health') {
        res.statusCode = healthCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: healthCode === 200 ? 'ok' : 'unhealthy' }));
        return;
      }

      if (req.url === '/attention' && req.method === 'POST') {
        const code = attentionSequence.length > 0 ? attentionSequence.shift()! : attentionCode;
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(code === 201
          ? { id: 'created-id', status: 'OPEN' }
          : { error: 'tone gate blocked', issue: 'B12 jargon detected' }));
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
    setHealthCode: (c) => { healthCode = c; },
    setAttentionCode: (c) => { attentionCode = c; attentionSequence = []; },
    setAttentionSequence: (codes) => { attentionSequence = [...codes]; },
  };
}

interface BashRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runBash(script: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<BashRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', script], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', status => resolve({ status, stdout, stderr }));
    const killer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`bash hung for >${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', () => clearTimeout(killer));
  });
}

const WATCHDOG_PATH = path.resolve(__dirname, '..', '..', 'src', 'templates', 'scripts', 'instar-watchdog.sh');

// The watchdog is a macOS-launchd singleton. The simulated peer-discovery in
// this test relies on bash source-tricks that don't survive Linux CI's
// strictly-set-e environments; the production path is darwin-only anyway, so
// we gate the integration test accordingly. Unit-level coverage of the bash
// template content (PATH-resolved npm, payload shape, jargon screening, etc.)
// runs on every platform.
const itDarwin = process.platform === 'darwin' ? it : it.skip;

describe('fleet watchdog — escalate_via_peer', () => {
  let mockPeer: MockPeer;
  let tmp: string;
  let sandboxLaunchAgents: string;
  let sandboxStateDir: string;
  let sandboxLogFile: string;
  let peerProjectDir: string;

  beforeAll(async () => {
    mockPeer = await startMockPeer();
  });
  afterAll(async () => {
    await mockPeer.close();
  });

  beforeEach(() => {
    // Reset peer state per test.
    mockPeer.requests.length = 0;
    mockPeer.setHealthCode(200);
    mockPeer.setAttentionCode(201);

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watchdog-int-'));
    sandboxLaunchAgents = path.join(tmp, 'LaunchAgents');
    sandboxStateDir = path.join(tmp, 'state');
    sandboxLogFile = path.join(tmp, 'watchdog.log');
    fs.mkdirSync(sandboxLaunchAgents, { recursive: true });
    fs.mkdirSync(sandboxStateDir, { recursive: true });

    // Build a "peer" agent fixture
    peerProjectDir = path.join(tmp, 'peer-agent');
    fs.mkdirSync(path.join(peerProjectDir, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(peerProjectDir, '.instar', 'config.json'),
      JSON.stringify({ port: mockPeer.port, authToken: 'test-peer-token' }),
    );

    // Build a plist for the peer that the watchdog's escalate_via_peer will discover
    fs.writeFileSync(
      path.join(sandboxLaunchAgents, 'ai.instar.peer-fixture.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>ai.instar.peer-fixture</string>
  <key>WorkingDirectory</key><string>${peerProjectDir}</string>
</dict></plist>`,
    );
    // Build a plist for the "dead" agent — same shape, but escalate_via_peer
    // is supposed to skip it (it's the dead_label).
    fs.writeFileSync(
      path.join(sandboxLaunchAgents, 'ai.instar.dead-fixture.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>ai.instar.dead-fixture</string>
  <key>WorkingDirectory</key><string>${peerProjectDir}-not-real</string>
</dict></plist>`,
    );
  });

  function envWithSandbox(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmp,
      INSTAR_WATCHDOG_LAUNCH_AGENTS_DIR: sandboxLaunchAgents,
      INSTAR_WATCHDOG_STATE_DIR: sandboxStateDir,
      INSTAR_WATCHDOG_LOG_FILE: sandboxLogFile,
    };
  }

  itDarwin('discovers healthy peer and POSTs degradation to /attention', async () => {
    // Source the watchdog script's function defs (skip its main loop by exiting
    // early before the `for plist in ...` loop) — we want to call
    // escalate_via_peer in isolation.
    const inlineSourceTrick = `
      set +e
      # Source the script's helper functions without running the main loop.
      # Trick: redefine the for-loop entry so the script returns immediately
      # after defining helpers. We do this by writing a temp wrapper.
      tmp_src=$(mktemp)
      # Take everything up to the comment marker "recovered=0" (right before
      # the main loop). Append a "return 0".
      awk '/^recovered=0$/{print "return 0"; exit} {print}' "${WATCHDOG_PATH}" > "$tmp_src"
      # shellcheck disable=SC1090
      source "$tmp_src"
      rm -f "$tmp_src"
      escalate_via_peer "ai.instar.dead-fixture" 3
      echo "EXIT=$?"
    `;
    const result = await runBash(inlineSourceTrick, envWithSandbox());

    if (result.status !== 0) {
      // For diagnostic visibility when something breaks.
      // eslint-disable-next-line no-console
      console.error('runBash failed:', result);
    }

    // Watchdog should have:
    //  1. Probed /health on the peer
    //  2. POSTed to /attention on the peer
    const healthProbes = mockPeer.requests.filter(r => r.url === '/health');
    const attentionPosts = mockPeer.requests.filter(r => r.url === '/attention' && r.method === 'POST');

    expect(healthProbes.length).toBeGreaterThanOrEqual(1);
    expect(attentionPosts.length).toBe(1);

    // Validate the payload shape
    const payload = JSON.parse(attentionPosts[0].body);
    expect(payload.category).toBe('degradation');
    expect(payload.priority).toBe('HIGH');
    expect(payload.title).toContain('dead-fixture');
    expect(payload.summary).toMatch(/offline/i);
    expect(payload.description).toMatch(/dig in/i);
    // No jargon (verified at template level too, but worth re-asserting here)
    expect(payload.summary.toLowerCase()).not.toMatch(/lifeline|crash-loop|launchd|pid/);

    // Auth header was set with the peer's token
    const auth = attentionPosts[0].headers['authorization'];
    expect(auth).toBe('Bearer test-peer-token');

    // Watchdog should not have attempted to escalate via the dead label itself
    // (which would loop forever — the peer is "fixture", not "dead-fixture")
    const wrongPeer = attentionPosts.find(p => p.headers['authorization'] !== 'Bearer test-peer-token');
    expect(wrongPeer).toBeUndefined();
  });

  itDarwin('on 422 (tone gate block) retries with the canonical safe template', async () => {
    mockPeer.setAttentionSequence([422, 201]);
    const inlineSourceTrick = `
      tmp_src=$(mktemp)
      awk '/^recovered=0$/{print "return 0"; exit} {print}' "${WATCHDOG_PATH}" > "$tmp_src"
      source "$tmp_src"
      rm -f "$tmp_src"
      set +e
      mkdir -p "${sandboxStateDir}"
      echo 3 > "${sandboxStateDir}/ai.instar.dead-fixture.consecutive-heal-fails"
      escalate_via_peer "ai.instar.dead-fixture" 3
      rc=$?
      echo "EXIT=$rc"
      echo "AFTER_COUNTER=$(cat ${sandboxStateDir}/ai.instar.dead-fixture.consecutive-heal-fails 2>/dev/null || echo MISSING)"
    `;
    const result = await runBash(inlineSourceTrick, envWithSandbox());

    // Two POSTs: first with our copy (422), second with safe template (201)
    const attentionPosts = mockPeer.requests.filter(r => r.url === '/attention');
    expect(attentionPosts.length).toBe(2);
    const firstPayload = JSON.parse(attentionPosts[0].body);
    const secondPayload = JSON.parse(attentionPosts[1].body);
    expect(firstPayload.summary).toMatch(/offline/i);
    expect(secondPayload.summary).toMatch(/Something on my end stopped working/);
    expect(secondPayload.id).toContain('-safe');
    // Counter reset on safe-template 201
    expect(result.stdout).toContain('AFTER_COUNTER=MISSING');
    expect(result.stdout).toContain('EXIT=0');
  });

  itDarwin('on 422 then second 422 (gate genuinely broken) preserves counter for next cycle', async () => {
    mockPeer.setAttentionCode(422); // both posts will be 422
    const inlineSourceTrick = `
      tmp_src=$(mktemp)
      awk '/^recovered=0$/{print "return 0"; exit} {print}' "${WATCHDOG_PATH}" > "$tmp_src"
      source "$tmp_src"
      rm -f "$tmp_src"
      set +e
      mkdir -p "${sandboxStateDir}"
      echo 3 > "${sandboxStateDir}/ai.instar.dead-fixture.consecutive-heal-fails"
      escalate_via_peer "ai.instar.dead-fixture" 3
      rc=$?
      echo "EXIT=$rc"
      echo "AFTER_COUNTER=$(cat ${sandboxStateDir}/ai.instar.dead-fixture.consecutive-heal-fails 2>/dev/null || echo MISSING)"
    `;
    const result = await runBash(inlineSourceTrick, envWithSandbox());

    // Two POSTs (initial + safe-template retry), both 422
    const attentionPosts = mockPeer.requests.filter(r => r.url === '/attention');
    expect(attentionPosts.length).toBe(2);
    // Counter PRESERVED — user was NOT notified, so we must escalate again next cycle.
    expect(result.stdout).toContain('AFTER_COUNTER=3');
    expect(result.stdout).toContain('EXIT=1');
  });

  itDarwin('skips escalation when no healthy peer exists', async () => {
    mockPeer.setHealthCode(500);
    const inlineSourceTrick = `
      tmp_src=$(mktemp)
      awk '/^recovered=0$/{print "return 0"; exit} {print}' "${WATCHDOG_PATH}" > "$tmp_src"
      source "$tmp_src"
      rm -f "$tmp_src"
      # Disable set -e inherited from the sourced script so non-zero from
      # escalate_via_peer doesn't kill the test shell before echo runs.
      set +e
      escalate_via_peer "ai.instar.dead-fixture" 3
      rc=$?
      echo "EXIT=$rc"
    `;
    const result = await runBash(inlineSourceTrick, envWithSandbox());

    const attentionPosts = mockPeer.requests.filter(r => r.url === '/attention');
    expect(attentionPosts.length).toBe(0);
    expect(result.stdout).toContain('EXIT=1');
    // The log file should have the ESCALATE-FAIL entry
    if (fs.existsSync(sandboxLogFile)) {
      expect(fs.readFileSync(sandboxLogFile, 'utf-8')).toContain('ESCALATE-FAIL');
    }
  });
});
