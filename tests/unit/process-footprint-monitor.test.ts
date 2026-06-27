/**
 * ProcessFootprintMonitor — the per-machine process-footprint measurement (the
 * signal that was missing before the 2026-06-26 resource-exhaustion panic).
 * Observe-only; tests cover classification, sampling, trend, the threshold latch
 * (both sides + hysteresis), and the fail-safe + dark-default behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyFootprintProcess,
  buildFootprintSample,
  ProcessFootprintMonitor,
  type FootprintProcess,
} from '../../src/monitoring/ProcessFootprintMonitor.js';

const proc = (command: string, rssBytes = 0, pid = 1): FootprintProcess => ({ pid, command, rssBytes });

describe('classifyFootprintProcess', () => {
  it('classifies MCP servers via the allow-listed signatures', () => {
    expect(classifyFootprintProcess(proc('node /x/@playwright/mcp/cli.js'))).toBe('mcp');
    expect(classifyFootprintProcess(proc('npx mcp-remote https://fathom'))).toBe('mcp');
  });

  it('classifies agent CLIs', () => {
    expect(classifyFootprintProcess(proc('claude --resume abc'))).toBe('agent-cli');
    expect(classifyFootprintProcess(proc('codex exec --json'))).toBe('agent-cli');
  });

  it('classifies other instar node processes', () => {
    expect(classifyFootprintProcess(proc('node /Users/x/.instar/agents/echo/.instar/bin/cli.js server'))).toBe('other-node');
  });

  it('does NOT count unrelated or empty processes (and ignores grep noise)', () => {
    expect(classifyFootprintProcess(proc('/usr/sbin/cupsd'))).toBeNull();
    expect(classifyFootprintProcess(proc(''))).toBeNull();
    expect(classifyFootprintProcess(proc('grep claude'))).toBeNull();
  });
});

describe('buildFootprintSample', () => {
  it('counts totals + per-kind + sums RSS', () => {
    const s = buildFootprintSample([
      proc('claude --resume a', 100),
      proc('codex exec', 200),
      proc('node @playwright/mcp', 800),
      proc('node /.instar/bin/cli.js server', 300),
      proc('/usr/sbin/cupsd', 999), // not counted
    ], 1000);
    expect(s.total).toBe(4);
    expect(s.byKind['agent-cli']).toBe(2);
    expect(s.byKind.mcp).toBe(1);
    expect(s.byKind['other-node']).toBe(1);
    expect(s.rssBytes).toBe(1400); // 999 excluded
    expect(s.ts).toBe(1000);
  });
});

describe('ProcessFootprintMonitor — sampling, trend, alert latch', () => {
  const listOf = (n: number): FootprintProcess[] =>
    Array.from({ length: n }, (_, i) => proc('claude --resume x', 10, i + 1));

  it('keeps a bounded ring buffer (windowSamples)', () => {
    let t = 0;
    const m = new ProcessFootprintMonitor(
      { listProcesses: () => listOf(3), now: () => (t += 1000) },
      { enabled: true, windowSamples: 2 },
    );
    m.sample(); m.sample(); m.sample();
    expect(m.status().samples.length).toBe(2);
  });

  it('reports a rising trend when the latest exceeds the window median', () => {
    let count = 5;
    let t = 0;
    const m = new ProcessFootprintMonitor(
      { listProcesses: () => listOf(count), now: () => (t += 1000) },
      { enabled: true, windowSamples: 10 },
    );
    for (let i = 0; i < 5; i++) m.sample();      // 5 samples at 5
    count = 30; m.sample();                       // a spike well above median
    expect(m.status().trend).toBe('rising');
  });

  it('raises ONE heads-up at/over the threshold, then re-arms with hysteresis', () => {
    const emit = vi.fn();
    let count = 0;
    let t = 0;
    const m = new ProcessFootprintMonitor(
      { listProcesses: () => listOf(count), now: () => (t += 1000), emitAttention: emit },
      { enabled: true, alertEnabled: true, alertThreshold: 100, windowSamples: 50 },
    );
    count = 120; m.sample();            // over → one alert
    count = 130; m.sample();            // still over → NO second alert (latched)
    expect(emit).toHaveBeenCalledTimes(1);
    count = 80;  m.sample();            // recovered (< 90% of threshold) → re-arm
    count = 150; m.sample();            // over again → a fresh alert
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('does NOT alert when alertEnabled is false (measure-first default)', () => {
    const emit = vi.fn();
    const m = new ProcessFootprintMonitor(
      { listProcesses: () => listOf(500), emitAttention: emit },
      { enabled: true, alertEnabled: false, alertThreshold: 100 },
    );
    m.sample();
    expect(emit).not.toHaveBeenCalled();
  });

  it('start() is a no-op when disabled (dark default)', () => {
    const list = vi.fn(() => listOf(1));
    const m = new ProcessFootprintMonitor({ listProcesses: list }, { enabled: false });
    m.start();
    expect(list).not.toHaveBeenCalled();
    m.stop();
  });

  it('fail-safe: a throwing scanner does not crash sample()', () => {
    const m = new ProcessFootprintMonitor(
      { listProcesses: () => { throw new Error('ps failed'); } },
      { enabled: true },
    );
    expect(() => m.sample()).not.toThrow();
  });
});
