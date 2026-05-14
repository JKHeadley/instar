/**
 * Tests for PreCompactionFlush — opt-in pre-compaction memory flush.
 *
 * Covers:
 *   - Disabled by default
 *   - No intelligence → no-intelligence outcome (audit only)
 *   - Missing session_id → no-session-id
 *   - Transcript file missing → no-transcript
 *   - Provider error → provider-error
 *   - LLM returns NONE → no-facts
 *   - LLM returns parse-failure → parse-failure
 *   - LLM returns valid JSON array → ok + files written + audit entry
 *   - JSON inside fenced code block parses correctly
 *   - maxFactsPerFlush caps writes
 *   - Slug coercion strips disallowed chars
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreCompactionFlush, DEFAULT_PRE_COMPACTION_FLUSH_CONFIG } from '../../src/core/PreCompactionFlush.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

function makeTempProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'precompact-flush-test-'));
}

function makeStubIntelligence(response: string | Error): IntelligenceProvider {
  return {
    evaluate: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function readAudit(projectDir: string): Array<Record<string, unknown>> {
  const auditPath = path.join(projectDir, '.instar', 'audit', 'pre-compaction-flush.jsonl');
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('PreCompactionFlush', () => {
  let projectDir: string;
  let claudeProjectsRoot: string;
  const fixedNow = () => new Date('2026-05-13T19:00:00Z');

  beforeEach(() => {
    projectDir = makeTempProjectDir();
    claudeProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-test-'));
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PreCompactionFlush.test.ts:afterEach' }); } catch { /* */ }
    try { SafeFsExecutor.safeRmSync(claudeProjectsRoot, { recursive: true, force: true, operation: 'tests/unit/PreCompactionFlush.test.ts:afterEach' }); } catch { /* */ }
  });

  describe('gate / skip outcomes', () => {
    it('returns disabled when config.enabled is false', async () => {
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence('NONE'), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: false },
      );
      const entry = await flush.handle({ session_id: 'abc' });
      expect(entry.outcome).toBe('disabled');
      expect(readAudit(projectDir)).toHaveLength(1);
      expect(readAudit(projectDir)[0].outcome).toBe('disabled');
    });

    it('returns no-intelligence when intelligence is null', async () => {
      const flush = new PreCompactionFlush(
        { intelligence: null, projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'abc' });
      expect(entry.outcome).toBe('no-intelligence');
    });

    it('returns no-session-id when session_id is missing', async () => {
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence('NONE'), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({});
      expect(entry.outcome).toBe('no-session-id');
    });

    it('returns no-transcript when the transcript file does not exist', async () => {
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence('NONE'), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'missing-uuid' });
      expect(entry.outcome).toBe('no-transcript');
    });

    it('returns provider-error when the LLM call throws', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake transcript content');
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence(new Error('rate-limited')), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('provider-error');
      expect(entry.reason).toContain('rate-limited');
    });

    it('returns no-facts when the LLM returns NONE', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake');
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence('NONE'), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('no-facts');
    });

    it('returns no-facts when the LLM returns []', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake');
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence('[]'), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('no-facts');
    });

    it('returns parse-failure when the LLM response is non-JSON garbage', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake');
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence('this is not json or NONE'), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('parse-failure');
    });
  });

  describe('happy path', () => {
    it('writes per-fact files and an audit entry on a successful flush', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'recent conversation about routing patterns');
      const response = JSON.stringify([
        { slug: 'routing-pattern', body: 'Use the new router with onRouteChange callback.' },
        { slug: 'db-pool-size', body: 'Production db pool max is 20.' },
      ]);
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence(response), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('ok');
      expect(entry.factsWritten).toBe(2);
      const memoryDir = path.join(projectDir, '.instar', 'memory');
      const files = fs.readdirSync(memoryDir);
      expect(files.length).toBe(2);
      expect(files.some((f) => f.includes('routing-pattern'))).toBe(true);
      expect(files.some((f) => f.includes('db-pool-size'))).toBe(true);
    });

    it('parses JSON wrapped in fenced code blocks', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake');
      const response = '```json\n[{"slug":"foo","body":"bar"}]\n```';
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence(response), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('ok');
      expect(entry.factsWritten).toBe(1);
    });

    it('parses { facts: [...] } object form', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake');
      const response = JSON.stringify({ facts: [{ slug: 'foo', body: 'bar' }] });
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence(response), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('ok');
      expect(entry.factsWritten).toBe(1);
    });

    it('caps writes at maxFactsPerFlush', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake');
      const response = JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({ slug: `fact-${i}`, body: `body ${i}` })),
      );
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence(response), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true, maxFactsPerFlush: 3 },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('ok');
      expect(entry.factsWritten).toBe(3);
      const memoryDir = path.join(projectDir, '.instar', 'memory');
      expect(fs.readdirSync(memoryDir).length).toBe(3);
    });

    it('coerces malformed slugs and drops empty / invalid facts', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake');
      const response = JSON.stringify([
        { slug: 'Foo Bar / Baz!', body: 'valid body' },
        { slug: '', body: 'empty slug' },
        { slug: 'no-body', body: '' },
        { something: 'else' },
        'not an object',
        { slug: 'good', body: 'also good' },
      ]);
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence(response), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const entry = await flush.handle({ session_id: 'sess-1' });
      expect(entry.outcome).toBe('ok');
      expect(entry.factsWritten).toBe(2);
      const memoryDir = path.join(projectDir, '.instar', 'memory');
      const files = fs.readdirSync(memoryDir);
      expect(files.some((f) => f.includes('foo-bar-baz'))).toBe(true);
      expect(files.some((f) => f.includes('good'))).toBe(true);
    });

    it('appends entries to MEMORY.md when it exists', async () => {
      writeFakeTranscript(claudeProjectsRoot, projectDir, 'sess-1', 'fake');
      fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.instar', 'MEMORY.md'),
        '# Memory Index\n\n## Existing\n\n- old item\n',
      );
      const response = JSON.stringify([{ slug: 'new-thing', body: 'remember this' }]);
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence(response), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      await flush.handle({ session_id: 'sess-1' });
      const memory = fs.readFileSync(path.join(projectDir, '.instar', 'MEMORY.md'), 'utf8');
      expect(memory).toContain('## Pre-Compaction Saves');
      expect(memory).toContain('precompact: new-thing');
    });
  });

  describe('audit log shape', () => {
    it('writes every outcome to audit jsonl with required fields', async () => {
      const flush = new PreCompactionFlush(
        { intelligence: null, projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      await flush.handle({ session_id: 'abc', trigger: 'manual' });
      const audit = readAudit(projectDir);
      expect(audit).toHaveLength(1);
      const e = audit[0];
      expect(e.flushId).toMatch(/^flush_[a-f0-9]+$/);
      expect(e.sessionId).toBe('abc');
      expect(e.trigger).toBe('manual');
      expect(e.outcome).toBe('no-intelligence');
      expect(typeof e.at).toBe('string');
      expect(typeof e.durationMs).toBe('number');
    });
  });

  describe('prompt construction', () => {
    it('asks for JSON array with slug/body and the NONE escape hatch', () => {
      const flush = new PreCompactionFlush(
        { intelligence: makeStubIntelligence(''), projectDir, claudeProjectsRoot, now: fixedNow },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, enabled: true },
      );
      const prompt = flush.buildPrompt('hello world');
      expect(prompt).toContain('JSON array');
      expect(prompt).toContain('"slug"');
      expect(prompt).toContain('"body"');
      expect(prompt).toContain('NONE');
      expect(prompt).toContain('hello world');
    });
  });
});

/** Create a transcript file at the standard Claude Code path. */
function writeFakeTranscript(
  claudeProjectsRoot: string,
  projectDir: string,
  sessionId: string,
  content: string,
): string {
  const encoded = projectDir.replace(/[\/.]/g, '-');
  const dir = path.join(claudeProjectsRoot, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}
