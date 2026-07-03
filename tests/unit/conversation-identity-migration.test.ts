// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Migration parity — durable conversation identity (spec
 * durable-conversation-identity §6.2/§9, §10 Tier 2):
 *
 *  - ConfigDefaults NEVER materializes `followThrough.enabled` (the #1001
 *    mechanism: a default-shaped false force-darks even a dev agent) and DOES
 *    carry `recording.enabled: true` (the D1 kill-switch default, delivered by
 *    the applyDefaults add-missing merge — "adds recording.enabled:true when
 *    absent").
 *  - migrateConfigConversationFollowThroughDevGate strips ONLY a default-shaped
 *    `enabled: false` (an explicit true is preserved; it never WRITES).
 *  - The backup manifest carries BOTH the snapshot AND the journal glob, and —
 *    through the REAL deployed BackupManager — the glob's EXPANDED set is
 *    non-empty with every expanded file PRESENT IN the created snapshot
 *    (gemini-C1 / R3-C4: a string-only dead manifest entry FAILS this test).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { migrateConfigConversationFollowThroughDevGate } from '../../src/core/PostUpdateMigrator.js';
import { BackupManager } from '../../src/core/BackupManager.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('conversation-identity config defaults (§9)', () => {
  it('applyDefaults adds recording.enabled:true when absent and NEVER materializes followThrough.enabled', () => {
    const merged: Record<string, unknown> = {};
    applyDefaults(merged, getMigrationDefaults('standalone'));
    const ci = merged.conversationIdentity as {
      recording?: { enabled?: boolean; disableJournalFsync?: boolean };
      followThrough?: Record<string, unknown>;
      mintBreaker?: { windowMs?: number; speculativePerWindow?: number; durableBindingPerWindow?: number };
    };
    expect(ci).toBeTruthy();
    expect(ci.recording?.enabled).toBe(true); // D1 default — always-on foundation
    expect(ci.recording?.disableJournalFsync).toBe(false);
    // The dev-gate convention: `enabled` OMITTED so resolveDevAgentGate decides.
    expect(Object.prototype.hasOwnProperty.call(ci.followThrough ?? {}, 'enabled')).toBe(false);
    expect(ci.followThrough).toMatchObject({ dryRun: true }); // dryRun-FIRST (§9)
    // §3.3 pinned breaker defaults.
    expect(ci.mintBreaker).toEqual({ windowMs: 600000, speculativePerWindow: 200, durableBindingPerWindow: 50 });
  });

  it('an operator explicit followThrough.enabled survives applyDefaults untouched', () => {
    const merged: Record<string, unknown> = { conversationIdentity: { followThrough: { enabled: true, dryRun: false } } };
    applyDefaults(merged, getMigrationDefaults('standalone'));
    const ci = merged.conversationIdentity as { followThrough?: { enabled?: boolean; dryRun?: boolean } };
    expect(ci.followThrough?.enabled).toBe(true);
    expect(ci.followThrough?.dryRun).toBe(false);
  });
});

describe('migrateConfigConversationFollowThroughDevGate (§9 — the #1001 strip)', () => {
  it('strips ONLY a default-shaped enabled:false', () => {
    const config: Record<string, unknown> = { conversationIdentity: { followThrough: { enabled: false, dryRun: true } } };
    expect(migrateConfigConversationFollowThroughDevGate(config)).toBe(true);
    const ft = (config.conversationIdentity as { followThrough: Record<string, unknown> }).followThrough;
    expect(Object.prototype.hasOwnProperty.call(ft, 'enabled')).toBe(false);
    expect(ft.dryRun).toBe(true); // sibling tuning untouched
  });

  it('preserves an explicit operator fleet-flip (enabled:true)', () => {
    const config: Record<string, unknown> = { conversationIdentity: { followThrough: { enabled: true } } };
    expect(migrateConfigConversationFollowThroughDevGate(config)).toBe(false);
    expect((config.conversationIdentity as { followThrough: { enabled?: boolean } }).followThrough.enabled).toBe(true);
  });

  it('never WRITES enabled: absent block / absent key are no-ops (idempotent)', () => {
    for (const config of [{}, { conversationIdentity: {} }, { conversationIdentity: { followThrough: { dryRun: true } } }] as Record<string, unknown>[]) {
      expect(migrateConfigConversationFollowThroughDevGate(config)).toBe(false);
      const ft = (config.conversationIdentity as { followThrough?: Record<string, unknown> } | undefined)?.followThrough;
      if (ft) expect(Object.prototype.hasOwnProperty.call(ft, 'enabled')).toBe(false);
    }
  });
});

describe('backup manifest — snapshot AND journal glob through the REAL BackupManager (gemini-C1 / R3-C4)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-backup-'));
    // Core files the default manifest includes (so createSnapshot is realistic).
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent');
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), '{}');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/conversation-identity-migration.test.ts:afterEach' });
  });

  it('after a durable mint, the glob EXPANDS to a non-empty set and every expanded file lands in the snapshot', async () => {
    // A durable-binding mint writes the fsynced journal line (§3.3 WAL rule)…
    const registry = new ConversationRegistry({ stateDir, machineId: () => 'm-test' });
    const minted = registry.mintForDurableBinding('C0BA4F4E0FP:1751412345.123456');
    expect(minted.ok).toBe(true);
    await registry.flushSnapshot(); // …and the batched snapshot file.
    expect(fs.existsSync(path.join(stateDir, 'conversation-registry.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'conversation-registry.json'))).toBe(true);

    // The EXACT entries migrateBackupManifest persists (stateDir-relative; the
    // journal glob is the ONE top-level trailing-star shape expandGlob expands).
    const mgr = new BackupManager(stateDir, {
      includeFiles: ['state/conversation-registry.json', 'conversation-registry.jsonl*'],
    });
    const snap = mgr.createSnapshot('manual');

    // The glob expanded to real files and every one is IN the snapshot — a
    // string-only dead manifest entry (the pr-pipeline.jsonl* class) fails here.
    const journalFiles = snap.files.filter((f) => f.startsWith('conversation-registry.jsonl'));
    expect(journalFiles.length).toBeGreaterThan(0);
    expect(journalFiles).toContain('conversation-registry.jsonl');
    // The literal snapshot-file entry is present the same way.
    expect(snap.files).toContain('state/conversation-registry.json');
  });

  it('rotated journal files within retention ride the same glob', async () => {
    const registry = new ConversationRegistry({ stateDir, machineId: () => 'm-test', journalRotateBytes: 10 });
    registry.mintForDurableBinding('C0AAAA11111');
    registry.mintForDurableBinding('C0BBBB22222'); // forces a rotation
    await registry.flushSnapshot();
    const mgr = new BackupManager(stateDir, {
      includeFiles: ['state/conversation-registry.json', 'conversation-registry.jsonl*'],
    });
    const snap = mgr.createSnapshot('manual');
    const rotated = snap.files.filter((f) => /^conversation-registry\.jsonl\.\d+$/.test(f));
    expect(rotated.length).toBeGreaterThan(0);
  });
});
