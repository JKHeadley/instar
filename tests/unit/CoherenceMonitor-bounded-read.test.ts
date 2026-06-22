/**
 * Event-loop blocker regression (2026-06-22 batch) — CoherenceMonitor's
 * output-sanity check must read only a bounded TAIL of telegram-messages.jsonl,
 * never the whole multi-MB file. A 12MB synchronous read on a 5-minute timer
 * froze the event loop (up to 20s). The check only inspects the last 50 agent
 * messages, so the tail window is sufficient — and a bad pattern in a recent
 * agent message must STILL be caught.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoherenceMonitor } from '../../src/monitoring/CoherenceMonitor.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coherence-bounded-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({}, null, 2));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/CoherenceMonitor-bounded-read.test.ts' });
  vi.restoreAllMocks();
});

function makeMonitor(): CoherenceMonitor {
  return new CoherenceMonitor({ stateDir, liveConfig: new LiveConfig(stateDir) });
}

function writeBigLog(recentAgentText: string): void {
  const logPath = path.join(stateDir, 'telegram-messages.jsonl');
  const lines: string[] = [];
  for (let i = 0; i < 25_000; i++) {
    lines.push(JSON.stringify({ messageId: i, topicId: 1, text: 'older clean message '.repeat(4), fromUser: i % 2 === 0, timestamp: new Date().toISOString() }));
  }
  // The interesting recent agent message at the very END.
  lines.push(JSON.stringify({ messageId: 99999, topicId: 1, text: recentAgentText, fromUser: false, timestamp: new Date().toISOString() }));
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  expect(fs.statSync(logPath).size).toBeGreaterThan(2_000_000);
}

describe('CoherenceMonitor output-sanity bounded read', () => {
  it('never calls fs.readFileSync on the multi-MB message log', () => {
    writeBigLog('all good here');
    const logPath = path.join(stateDir, 'telegram-messages.jsonl');

    const realReadFileSync = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && p === logPath) {
        throw new Error('REGRESSION: full-file fs.readFileSync on telegram-messages.jsonl');
      }
      // @ts-expect-error pass-through
      return realReadFileSync(p, ...rest);
    }) as typeof fs.readFileSync);

    const monitor = makeMonitor();
    expect(() => monitor.runCheck()).not.toThrow();
    spy.mockRestore();
  });

  it('still flags a bad pattern in a RECENT agent message at the tail of a large log', () => {
    // A localhost URL in the newest agent message — must be caught via the tail read.
    writeBigLog('Open your dashboard at http://localhost:4040/dashboard');
    const monitor = makeMonitor();
    const report = monitor.runCheck();
    const sanity = report.checks.find((c) => c.name === 'output-sanity');
    expect(sanity).toBeDefined();
    expect(sanity!.passed).toBe(false); // the recent localhost message was reachable
  });
});
