/**
 * Rotation (trimming) of the Telegram message log must stay the old code, byte for byte
 * (docs/specs/conversation-list-log-view.md). This guard drives BOTH save paths of the real
 * TelegramAdapter (the legacy `maybeRotateLog` and the shared `MessageLogger`) at the real sizes:
 * the 20 MB size gate, the 100 000-line cap and the 75 000 lines kept, from a fixture built just
 * under the cap. After EVERY save it compares the file's raw bytes with an oracle that replays the
 * old algorithm (2e3e9a868) on exactly the bytes each save wrote, and it compares how many times the
 * log view was told to follow the file. Failures are injected into the rotation read, the rename,
 * and the save itself (a genuinely torn write: part of a line, no newline).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SHARED_INFRA_FLAGS } from '../../src/messaging/shared/FeatureFlags.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/message-log-rotation-real-size.test.ts';
const SIZE_GATE = 20 * 1024 * 1024;
const MAX_LINES = 100_000;
const KEEP_LINES = 75_000;
const START_LINES = MAX_LINES - 5; // the 6th save crosses the cap
const SAVES = 12;

let template: string;
const dirs: string[] = [];

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-real-template-'));
  dirs.push(dir);
  template = path.join(dir, 'template.jsonl');
  const pad = 'x'.repeat(150);
  const fd = fs.openSync(template, 'w');
  let chunk = '';
  for (let i = 0; i < START_LINES; i++) {
    chunk += JSON.stringify({ messageId: 1_000_000 + i, topicId: 100 + (i % 50), text: `fixture ${i} ${pad}`, fromUser: i % 2 === 0, timestamp: new Date(1_600_000_000_000 + i * 1000).toISOString(), sessionName: null }) + '\n';
    if (chunk.length > 1_000_000) { fs.writeSync(fd, chunk); chunk = ''; }
  }
  fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  expect(fs.statSync(template).size).toBeGreaterThan(SIZE_GATE); // the fixture is over the real size gate
}, 120_000);

afterAll(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
});
afterEach(() => { vi.restoreAllMocks(); });

/** The old rotation (2e3e9a868, both paths): run after a save that succeeded. */
function oldRotate(bytes: string): { bytes: string; rotated: boolean } {
  if (Buffer.byteLength(bytes) < SIZE_GATE) return { bytes, rotated: false };
  const lines = bytes.split('\n').filter(Boolean);
  if (lines.length <= MAX_LINES) return { bytes, rotated: false };
  return { bytes: lines.slice(-KEEP_LINES).join('\n') + '\n', rotated: true };
}

type Fail = 'none' | 'read' | 'rename' | 'torn';

async function run(pathKind: 'legacy' | 'shared', failAt: Map<number, Fail>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-real-'));
  dirs.push(dir);
  const logPath = path.join(dir, 'telegram-messages.jsonl');
  fs.copyFileSync(template, logPath);
  const prior = SHARED_INFRA_FLAGS.useSharedMessageLogger;
  (SHARED_INFRA_FLAGS as { useSharedMessageLogger: boolean }).useSharedMessageLogger = pathKind === 'shared';
  const adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, dir);
  (SHARED_INFRA_FLAGS as { useSharedMessageLogger: boolean }).useSharedMessageLogger = prior;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const notes = vi.spyOn(adapter as unknown as { noteLogRotated(): void }, 'noteLogRotated');

  let oracle = fs.readFileSync(template, 'utf-8');
  let oracleNotes = 0;
  const realAppend = fs.appendFileSync.bind(fs);
  const realRead = fs.readFileSync.bind(fs);
  const realRename = fs.renameSync.bind(fs);
  let mode: Fail = 'none';
  let written = '';
  vi.spyOn(fs, 'appendFileSync').mockImplementation(((f: fs.PathOrFileDescriptor, d: string | Uint8Array, o?: unknown) => {
    if (String(f) !== logPath) return (realAppend as (...a: unknown[]) => unknown)(f, d, o);
    const data = String(d);
    if (mode === 'torn') {
      written = data.slice(0, Math.floor(data.length / 2)); // part of the line, no newline
      realAppend(f, written);
      throw new Error('simulated torn write');
    }
    written = data;
    return (realAppend as (...a: unknown[]) => unknown)(f, d, o);
  }) as typeof fs.appendFileSync);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((f: fs.PathOrFileDescriptor, o?: unknown) => {
    // The rotation read (a full read of the log as text). The first save's dedupe seed reads it
    // too, in the same form; failures are injected only after the first save.
    if (mode === 'read' && String(f) === logPath && o === 'utf-8') throw new Error('simulated read failure');
    return (realRead as (...a: unknown[]) => unknown)(f, o);
  }) as typeof fs.readFileSync);
  vi.spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
    if (mode === 'rename' && String(b) === logPath) throw new Error('simulated rename failure');
    return realRename(a, b);
  }) as typeof fs.renameSync);

  for (let i = 0; i < SAVES; i++) {
    mode = failAt.get(i) ?? 'none';
    written = '';
    adapter.logInboundMessage({ messageId: 5_000 + i, topicId: 7, text: `save ${i}`, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString() });
    mode = 'none';
    oracle += written;
    if (failAt.get(i) === 'torn') {
      oracleNotes += 1; // the adapter re-reads its view after a failed save
    } else if (failAt.get(i) !== 'read' && failAt.get(i) !== 'rename') {
      const r = oldRotate(oracle);
      oracle = r.bytes;
      if (r.rotated) oracleNotes += 1;
    }
    expect(Buffer.compare(realRead(logPath) as Buffer, Buffer.from(oracle)), `bytes after save ${i}`).toBe(0);
    expect(notes.mock.calls.length, `view notices after save ${i}`).toBe(oracleNotes);
  }
  await adapter.stop();
  return { rotations: oracleNotes };
}

const scenarios: Array<[string, Map<number, Fail>]> = [
  ['no failure', new Map()],
  ['the rotation read fails on the crossing save and the next', new Map([[5, 'read'], [6, 'read']])],
  ['the rename fails on the crossing save', new Map([[5, 'rename']])],
  ['a torn write (part of a line, no newline) just before the crossing save', new Map([[4, 'torn']])],
  ['a torn write on the crossing save itself', new Map([[5, 'torn']])],
];

describe('message-log rotation at real size matches the old code byte for byte', () => {
  for (const pathKind of ['legacy', 'shared'] as const) {
    for (const [name, failAt] of scenarios) {
      it(`${pathKind} save path — ${name}`, async () => {
        const r = await run(pathKind, failAt);
        expect(r.rotations).toBeGreaterThan(0); // every scenario crosses the cap at least once
      }, 180_000);
    }
  }
});
