// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — the shadow answerer (context-budget-layered-summaries §10 "Shadow
 * mode"; Phase 2 slice P2-3b). Fake spawn and transcript, real fold marker on
 * disk. Covers: the marker exists before the spawn under the id the spawn
 * carries; the spawn is credential-free with the narrow token, Bash only, the
 * live model and a bound; lookups count only when the transcript corroborates
 * them; timeout kills; the token is revoked on every path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShadowAnswerer, lookupsInTranscript, parseAnswers, buildAnswererPrompt, type AnswererDeps } from '../../src/monitoring/foldShadowAnswerer.js';
import { foldMarkerPath } from '../../src/monitoring/foldMarker.js';
import { finalAssistantText } from '../../src/scheduler/jobTranscriptEvidence.js';
import type { ProbeQuestion } from '../../src/monitoring/foldProbe.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/fold-shadow-answerer.test.ts';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

const PORT = 4042;
const T = '141133';
const q = (id: string, type: ProbeQuestion['type'] = 'detail'): ProbeQuestion => ({ id, type, source: 'span', sourceRef: null, spanIndex: 0, sample: 'named', question: `question ${id}?`, expected: 'x', referenceEntryIds: [] });
const QS = [q('f-q0'), q('f-q1', 'constraint')];
const curl = (suffix: string) => `curl -s -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" "http://localhost:${PORT}/topic/${T}/chunks${suffix}"`;
let nextId = 0;
/** A tool call followed by its result: `ok` is a chunk JSON body; otherwise a denial, a 404 body or an error. */
const call = (cmd: string, result: 'ok' | 'denied' | '404' | 'error' = 'ok'): string => {
  const id = `toolu_${nextId++}`;
  const use = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } });
  const content = result === 'ok' ? '{"record":{"key":"span-1"},"summary":{}}' : result === '404' ? '{"error":"no such chunk"}' : result === 'denied' ? 'fold-marker: command not allowed' : 'curl: (7) Failed to connect';
  const res = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(result === 'denied' || result === 'error' ? { is_error: true } : {}) }] } });
  return `${use}\n${res}`;
};
const reply = (o: unknown) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(o) }] } });

function harness(o: { transcript?: string[] | null; aliveTicks?: number; spawnThrows?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'answerer-')); dirs.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir);
  const file = path.join(root, 'transcript.jsonl');
  if (o.transcript !== null) fs.writeFileSync(file, (o.transcript ?? [call(curl('')), call(curl('/span-1')), call(curl('/span-9'), '404'), reply({ answers: [{ id: 'f-q0', answer: 'from span-1', usedChunks: ['span-1', 'span-9'] }, { id: 'f-q1', answer: 'kept', usedChunks: [] }] })]).join('\n'));
  const log: string[] = [];
  let spawned: Parameters<AnswererDeps['spawn']>[0] | null = null;
  let ticks = o.aliveTicks ?? 1;
  let clock = 0;
  const d: AnswererDeps = {
    stateDir, port: PORT,
    spawn: async (opts) => {
      // The marker must already exist, under the id this spawn carries.
      log.push(`marker-before-spawn=${fs.existsSync(foldMarkerPath(stateDir, opts.instarSessionId)!)}`);
      spawned = opts;
      if (o.spawnThrows) throw new Error('tmux refused');
      return { id: opts.instarSessionId, tmuxSession: opts.name };
    },
    isAlive: () => ticks-- > 0,
    kill: async (id) => { log.push(`kill ${id}`); },
    issueToken: (id, topic) => { log.push(`issue ${id} ${topic}`); return `mps_${'t'.repeat(43)}`; },
    revokeTokens: (id) => { log.push(`revoke ${id}`); },
    findTranscript: () => (o.transcript === null ? null : file),
    finalText: finalAssistantText,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { d, log, spawned: () => spawned };
}

const input = { topicKey: T, foldId: 'fold-abc123', packetText: '=== RESTORED CONTEXT ===', questions: QS, model: 'opus', boundMs: 60_000 };

describe('runShadowAnswerer', () => {
  it('writes the marker before the spawn, spawns credential-free with the narrow token, and corroborates lookups', async () => {
    const h = harness();
    const r = await runShadowAnswerer(h.d, input);
    expect(r.status).toBe('answered');
    if (r.status !== 'answered') return;
    expect(h.log[0]).toBe('issue fold-probe-fold-abc123 141133');
    expect(h.log).toContain('marker-before-spawn=true');
    expect(h.spawned()).toMatchObject({ omitAuthEnv: true, confinedTools: ['Bash'], requireToolConfinement: true, instarSessionId: 'fold-probe-fold-abc123', memorySessionToken: `mps_${'t'.repeat(43)}`, model: 'opus', framework: 'claude-code', maxDurationMinutes: 1 });
    expect(h.spawned()!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // span-1 was fetched (corroborated); span-9 was claimed and its fetch 404ed.
    expect(r.answers.find((a) => a.questionId === 'f-q0')!.lookups).toEqual(['GET chunk span-1']);
    expect(r.answers.find((a) => a.questionId === 'f-q1')!.lookups).toEqual([]);
    expect(r.lookupCalls).toBe(2);
    expect(r.unanswered).toEqual([]);
    expect(h.log[h.log.length - 1]).toBe('revoke fold-probe-fold-abc123');
  });

  it('kills the answerer at its bound and still revokes the token', async () => {
    const h = harness({ aliveTicks: 1_000 });
    const r = await runShadowAnswerer(h.d, input);
    expect(r.status).toBe('timeout');
    expect(h.log).toContain('kill fold-probe-fold-abc123');
    expect(h.log[h.log.length - 1]).toBe('revoke fold-probe-fold-abc123');
  });

  it('a spawn failure, a missing transcript or a non-JSON reply is named, and the token is revoked', async () => {
    for (const [o, status] of [[{ spawnThrows: true }, 'spawn-failed'], [{ transcript: null }, 'no-transcript'], [{ transcript: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I could not do it.' }] } })] }, 'unparseable']] as const) {
      const h = harness(o);
      const r = await runShadowAnswerer(h.d, input);
      expect(r.status).toBe(status);
      expect(h.log[h.log.length - 1]).toBe('revoke fold-probe-fold-abc123');
    }
  });

  it('refuses unsafe ids before anything is written', async () => {
    const h = harness();
    await expect(runShadowAnswerer(h.d, { ...input, foldId: '../x' })).rejects.toThrow(/unsafe/);
    await expect(runShadowAnswerer(h.d, { ...input, topicKey: 'slack:D2' })).rejects.toThrow(/unsafe/);
    expect(h.log).toEqual([]);
  });
});

describe('lookupsInTranscript', () => {
  it('counts only exact, successful chunk lookups on this agent, this topic', () => {
    const jsonl = [
      call(curl('')), call(curl('/span-1')), call(curl('?kind=chunk')),
      call(`curl -s "http://localhost:9999/topic/${T}/chunks/span-2"`), // another port
      call(`curl -s "http://localhost:${PORT}/topic/999/chunks/span-3"`), // another topic
      call(`curl -s "http://localhost:${PORT}/topic/${T}/chunks/span-4"; cat x`), // not the exact shape
      call(`curl -s "http://localhost:${PORT}/topic/${T}/chunks/a:b"`), // ':' the hook refuses
      'not json',
    ].join('\n');
    const r = lookupsInTranscript(jsonl, { port: PORT, topicKey: T });
    expect([...r.keys]).toEqual(['span-1']);
    expect(r).toMatchObject({ listCalls: 2, total: 3, failed: 0 });
  });

  it('a denied, 404, erroring or unanswered call never corroborates', () => {
    const lone = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_lone', name: 'Bash', input: { command: curl('/span-8') } }] } });
    const jsonl = [call(curl('/span-5'), 'denied'), call(curl('/span-6'), '404'), call(curl('/span-7'), 'error'), lone].join('\n');
    const r = lookupsInTranscript(jsonl, { port: PORT, topicKey: T });
    expect(r).toMatchObject({ total: 0, failed: 4 });
    expect(r.keys.size).toBe(0);
  });
});

describe('parseAnswers / buildAnswererPrompt', () => {
  it('ignores unknown and duplicate ids, lists the unanswered, and bounds an answer', () => {
    const r = parseAnswers(JSON.stringify({ answers: [{ id: 'f-q0', answer: 'a'.repeat(10_000) }, { id: 'f-q0', answer: 'dup' }, { id: 'ghost', answer: 'x' }] }), QS, { keys: new Set() })!;
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0].answer.length).toBeLessThanOrEqual(4_100);
    expect(r.unanswered).toEqual(['f-q1']);
    expect(parseAnswers('nope', QS, { keys: new Set() })).toBeNull();
  });

  it('the prompt carries the packet, the one allowed lookup shape and every question id', () => {
    const p = buildAnswererPrompt({ packetText: 'PACKET-BODY', questions: QS, port: PORT, topicKey: T });
    expect(p.startsWith('PACKET-BODY')).toBe(true);
    expect(p).toContain(curl(''));
    for (const x of QS) expect(p).toContain(`[${x.id}]`);
  });
});
