/**
 * McpLoadedSetStore — durable per-topic loaded-set state with two-phase commit.
 * Verifies atomic write, the committed/un-committed reader contract (M1/M3),
 * exists() vs unreadable, and de-dup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { McpLoadedSetStore } from '../../src/core/McpLoadedSetStore.js';

describe('McpLoadedSetStore', () => {
  let dir: string;
  let store: McpLoadedSetStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-loadedset-'));
    store = new McpLoadedSetStore(dir);
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mcp-loaded-set-store.test.ts' });
  });

  it('absent topic ⇒ read null, readCommitted null, exists false', () => {
    expect(store.read(7)).toBeNull();
    expect(store.readCommitted(7)).toBeNull();
    expect(store.exists(7)).toBe(false);
  });

  it('a committed write is readable as the committed set', () => {
    store.write(7, ['threadline'], true, 'baseline');
    expect(store.exists(7)).toBe(true);
    expect(store.readCommitted(7)).toEqual(['threadline']);
    expect(store.read(7)).toMatchObject({ servers: ['threadline'], committed: true, reason: 'baseline' });
  });

  it('[M1/M3] an UN-committed write exists but readCommitted returns null (ignored by the reader)', () => {
    store.write(7, ['playwright', 'threadline'], false, 'load');
    expect(store.exists(7)).toBe(true);
    expect(store.readCommitted(7)).toBeNull();
    expect(store.read(7)).toMatchObject({ committed: false });
  });

  it('committing after an in-flight write makes it authoritative', () => {
    store.write(7, ['playwright', 'threadline'], false, 'load');
    expect(store.readCommitted(7)).toBeNull();
    store.write(7, ['playwright', 'threadline'], true, 'load');
    expect(new Set(store.readCommitted(7))).toEqual(new Set(['playwright', 'threadline']));
  });

  it('de-dupes + drops blanks on write', () => {
    store.write(7, ['threadline', 'threadline', ''], true, 'x');
    expect(store.readCommitted(7)).toEqual(['threadline']);
  });

  it('an unreadable (torn) file ⇒ read null but exists true (caller distinguishes)', () => {
    fs.writeFileSync(path.join(dir, '7.json'), '{ not json');
    expect(store.exists(7)).toBe(true);
    expect(store.read(7)).toBeNull();
    expect(store.readCommitted(7)).toBeNull();
  });

  it('write leaves no .tmp file behind (atomic rename)', () => {
    store.write(7, ['threadline'], true, 'x');
    expect(fs.existsSync(path.join(dir, '7.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '7.json'))).toBe(true);
  });
});
