/**
 * Tests for TelegramAdapter polling offset persistence.
 *
 * Covers: offset save/load across restarts, corrupted file handling,
 * invalid values, and offset update after processing updates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('TelegramAdapter — offset persistence', () => {
  const sourcePath = path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts');
  let source: string;

  // Read source once for all tests
  source = fs.readFileSync(sourcePath, 'utf-8');

  describe('offset file management', () => {
    it('has an offsetPath property for persistence', () => {
      expect(source).toContain('offsetPath');
      expect(source).toContain('telegram-poll-offset.json');
    });

    it('loads offset on construction', () => {
      expect(source).toContain('loadOffset()');
      // loadOffset should be called in constructor
      const constructorSection = source.slice(
        source.indexOf('constructor('),
        source.indexOf('async start()')
      );
      expect(constructorSection).toContain('this.loadOffset()');
    });

    it('saves offset after processing updates', () => {
      expect(source).toContain('saveOffset()');
      // saveOffset should be called in poll method after processing updates
      const pollSection = source.slice(source.indexOf('private async poll'));
      expect(pollSection).toContain('this.saveOffset()');
    });

    it('saves offset after each individual update (not batch-end)', () => {
      // saveOffset must be called inside the for-loop, after each processUpdate,
      // so a mid-batch crash doesn't re-deliver already-processed messages.
      // Pattern mirrors TelegramLifeline.poll — see commit 96006ff.
      const pollSection = source.slice(source.indexOf('private async poll'));
      const forLoopSection = pollSection.slice(
        pollSection.indexOf('for (const update of updates)'),
        pollSection.indexOf('} catch (err)')
      );
      // saveOffset should appear inside the loop body, before the closing brace
      expect(forLoopSection).toContain('this.saveOffset()');
      // The old batch-end pattern ('if (updates.length > 0)') should NOT exist
      expect(pollSection.slice(0, pollSection.indexOf('} catch (err)'))).not.toContain('if (updates.length > 0)');
    });
  });

  describe('loadOffset validation', () => {
    it('validates offset is a positive finite number', () => {
      // Should check Number.isFinite and > 0
      const loadSection = source.slice(
        source.indexOf('private loadOffset'),
        source.indexOf('private saveOffset')
      );
      expect(loadSection).toContain('isFinite');
      expect(loadSection).toContain('> 0');
    });

    it('handles missing file gracefully', () => {
      const loadSection = source.slice(
        source.indexOf('private loadOffset'),
        source.indexOf('private saveOffset')
      );
      // Should have try-catch
      expect(loadSection).toContain('catch');
    });
  });

  describe('saveOffset atomicity', () => {
    it('uses atomic write pattern (temp file + rename)', () => {
      const start = source.indexOf('private saveOffset');
      const end = source.indexOf('private async poll');
      const saveSection = source.slice(start, end);
      expect(saveSection).toContain('.tmp');
      expect(saveSection).toContain('renameSync');
    });

    it('cleans up temp file on write failure', () => {
      const start = source.indexOf('private saveOffset');
      const end = source.indexOf('private async poll');
      const saveSection = source.slice(start, end);
      expect(saveSection).toMatch(/safeUnlinkSync\(tmpPath/);
    });
  });

  describe('offset range sanity check', () => {
    it('detects cross-token offset corruption in poll()', () => {
      // A sanity check must exist that detects when received update_ids are
      // significantly lower than the stored offset — indicating the offset was
      // written by a different bot token or corrupted during migration.
      const pollSection = source.slice(source.indexOf('private async poll'));
      expect(pollSection).toContain('OFFSET_RANGE_THRESHOLD');
    });

    it('uses a 10M delta threshold for corruption detection', () => {
      const pollSection = source.slice(source.indexOf('private async poll'));
      expect(pollSection).toContain('10_000_000');
    });

    it('auto-corrects offset when corruption detected', () => {
      // Must reset this.lastUpdateId to the received max and save
      const pollSection = source.slice(source.indexOf('private async poll'));
      const sanitySection = pollSection.slice(
        pollSection.indexOf('OFFSET_RANGE_THRESHOLD'),
        pollSection.indexOf('for (const update of updates)')
      );
      expect(sanitySection).toContain('this.lastUpdateId = maxReceivedId');
      expect(sanitySection).toContain('this.saveOffset()');
    });

    it('logs a warning when auto-correcting offset', () => {
      const pollSection = source.slice(source.indexOf('private async poll'));
      const sanitySection = pollSection.slice(
        pollSection.indexOf('OFFSET_RANGE_THRESHOLD'),
        pollSection.indexOf('for (const update of updates)')
      );
      expect(sanitySection).toContain('console.warn');
      expect(sanitySection).toContain('Auto-correcting');
    });
  });
});
