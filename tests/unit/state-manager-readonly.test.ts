/**
 * Unit tests for StateManager read-only mode.
 *
 * Tests:
 * - Read-only mode blocks all write operations
 * - Read operations still work in read-only mode
 * - Mode can be toggled on and off
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-state-ro-test-'));
}

function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/state-manager-readonly.test.ts:22' });
}

describe('StateManager read-only mode', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    state = new StateManager(tmpDir);
  });

  afterEach(() => cleanup(tmpDir));

  // ── Mode toggle ────────────────────────────────────────────────

  describe('setReadOnly / readOnly', () => {
    it('starts in read-write mode', () => {
      expect(state.readOnly).toBe(false);
    });

    it('can be set to read-only', () => {
      state.setReadOnly(true);
      expect(state.readOnly).toBe(true);
    });

    it('can be toggled back to read-write', () => {
      state.setReadOnly(true);
      state.setReadOnly(false);
      expect(state.readOnly).toBe(false);
    });
  });

  // ── Write blocking ─────────────────────────────────────────────

  describe('write operations blocked in read-only', () => {
    beforeEach(() => {
      state.setReadOnly(true);
    });

    it('saveSession throws', () => {
      expect(() => state.saveSession({
        id: 'test-1',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any)).toThrow('read-only');
    });

    it('saveJobState throws', () => {
      expect(() => state.saveJobState({
        slug: 'test-job',
        lastRun: new Date().toISOString(),
      } as any)).toThrow('read-only');
    });

    it('appendEvent throws', () => {
      expect(() => state.appendEvent({
        type: 'test',
        timestamp: new Date().toISOString(),
      } as any)).toThrow('read-only');
    });

    it('set throws', () => {
      expect(() => state.set('test-key', { foo: 'bar' })).toThrow('read-only');
    });

    it('delete throws', () => {
      expect(() => state.delete('test-key')).toThrow('read-only');
    });

    it('error message includes operation name', () => {
      expect(() => state.saveSession({
        id: 'test-1',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any)).toThrow('saveSession');
    });

    it('error message mentions standby', () => {
      expect(() => state.set('key', 'val')).toThrow('standby');
    });
  });

  // ── Read operations still work ─────────────────────────────────

  describe('read operations work in read-only', () => {
    beforeEach(() => {
      // Write some data first (in read-write mode)
      state.set('test-data', { value: 42 });
      state.setReadOnly(true);
    });

    it('get works', () => {
      const result = state.get<{ value: number }>('test-data');
      expect(result).toEqual({ value: 42 });
    });

    it('getSession returns null for missing session', () => {
      expect(state.getSession('nonexistent')).toBeNull();
    });

    it('listSessions returns empty array', () => {
      expect(state.listSessions()).toEqual([]);
    });

    it('getJobState returns null for missing job', () => {
      expect(state.getJobState('nonexistent')).toBeNull();
    });

    it('queryEvents returns empty array', () => {
      expect(state.queryEvents({})).toEqual([]);
    });
  });

  // ── Toggle back to writable ────────────────────────────────────

  describe('recovery from read-only', () => {
    it('writes work again after disabling read-only', () => {
      state.setReadOnly(true);
      expect(() => state.set('key', 'val')).toThrow('read-only');

      state.setReadOnly(false);
      state.set('key', 'val');
      expect(state.get<string>('key')).toBe('val');
    });
  });
});

describe('StateManager read-only + session pool active (bug #9)', () => {
  let tmpDir: string;
  let state: StateManager;
  const sess = (id: string) => ({ id, status: 'running', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as any);

  beforeEach(() => {
    tmpDir = createTempDir();
    state = new StateManager(tmpDir);
    state.setReadOnly(true);          // standby
    state.setSessionPoolActive(true); // but participates in the active-active pool
  });
  afterEach(() => cleanup(tmpDir));

  it('ALLOWS saveSession for an owned session (per-session write, pool CAS = single owner)', () => {
    expect(() => state.saveSession(sess('moved-1'))).not.toThrow();
    expect(state.getSession('moved-1')).toMatchObject({ id: 'moved-1' });
  });

  it('ALLOWS removeSession (per-session lifecycle)', () => {
    state.saveSession(sess('moved-2'));
    expect(() => state.removeSession('moved-2')).not.toThrow();
    expect(state.getSession('moved-2')).toBeNull();
  });

  it('STILL BLOCKS shared-cluster writes on a standby (no state fork)', () => {
    expect(() => state.set('shared-key', { x: 1 })).toThrow('read-only');
    expect(() => state.delete('shared-key')).toThrow('read-only');
    expect(() => state.saveJobState({ slug: 'j', lastRun: new Date(0).toISOString() } as any)).toThrow('read-only');
    expect(() => state.appendEvent({ type: 't', timestamp: new Date(0).toISOString() } as any)).toThrow('read-only');
  });

  it('a read-only standby with the pool INACTIVE blocks saveSession too (pure one-awake unchanged)', () => {
    const s2 = new StateManager(createTempDir());
    s2.setReadOnly(true); // pool NOT active (default)
    expect(() => s2.saveSession(sess('x'))).toThrow('read-only');
  });

  it('pool-active alone (not read-only) leaves all writes working', () => {
    const s3 = new StateManager(createTempDir());
    s3.setSessionPoolActive(true);
    expect(() => s3.set('k', 'v')).not.toThrow();
    expect(() => s3.saveSession(sess('y'))).not.toThrow();
  });
});
