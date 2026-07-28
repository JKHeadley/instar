/**
 * Pi RPC adapter integration — the AgenticSessionRpc primitive against the
 * REAL pi binary + hermetic mock provider (PI-HARNESS-INTEGRATION-SPEC §4.1-4.2).
 *
 * Proves the "data cable" end-to-end with zero credentials:
 *   - start() spawns `pi --mode rpc` and emits session-lifecycle 'started'
 *   - startTurn() drives the FULL agent loop; canonical events arrive in
 *     order: tool-call → tool-result → message-delta → turn-end (with usage)
 *   - the PiCliIntelligenceProvider (componentFrameworks alive path) returns
 *     the final text through the same transport
 *   - close() tears the process down
 *
 * Skips when the pi binary or tmux-free runtime deps are unavailable.
 * Locally: PI_TEST_BIN=<path> overrides detection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { detectPiPath } from '../../src/core/Config.js';
import { createPiAgenticSessionRpc } from '../../src/providers/adapters/pi-cli/transport/agenticSessionRpc.js';
import { PiCliIntelligenceProvider } from '../../src/core/PiCliIntelligenceProvider.js';
import { PiAnthropicRouteError } from '../../src/providers/adapters/pi-cli/errors.js';
import type { CanonicalEvent } from '../../src/providers/events.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PI_BIN = process.env.PI_TEST_BIN ?? detectPiPath();
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/pi-mock-provider');
const MOCK_PORT = 18933;

function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
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

describe.skipIf(!PI_BIN)('pi AgenticSessionRpc + intelligence provider vs real binary', () => {
  let dir: string;
  let home: string;
  let workspace: string;
  let mock: ChildProcess;
  const savedHome = process.env.HOME;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-int-'));
    home = path.join(dir, 'home');
    workspace = path.join(dir, 'workspace');
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const models = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'models.json'), 'utf8'));
    models.providers.mock.baseUrl = `http://127.0.0.1:${MOCK_PORT}/v1`;
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify(models, null, 2));
    let ready = false;
    mock = spawn(process.execPath, [path.join(FIXTURE_DIR, 'mock-openai-server.mjs')], {
      env: { ...process.env, PI_MOCK_PORT: String(MOCK_PORT) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    mock.stdout!.on('data', (c: Buffer) => { if (String(c).includes('listening')) ready = true; });
    await waitFor(() => ready, 10_000);
    // pi reads ~/.pi from HOME; the hardened child env passes HOME through.
    process.env.HOME = home;
  }, 20_000);

  afterAll(() => {
    process.env.HOME = savedHome;
    mock?.kill();
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/pi-rpc-adapter-real-binary.test.ts:afterAll',
      });
    } catch { /* best-effort */ }
  });

  it('drives a full turn over the data cable: tool-call → tool-result → message-delta → turn-end(usage)', async () => {
    const rpc = createPiAgenticSessionRpc({
      piPath: PI_BIN!,
      model: 'mock/mock-model',
    });
    const session = await rpc.start({ transport: 'stdio', workingDirectory: workspace });
    const seen: CanonicalEvent[] = [];
    const collector = (async () => {
      for await (const event of session.events) {
        seen.push(event);
        // pi emits ONE turn-end per model turn: turn 1 ends with
        // stopReason 'tool-use' (the bash call), turn 2 — the final text —
        // ends with 'end-of-turn'. Collect until the FINAL turn.
        if (event.type === 'turn-end' && event.stopReason !== 'tool-use') break;
      }
    })();

    const { turnId } = await rpc.startTurn(session.handle, { prompt: 'Run the eval command.' });
    expect(turnId).toBe('turn-1');

    const finished = await Promise.race([
      collector.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 45_000)),
    ]);
    expect(finished).toBe(true);

    const types = seen.map((e) => e.type);
    expect(types[0]).toBe('session-lifecycle');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    expect(types).toContain('message-delta');
    const toolCall = seen.find((e) => e.type === 'tool-call') as Extract<CanonicalEvent, { type: 'tool-call' }>;
    expect(toolCall.toolName).toBe('bash');
    const turnEnds = seen.filter((e) => e.type === 'turn-end') as Array<Extract<CanonicalEvent, { type: 'turn-end' }>>;
    expect(turnEnds.length).toBeGreaterThanOrEqual(2); // tool turn + final turn
    expect(turnEnds[0].stopReason).toBe('tool-use');
    const finalTurn = turnEnds[turnEnds.length - 1];
    expect(finalTurn.usage).not.toBeNull();
    expect(finalTurn.usage!.inputTokens).toBeGreaterThan(0);

    await rpc.close(session.handle);
  }, 60_000);

  it('start() with an Anthropic-routed model throws PiAnthropicRouteError BEFORE spawning', async () => {
    const rpc = createPiAgenticSessionRpc({
      piPath: PI_BIN!,
      model: 'anthropic/claude-sonnet-4-6',
    });
    await expect(rpc.start({ transport: 'stdio' })).rejects.toThrow(PiAnthropicRouteError);
  });

  it('PiCliIntelligenceProvider.evaluate returns the final text (componentFrameworks alive path)', async () => {
    const provider = new PiCliIntelligenceProvider({
      piPath: PI_BIN!,
      model: 'mock/mock-model',
    });
    const text = await provider.evaluate('Run the eval command.', { timeoutMs: 45_000 });
    expect(text).toContain('EVAL-COMPLETE');
  }, 60_000);
});
