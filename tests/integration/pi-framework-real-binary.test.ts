/**
 * Pi framework integration — REAL pi binary against the hermetic mock provider
 * (PI-HARNESS-INTEGRATION-SPEC §3 + §7). Zero credentials, zero network beyond
 * localhost: the mock OpenAI-completions fixture scripts one tool-call turn and
 * one final-text turn, so the FULL agent loop (prompt → streamed tool call →
 * real bash execution → tool result → final text) runs end-to-end.
 *
 * Two proofs:
 *   1. Headless one-shot — the exact argv `buildHeadlessLaunch('pi-cli', …)`
 *      produces actually runs and emits the expected JSONL event stream.
 *   2. TUI-in-tmux round-trip — the dashboard-parity primitive: a pi TUI
 *      session in tmux accepts our standard send-keys injection and renders
 *      the tool execution in the pane (what `GET /sessions/:name/output`
 *      streams to the dashboard).
 *
 * Skips automatically when the pi binary or tmux is unavailable (mirrors the
 * LLM-dependent test convention). Locally: PI_TEST_BIN=<path> overrides
 * detection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { buildHeadlessLaunch } from '../../src/core/frameworkSessionLaunch.js';
import { detectPiPath } from '../../src/core/Config.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PI_BIN = process.env.PI_TEST_BIN ?? detectPiPath();
const tmuxOk = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/pi-mock-provider');
const MOCK_PORT = 18931; // off the fixture default to avoid clashing with a dev-run mock
const SESSION = `pi-int-${process.pid}-${Math.floor(process.hrtime()[1] % 100000)}`;

function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe.skipIf(!PI_BIN || !tmuxOk)('pi framework vs real binary + hermetic mock provider', () => {
  let dir: string;
  let home: string;
  let workspace: string;
  let mock: ChildProcess;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-int-'));
    home = path.join(dir, 'home');
    workspace = path.join(dir, 'workspace');
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    // Point the custom provider at this test's mock port.
    const models = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'models.json'), 'utf8'));
    models.providers.mock.baseUrl = `http://127.0.0.1:${MOCK_PORT}/v1`;
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify(models, null, 2));
    // Boot the mock provider and wait for its ready line.
    let ready = false;
    mock = spawn(process.execPath, [path.join(FIXTURE_DIR, 'mock-openai-server.mjs')], {
      env: { ...process.env, PI_MOCK_PORT: String(MOCK_PORT) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    mock.stdout!.on('data', (c: Buffer) => { if (String(c).includes('listening')) ready = true; });
    await waitFor(() => ready, 10_000);
  }, 20_000);

  afterAll(() => {
    mock?.kill();
    spawnSync('tmux', ['kill-session', '-t', `=${SESSION}`], { stdio: 'ignore' });
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/pi-framework-real-binary.test.ts:afterAll',
      });
    } catch { /* best-effort */ }
  });

  it('headless one-shot: the buildHeadlessLaunch argv runs the FULL agent loop (tool exec + final text)', async () => {
    const spec = buildHeadlessLaunch('pi-cli', {
      binaryPath: PI_BIN!,
      prompt: 'Run the eval command.',
      model: 'mock/mock-model',
    });
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: workspace,
        env: { ...process.env, HOME: home, CLAUDECODE: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => (stdout += String(c)));
      child.on('close', () => resolve(stdout));
      child.on('error', reject);
      setTimeout(() => { child.kill(); resolve(stdout); }, 45_000);
    });
    // The event stream proves each loop stage ran.
    expect(out).toContain('"toolName":"bash"');         // tool call streamed
    expect(out).toContain('EVAL-COMPLETE');             // final text arrived
    const lines = out.trim().split('\n').filter(Boolean);
    // Every stdout line is valid JSON (strict JSONL protocol).
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 60_000);

  it('TUI-in-tmux: standard send-keys injection round-trips and the pane shows the tool execution (dashboard parity)', async () => {
    spawnSync('tmux', [
      'new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50',
      `cd ${workspace} && HOME=${home} ${PI_BIN} --no-session --offline --provider mock --model mock-model; sleep 30`,
    ], { stdio: 'ignore', shell: false });

    // Wait for pi's banner (boot complete) before injecting.
    const booted = await waitFor(() => {
      const pane = spawnSync('tmux', ['capture-pane', '-t', `=${SESSION}:`, '-p'], { encoding: 'utf8' }).stdout ?? '';
      return pane.includes('pi v');
    }, 20_000, 500);
    expect(booted).toBe(true);

    // The standard two-step injection our session layer uses: text, then Enter.
    spawnSync('tmux', ['send-keys', '-t', `=${SESSION}:`, 'Run the eval command.'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    spawnSync('tmux', ['send-keys', '-t', `=${SESSION}:`, 'Enter'], { stdio: 'ignore' });

    // The pane must show the REAL tool execution + completion — this is exactly
    // what the dashboard's session streaming surfaces.
    const done = await waitFor(() => {
      const pane = spawnSync('tmux', ['capture-pane', '-t', `=${SESSION}:`, '-p'], { encoding: 'utf8' }).stdout ?? '';
      return pane.includes('HERMETIC-TOOL-EXEC-OK') && pane.includes('EVAL-COMPLETE');
    }, 30_000, 500);
    expect(done).toBe(true);
  }, 60_000);
});
