/**
 * transcriptProber — gate E of the SessionReaper. The load-bearing safety
 * property under test: an UNRESOLVABLE transcript is NEVER reported as quiet.
 * It must read as `'unknown'` (→ classifier KEEPs), which is what makes Codex
 * sessions and missing/rotated transcripts safe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  probeTranscript,
  transcriptDelta,
  type TranscriptProbe,
} from '../../src/monitoring/transcriptProber.js';

describe('transcriptProber', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tprobe-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/transcriptProber.test.ts' });
  });

  describe('probeTranscript', () => {
    it('resolves and stats a Claude transcript', () => {
      const root = path.join(tmp, 'claude');
      const encoded = '-Users-justin-proj';
      fs.mkdirSync(path.join(root, encoded), { recursive: true });
      const file = path.join(root, encoded, 'sid-123.jsonl');
      fs.writeFileSync(file, 'x'.repeat(100));
      const probe = probeTranscript({
        framework: 'claude-code',
        sessionId: 'sid-123',
        projectDir: '/Users/justin/proj',
        rootOverride: root,
      });
      expect(probe.resolved).toBe(true);
      expect(probe.size).toBe(100);
      expect(probe.path).toBe(file);
    });

    it('resolves a Codex transcript under the date-partitioned tree', () => {
      const root = path.join(tmp, 'codex');
      const dDir = path.join(root, '2026', '05', '26');
      fs.mkdirSync(dDir, { recursive: true });
      const file = path.join(dDir, 'rollout-2026-05-26T08-00-00-abc-uuid.jsonl');
      fs.writeFileSync(file, 'y'.repeat(42));
      const probe = probeTranscript({
        framework: 'codex-cli',
        sessionId: 'abc-uuid',
        projectDir: '/whatever',
        rootOverride: root,
      });
      expect(probe.resolved).toBe(true);
      expect(probe.size).toBe(42);
    });

    it('returns resolved:false when there is no session id (Codex/pre-hook)', () => {
      const probe = probeTranscript({ framework: 'claude-code', sessionId: '', projectDir: '/x' });
      expect(probe.resolved).toBe(false);
      expect(probe.path).toBe('');
    });

    it('returns resolved:false when the Codex root has no matching file', () => {
      const root = path.join(tmp, 'codex-empty');
      fs.mkdirSync(root, { recursive: true });
      const probe = probeTranscript({
        framework: 'codex-cli',
        sessionId: 'missing',
        projectDir: '/x',
        rootOverride: root,
      });
      expect(probe.resolved).toBe(false);
    });

    it('returns resolved:false when the resolved path is missing on disk', () => {
      const root = path.join(tmp, 'claude2');
      // resolver builds a deterministic path; do NOT create the file.
      const probe = probeTranscript({
        framework: 'claude-code',
        sessionId: 'nope',
        projectDir: '/p',
        rootOverride: root,
      });
      expect(probe.resolved).toBe(false);
    });
  });

  describe('transcriptDelta', () => {
    const base = (over: Partial<TranscriptProbe>): TranscriptProbe => ({
      resolved: true, path: '/t.jsonl', size: 100, mtime: 1000, ...over,
    });

    it('grew when size advances', () => {
      expect(transcriptDelta(base({}), base({ size: 200 }))).toBe('grew');
    });
    it('grew when mtime advances', () => {
      expect(transcriptDelta(base({}), base({ mtime: 2000 }))).toBe('grew');
    });
    it('static when resolved both times with no growth', () => {
      expect(transcriptDelta(base({}), base({}))).toBe('static');
    });
    it('unknown when baseline unresolved — NEVER static', () => {
      expect(transcriptDelta(base({ resolved: false }), base({}))).toBe('unknown');
    });
    it('unknown when current unresolved — NEVER static', () => {
      expect(transcriptDelta(base({}), base({ resolved: false }))).toBe('unknown');
    });
    it('unknown when the file identity changed (rotation)', () => {
      expect(transcriptDelta(base({ path: '/a.jsonl' }), base({ path: '/b.jsonl' }))).toBe('unknown');
    });
  });
});
