/**
 * A relay that drops must say so.
 *
 * INCIDENT (2026-07-26). This agent could not send to a peer. The peer was
 * healthy and listening; this agent's relay was down. It was impossible to
 * diagnose from the record, because the record could only ever contain one line:
 * `Threadline: relay connected (fingerprint: …)`.
 *
 * `RelayClient` emits both `disconnected` and `displaced`. `ThreadlineBootstrap`
 * subscribed to `message`, `unknown-sender` and `auto-discovered` — and neither of
 * those two. So the successful connect line stayed the last word forever.
 *
 * The `displaced` case is the one that matters most: it sets
 * `shouldReconnect = false` permanently, so the connection is gone for the life of
 * the process. A terminal state nobody records is the worst available combination.
 *
 * These tests fail if either subscription is removed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  attachRelayObservability,
  type RelayConnectionEvent,
} from '../../src/threadline/relayConnectionObserver.js';

/** Stands in for ThreadlineClient — the observer only needs `on` + `fingerprint`. */
class FakeRelayClient extends EventEmitter {
  constructor(public readonly fingerprint: string | null = 'abc123fingerprint') {
    super();
  }
}

let tmpDir: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-observer-'));
  logs = [];
  errors = [];
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true, force: true,
    operation: 'tests/unit/relay-connection-observer.test.ts',
  });
});

function attach(client: FakeRelayClient) {
  return attachRelayObservability(client, {
    logDir: tmpDir,
    log: (l) => logs.push(l),
    logError: (l) => errors.push(l),
  });
}

function readRecorded(): RelayConnectionEvent[] {
  const file = path.join(tmpDir, 'threadline-relay-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('relay connection observability', () => {
  it('REGRESSION: a disconnect is recorded — it can no longer pass silently', () => {
    const client = new FakeRelayClient();
    attach(client);
    client.emit('disconnected', 'Code: 1006');

    const recorded = readRecorded();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].event).toBe('disconnected');
    expect(recorded[0].reason).toContain('1006');
    expect(logs.join('\n')).toContain('relay disconnected');
  });

  it('REGRESSION: a displacement is recorded AND marked terminal', () => {
    const client = new FakeRelayClient();
    attach(client);
    client.emit('displaced', 'another connection claimed this identity');

    const recorded = readRecorded();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].event).toBe('displaced');
    expect(recorded[0].terminal).toBe(true);
  });

  it('a displacement is reported as an ERROR and says reconnect is disarmed', () => {
    // The load-bearing distinction: a plain disconnect retries, a displacement
    // never does. If the message does not say so, a reader cannot tell whether
    // waiting will help.
    const client = new FakeRelayClient();
    attach(client);
    client.emit('displaced', 'displaced by daemon');

    const text = errors.join('\n');
    expect(text).toContain('DISPLACED');
    expect(text.toLowerCase()).toContain('disarmed');
    expect(logs.join('\n')).not.toContain('DISPLACED');
  });

  it('distinguishes retrying from terminal — the two are not interchangeable', () => {
    const client = new FakeRelayClient();
    attach(client);
    client.emit('disconnected', 'socket closed');
    client.emit('displaced', 'identity taken');

    const recorded = readRecorded();
    expect(recorded.map(r => r.terminal)).toEqual([false, true]);
  });

  it('exposes the latest event so a status surface can report WHY, not just that', () => {
    const client = new FakeRelayClient();
    const obs = attach(client);

    // Never dropped is a genuinely different state from dropped-for-reason-X,
    // and must not be collapsed into a falsy "unknown".
    expect(obs.getLastEvent()).toBeNull();

    client.emit('disconnected', 'first');
    expect(obs.getLastEvent()?.reason).toBe('first');
    client.emit('displaced', 'second');
    expect(obs.getLastEvent()?.reason).toBe('second');
    expect(obs.getLastEvent()?.terminal).toBe(true);
  });

  it('records every occurrence — later events never overwrite earlier ones', () => {
    // Append, not overwrite. A single-slot alert file cannot show a flapping
    // connection, which is exactly what a reconnect bug looks like.
    const client = new FakeRelayClient();
    attach(client);
    for (let i = 0; i < 5; i++) client.emit('disconnected', `drop ${i}`);
    expect(readRecorded()).toHaveLength(5);
  });

  it('an unwritable log directory does not throw out of the handler', () => {
    // A failed audit write must never take down the connection path it observes.
    const client = new FakeRelayClient();
    const filePath = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(filePath, 'blocking file');
    const obs = attachRelayObservability(client, {
      logDir: filePath,
      log: (l) => logs.push(l),
      logError: (l) => errors.push(l),
    });

    expect(() => client.emit('disconnected', 'boom')).not.toThrow();
    // Console output and in-memory state still work even when the file does not.
    expect(logs.join('\n')).toContain('relay disconnected');
    expect(obs.getLastEvent()?.reason).toBe('boom');
    expect(errors.join('\n')).toContain('failed to record');
  });

  it('clamps a hostile reason string instead of writing it whole', () => {
    const client = new FakeRelayClient();
    attach(client);
    client.emit('disconnected', 'x'.repeat(5000));
    expect(readRecorded()[0].reason.length).toBeLessThan(400);
  });

  it('a null fingerprint is recorded honestly, not as an empty string', () => {
    const client = new FakeRelayClient(null);
    attach(client);
    client.emit('disconnected', 'no identity');
    expect(readRecorded()[0].fingerprint).toBe('unknown');
  });

  /**
   * Dead-check guard. Every assertion above would pass against an observer that
   * recorded everything unconditionally, or one stuck on a single verdict. Assert
   * the observer actually discriminates AND that it records nothing when nothing
   * happened — so this file cannot decay into a test that checks nothing.
   */
  it('records nothing when the connection never drops', () => {
    const client = new FakeRelayClient();
    const obs = attach(client);
    client.emit('message', { some: 'inbound' });
    client.emit('auto-discovered', { count: 3 });

    expect(readRecorded()).toHaveLength(0);
    expect(obs.getLastEvent()).toBeNull();
    expect(errors).toHaveLength(0);
  });
});
