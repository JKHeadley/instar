import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createChiefOfStaffProjectComparisonJournal } from '../../src/core/ChiefOfStaffProjectComparisonJournal.js';
import {
  CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_STORE_KEY,
  buildBindingPut, buildLifecycleEvent,
} from '../../src/core/ChiefOfStaffStore.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const activeKey = 'app:ddc8b035-ef0c-4762-a041-12c8a03d18f5';
const closedKey = 'app:61077451-2be5-4d08-9f91-741dbd0bba5d';
const noPointerKey = 'app:452a77c4-f011-4ae1-9c24-1265b4bdc1b2';
const origin = 'cos-fixture';
const timestamp = '2026-11-24T08:00:00.000Z';
const cleanups: Array<() => void> = [];
let workerUrl: URL;
let workerDirectory: string;

beforeAll(async () => {
  workerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-comparison-worker-'));
  const outfile = path.join(workerDirectory, 'comparison.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/core/ChiefOfStaffProjectComparisonJournal.worker.ts', import.meta.url))],
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  });
  workerUrl = pathToFileURL(outfile);
});

function removeFixture(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test:cos-comparison-fixture' });
}

afterAll(() => { if (workerDirectory) removeFixture(workerDirectory); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(rotateAt?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-comparison-journal-'));
  const journal = new CoherenceJournal({
    stateDir: dir, machineId: origin, flushIntervalMs: 1_000_000,
    ...(rotateAt === undefined ? {} : { retention: { 'chief-of-staff-record': { maxFileBytes: rotateAt, rotateKeep: 0 } } }),
  });
  cleanups.push(() => {
    journal.close();
    removeFixture(dir);
  });
  const registry = new ReplicatedKindRegistry();
  registry.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
  journal.setReplicatedKindRegistry(registry);
  journal.open();
  const emitter = new ReplicatedRecordEmitter({
    journal, clock: new HybridLogicalClock({ node: origin, now: () => Date.parse(timestamp) }),
    registry, origin, stores: () => ({ chiefOfStaff: { enabled: true } }), loadWitness: () => undefined,
  });
  const binding = (key: string, pointer?: string, confirmed = true) => {
    const accepted = emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `binding:${key}`, buildBindingPut({
      conversationKey: key, goal: 'Private goal should not leave journal worker',
      doneDefinition: [{ id: 'done', text: 'Private done item', kind: 'judgment' }],
      checkCadenceHours: 24, linked: {}, initiativeId: pointer,
      ...(confirmed ? { confirmedBy: 'owner', confirmedAt: timestamp } : {}),
    }));
    expect(accepted.outcome).toBe('emitted');
    return accepted.hlc!;
  };
  const closeBinding = (key: string, bindingHlc: ReturnType<typeof binding>) => {
    const result = emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `lifecycle:${key}:${Date.parse(timestamp)}`,
      buildLifecycleEvent(key, 'closed', bindingHlc, 'owner-tap', timestamp));
    expect(result.outcome).toBe('emitted');
  };
  let authorized = true;
  const source = createChiefOfStaffProjectComparisonJournal({ journal, isAuthorized: () => authorized, workerUrl });
  const file = path.join(dir, 'state', 'coherence-journal', `${origin}.chief-of-staff-record.jsonl`);
  return { journal, binding, closeBinding, file, source, revoke: () => { authorized = false; } };
}

const signal = () => new AbortController().signal;

describe('Chief of Staff local native project comparison journal', () => {
  it('folds real confirmed live bindings and exposes no private goal or pointer value, without writing', async () => {
    const f = fixture();
    f.binding(activeKey, 'private-pointer-value');
    f.binding(noPointerKey);
    const toClose = f.binding(closedKey, 'closed-pointer');
    f.closeBinding(closedKey, toClose);
    f.binding('telegram:2369', undefined, false);
    f.journal.flush();

    const directory = path.dirname(f.file);
    const files = fs.readdirSync(directory).sort();
    const before = files.filter(file => fs.statSync(path.join(directory, file)).isFile())
      .map(file => [file, fs.readFileSync(path.join(directory, file))] as const);
    const result = await f.source.read(signal());
    expect(result?.keys).toEqual([
      { conversationKey: activeKey, hasInitiativePointer: true },
      { conversationKey: noPointerKey, hasInitiativePointer: false },
    ]);
    expect(result?.release()).toBe(true);
    expect(fs.readdirSync(directory).sort()).toEqual(files);
    for (const [file, bytes] of before) expect(fs.readFileSync(path.join(directory, file))).toEqual(bytes);
    f.revoke();
    expect(result?.release()).toBe(false);
  });

  it('refuses before file admission if unauthorized and while native changes are pending', async () => {
    const f = fixture();
    f.binding(activeKey);
    const lstat = vi.spyOn(fs, 'lstatSync');
    try {
      expect(await f.source.read(signal())).toBeNull();
      expect(lstat.mock.calls.some(([file]) => file === f.file)).toBe(false);
      expect(f.journal.pendingCount).toBe(1);

      f.journal.flush();
      const result = await f.source.read(signal());
      expect(result?.release()).toBe(true);
      f.binding(noPointerKey);
      expect(result?.release()).toBe(false);
      expect(await f.source.read(signal())).toBeNull();
      expect(f.journal.pendingCount).toBe(1);

      f.revoke();
      f.journal.flush();
      lstat.mockClear();
      expect(await f.source.read(signal())).toBeNull();
      expect(lstat.mock.calls.some(([file]) => file === f.file)).toBe(false);
    } finally {
      lstat.mockRestore();
    }
  });

  it('invalidates a captured read across a close and reopen of the same writer', async () => {
    const f = fixture();
    f.binding(activeKey);
    f.journal.flush();
    const result = await f.source.read(signal());
    expect(result?.release()).toBe(true);
    const advert = f.journal.getOwnAdvert()['chief-of-staff-record'];
    f.journal.close();
    f.journal.open();
    expect(f.journal.getOwnAdvert()['chief-of-staff-record']).toEqual(advert);
    expect(result?.release()).toBe(false);
    expect((await f.source.read(signal()))?.release()).toBe(true);
  });

  it('discards an in-flight snapshot when the native writer accepts a newer closure', async () => {
    const f = fixture();
    const binding = f.binding(activeKey);
    f.journal.flush();
    const pending = f.source.read(signal());
    f.closeBinding(activeKey, binding);
    expect(await pending).toBeNull();
    expect(f.journal.pendingCount).toBe(1);
    f.journal.flush();
    expect((await f.source.read(signal()))?.keys).toEqual([]);
  });

  it('rejects an interrupted worker and refuses current files with missing, torn, oversized, or rotated coverage', async () => {
    const f = fixture();
    f.binding(activeKey);
    f.journal.flush();
    const original = fs.readFileSync(f.file);

    const abort = new AbortController();
    const pending = f.source.read(abort.signal);
    abort.abort();
    expect(await pending).toBeNull();

    const result = await f.source.read(signal());
    fs.appendFileSync(f.file, '{');
    expect(result?.release()).toBe(false);
    expect(await f.source.read(signal())).toBeNull();

    fs.truncateSync(f.file, 4 * 1024 * 1024 + 1);
    expect(await f.source.read(signal())).toBeNull();
    fs.renameSync(f.file, `${f.file}.missing`);
    expect(await f.source.read(signal())).toBeNull();
    fs.writeFileSync(f.file, original);

    const rotated = fixture(1);
    rotated.binding(activeKey);
    rotated.journal.flush();
    rotated.binding(noPointerKey);
    rotated.journal.flush();
    expect(await rotated.source.read(signal())).toBeNull();
  });

  it('withholds membership if an eligible native binding has no App-scope key', async () => {
    const f = fixture();
    f.binding(activeKey);
    f.binding('telegram:2369');
    f.journal.flush();
    expect(await f.source.read(signal())).toBeNull();
  });
});
