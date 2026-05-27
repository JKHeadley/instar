/**
 * AgentTelegramLedger + ProcessedIdStore unit tests (PR 3a, spec §Fix 2a "Round-trip audit
 * ledger" + "Processed-id ledger").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentTelegramLedger, defaultLedgerPaths, type ReceiveAuditRow } from '../../../src/messaging/AgentTelegramLedger.js';
import { ProcessedIdStore } from '../../../src/messaging/ProcessedIdStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { SendAuditRow } from '../../../src/messaging/AgentTelegramComms.js';

const NOW = 1_779_900_000_000;

describe('AgentTelegramLedger', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ledger-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'a2a-ledger test' }); });

  function mkSent(over: Partial<SendAuditRow> = {}): SendAuditRow {
    return {
      localTs: '2026-05-27T00:00:00.000Z', direction: 'sent', fromAgent: 'echo', toAgent: 'instar-codey',
      role: 'mentor', id: 'i1', corr: 'i1', ts: NOW, telegramFromBotId: 'echo-bot', telegramToBotId: 'codey-bot',
      topicId: 42, result: 'ok', sentMessageId: 'msg-1', ...over,
    };
  }

  function mkRecv(over: Partial<ReceiveAuditRow> = {}): ReceiveAuditRow {
    return {
      localTs: '2026-05-27T00:00:01.000Z', direction: 'received', decision: 'routed',
      fromAgent: 'instar-codey', toAgent: 'echo', role: 'mentor-reply', id: 'r1', corr: 'i1', ts: NOW,
      telegramFromBotId: 'codey-bot', topicId: 42, ...over,
    };
  }

  it('appendSent + appendReceived write JSONL rows to distinct files at the default paths', () => {
    const paths = defaultLedgerPaths(dir);
    const led = new AgentTelegramLedger(paths);
    led.appendSent(mkSent());
    led.appendSent(mkSent({ id: 'i2', corr: 'i2', sentMessageId: 'msg-2' }));
    led.appendReceived(mkRecv());

    expect(fs.existsSync(paths.sentPath)).toBe(true);
    expect(fs.existsSync(paths.receivedPath)).toBe(true);
    const sentLines = fs.readFileSync(paths.sentPath, 'utf-8').trim().split('\n');
    expect(sentLines).toHaveLength(2);
    expect(JSON.parse(sentLines[0])).toMatchObject({ direction: 'sent', id: 'i1', result: 'ok' });
    expect(JSON.parse(sentLines[1])).toMatchObject({ id: 'i2', sentMessageId: 'msg-2' });
    const recv = JSON.parse(fs.readFileSync(paths.receivedPath, 'utf-8').trim());
    expect(recv).toMatchObject({ direction: 'received', decision: 'routed', role: 'mentor-reply', corr: 'i1' });
  });

  it('records drops with the drop reason (the routing matrix audit trail)', () => {
    const paths = defaultLedgerPaths(dir);
    const led = new AgentTelegramLedger(paths);
    led.appendReceived(mkRecv({ decision: 'dropped', dropReason: 'agent-marker-spoofed-by-user', role: undefined, id: undefined }));
    const r = JSON.parse(fs.readFileSync(paths.receivedPath, 'utf-8').trim());
    expect(r).toMatchObject({ decision: 'dropped', dropReason: 'agent-marker-spoofed-by-user' });
  });

  it('NEVER throws when the directory is unwritable (best-effort; tick survives)', () => {
    // Point ledger at a path whose parent is a regular file (mkdirSync will fail) —
    // appendLine must NOT throw.
    const blockerFile = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blockerFile, 'i am a file');
    const led = new AgentTelegramLedger({
      sentPath: path.join(blockerFile, 'sent.jsonl'),
      receivedPath: path.join(blockerFile, 'received.jsonl'),
    });
    expect(() => led.appendSent(mkSent())).not.toThrow();
    expect(() => led.appendReceived(mkRecv())).not.toThrow();
  });
});

describe('ProcessedIdStore — idempotency dedup', () => {
  let dir: string;
  let clock: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-pids-')); clock = NOW; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'a2a-pids test' }); });

  function mk(over: Partial<{ maxEntries: number; maxAgeMs: number }> = {}): ProcessedIdStore {
    return new ProcessedIdStore({
      filePath: path.join(dir, 'pids.json'),
      now: () => clock,
      ...over,
    });
  }

  it('marks + recalls + persists across re-open', () => {
    const s1 = mk();
    expect(s1.hasProcessed('abc')).toBe(false);
    s1.markProcessed('abc');
    expect(s1.hasProcessed('abc')).toBe(true);
    // Re-open from disk
    const s2 = mk();
    expect(s2.hasProcessed('abc')).toBe(true);
    expect(s2.hasProcessed('xyz')).toBe(false);
  });

  it('evicts entries older than maxAgeMs', () => {
    const s = mk({ maxAgeMs: 5000 });
    s.markProcessed('old');
    clock += 6000;
    expect(s.hasProcessed('old')).toBe(false); // expired
    s.markProcessed('fresh');
    expect(s.hasProcessed('fresh')).toBe(true);
  });

  it('evicts oldest when over maxEntries', () => {
    const s = mk({ maxEntries: 3 });
    s.markProcessed('a'); clock += 1;
    s.markProcessed('b'); clock += 1;
    s.markProcessed('c'); clock += 1;
    expect(s.size()).toBe(3);
    s.markProcessed('d'); // forces eviction of 'a'
    expect(s.hasProcessed('a')).toBe(false);
    expect(s.hasProcessed('b')).toBe(true);
    expect(s.hasProcessed('d')).toBe(true);
    expect(s.size()).toBe(3);
  });

  it('survives a corrupted file (starts fresh rather than crash)', () => {
    fs.writeFileSync(path.join(dir, 'pids.json'), '{not valid json');
    const s = mk();
    expect(s.size()).toBe(0); // fresh start
    s.markProcessed('q'); // can still operate
    expect(s.hasProcessed('q')).toBe(true);
  });

  it('re-marking the same id is a no-op (idempotent)', () => {
    const s = mk();
    s.markProcessed('z');
    const tsBefore = clock;
    clock += 10_000;
    s.markProcessed('z'); // does NOT refresh the ts (first-seen semantics)
    // Force a re-load to verify persisted ts.
    const s2 = mk();
    // Inspect the persisted file directly: ts should be the original mark time.
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'pids.json'), 'utf-8'));
    expect(persisted.entries.z).toBe(tsBefore);
    expect(s2.hasProcessed('z')).toBe(true);
  });
});
