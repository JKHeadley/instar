import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalAttentionItems, LOCAL_ATTENTION_MAX_ITEMS } from '../../src/core/LocalAttentionItems.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'local-attention-')); }
function cleanup(dir: string): void { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); }

describe('LocalAttentionItems', () => {
  it('stores a raised item durably and reads it back from a fresh instance', () => {
    const dir = tmp();
    try {
      const store = new LocalAttentionItems(dir);
      expect(store.raise({ id: 'agent:desktop-relock-failed:x', title: 'A Mac may still be unlocked', summary: 'Lock it.', priority: 'HIGH', category: 'security' })).toBe(true);
      const again = new LocalAttentionItems(dir);
      expect(again.get('agent:desktop-relock-failed:x')).toMatchObject({ status: 'OPEN', priority: 'HIGH', category: 'security', surface: 'local', raisedCount: 1 });
      expect(again.list('OPEN')).toHaveLength(1);
    } finally { cleanup(dir); }
  });

  it('keeps one row per id: a re-raise refreshes and reopens it', () => {
    const dir = tmp();
    try {
      const store = new LocalAttentionItems(dir);
      store.raise({ id: 'a', title: 'one', summary: 's' });
      store.setStatus('a', 'DONE', 'locked it');
      expect(store.get('a')).toMatchObject({ status: 'DONE', resolution: 'locked it' });
      store.raise({ id: 'a', title: 'two', summary: 's2' });
      const row = store.get('a')!;
      expect(store.list()).toHaveLength(1);
      expect(row).toMatchObject({ status: 'OPEN', title: 'two', raisedCount: 2 });
      expect(row.resolution).toBeUndefined();
    } finally { cleanup(dir); }
  });

  it('reports false when the row cannot be written, so the caller retries', () => {
    const dir = tmp();
    try {
      // A plain file where the state directory should be makes every write fail.
      fs.writeFileSync(path.join(dir, 'state'), 'not a directory');
      const store = new LocalAttentionItems(dir);
      expect(store.raise({ id: 'a', title: 't', summary: 's' })).toBe(false);
      expect(store.list()).toEqual([]);
    } finally { cleanup(dir); }
  });

  it('setStatus on an unknown id returns undefined', () => {
    const dir = tmp();
    try { expect(new LocalAttentionItems(dir).setStatus('nope', 'DONE')).toBeUndefined(); } finally { cleanup(dir); }
  });

  it('stays bounded, dropping the oldest closed rows and never an open one', () => {
    const dir = tmp();
    try {
      let t = 0;
      const store = new LocalAttentionItems(dir, () => new Date(1_700_000_000_000 + (t++) * 1000));
      store.raise({ id: 'open-first', title: 't', summary: 's' });
      for (let i = 0; i < LOCAL_ATTENTION_MAX_ITEMS + 5; i++) {
        store.raise({ id: `c${i}`, title: 't', summary: 's' });
        store.setStatus(`c${i}`, 'DONE');
      }
      const all = store.list();
      expect(all).toHaveLength(LOCAL_ATTENTION_MAX_ITEMS);
      expect(store.get('open-first')?.status).toBe('OPEN');
      expect(store.get('c0')).toBeUndefined();
      expect(store.get(`c${LOCAL_ATTENTION_MAX_ITEMS + 4}`)).toBeDefined();
    } finally { cleanup(dir); }
  });

  it('treats a corrupt file as empty and replaces it on the next raise', () => {
    const dir = tmp();
    try {
      const store = new LocalAttentionItems(dir);
      fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
      fs.writeFileSync(store.filePath, '{not json');
      expect(store.list()).toEqual([]);
      expect(store.raise({ id: 'a', title: 't', summary: 's' })).toBe(true);
      expect(store.list()).toHaveLength(1);
    } finally { cleanup(dir); }
  });
});
