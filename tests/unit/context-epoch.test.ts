// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The context epoch (context-budget-layered-summaries §7.7, §9.1): "every
 * writer of the seeded marker derives it the same way". Driven through the
 * REAL writers — the rendered session-start hook's compact branch, the
 * rendered clear-seed hook, and the server's writer — and the real readers (the
 * marker reader + `markerEpoch`, and the canary's detection id).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { deriveContextEpoch, boundaryEpochFor, markerEpoch, BOUNDARY_SLACK_MS } from '../../src/monitoring/contextEpoch.js';
import { readSeedMarkerFile, writeSeedMarkerFile } from '../../src/monitoring/compactionSeedMarker.js';
import { writeClearSeedPointer, contextLayersRoot } from '../../src/monitoring/clearSeedPointer.js';
import { CompactionCanary } from '../../src/monitoring/compactionCanary.js';

const OP = 'tests/unit/context-epoch.test.ts';
const SID = 'abcd-1234';

describe('deriveContextEpoch', () => {
  it('compaction ⇒ the boundary id; fold or clear ⇒ the foldId; otherwise ⇒ the spawn id', () => {
    expect(deriveContextEpoch({ source: 'compact', boundaryUuid: 'b-1', foldId: 'f', spawnId: 's' })).toBe('b-1');
    expect(deriveContextEpoch({ source: 'compact' })).toBe(''); // not visible yet: bind later, never invent
    expect(deriveContextEpoch({ source: 'clear', foldId: 'fold-9', spawnId: 's' })).toBe('fold-9');
    expect(deriveContextEpoch({ source: 'fold', foldId: 'fold-9' })).toBe('fold-9');
    for (const source of ['startup', 'resume', 'fork', 'unknown']) expect(deriveContextEpoch({ source, spawnId: 'inst-1', boundaryUuid: 'b' })).toBe('inst-1');
  });

  it('binds a time to the newest boundary at or before it, with the hook slack on either side of the line', () => {
    const b = [{ uuid: 'b1', at: 10_000 }, { uuid: 'b2', at: 100_000 }];
    expect(boundaryEpochFor(500, b)).toBeNull();
    expect(boundaryEpochFor(100_000 - BOUNDARY_SLACK_MS, b)).toBe('b2'); // a hook marker 2 s before its boundary
    expect(boundaryEpochFor(100_000 - BOUNDARY_SLACK_MS - 1, b)).toBe('b1');
    expect(boundaryEpochFor(200_000, b)).toBe('b2'); // a server marker after its boundary
  });
});

describe('every writer of the seeded marker derives the same epoch', () => {
  let projectDir: string; let stateDir: string; let hooksDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-epoch-'));
    stateDir = path.join(projectDir, '.instar');
    hooksDir = path.join(stateDir, 'hooks', 'instar');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 1 }));
    const migrator = new PostUpdateMigrator({ stateDir, port: 1, sessions: { claudePath: 'claude' } } as never);
    const content = (n: string) => (migrator as unknown as { getHookContent(n: string): string }).getHookContent(n);
    fs.writeFileSync(path.join(hooksDir, 'session-start.sh'), content('session-start'), { mode: 0o755 });
    fs.writeFileSync(path.join(hooksDir, 'clear-seed.sh'), content('clear-seed'), { mode: 0o755 });
    fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), '#!/bin/bash\necho "=== IDENTITY RECOVERY (post-compaction) ==="\n', { mode: 0o755 });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP }));

  const run = (hook: string, input: unknown, env: Record<string, string> = {}) => spawnSync('bash', [path.join(hooksDir, hook)], {
    input: JSON.stringify(input), env: { PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir, ...env }, timeout: 20_000,
  });

  it('the compact hook (empty epoch), the server writer and the canary all name the same compaction', () => {
    const transcript = path.join(projectDir, `${SID}.jsonl`);
    const prev = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary-prev', timestamp: new Date(Date.now() - 3_600_000).toISOString(), compactMetadata: { trigger: 'auto' } };
    fs.writeFileSync(transcript, JSON.stringify(prev) + '\n');
    // 1. The real hook seeds (it can only see the PREVIOUS boundary) and writes its marker.
    const r = run('session-start.sh', { source: 'compact', session_id: SID, transcript_path: transcript });
    expect(r.status).toBe(0);
    const hookMarker = readSeedMarkerFile(stateDir, SID)!;
    expect(hookMarker).toMatchObject({ epoch: '', source: 'compact' });
    // 2. Claude Code then stamps THIS compaction's boundary about a second later.
    const cur = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary-now', timestamp: new Date(hookMarker.seededAt + 1_000).toISOString(), compactMetadata: { trigger: 'auto' } };
    fs.appendFileSync(transcript, JSON.stringify(cur) + '\n');
    // 3. The canary's detection id for that boundary.
    const canary = new CompactionCanary({ stateDir, machineId: 'm1' });
    canary.scan([{ topicKey: '1', claudeSessionId: SID, transcriptPath: transcript, engine: 'claude-code' }], true);
    const bounds = canary.boundariesOf(SID);
    const canaryEpoch = canary.report(true).recent.find((d) => d.boundaryUuid === 'boundary-now')!.boundaryUuid;
    const fromHook = markerEpoch(hookMarker, bounds);
    // 4. The server writer, which sees the boundary (fallback delivery or heal).
    expect(writeSeedMarkerFile(stateDir, SID, { boundaryUuid: 'boundary-now', source: 'server-fallback', seededAt: hookMarker.seededAt + 40_000 })).toBe(true);
    const serverMarker = readSeedMarkerFile(stateDir, SID)!;
    expect(serverMarker.source).toBe('server-fallback');
    const fromServer = markerEpoch(serverMarker, bounds);
    expect(fromHook).toBe('boundary-now');
    expect(fromServer).toBe(fromHook);
    expect(canaryEpoch).toBe(fromHook);
    expect(deriveContextEpoch({ source: 'compact', boundaryUuid: cur.uuid })).toBe(fromHook);
    // A server marker is bound by its explicit epoch only, never re-bound by time.
    expect(markerEpoch({ ...serverMarker, epoch: '' }, bounds)).toBeNull();
  });

  it('the clear-seed hook writes epoch = foldId, the same as the shared derivation', () => {
    const FOLD = 'fold-0001'; const IID = 'inst-77'; const NEW_SID = 'sess-after-clear';
    const dir = path.join(contextLayersRoot(stateDir), 'topic-1', 'folds', FOLD);
    fs.mkdirSync(dir, { recursive: true });
    const packet = path.join(dir, 'packet.md'); fs.writeFileSync(packet, 'PACKET\n');
    expect(writeClearSeedPointer(stateDir, { instarSessionId: IID, claudeSessionId: 'old', foldId: FOLD, packetFile: packet, leaseExpiresAt: Date.now() + 60_000 })).not.toBeNull();
    const r = run('clear-seed.sh', { source: 'clear', session_id: NEW_SID }, { INSTAR_SESSION_ID: IID });
    expect(r.status).toBe(0);
    const raw = JSON.parse(fs.readFileSync(path.join(contextLayersRoot(stateDir), '_seeded', `${NEW_SID}.json`), 'utf-8'));
    expect(raw.epoch).toBe(deriveContextEpoch({ source: 'clear', foldId: FOLD }));
    expect(markerEpoch({ epoch: raw.epoch, seededAt: raw.seededAt, source: raw.source }, [])).toBe(FOLD);
    // A clear marker never stands a compaction's path down.
    expect(readSeedMarkerFile(stateDir, NEW_SID)).toBeNull();
  });

  it('the server writer refuses an empty epoch or an unsafe id (no marker without a real boundary)', () => {
    expect(writeSeedMarkerFile(stateDir, SID, { boundaryUuid: '', source: 'heal' })).toBe(false);
    expect(writeSeedMarkerFile(stateDir, '../x', { boundaryUuid: 'b', source: 'heal' })).toBe(false);
    expect(readSeedMarkerFile(stateDir, SID)).toBeNull();
    expect(writeSeedMarkerFile(stateDir, SID, { boundaryUuid: crypto.randomUUID(), source: 'heal' })).toBe(true);
    const f = path.join(stateDir, 'state', 'context-layers', '_seeded', `${SID}.json`);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});
