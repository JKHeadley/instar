// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * TopicResumeMap checks a transcript in the layout of the session's OWN
 * framework. A session known to be claude-code never enters the Codex or
 * Gemini discovery (2026-10-13 server-loop freeze: two live Claude sessions
 * with stale ids sent the heartbeat into a 286,984-file Codex walk every
 * minute). A miss is honest: the existing mapping is kept, nothing is
 * substituted. Both sides of each boundary are covered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { resetRolloutLookupState, rolloutLookupStats } from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { localPartitionOf, makeFakeHome, uuidV4Like, uuidV7At, writeRollout, writeTmuxStub } from '../helpers/codexArchiveFixture.js';

const CLAUDE_UUID = 'ba7cbe23-6ce3-4eb1-a924-c6b2271bd0d4';

function archiveReads(): number {
  const s = rolloutLookupStats();
  return s.hintedPartitionReads + s.syncDirectoryReads + s.asyncEnumerations + s.asyncDirectoryReads;
}

describe('TopicResumeMap — framework-scoped transcript check', () => {
  let home: string;
  let priorHome: string | undefined;
  let stateDir: string;
  let projectDir: string;
  let tmuxStub: string;
  let map: TopicResumeMap;

  const claudeProjectDir = (base: string): string =>
    path.join(base, 'projects', projectDir.replace(/[\/\.]/g, '-'));

  function writeClaudeTranscript(uuid: string, homeName = '.claude'): string {
    const dir = claudeProjectDir(path.join(home, homeName));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${uuid}.jsonl`);
    fs.writeFileSync(file, '{"type":"user"}\n');
    return file;
  }

  beforeEach(() => {
    home = makeFakeHome('topic-resume-fw-');
    priorHome = process.env.HOME;
    process.env.HOME = home; // os.homedir() reads $HOME on POSIX
    stateDir = path.join(home, 'state');
    projectDir = path.join(home, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    tmuxStub = writeTmuxStub(home);
    map = new TopicResumeMap(stateDir, projectDir, tmuxStub);
    resetRolloutLookupState();
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    resetRolloutLookupState();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/TopicResumeMap-framework-layout.test.ts:cleanup' });
  });

  describe('jsonlExistsPublic(uuid, framework)', () => {
    it('a claude-code session checks Claude transcripts ONLY — a Codex rollout under the same id is not consulted', () => {
      writeRollout(home, CLAUDE_UUID, '2026/09/26');
      expect(map.jsonlExistsPublic(CLAUDE_UUID, 'claude-code')).toBe(false);
      expect(archiveReads()).toBe(0);
    });

    it('a claude-code session finds its transcript in ~/.claude and in a pooled ~/.claude-* home', () => {
      writeClaudeTranscript(CLAUDE_UUID);
      expect(map.jsonlExistsPublic(CLAUDE_UUID, 'claude-code')).toBe(true);
      const pooled = uuidV4Like(2);
      writeClaudeTranscript(pooled, '.claude-work');
      expect(map.jsonlExistsPublic(pooled, 'claude-code')).toBe(true);
      expect(archiveReads()).toBe(0);
    });

    it('a codex-cli session finds its rollout through the bounded lookup and never reads Claude homes', () => {
      const when = new Date(2026, 9, 10, 9, 0, 0);
      const codexId = uuidV7At(when, 3);
      writeRollout(home, codexId, localPartitionOf(when));
      expect(map.jsonlExistsPublic(codexId, 'codex-cli')).toBe(true);
      expect(rolloutLookupStats().hintedPartitionReads).toBeGreaterThanOrEqual(1);
      // A Claude transcript under a codex id is not what a codex session resumes from.
      const claudeOnly = uuidV4Like(4);
      writeClaudeTranscript(claudeOnly);
      expect(map.jsonlExistsPublic(claudeOnly, 'codex-cli')).toBe(false);
    });

    it('a gemini-cli session never enters the Codex archive', () => {
      writeRollout(home, CLAUDE_UUID, '2026/09/26');
      expect(map.jsonlExistsPublic(CLAUDE_UUID, 'gemini-cli')).toBe(false);
      expect(archiveReads()).toBe(0);
    });

    it('an unknown framework keeps the legacy order: Claude, then the bounded Codex lookup, then Gemini', () => {
      writeRollout(home, CLAUDE_UUID, '2026/09/26');
      expect(map.jsonlExistsPublic(CLAUDE_UUID)).toBe(true); // found as a Codex rollout
      expect(archiveReads()).toBeGreaterThan(0);
      expect(map.jsonlExistsPublic(uuidV4Like(5))).toBe(false);
      expect(map.jsonlExistsPublic('', 'claude-code')).toBe(false);
    });
  });

  describe('refreshResumeMappings (the 60s heartbeat)', () => {
    it('keeps an existing mapping when a claude-code session\'s transcript is missing — no deletion, no substitution, no Codex walk', () => {
      // A newer Claude transcript exists for ANOTHER session: it must not be substituted.
      writeClaudeTranscript(uuidV4Like(9));
      // The stale id also exists as a Codex rollout — a claude session must not find it there.
      writeRollout(home, CLAUDE_UUID, '2026/09/26');
      map.save(61449, CLAUDE_UUID, 'echo-instar-agent-management');
      const before = map.getEntryRaw(61449);
      expect(before?.uuid).toBe(CLAUDE_UUID);

      map.refreshResumeMappings(new Map([[61449, { sessionName: 'echo-instar-agent-management', claudeSessionId: CLAUDE_UUID, framework: 'claude-code' }]]));

      const after = map.getEntryRaw(61449);
      expect(after).toEqual(before); // kept byte-for-byte: same uuid, same savedAt
      expect(archiveReads()).toBe(0);
    });

    it('refreshes the mapping when a claude-code session\'s transcript exists', () => {
      writeClaudeTranscript(CLAUDE_UUID);
      map.refreshResumeMappings(new Map([[9210, { sessionName: 'echo-threadline-dev', claudeSessionId: CLAUDE_UUID, framework: 'claude-code' }]]));
      const entry = map.getEntryRaw(9210);
      expect(entry?.uuid).toBe(CLAUDE_UUID);
      expect(entry?.framework).toBe('claude-code');
      expect(entry?.provenance).toBe('hook');
      expect(archiveReads()).toBe(0);
    });

    it('a session with no framework tag still resolves (legacy order) — the bounded path, never a per-file walk', () => {
      const when = new Date(2026, 9, 10, 9, 0, 0);
      const codexId = uuidV7At(when, 6);
      writeRollout(home, codexId, localPartitionOf(when));
      map.refreshResumeMappings(new Map([[1, { sessionName: 'legacy', claudeSessionId: codexId }]]));
      expect(map.getEntryRaw(1)?.uuid).toBe(codexId);
      expect(rolloutLookupStats().statCalls).toBeLessThanOrEqual(3);
    });

    it('a session with no reported id writes nothing and keeps whatever was there', () => {
      map.save(7, CLAUDE_UUID, 'sess');
      const before = map.getEntryRaw(7);
      map.refreshResumeMappings(new Map([[7, { sessionName: 'sess', framework: 'claude-code' }]]));
      expect(map.getEntryRaw(7)).toEqual(before);
    });
  });

  describe('get() and findUuidForSession()', () => {
    it('get() verifies a claude-tagged entry against Claude transcripts only', () => {
      writeRollout(home, CLAUDE_UUID, '2026/09/26');
      map.save(61449, CLAUDE_UUID, 'sess');
      expect(map.get(61449)).toBeNull(); // the Codex rollout does not count for a Claude entry
      expect(archiveReads()).toBe(0);
      writeClaudeTranscript(CLAUDE_UUID);
      expect(map.get(61449)).toBe(CLAUDE_UUID);
    });

    it('an untagged legacy entry grandfathers as claude-code', () => {
      writeRollout(home, CLAUDE_UUID, '2026/09/26');
      fs.writeFileSync(path.join(stateDir, 'topic-resume-map.json'), JSON.stringify({
        '5': { uuid: CLAUDE_UUID, savedAt: new Date().toISOString(), sessionName: 'legacy' },
      }));
      expect(map.get(5)).toBeNull();
      expect(archiveReads()).toBe(0);
    });

    it('findUuidForSession honours the framework', () => {
      writeRollout(home, CLAUDE_UUID, '2026/09/26');
      expect(map.findUuidForSession('sess', CLAUDE_UUID, 'claude-code')).toBeNull();
      expect(archiveReads()).toBe(0);
      expect(map.findUuidForSession('sess', CLAUDE_UUID)).toBe(CLAUDE_UUID); // unknown → legacy order
      expect(map.findUuidForSession('sess', undefined, 'claude-code')).toBeNull();
    });
  });
});
