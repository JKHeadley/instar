import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import type { RelationshipManagerConfig, UserChannel } from '../../src/core/types.js';

/**
 * Tests for RelationshipManager merge/delete operations.
 * Validates that the ESM fix (unlinkSync import) works correctly.
 */
describe('RelationshipManager delete operations', () => {
  let tmpDir: string;
  let config: RelationshipManagerConfig;
  let manager: RelationshipManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rel-delete-'));
    config = {
      relationshipsDir: path.join(tmpDir, 'relationships'),
      maxRecentInteractions: 20,
    };
    manager = new RelationshipManager(config);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merge deletes the source relationship file from disk', () => {
    const ch1: UserChannel = { type: 'telegram', identifier: '111' };
    const ch2: UserChannel = { type: 'email', identifier: 'alice@test.com' };

    const r1 = manager.findOrCreate('Alice (Telegram)', ch1);
    const r2 = manager.findOrCreate('Alice (Email)', ch2);

    // Both files should exist
    const file1 = path.join(config.relationshipsDir, `${r1.id}.json`);
    const file2 = path.join(config.relationshipsDir, `${r2.id}.json`);
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(true);

    // Merge r2 into r1
    manager.mergeRelationships(r1.id, r2.id);

    // r1 file should still exist, r2 file should be deleted
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(false);
  });

  it('merge preserves interaction history from both records', () => {
    const ch1: UserChannel = { type: 'telegram', identifier: '111' };
    const ch2: UserChannel = { type: 'slack', identifier: 'U12345' };

    const r1 = manager.findOrCreate('Bob', ch1);
    const r2 = manager.findOrCreate('Bob (Slack)', ch2);

    manager.recordInteraction(r1.id, {
      timestamp: new Date(Date.now() - 5000).toISOString(),
      channel: 'telegram',
      summary: 'Telegram conversation',
      topics: ['project-setup'],
    });

    manager.recordInteraction(r2.id, {
      timestamp: new Date().toISOString(),
      channel: 'slack',
      summary: 'Slack follow-up',
      topics: ['deployment'],
    });

    manager.mergeRelationships(r1.id, r2.id);

    const merged = manager.get(r1.id)!;
    expect(merged.recentInteractions).toHaveLength(2);
    expect(merged.interactionCount).toBe(2);
    expect(merged.themes).toContain('project-setup');
    expect(merged.themes).toContain('deployment');
  });

  it('merged record survives manager reload', () => {
    const ch1: UserChannel = { type: 'telegram', identifier: '111' };
    const ch2: UserChannel = { type: 'email', identifier: 'carol@test.com' };

    const r1 = manager.findOrCreate('Carol', ch1);
    const r2 = manager.findOrCreate('Carol (email)', ch2);
    manager.mergeRelationships(r1.id, r2.id);

    // Create a new manager pointing at the same dir
    const manager2 = new RelationshipManager(config);

    // r1 should exist with both channels
    const loaded = manager2.get(r1.id)!;
    expect(loaded).not.toBeNull();
    expect(loaded.channels).toHaveLength(2);

    // r2 should NOT exist
    expect(manager2.get(r2.id)).toBeNull();

    // Both channels should resolve to r1
    expect(manager2.resolveByChannel(ch1)!.id).toBe(r1.id);
    expect(manager2.resolveByChannel(ch2)!.id).toBe(r1.id);
  });

  it('handles merge with nonexistent source gracefully', () => {
    const ch1: UserChannel = { type: 'telegram', identifier: '111' };
    const r1 = manager.findOrCreate('Dave', ch1);

    // Should not throw when merging nonexistent source
    expect(() => {
      manager.mergeRelationships(r1.id, 'nonexistent-id');
    }).not.toThrow();

    // r1 should be unchanged
    const unchanged = manager.get(r1.id)!;
    expect(unchanged.name).toBe('Dave');
    expect(unchanged.channels).toHaveLength(1);
  });
});
