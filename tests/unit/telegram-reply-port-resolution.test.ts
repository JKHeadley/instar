/**
 * Layer 1a tests — telegram-reply.sh port resolution and X-Instar-AgentId header.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 1a.
 *
 * Resolution order (env > config > 4040-warn) plus mandatory
 * `X-Instar-AgentId` header sourced from `.instar/config.json#projectName`.
 *
 * The originating incident was: when INSTAR_PORT is unset and the script
 * defaults to 4040, the request hits a *different* agent's server (port
 * collision). These tests pin the new resolution order and the header
 * payload, so a future regression cannot silently re-introduce that path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT_PATH = path.join(process.cwd(), 'src/templates/scripts/telegram-reply.sh');

interface CapturedRequest {
  port: number;
  agentIdHeader: string | undefined;
  authHeader: string | undefined;
  body: string;
}

interface MockServer {
  port: number;
  close: () => Promise<void>;
  lastRequest: () => CapturedRequest | null;
  reset: () => void;
}

async function startMockServer(): Promise<MockServer> {
  let last: CapturedRequest | null = null;
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const addr = server.address();
      const port = addr && typeof addr !== 'string' ? addr.port : 0;
      last = {
        port,
        agentIdHeader: req.headers['x-instar-agentid'] as string | undefined,
        authHeader: req.headers['authorization'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad address');
  return {
    port: addr.port,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
    lastRequest() {
      return last;
    },
    reset() {
      last = null;
    },
  };
}

interface RunOpts {
  envPort?: string;
  configPort?: number;
  authToken?: string;
  agentId?: string;
  /** When true, do NOT write a config.json. */
  noConfig?: boolean;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
}

async function runScript(opts: RunOpts): Promise<RunResult> {
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reply-port-'));
  if (!opts.noConfig) {
    const cfgDir = path.join(tmpCwd, '.instar');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfg: Record<string, unknown> = {};
    if (opts.configPort !== undefined) cfg.port = opts.configPort;
    if (opts.authToken !== undefined) cfg.authToken = opts.authToken;
    if (opts.agentId !== undefined) cfg.projectName = opts.agentId;
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg));
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  if (opts.envPort !== undefined) env.INSTAR_PORT = opts.envPort;
  return await new Promise<RunResult>((resolve, reject) => {
    const proc = spawn('bash', [SCRIPT_PATH, '42'], {
      cwd: tmpCwd,
      env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    const kill = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('script hung'));
    }, 10_000);
    proc.on('close', (status) => {
      clearTimeout(kill);
      resolve({ status, stdout, stderr, cwd: tmpCwd });
    });
    proc.stdin.write('hello\n');
    proc.stdin.end();
  }).finally(() => {
    SafeFsExecutor.safeRmSync(tmpCwd, {
      recursive: true,
      force: true,
      operation: 'tests/unit/telegram-reply-port-resolution.test.ts',
    });
  });
}

describe('telegram-reply.sh — port resolution', () => {
  let mockA: MockServer;
  let mockB: MockServer;

  beforeAll(async () => {
    mockA = await startMockServer();
    mockB = await startMockServer();
  });
  afterAll(async () => {
    await mockA.close();
    await mockB.close();
  });

  it('reads `port` from .instar/config.json when INSTAR_PORT is absent', async () => {
    mockA.reset();
    mockB.reset();
    const result = await runScript({
      configPort: mockA.port,
      authToken: 't',
      agentId: 'agent-A',
    });
    expect(result.status).toBe(0);
    expect(mockA.lastRequest()).not.toBeNull();
    expect(mockB.lastRequest()).toBeNull();
    expect(mockA.lastRequest()!.agentIdHeader).toBe('agent-A');
  });

  it('INSTAR_PORT env var wins over config.json port', async () => {
    mockA.reset();
    mockB.reset();
    // config points at A; env points at B → request hits B.
    const result = await runScript({
      envPort: String(mockB.port),
      configPort: mockA.port,
      authToken: 't',
      agentId: 'agent-A',
    });
    expect(result.status).toBe(0);
    expect(mockA.lastRequest()).toBeNull();
    expect(mockB.lastRequest()).not.toBeNull();
  });

  it('falls back to 4040 with a stderr warning when neither env nor config is readable', async () => {
    // No config file, no env. We don't actually want to hit port 4040 —
    // we just want to assert the warning fires and the script tries 4040.
    // The connect will fail; the script will exit 1 with the warning still
    // on stderr.
    const result = await runScript({ noConfig: true });
    expect(result.stderr).toMatch(/falling back to 4040|no INSTAR_PORT/i);
  });

  it('sends X-Instar-AgentId header sourced from config.projectName', async () => {
    mockA.reset();
    const result = await runScript({
      configPort: mockA.port,
      authToken: 'tok',
      agentId: 'echo',
    });
    expect(result.status).toBe(0);
    const req = mockA.lastRequest()!;
    expect(req.agentIdHeader).toBe('echo');
    expect(req.authHeader).toBe('Bearer tok');
  });

  it('omits X-Instar-AgentId when projectName is absent (graceful degradation)', async () => {
    mockA.reset();
    const result = await runScript({
      configPort: mockA.port,
      authToken: 'tok',
      // no agentId
    });
    expect(result.status).toBe(0);
    const req = mockA.lastRequest()!;
    expect(req.agentIdHeader).toBeUndefined();
  });
});
