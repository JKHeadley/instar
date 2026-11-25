import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { decideManagedCodexStop } from '../../src/core/ManagedCodexStopDecision.js';
import type { ManagedStopEnrollment } from '../../src/core/ManagedCodexStopDecision.js';
import { verifyManagedCodexStop as verify } from '../../src/core/ManagedCodexStopVerifier.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'managed-stop-verifier-test' });
  }
});

const baseEnrollment: ManagedStopEnrollment = {
  sessionId: 'native', machineId: 'one-member', ownerEpoch: 3,
  state: 'active', remaining: 2, issuedCycles: [],
};

function makeFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-stop-rollout-')));
  dirs.push(dir);
  const home = path.join(dir, 'codex-home');
  fs.mkdirSync(home);
  const rolloutPath = path.join(home, 'rollout.jsonl');
  const worker = {
    topicId: 'project-topic', nativeSessionId: 'native', machineId: 'one-member',
    ownerEpoch: 3, codexHome: home, rolloutPath,
  };
  const request = {
    topicId: worker.topicId, sessionId: 'native', turnId: 'turn', lastAssistantMessage: 'first response',
  };
  const append = (item: object) => fs.appendFileSync(rolloutPath, JSON.stringify({
    type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn', item },
  }) + '\n');
  append({ type: 'AgentMessage', id: 'first', content: [{ type: 'Text', text: 'first response' }] });
  const enrollment = baseEnrollment;
  return { worker, request, append, enrollment };
}

describe('managed native Stop verification', () => {
  it('binds issuance to a real file boundary and accepts only the later matching receipt', () => {
    const { worker, request, append, enrollment } = makeFixture();
    const first = verify(request, worker, enrollment, 8192);
    expect(first?.boundary).toMatchObject({ turnId: 'turn' });
    if (!first) throw new Error('expected a verified first callback');
    const issued = decideManagedCodexStop(enrollment, {
      ...first, enabled: true, sessionId: 'native', paused: false, actionOpen: true,
    }).enrollment;
    append({ type: 'HookPrompt', id: 'receipt', fragments: [{ text: 'Continue ' + first.marker }] });
    append({ type: 'AgentMessage', id: 'second', content: [{ type: 'Text', text: 'second response' }] });

    const second = verify({ ...request, lastAssistantMessage: 'second response' }, worker, issued, 8192);
    expect(second?.receipt).toEqual({ cycle: first.cycle, marker: first.marker });
    expect(second?.cycle).not.toBe(first.cycle);
    expect(verify(request, worker, issued, 8192)).toBeUndefined();
  });

  it('rejects a replacement rollout after the first verified boundary', () => {
    const { worker, request, enrollment } = makeFixture();
    const rolloutFileKey = verify(request, worker, enrollment, 8192)?.boundary?.fileKey;
    expect(rolloutFileKey).toBeDefined();
    const replacement = worker.rolloutPath + '.replacement';
    fs.copyFileSync(worker.rolloutPath, replacement);
    fs.renameSync(replacement, worker.rolloutPath);

    const replacementKey = verify(request, worker, enrollment, 8192)?.boundary?.fileKey;
    expect(replacementKey).toBeDefined();
    expect(replacementKey).not.toBe(rolloutFileKey);
    expect(verify(request, worker, { ...enrollment, rolloutFileKey }, 8192)).toBeUndefined();
  });

  it('rejects wrong scope, a changed owner, escaped files, and over-budget reads', () => {
    const { worker, request, enrollment } = makeFixture();
    expect(verify({ ...request, topicId: 'other' }, worker, enrollment, 8192)).toBeUndefined();
    expect(verify(request, { ...worker, ownerEpoch: 4 }, enrollment, 8192)).toBeUndefined();
    expect(verify(request, { ...worker, nativeSessionId: 'replacement' }, enrollment, 8192)).toBeUndefined();
    expect(verify(request, worker, enrollment, 1)).toBeUndefined();
    const escaped = path.join(path.dirname(worker.codexHome), 'other.jsonl');
    fs.copyFileSync(worker.rolloutPath, escaped);
    const link = path.join(worker.codexHome, 'linked.jsonl');
    fs.symlinkSync(escaped, link);
    expect(verify(request, { ...worker, rolloutPath: link }, enrollment, 8192)).toBeUndefined();
  });
});
