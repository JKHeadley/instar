// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * E2E — framework-scoped resume lookups, full lifecycle on the PRODUCTION path.
 *
 * Mirrors how commands/server.ts builds the pieces: the TopicResumeMap from
 * `config.stateDir` / `config.sessions.projectDir` / `config.sessions.tmuxPath`;
 * the ThreadResumeMap with a framework resolver over `state.listSessions()`;
 * the CodexResumeMap over the Codex home; and the 60-second heartbeat tick
 * (`runResumeHeartbeatTick`) fed from the session registry — then drives the
 * lifecycle the 2026-10-13 freeze exposed:
 *   1. two live claude-code sessions whose recorded ids have no transcript on
 *      this machine → every tick is an honest miss: mappings kept, nothing
 *      substituted (even though a newer Claude transcript exists), and the
 *      Codex archive is never read;
 *   2. a transcript appears → the next tick refreshes the mapping;
 *   3. a codex topic + a codex thread still resolve a PRESENT rollout through
 *      the partition hint; a claude thread with a missing transcript is null
 *      with zero Codex reads;
 *   4. "server restart": fresh map instances over the same state answer the
 *      same way.
 *
 * WHY THIS TEST EXISTS: the unit tests prove each map's logic; this proves the
 * framework actually travels from the session registry into every lookup the
 * way production wires it, so the fix cannot be dead on arrival.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { CodexResumeMap } from '../../src/core/CodexResumeMap.js';
import { ThreadResumeMap, type ThreadResumeEntry } from '../../src/threadline/ThreadResumeMap.js';
import { runResumeHeartbeatTick } from '../../src/core/ResumeHeartbeat.js';
import { resetRolloutLookupState, rolloutLookupStats } from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';
import { createTempProject, type TempProject } from '../helpers/setup.js';
import { buildLargeArchive, codexHomeOf, localPartitionOf, makeFakeHome, uuidV4Like, uuidV7At, writeRollout, writeTmuxStub } from '../helpers/codexArchiveFixture.js';

const ROOT = path.resolve(__dirname, '..', '..');
const STALE_A = 'ba7cbe23-6ce3-4eb1-a924-c6b2271bd0d4';
const STALE_B = '58846c28-2bb7-4605-a072-76732054d476';

function archiveReads(): number {
  const s = rolloutLookupStats();
  return s.hintedPartitionReads + s.syncDirectoryReads + s.asyncEnumerations + s.asyncDirectoryReads;
}

class NoTmuxThreadResumeMap extends ThreadResumeMap {
  protected sessionAlive(): boolean {
    return false;
  }
}

describe('resume lookups follow the session framework — production lifecycle', () => {
  let home: string;
  let priorHome: string | undefined;
  let project: TempProject;
  let tmuxPath: string;
  let topicMap: TopicResumeMap;
  let codexMap: CodexResumeMap;
  let threadMap: ThreadResumeMap;
  const codexWhen = new Date(2026, 9, 11, 10, 0, 0);
  const codexId = uuidV7At(codexWhen, 61449);

  const claudeProjectDir = (base: string): string => path.join(base, 'projects', project.dir.replace(/[\/\.]/g, '-'));
  const writeClaudeTranscript = (uuid: string, homeName = '.claude'): void => {
    const dir = claudeProjectDir(path.join(home, homeName));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), '{"type":"user"}\n');
  };

  const sessionRecord = (name: string, framework: Session['framework'], claudeSessionId?: string): Session => ({
    id: `id-${name}`, name, status: 'running', tmuxSession: name, startedAt: new Date().toISOString(), framework, claudeSessionId,
  });

  const buildMaps = (): void => {
    // Exactly as commands/server.ts constructs them.
    topicMap = new TopicResumeMap(project.stateDir, project.dir, tmuxPath);
    codexMap = new CodexResumeMap(project.stateDir, codexHomeOf(home));
    threadMap = new NoTmuxThreadResumeMap(project.stateDir, project.stateDir, undefined, undefined, {
      frameworkResolver: (sessionName) => project.state.listSessions().find((s) => s.tmuxSession === sessionName)?.framework,
    });
  };

  const tick = (): void => {
    runResumeHeartbeatTick({
      topicResumeMap: topicMap,
      listRunningSessions: () => project.state.listSessions({ status: 'running' }),
      telegramTopicSessions: () => [[61449, 'echo-instar-agent-management'], [9210, 'echo-threadline-dev'], [777, 'echo-codex-topic']],
    });
  };

  beforeAll(() => {
    home = makeFakeHome('resume-hb-e2e-');
    priorHome = process.env.HOME;
    process.env.HOME = home;
    buildLargeArchive(home, { partitions: 8, perPartition: 300, end: new Date(2026, 9, 12, 12, 0, 0) });
    writeRollout(home, codexId, localPartitionOf(codexWhen), '2026-10-11T10-00-00');
    resetRolloutLookupState();
    project = createTempProject();
    tmuxPath = writeTmuxStub(home);
    project.state.saveSession(sessionRecord('echo-instar-agent-management', 'claude-code', STALE_A));
    project.state.saveSession(sessionRecord('echo-threadline-dev', 'claude-code', STALE_B));
    project.state.saveSession(sessionRecord('echo-codex-topic', 'codex-cli', codexId));
    project.state.saveSession(sessionRecord('echo-thread-claude', 'claude-code'));
    project.state.saveSession(sessionRecord('echo-thread-codex', 'codex-cli'));
    buildMaps();
  });

  afterAll(() => {
    project.cleanup();
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    resetRolloutLookupState();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/e2e/resume-heartbeat-framework-lifecycle.test.ts:cleanup' });
  });

  it('production wiring: server.ts runs the extracted tick and gives the thread map a session-registry framework resolver', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'server.ts'), 'utf8');
    expect(src).toContain("import { runResumeHeartbeatTick } from '../core/ResumeHeartbeat.js';");
    expect(src).toContain('runResumeHeartbeatTick({');
    expect(src).toMatch(/frameworkResolver: \(sessionName\) => state\.listSessions\(\)\.find\(\(s\) => s\.tmuxSession === sessionName\)\?\.framework/);
    expect(src).toContain('new TopicResumeMap(config.stateDir, config.sessions.projectDir, config.sessions.tmuxPath)');
  });

  it('1. stale claude ids: ticks keep both mappings, substitute nothing, never read the Codex archive', () => {
    writeClaudeTranscript(uuidV4Like(4242)); // a newer transcript for some OTHER session
    writeRollout(home, STALE_A, '2026/09/26'); // the stale id also exists as a Codex rollout — irrelevant to a Claude session
    topicMap.save(61449, STALE_A, 'echo-instar-agent-management');
    topicMap.save(9210, STALE_B, 'echo-threadline-dev');
    const a = topicMap.getEntryRaw(61449);
    const b = topicMap.getEntryRaw(9210);
    resetRolloutLookupState();

    tick();
    tick();
    tick();

    expect(topicMap.getEntryRaw(61449)).toEqual(a);
    expect(topicMap.getEntryRaw(9210)).toEqual(b);
    // The codex topic DID get looked up (through its partition) — the claude ones did not touch the archive.
    const s = rolloutLookupStats();
    expect(s.syncDirectoryReads).toBe(0);
    expect(s.asyncEnumerations).toBe(0);
    expect(s.hintedPartitionReads).toBeGreaterThanOrEqual(1);
    expect(s.statCalls).toBeLessThanOrEqual(4);
    // The map answers honestly: no transcript → no resume id, no Codex consultation.
    resetRolloutLookupState();
    expect(topicMap.get(61449)).toBeNull();
    expect(topicMap.getForFramework(61449, 'claude-code')).toBeNull();
    expect(archiveReads()).toBe(0);
  });

  it('2. the transcript appears (pooled login home) → the next tick refreshes the mapping, still without the archive', () => {
    writeClaudeTranscript(STALE_B, '.claude-pool');
    resetRolloutLookupState();
    const before = topicMap.getEntryRaw(9210);
    tick();
    const after = topicMap.getEntryRaw(9210);
    expect(after?.uuid).toBe(STALE_B);
    expect(after?.framework).toBe('claude-code');
    expect(after?.provenance).toBe('hook');
    expect(after?.savedAt === before?.savedAt || Date.parse(after!.savedAt) >= Date.parse(before!.savedAt)).toBe(true);
    expect(topicMap.get(9210)).toBe(STALE_B);
    expect(topicMap.getEntryRaw(61449)?.uuid).toBe(STALE_A); // the other stale mapping is still kept
    expect(rolloutLookupStats().syncDirectoryReads + rolloutLookupStats().asyncEnumerations).toBe(0);
  });

  it('3. codex topic + codex thread resolve a present rollout via the partition hint; a claude thread with no transcript is null with zero Codex reads', () => {
    resetRolloutLookupState();
    codexMap.save(777, codexId, 'echo-codex-topic');
    expect(codexMap.get(777)).toBe(codexId);
    expect(rolloutLookupStats().hintedPartitionReads).toBeGreaterThanOrEqual(1);
    expect(rolloutLookupStats().syncDirectoryReads).toBe(0);

    const now = new Date().toISOString();
    const entry = (uuid: string, sessionName: string): ThreadResumeEntry => ({
      uuid, sessionName, createdAt: now, savedAt: now, lastAccessedAt: now, remoteAgent: 'dawn', subject: 'e2e', state: 'active', pinned: false, messageCount: 1,
    });
    threadMap.save('thread-codex', entry(codexId, 'echo-thread-codex'));
    expect(threadMap.get('thread-codex')?.uuid).toBe(codexId);

    resetRolloutLookupState();
    const missingClaude = uuidV4Like(9999);
    writeRollout(home, missingClaude, '2026/09/26');
    threadMap.save('thread-claude', entry(missingClaude, 'echo-thread-claude'));
    expect(threadMap.get('thread-claude')).toBeNull();
    expect(archiveReads()).toBe(0);
  });

  it('4. after a "restart" (fresh instances over the same state) the answers are unchanged', () => {
    buildMaps();
    resetRolloutLookupState();
    expect(topicMap.get(9210)).toBe(STALE_B);
    expect(topicMap.get(61449)).toBeNull();
    expect(archiveReads()).toBe(0);
    expect(codexMap.get(777)).toBe(codexId);
    expect(threadMap.get('thread-codex')?.uuid).toBe(codexId);
    expect(threadMap.get('thread-claude')).toBeNull();
    expect(rolloutLookupStats().statCalls).toBeLessThanOrEqual(6);
  });
});
