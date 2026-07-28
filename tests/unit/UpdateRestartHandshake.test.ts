/**
 * Unit tests for UpdateRestartHandshake — version-skew restart verification.
 * codex-instar audit Item 4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  UpdateRestartHandshake,
  verifyRestartHandshake,
} from '../../src/core/UpdateRestartHandshake.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('UpdateRestartHandshake', () => {
  let stateDir: string;
  let handshakeFilePath: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-handshake-'));
    handshakeFilePath = path.join(stateDir, 'state', 'restart-handshake.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/UpdateRestartHandshake.test.ts:cleanup',
    });
  });

  describe('writePendingHandshake', () => {
    it('writes the handshake state file atomically', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'Just updated to v1.2.51. Restarting.',
      });

      expect(fs.existsSync(handshakeFilePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(handshakeFilePath, 'utf-8'));
      expect(parsed.expectedVersion).toBe('1.2.51');
      expect(parsed.previousVersion).toBe('1.2.50');
      expect(parsed.deferredNotification).toBe('Just updated to v1.2.51. Restarting.');
      expect(parsed.retryCount).toBe(0);
      expect(typeof parsed.triggeredAt).toBe('string');
    });

    it('overwrites any prior handshake (last write wins)', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.50',
        previousVersion: '1.2.49',
        deferredNotification: 'first',
      });
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'second',
      });

      const parsed = JSON.parse(fs.readFileSync(handshakeFilePath, 'utf-8'));
      expect(parsed.expectedVersion).toBe('1.2.51');
      expect(parsed.deferredNotification).toBe('second');
    });
  });

  describe('readPendingHandshake', () => {
    it('returns null when no handshake is pending', () => {
      const h = new UpdateRestartHandshake(stateDir);
      expect(h.readPendingHandshake()).toBeNull();
    });

    it('returns the parsed state when a handshake exists', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'hello',
      });
      const state = h.readPendingHandshake();
      expect(state).not.toBeNull();
      expect(state!.expectedVersion).toBe('1.2.51');
      expect(state!.retryCount).toBe(0);
    });

    it('returns null for a malformed handshake file', () => {
      fs.mkdirSync(path.dirname(handshakeFilePath), { recursive: true });
      fs.writeFileSync(handshakeFilePath, '{this is not valid JSON');
      const h = new UpdateRestartHandshake(stateDir);
      expect(h.readPendingHandshake()).toBeNull();
    });

    it('returns null when required fields are missing', () => {
      fs.mkdirSync(path.dirname(handshakeFilePath), { recursive: true });
      fs.writeFileSync(handshakeFilePath, JSON.stringify({ expectedVersion: 'x' }));
      const h = new UpdateRestartHandshake(stateDir);
      expect(h.readPendingHandshake()).toBeNull();
    });
  });

  describe('clearHandshake', () => {
    it('removes the handshake file', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'gone',
      });
      expect(fs.existsSync(handshakeFilePath)).toBe(true);
      h.clearHandshake();
      expect(fs.existsSync(handshakeFilePath)).toBe(false);
    });

    it('is a no-op when no handshake exists', () => {
      const h = new UpdateRestartHandshake(stateDir);
      expect(() => h.clearHandshake()).not.toThrow();
    });
  });

  describe('bumpRetryCount', () => {
    it('increments retryCount and persists', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'x',
      });

      expect(h.bumpRetryCount()).toBe(1);
      expect(h.bumpRetryCount()).toBe(2);
      expect(h.bumpRetryCount()).toBe(3);

      const state = h.readPendingHandshake();
      expect(state!.retryCount).toBe(3);
      // Other fields preserved across bumps.
      expect(state!.expectedVersion).toBe('1.2.51');
      expect(state!.deferredNotification).toBe('x');
    });

    it('returns 0 when no handshake exists', () => {
      const h = new UpdateRestartHandshake(stateDir);
      expect(h.bumpRetryCount()).toBe(0);
    });
  });

  describe('verifyRestartHandshake', () => {
    it('returns no-handshake when no marker is pending', () => {
      const h = new UpdateRestartHandshake(stateDir);
      const outcome = verifyRestartHandshake({
        handshake: h,
        runningVersion: '1.2.51',
      });
      expect(outcome.kind).toBe('no-handshake');
    });

    it('returns verified when runningVersion matches expectedVersion', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'Just updated to v1.2.51.',
      });

      const outcome = verifyRestartHandshake({
        handshake: h,
        runningVersion: '1.2.51',
      });
      expect(outcome.kind).toBe('verified');
      if (outcome.kind === 'verified') {
        expect(outcome.expectedVersion).toBe('1.2.51');
        expect(outcome.previousVersion).toBe('1.2.50');
        expect(outcome.deferredNotification).toBe('Just updated to v1.2.51.');
      }
      // verified does NOT clear — caller decides to clear after sending.
      expect(fs.existsSync(handshakeFilePath)).toBe(true);
    });

    it('returns failed (no escalation on first miss) when runningVersion mismatches', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'unused',
      });

      const outcome = verifyRestartHandshake({
        handshake: h,
        runningVersion: '1.2.50',
      });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.runningVersion).toBe('1.2.50');
        expect(outcome.expectedVersion).toBe('1.2.51');
        expect(outcome.retryCount).toBe(1);
        expect(outcome.escalate).toBe(false); // threshold default = 2
      }
      // Handshake persists for next boot to re-check.
      expect(fs.existsSync(handshakeFilePath)).toBe(true);
    });

    it('escalates after retryCount reaches the threshold', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'unused',
      });

      // First failed verification — retry=1, no escalation.
      const first = verifyRestartHandshake({
        handshake: h,
        runningVersion: '1.2.50',
      });
      expect(first.kind).toBe('failed');
      if (first.kind === 'failed') expect(first.escalate).toBe(false);

      // Second failed verification — retry=2, threshold met, escalate.
      const second = verifyRestartHandshake({
        handshake: h,
        runningVersion: '1.2.50',
      });
      expect(second.kind).toBe('failed');
      if (second.kind === 'failed') {
        expect(second.retryCount).toBe(2);
        expect(second.escalate).toBe(true);
      }
    });

    it('respects a custom escalationThreshold', () => {
      const h = new UpdateRestartHandshake(stateDir);
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'unused',
      });

      const outcome = verifyRestartHandshake({
        handshake: h,
        runningVersion: '1.2.50',
        escalationThreshold: 1,
      });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.retryCount).toBe(1);
        expect(outcome.escalate).toBe(true);
      }
    });
  });

  describe('end-to-end happy path', () => {
    it('write → verify match → clear is the canonical sequence', () => {
      const h = new UpdateRestartHandshake(stateDir);

      // OLD process (just applied update, about to restart):
      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'Just updated to v1.2.51. Restarting.',
      });

      // ── restart happens ──

      // NEW process (boots on v1.2.51):
      const outcome = verifyRestartHandshake({
        handshake: h,
        runningVersion: '1.2.51',
      });
      expect(outcome.kind).toBe('verified');

      // Now send the (truthful) notification + clear.
      h.clearHandshake();
      expect(fs.existsSync(handshakeFilePath)).toBe(false);
    });

    it('write → verify mismatch (twice) → escalate is the failure sequence', () => {
      const h = new UpdateRestartHandshake(stateDir);

      h.writePendingHandshake({
        expectedVersion: '1.2.51',
        previousVersion: '1.2.50',
        deferredNotification: 'never sent (verification will fail)',
      });

      // Restart didn't take effect — still on old code.
      const r1 = verifyRestartHandshake({ handshake: h, runningVersion: '1.2.50' });
      expect(r1.kind).toBe('failed');
      if (r1.kind === 'failed') expect(r1.escalate).toBe(false);

      // Operator restarts again, still didn't catch up.
      const r2 = verifyRestartHandshake({ handshake: h, runningVersion: '1.2.50' });
      expect(r2.kind).toBe('failed');
      if (r2.kind === 'failed') {
        expect(r2.escalate).toBe(true);
        expect(r2.retryCount).toBe(2);
      }
    });
  });
});
