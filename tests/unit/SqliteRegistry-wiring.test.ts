/**
 * Wiring-integrity tests for the SQLite close-on-exit registry (P4 Wiring
 * Integrity; docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md §Problem B).
 *
 * Two guards:
 *   1. ALLOWLIST COMPLETENESS (static) — every long-lived store registers, and
 *      every better-sqlite3 open-callsite in src/ is accounted for (either a
 *      long-lived store that registers, OR an explicitly-allowlisted transient).
 *      This is the structural guarantee that a NEW store added later can't
 *      silently fall out of the close-list — the exact bug this fixes.
 *   2. REGISTRATION FIRES (functional) — instantiating a representative store
 *      against a real temp db actually grows the registry by one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sqliteRegistrySize,
  __resetSqliteRegistryForTests,
} from '../../src/core/SqliteRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StopGateDb } from '../../src/core/StopGateDb.js';
import { PreferenceStore } from '../../src/providers/uxConfirm/PreferenceStore.js';
import { SpawnLedger } from '../../src/threadline/SpawnLedger.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(REPO_ROOT, 'src');

/** The 15 long-lived (process-lifetime) SQLite stores — the registry allowlist. */
const LONG_LIVED_STORES = [
  'src/core/StopGateDb.ts',
  'src/core/FeatureRegistry.ts',
  'src/providers/uxConfirm/PreferenceStore.ts',
  'src/threadline/SpawnLedger.ts',
  'src/threadline/relay/RegistryStore.ts',
  'src/monitoring/TokenLedger.ts',
  'src/monitoring/CorrectionLedger.ts',
  'src/monitoring/FailureLedger.ts',
  'src/monitoring/FeatureMetricsLedger.ts',
  'src/monitoring/FrameworkIssueLedger.ts',
  'src/memory/TopicMemory.ts',
  'src/memory/SemanticMemory.ts',
  'src/messaging/MessageProcessingLedger.ts',
  'src/messaging/pending-relay-store.ts',
  'src/messaging/imessage/NativeBackend.ts',
];

/**
 * Files that open a better-sqlite3 handle but legitimately do NOT register —
 * each documented as a transient (closes itself) or a non-owning helper.
 */
const TRANSIENT_SKIP: Record<string, string> = {
  'src/commands/server.ts': ':memory: probe testDb — closes itself immediately',
  'src/server/routes.ts': 'readonly per-request open — closed per request, not process-lifetime',
  'src/memory/NativeModuleHealer.ts': 'generic ABI-heal helper — owns no handle (a comment mentions new Database)',
};

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkTs(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('SqliteRegistry wiring — allowlist completeness (static)', () => {
  it('every long-lived store calls registerSqliteHandle', () => {
    const missing: string[] = [];
    for (const rel of LONG_LIVED_STORES) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      if (!/registerSqliteHandle\s*\(/.test(src)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  it('every better-sqlite3 open-callsite in src/ is accounted for (no silent un-registered store)', () => {
    // Detect ANY way a store opens a handle: literal `new Database(` /
    // `new BetterSqlite3(`, OR the NativeModuleHealer.openWithHealSync wrapper.
    const OPEN_RE = /new\s+Database\s*\(|new\s+BetterSqlite3\s*\(|openWithHealSync\s*\(/;
    const unaccounted: string[] = [];
    for (const abs of walkTs(SRC)) {
      const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
      // The registry module itself + test fixtures are not stores.
      if (rel === 'src/core/SqliteRegistry.ts') continue;
      const src = fs.readFileSync(abs, 'utf8');
      if (!OPEN_RE.test(src)) continue;
      const isLongLived = LONG_LIVED_STORES.includes(rel);
      const isTransient = rel in TRANSIENT_SKIP;
      if (!isLongLived && !isTransient) {
        unaccounted.push(rel);
      }
      // A long-lived store that opens a handle MUST register.
      if (isLongLived && !/registerSqliteHandle\s*\(/.test(src)) {
        unaccounted.push(`${rel} (long-lived but does not register!)`);
      }
    }
    // If this fails, a NEW sqlite store was added: either register it (and add
    // to LONG_LIVED_STORES) or document it in TRANSIENT_SKIP with the reason.
    expect(unaccounted).toEqual([]);
  });
});

describe('SqliteRegistry wiring — registration fires (functional)', () => {
  let tmp: string;
  beforeEach(() => {
    __resetSqliteRegistryForTests();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-reg-'));
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/SqliteRegistry-wiring.test.ts' }); } catch { /* ignore */ }
  });

  it('StopGateDb registers on construct', () => {
    expect(sqliteRegistrySize()).toBe(0);
    new StopGateDb({ dbPath: path.join(tmp, 'stopgate.db') });
    expect(sqliteRegistrySize()).toBe(1);
  });

  it('PreferenceStore registers on construct', () => {
    expect(sqliteRegistrySize()).toBe(0);
    new PreferenceStore({ dbPath: path.join(tmp, 'prefs.db') });
    expect(sqliteRegistrySize()).toBe(1);
  });

  it('SpawnLedger registers on construct', () => {
    expect(sqliteRegistrySize()).toBe(0);
    new SpawnLedger(path.join(tmp, 'spawn.db'));
    expect(sqliteRegistrySize()).toBe(1);
  });
});
