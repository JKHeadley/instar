// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §9.3 steps 3/8 — e2e across a REAL process
 * crash: a child process (vite-node, production modules) begins a fold, takes
 * the engine checkpoint of a transcript with a secret-shaped and an oversize
 * entry, advances past the point of no return and dies. A server-style boot
 * (buildFoldCoordinator + recoverPendingFolds, default carriers) quarantines
 * the fold and KEEPS the checkpoint; the restore then materialises a new
 * session transcript that equals the pre-fold transcript except for sessionId.
 * (L7 on real Claude Code 2.1.322 — a resumed materialised session recalled a
 * codeword only the checkpoint held — is recorded in the side-effects artifact.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { readEngineCheckpoint, restoreEngineCheckpoint } from '../../src/monitoring/engineCheckpoint.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/engine-checkpoint-crash-lifecycle.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = '141133';
const SID = '11111111-2222-3333-4444-555555555555';

const CHILD = `
import { buildFoldCoordinator } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/foldCoordinatorBoot.ts'))};
import { takeEngineCheckpoint } from ${JSON.stringify(path.join(ROOT, 'src/monitoring/engineCheckpoint.ts'))};
const [stateDir, transcript] = process.argv.slice(-2);
const { coordinator } = buildFoldCoordinator({
  stateDir, runningTopicSessions: () => [{ topicKey: '${TOPIC}' }], poolPlacementLive: () => false,
  inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
});
const b = coordinator.begin('${TOPIC}');
if (!b.ok) process.exit(3);
let rec = b.record;
const cp = takeEngineCheckpoint(stateDir, { topicKey: '${TOPIC}', foldId: rec.foldId, sessionId: '${SID}', transcriptPath: transcript });
if (!cp.ok) { console.error(cp.reason); process.exit(5); }
for (const to of ['snapshotted', 'staged', 'replacing']) {
  const r = coordinator.transition(rec.topicKey, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
  if (!r.ok) process.exit(4);
  rec = r.record;
}
console.log(JSON.stringify({ foldId: rec.foldId }));
process.exit(0);
`;

describe('engine checkpoint across a real process crash', () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }); dir = null; });

  it('quarantined fold keeps its checkpoint; restore materialises the pre-fold transcript', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cp-e2e-'));
    const stateDir = dir;
    const engineDir = path.join(dir, 'projects');
    fs.mkdirSync(engineDir);
    const transcript = path.join(engineDir, `${SID}.jsonl`);
    const pre = [
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID, message: { content: 'token sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } }),
      JSON.stringify({ type: 'assistant', uuid: 'u2', sessionId: SID, message: { content: 'y'.repeat(1_100_000) } }),
      '',
    ].join('\n');
    fs.writeFileSync(transcript, pre);
    const script = path.join(dir, 'child.ts');
    fs.writeFileSync(script, CHILD);
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/vite-node'), [script, stateDir, transcript], { cwd: ROOT, encoding: 'utf-8', timeout: 90_000 });
    expect(r.status, r.stderr).toBe(0);
    const { foldId } = JSON.parse(r.stdout.trim().split('\n').pop() as string) as { foldId: string };

    // the fold replaced the context: the live transcript moved on
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'seed', sessionId: SID, message: { content: 'packet' } })}\n`);

    const { coordinator } = buildFoldCoordinator({
      stateDir, runningTopicSessions: () => [{ topicKey: TOPIC }], poolPlacementLive: () => false,
      inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
    });
    expect(coordinator.recoverPendingFolds().quarantined.map((x) => x.foldId)).toEqual([foldId]);
    const cp = readEngineCheckpoint(stateDir, TOPIC, foldId);
    expect(cp).not.toBeNull();

    const newId = crypto.randomUUID();
    const plan = restoreEngineCheckpoint(stateDir, cp!, { currentTranscriptPath: transcript, engineTranscriptDir: engineDir, newSessionId: () => newId });
    expect(plan.mode).toBe('materialised');
    if (plan.mode !== 'materialised') return;
    const made = fs.readFileSync(plan.transcriptPath, 'utf-8');
    expect(made).toBe(pre.split(SID).join(newId)); // the pre-fold transcript, byte for byte, with only the session id changed
  }, 120_000);
});
