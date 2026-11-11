// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The Codex next-prompt seed and the Codex adapter verification suite
 * (context-budget-layered-summaries §9.6 Codex column, §9.1, §7.7; Phase 1 S17).
 *
 * Both sides of every boundary: Codex vs Claude Code; the first prompt after a
 * compaction vs later prompts; an epoch already seeded vs a new one; a packet
 * verified vs failed; the suite on a throwaway target vs refused on a channel
 * topic. Rollout lines are shaped like Codex CLI 0.167.1's (measured by this
 * slice's live suite run, structure only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  CodexSeedService, CodexCompactionReader, validateCodexRolloutPath, readCodexSeedMarker, writeCodexSeedMarker, codexEpochSeeded,
  renderCodexSeed, CODEX_SEED_HEADER, FAILURE_BACKOFF_MS, SEEDED_EPOCHS_MAX,
} from '../../src/monitoring/contextLayers/codexSeed.js';
import { CompactionCanary, CODEX_SEED_GRACE_MS, CANARY_HEALTHY_MIN, type CanarySession, type CanaryEngineHooks } from '../../src/monitoring/compactionCanary.js';
import { evaluateCodexSuite, throwawayTargetProblem, runCodexAdapterSuite, removeThrowawayProjectTrust, DELTA_PROBE_CHARS, type CodexSuiteEvidence } from '../../src/monitoring/codexAdapterSuite.js';
import { ADAPTER_CAPABILITIES } from '../../src/monitoring/adapterVerificationSuite.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/codex-seed.test.ts';
const SID = '01a1c8e9-8b19-7d00-92cb-92bda3000001';
const iso = (ms: number) => new Date(ms).toISOString();
const meta = (at: number) => ({ timestamp: iso(at), type: 'session_meta', payload: { id: SID, cli_version: '0.167.1' } });
const usage = (at: number, used = 100_000) => ({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: used, cached_input_tokens: 9_000 }, model_context_window: 258_400 } } });
const compacted = (at: number, w: string) => ({ timestamp: iso(at), type: 'compacted', payload: { message: '', window_id: w, replacement_history: [] } });
/** How Codex records the hook's output: a developer message (model input). The time block comes first. */
const devMsg = (at: number, text: string) => ({ timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `--- CURRENT TIME ---\nnow\n--- END CURRENT TIME ---\n\n${text}` }] } });
const prompt = (at: number, text = '[telegram:200] hi') => ({ timestamp: iso(at), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

let dir: string; let sessions: string; let rollout: string; let now: number;
const append = (...o: object[]) => fs.appendFileSync(rollout, o.map((x) => `${JSON.stringify(x)}\n`).join(''));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-seed-'));
  sessions = path.join(dir, 'codex-home', 'sessions', '2026', '11', '10');
  fs.mkdirSync(sessions, { recursive: true });
  rollout = path.join(sessions, `rollout-2026-11-10T20-41-51-${SID}.jsonl`);
  now = Date.parse('2026-11-10T21:00:00Z');
  fs.writeFileSync(rollout, `${JSON.stringify(meta(now - 60_000))}\n`);
});
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));

const PACKET = '=== STANDING PACKET (topic 200) ===\nthe anchor\n=== END STANDING PACKET ===';
const sha = crypto.createHash('sha256').update(PACKET).digest('hex');
function svc(o: { ok?: boolean; calls?: { n: number } } = {}) {
  const calls = o.calls ?? { n: 0 };
  return new CodexSeedService({
    stateDir: dir, now: () => now,
    stageNow: () => { calls.n++; return o.ok === false ? { ok: false, reason: 'verify-failed' } : { ok: true, delivered: PACKET, sha256: sha }; },
  });
}
const req = (over: Record<string, unknown> = {}) => ({ topicId: 200, sessionId: SID, transcriptPath: rollout, framework: 'codex-cli', ...over });

describe('the Codex next-prompt seed (CodexSeedService)', () => {
  it('Codex vs Claude Code: only a codex-cli prompt is ever offered a seed', () => {
    append(usage(now), compacted(now + 1, 'w1'));
    expect(svc().offer(req({ framework: 'claude-code' }))).toEqual({ deliver: false, reason: 'not-codex' });
    expect(svc().offer(req())).toMatchObject({ deliver: true, epoch: 'w1' });
  });

  it('no compaction ⇒ no seed; the first prompt after one ⇒ the verified packet in its disclosure marker', () => {
    const s = svc();
    append(usage(now));
    expect(s.offer(req())).toEqual({ deliver: false, reason: 'no-compaction' });
    append(compacted(now + 1, 'w1'));
    const o = s.offer(req());
    expect(o.deliver).toBe(true);
    if (!o.deliver) return;
    expect(o.carrier).toBe(`packet:${sha.slice(0, 8)}`);
    expect(o.text.startsWith(CODEX_SEED_HEADER)).toBe(true);
    expect(o.text).toContain('next-prompt delivery');
    // The delimited body is byte-exact and its nonce is the body's sha256 (S10's carrier rule).
    const m = /--- STANDING PACKET ([0-9a-f]{8}) ---\n([\s\S]*)\n--- END STANDING PACKET \1 ---$/.exec(o.text)!;
    expect(m[2]).toBe(PACKET);
    expect(crypto.createHash('sha256').update(m[2]).digest('hex').slice(0, 8)).toBe(m[1]);
  });

  it('first prompt vs later prompts: once the seed is in the rollout as model input, the same epoch is never seeded again', () => {
    const s = svc();
    append(usage(now), compacted(now + 1, 'w1'), prompt(now + 2, '[telegram:200] first'));
    const o = s.offer(req({ promptSha256: crypto.createHash('sha256').update('[telegram:200] first').digest('hex') }));
    expect(o.deliver).toBe(true);
    if (!o.deliver) return;
    expect(s.ack({ sessionId: SID, epoch: 'w1', carrier: o.carrier, transcriptPath: rollout })).toMatchObject({ ok: true });
    expect(s.ack({ sessionId: SID, epoch: 'w1', carrier: o.carrier, transcriptPath: rollout })).toMatchObject({ ok: true }); // a repeated ack is harmless
    expect(readCodexSeedMarker(dir, SID)!.epochs).toHaveLength(1);
    append(devMsg(now + 3, o.text), prompt(now + 4, '[telegram:200] second'));
    expect(s.offer(req())).toEqual({ deliver: false, reason: 'already-seeded' });
  });

  it('a delivery the model never got (no seed in the rollout) is retried once on the next topic prompt — an acknowledgement alone never stops it', () => {
    const s = svc();
    append(usage(now), compacted(now + 1, 'w1'), prompt(now + 2, '[telegram:200] first'));
    const o = s.offer(req());
    expect(o.deliver).toBe(true);
    if (!o.deliver) return;
    s.ack({ sessionId: SID, epoch: 'w1', carrier: o.carrier, transcriptPath: rollout }); // acked, but Codex dropped the output
    append(prompt(now + 3, '[telegram:200] second'));
    expect(s.offer(req({ promptSha256: crypto.createHash('sha256').update('[telegram:200] second').digest('hex') })).deliver).toBe(true);
  });

  it('only the first topic prompt after a compaction (one retry): a compaction many prompts old is never seeded', () => {
    const s = svc();
    append(usage(now), compacted(now + 1, 'w1'), prompt(now + 2, '[telegram:200] a'), prompt(now + 3, '[telegram:200] b'));
    expect(s.offer(req())).toEqual({ deliver: false, reason: 'not-first-prompt' });
    // A prompt that names no topic is not one the hook seeds, so it does not count.
    append(compacted(now + 4, 'w2'), prompt(now + 5, 'plain prompt'), prompt(now + 6, 'another plain'));
    expect(s.offer(req())).toMatchObject({ deliver: true, epoch: 'w2' });
  });

  it('only the topic\'s own live Codex session is offered its packet', () => {
    append(usage(now), compacted(now + 1, 'w1'));
    const bound = new CodexSeedService({ stateDir: dir, now: () => now, sessionBound: (t, id) => t === 200 && id === SID, stageNow: () => ({ ok: true, delivered: PACKET, sha256: sha }) });
    expect(bound.offer(req()).deliver).toBe(true);
    expect(bound.offer(req({ topicId: 201 }))).toEqual({ deliver: false, reason: 'not-this-topic-session' });
  });

  it('epoch seen vs new: a later compaction is a new epoch and is seeded again; the earlier epoch stays recorded', () => {
    const s = svc();
    append(usage(now), compacted(now + 1, 'w1'));
    const o = s.offer(req()); if (!o.deliver) throw new Error('expected a seed');
    s.ack({ sessionId: SID, epoch: 'w1', carrier: `packet:${sha.slice(0, 8)}`, transcriptPath: rollout });
    append(devMsg(now + 2, o.text), usage(now + 2), compacted(now + 3, 'w2'));
    expect(s.offer(req())).toMatchObject({ deliver: true, epoch: 'w2' });
    s.ack({ sessionId: SID, epoch: 'w2', carrier: `packet:${sha.slice(0, 8)}`, transcriptPath: rollout });
    expect(codexEpochSeeded(dir, SID, 'w1')).not.toBeNull();
    expect(codexEpochSeeded(dir, SID, 'w2')).not.toBeNull();
  });

  it('a forked rollout\'s inherited compaction (before its first usage reading) is not a compaction of this session', () => {
    append(compacted(now + 1, 'parent-w'));
    expect(svc().offer(req())).toEqual({ deliver: false, reason: 'no-compaction' });
  });

  it('packet verified vs failed: an unverified packet is never delivered, no marker is written, and the topic backs off', () => {
    const calls = { n: 0 };
    const s = svc({ ok: false, calls });
    append(usage(now), compacted(now + 1, 'w1'));
    expect(s.offer(req())).toEqual({ deliver: false, reason: 'packet-unverified' });
    expect(readCodexSeedMarker(dir, SID)).toBeNull();
    expect(s.offer(req())).toEqual({ deliver: false, reason: 'packet-backoff' });
    expect(calls.n).toBe(1);
    now += FAILURE_BACKOFF_MS + 1;
    expect(s.offer(req())).toEqual({ deliver: false, reason: 'packet-unverified' });
    expect(calls.n).toBe(2);
  });

  it('an acknowledgement for an epoch the rollout does not hold as its newest is refused', () => {
    const s = svc();
    append(usage(now), compacted(now + 1, 'w1'));
    expect(s.ack({ sessionId: SID, epoch: 'forged', carrier: 'packet:00000000', transcriptPath: rollout })).toEqual({ ok: false, reason: 'not-the-current-epoch' });
    expect(s.ack({ sessionId: SID, epoch: 'w1', carrier: 'legacy', transcriptPath: rollout })).toEqual({ ok: false, reason: 'bad-request' });
    expect(readCodexSeedMarker(dir, SID)).toBeNull();
  });

  it('only a path shaped like this session\'s rollout is read', () => {
    expect(validateCodexRolloutPath(rollout, SID)).toBe(rollout);
    expect(validateCodexRolloutPath(rollout, 'other-session')).toBeNull();
    expect(validateCodexRolloutPath('relative/rollout-x-' + SID + '.jsonl', SID)).toBeNull();
    const outside = path.join(dir, `rollout-x-${SID}.jsonl`); fs.writeFileSync(outside, '');
    expect(validateCodexRolloutPath(outside, SID)).toBeNull(); // not under a sessions directory
    const link = path.join(sessions, `rollout-link-${SID}.jsonl`); fs.symlinkSync(rollout, link);
    expect(validateCodexRolloutPath(link, SID)).toBeNull();
    expect(svc().offer(req({ transcriptPath: '/etc/passwd' }))).toEqual({ deliver: false, reason: 'no-rollout' });
    expect(svc().offer(req({ topicId: 'x' }))).toEqual({ deliver: false, reason: 'bad-request' });
  });

  it('the reader is incremental and handles a truncated rollout', () => {
    const r = new CodexCompactionReader();
    append(usage(now), compacted(now + 1, 'w1'));
    expect(r.latest(rollout)?.windowId).toBe('w1');
    append(compacted(now + 2, 'w2'));
    expect(r.latest(rollout)?.windowId).toBe('w2');
    fs.writeFileSync(rollout, `${JSON.stringify(meta(now))}\n`);
    expect(r.latest(rollout)).toBeNull();
  });

  it('the marker keeps a bounded epoch history and never changes an epoch\'s first stamp', () => {
    for (let i = 0; i < SEEDED_EPOCHS_MAX + 5; i++) writeCodexSeedMarker(dir, SID, `w${i}`, 'packet:aaaaaaaa', i);
    const m = readCodexSeedMarker(dir, SID)!;
    expect(m.epochs).toHaveLength(SEEDED_EPOCHS_MAX);
    expect(m).toMatchObject({ engine: 'codex-cli', delivery: 'next-prompt', source: 'compact', epoch: `w${SEEDED_EPOCHS_MAX + 4}` });
    const again = writeCodexSeedMarker(dir, SID, `w${SEEDED_EPOCHS_MAX + 4}`, 'packet:bbbbbbbb', 9_999);
    expect(again.seededAt).toBe(SEEDED_EPOCHS_MAX + 4);
    expect(again.carrier).toBe('packet:aaaaaaaa');
    expect(renderCodexSeed('x', 'f'.repeat(64), 'w').split('\n')[0]).toBe(CODEX_SEED_HEADER);
  });
});

describe('the canary\'s Codex group verifies recovery from the next-prompt seed (S17)', () => {
  const hooks: CanaryEngineHooks = { onUsage: () => false, onCompaction: () => {}, onRearm: () => {} };
  const session = (): CanarySession => ({ topicKey: '200', claudeSessionId: SID, transcriptPath: rollout, engine: 'codex-cli' });
  const canary = () => new CompactionCanary({ stateDir: dir, machineId: 'm1', now: () => now, engineHooks: hooks });
  const group = (c: CompactionCanary) => c.report(true).groups.find((g) => g.engine === 'codex-cli')!;

  it('no prompt yet ⇒ pending however long; a prompt with no seed past the grace ⇒ diverged', () => {
    const c = canary();
    append(usage(now), compacted(now + 1_000, 'w1'));
    c.scan([session()], true);
    now += 3 * 60 * 60_000;
    expect(group(c)).toMatchObject({ pending: 1, state: 'uninitialized' });
    append(prompt(now));
    c.scan([session()], true);
    expect(group(c)).toMatchObject({ pending: 1 }); // inside the seed grace
    now += CODEX_SEED_GRACE_MS + 1;
    c.scan([session()], true);
    expect(group(c)).toMatchObject({ pending: 0, complete: 0, state: 'diverged' });
  });

  it('the seed in the rollout as model input ⇒ complete (no PostCompact record needed); never healthy without a positive control, however many', () => {
    const c = canary();
    append(usage(now));
    for (let i = 0; i < CANARY_HEALTHY_MIN + 1; i++) {
      append(compacted(now + 10 + i * 10, `w${i}`), prompt(now + 11 + i * 10), devMsg(now + 12 + i * 10, renderCodexSeed('P', 'abcdef01'.padEnd(64, '0'), `w${i}`)));
    }
    c.scan([session()], true);
    const g = group(c);
    expect(g).toMatchObject({ detected: CANARY_HEALTHY_MIN + 1, complete: CANARY_HEALTHY_MIN + 1, pending: 0, state: 'accruing', marking: 'synthesized' });
    expect(c.report(true).recent.find((d) => d.boundaryUuid === 'w0')).toMatchObject({ recoveryBlock: true, seededCarrier: 'packet:abcdef01', postCompact: false });
  });

  it('the marker alone is not recovery: an acknowledged epoch with no seed in the rollout settles diverged', () => {
    const c = canary();
    append(usage(now), compacted(now + 1_000, 'w1'), prompt(now + 1_001));
    writeCodexSeedMarker(dir, SID, 'w1', 'packet:abcdef01', now + 1_002);
    c.scan([session()], true);
    now += CODEX_SEED_GRACE_MS + 60_000;
    expect(group(c)).toMatchObject({ complete: 0, state: 'diverged' });
  });

  it('a compaction superseded by another before any topic prompt is judged neither way; a non-topic prompt does not settle', () => {
    const c = canary();
    append(usage(now), compacted(now + 1_000, 'w1'), prompt(now + 1_001, 'plain, no topic'), compacted(now + 2_000, 'w2'), prompt(now + 2_001), devMsg(now + 2_002, renderCodexSeed('P', 'f'.repeat(64), 'w2')));
    c.scan([session()], true);
    now += CODEX_SEED_GRACE_MS + 60_000;
    expect(group(c)).toMatchObject({ detected: 2, complete: 1, pending: 0, state: 'accruing' });
    expect(c.report(true).recent.find((d) => d.boundaryUuid === 'w1')).toMatchObject({ superseded: true });
  });

  it('a Codex environment-context block after the compaction is not the prompt that settles it', () => {
    const c = canary();
    append(usage(now), compacted(now + 1_000, 'w1'), prompt(now + 1_001, '<environment_context>x</environment_context>'));
    c.scan([session()], true);
    now += CODEX_SEED_GRACE_MS + 60_000;
    expect(group(c)).toMatchObject({ pending: 1 });
  });

  it('Claude Code is untouched: a boundary still needs BOTH the PostCompact record and the recovery block', () => {
    const cc = path.join(dir, 'cc.jsonl');
    fs.writeFileSync(cc, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: iso(now), version: '2.1.321', compactMetadata: { trigger: 'auto' } })}\n`);
    writeCodexSeedMarker(dir, 'cc-sid', 'b1', 'packet:abcdef01', now); // a marker never stands in for Claude's artifacts
    const c = canary();
    c.scan([{ topicKey: '1', claudeSessionId: 'cc-sid', transcriptPath: cc, engine: 'claude-code' }], true);
    now += 11 * 60_000;
    expect(c.report(true).groups.find((g) => g.engine === 'claude-code')).toMatchObject({ detected: 1, complete: 0, state: 'diverged' });
  });
});

describe('the per-prompt hook carries the seed (telegram-topic-context.sh)', () => {
  const hook = (new PostUpdateMigrator({ projectDir: '/tmp', stateDir: '/tmp/.instar', port: 4042, hasTelegram: false, projectName: 'test' }) as unknown as { getTelegramTopicContextHook(): string }).getTelegramTopicContextHook();
  let server: http.Server; let port: number; let hits: string[]; let acks: unknown[]; let offer: Record<string, unknown>;
  beforeEach(async () => {
    hits = []; acks = []; offer = { deliver: true, epoch: 'w1', carrier: 'packet:abcdef01', text: `${CODEX_SEED_HEADER}\nPACKET-BODY` };
    server = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', (c) => { body += c; });
      rq.on('end', () => {
        hits.push(`${rq.method} ${rq.url}`);
        if (rq.url === '/health') { rs.end('ok'); return; }
        if (rq.url === '/context-budget/codex-seed') { rs.setHeader('content-type', 'application/json'); rs.end(JSON.stringify(offer)); return; }
        if (rq.url === '/context-budget/codex-seed/ack') { acks.push(JSON.parse(body)); rs.end('{"ok":true}'); return; }
        if (rq.url?.startsWith('/telegram/topics/')) { rs.end(JSON.stringify({ messages: [{ timestamp: iso(now), fromUser: true, text: 'HISTORY-LINE' }] })); return; }
        if (rq.url?.startsWith('/topic-intent/')) { rs.end('BRIEFING-LINE'); return; }
        rs.statusCode = 404; rs.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    fs.mkdirSync(path.join(dir, 'proj', '.instar'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'proj', '.instar', 'config.json'), JSON.stringify({ port, projectName: 'p' }));
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));
  const runHook = (framework: string) => new Promise<string>((resolve) => {
    const f = path.join(dir, 'ttc.sh'); fs.writeFileSync(f, hook, { mode: 0o755 });
    const c = spawn('bash', [f], { env: { ...process.env, CLAUDE_PROJECT_DIR: path.join(dir, 'proj'), INSTAR_AUTH_TOKEN: 'tok', INSTAR_FRAMEWORK: framework, INSTAR_AGENT_ID: 'p' } });
    let out = ''; c.stdout.on('data', (b) => { out += b; });
    c.on('close', () => resolve(out));
    c.stdin.end(JSON.stringify({ prompt: '[telegram:200] hello', session_id: SID, transcript_path: rollout }));
  });

  it('Codex, first prompt after a compaction: the packet IN PLACE of the briefing and history, then the acknowledgement', async () => {
    const out = await runHook('codex-cli');
    expect(out).toContain('--- CURRENT TIME ---');
    expect(out).toContain('PACKET-BODY');
    expect(out).not.toContain('HISTORY-LINE');
    expect(out).not.toContain('BRIEFING-LINE');
    expect(acks).toEqual([{ sessionId: SID, transcriptPath: rollout, epoch: 'w1', carrier: 'packet:abcdef01' }]);
  });

  it('Codex, a later prompt (no seed offered): today\'s briefing and history exactly, no acknowledgement', async () => {
    offer = { deliver: false, reason: 'already-seeded' };
    const out = await runHook('codex-cli');
    expect(out).toContain('HISTORY-LINE');
    expect(out).toContain('BRIEFING-LINE');
    expect(out).not.toContain(CODEX_SEED_HEADER);
    expect(acks).toEqual([]);
  });

  it('Claude Code: the seed route is never asked', async () => {
    const out = await runHook('claude-code');
    expect(hits.some((h) => h.includes('codex-seed'))).toBe(false);
    expect(out).toContain('HISTORY-LINE');
  });

  it('the server down or the layers off (503): today\'s output', async () => {
    offer = { error: 'context-budget standing packet not enabled on this agent' };
    const out = await runHook('codex-cli');
    expect(out).toContain('HISTORY-LINE');
    expect(acks).toEqual([]);
  });
});

describe('the Codex adapter verification suite', () => {
  const tokens = { alpha: 'ALPHA-1', steer: 'STEER-1', seed: 'SEED-1', delta: 'DELTA-1', deny: 'DENY-1' };
  const full: CodexSuiteEvidence = {
    tokens, errors: [], version: '0.167.1', rolloutHasEntries: true, cacheCountersSeen: true, frameworkSeenByHook: 'codex-cli',
    deltaHookRan: true, deltaDeliveredWhole: true, denyHookRan: true, denyReasonInRollout: true, denyToolRan: false,
    controlCompacted: false, forcedCompacted: true, compactWindowId: 'w', preCompactPayload: { trigger: 'auto' }, postCompactPayload: { trigger: 'auto' },
    sessionStartCompactPayload: { source: 'compact' }, seedDeliveredAfterCompaction: true, deltaDeliveredAfterCompaction: true, steerTokenInRollout: false,
    restoreMode: 'materialised', restoreReply: 'ALPHA-1',
  };

  it('records every row of the §9.6 table', () => {
    expect(Object.keys(evaluateCodexSuite(full)).sort()).toEqual([...ADAPTER_CAPABILITIES].sort());
  });

  it('both sides of each measured row', () => {
    const r = evaluateCodexSuite(full);
    expect(r.seedAfterCompaction.state).toBe('supported');
    expect(evaluateCodexSuite({ ...full, sessionStartCompactPayload: undefined, seedDeliveredAfterCompaction: false }).seedAfterCompaction.state).toBe('synthesized');
    expect(evaluateCodexSuite({ ...full, sessionStartCompactPayload: undefined, seedDeliveredAfterCompaction: false, deltaDeliveredAfterCompaction: false }).seedAfterCompaction.state).toBe('absent');
    expect(r.preCompactionSteering.state).toBe('partial');
    expect(evaluateCodexSuite({ ...full, steerTokenInRollout: true }).preCompactionSteering.state).toBe('supported');
    expect(r.postCompactSummary.state).toBe('partial');
    expect(evaluateCodexSuite({ ...full, postCompactPayload: { compact_summary: 'S' } }).postCompactSummary.state).toBe('supported');
    expect(r.controlCompact.state).toBe('absent');
    expect(evaluateCodexSuite({ ...full, controlCompacted: true }).controlCompact.state).toBe('supported');
    expect(r.compactionWindowSetting.state).toBe('supported');
    expect(evaluateCodexSuite({ ...full, forcedCompacted: false }).compactionWindowSetting.state).toBe('absent');
    expect(r.perPromptDelta.state).toBe('supported');
    expect(evaluateCodexSuite({ ...full, deltaDeliveredWhole: false }).perPromptDelta.state).toBe('partial');
    expect(r.toolPolicy.state).toBe('supported');
    expect(evaluateCodexSuite({ ...full, denyToolRan: true }).toolPolicy.state).toBe('absent');
    expect(r.materialiseResume.state).toBe('supported');
    expect(evaluateCodexSuite({ ...full, restoreReply: 'no idea' }).materialiseResume.state).toBe('partial');
    expect(r.costModel.state).toBe('partial');
    expect(evaluateCodexSuite({ ...full, compactWindowIdPresent: false }).compactionDetection.state).toBe('partial');
    expect(r.seedAfterCompaction.evidence).toContain('did not echo');
    expect(evaluateCodexSuite({ ...full, afterCompactReply: 'SEED-1 DELTA-1' }).seedAfterCompaction.evidence).toContain('echoed it');
    expect(r.controlClear.evidence).toMatch(/^unmeasured/);
    expect(DELTA_PROBE_CHARS).toBeGreaterThan(6_000); // a standing-packet-sized delivery
  });

  it('throwaway vs channel topic: refused under a topic binding, inside an agent project, or with user-level hooks', () => {
    const home = path.join(dir, 'codex-home');
    const work = path.join(dir, 'work'); fs.mkdirSync(work);
    const clean = { ...process.env }; for (const k of ['INSTAR_TELEGRAM_TOPIC', 'INSTAR_SLACK_CHANNEL', 'INSTAR_TOPIC_ID', 'INSTAR_SESSION_ID', 'INSTAR_TMUX_SESSION']) delete clean[k];
    expect(throwawayTargetProblem({ workDir: work, env: clean, codexHome: home })).toBeNull();
    expect(throwawayTargetProblem({ workDir: work, env: { ...clean, INSTAR_TELEGRAM_TOPIC: '141133' }, codexHome: home })).toMatch(/channel topic/);
    fs.mkdirSync(path.join(dir, '.instar')); fs.writeFileSync(path.join(dir, '.instar', 'config.json'), '{}');
    expect(throwawayTargetProblem({ workDir: work, env: clean, codexHome: home })).toMatch(/agent project/);
    SafeFsExecutor.safeRmSync(path.join(dir, '.instar'), { recursive: true, force: true, operation: OP });
    // The [hooks.state] trust table is not a hook; an inline hook table is.
    fs.writeFileSync(path.join(home, 'config.toml'), '[hooks.state]\n[hooks.state."/p/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:x"\n');
    expect(throwawayTargetProblem({ workDir: work, env: clean, codexHome: home })).toBeNull();
    fs.writeFileSync(path.join(home, 'config.toml'), '[[hooks.UserPromptSubmit]]\nmatcher = ""\n');
    expect(throwawayTargetProblem({ workDir: work, env: clean, codexHome: home })).toMatch(/config\.toml defines user-level hooks/);
    fs.writeFileSync(path.join(home, 'config.toml'), '');
    fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
    expect(throwawayTargetProblem({ workDir: work, env: clean, codexHome: home })).toMatch(/user-level hooks/);
  });

  it('a refused run never calls the engine and is inconclusive (never recorded)', () => {
    let calls = 0;
    const { result } = runCodexAdapterSuite({ workDir: path.join(dir, 'w2'), machine: 'm', codexHome: path.join(dir, 'codex-home'), env: { INSTAR_TELEGRAM_TOPIC: '1' }, run: () => { calls++; return { status: 0, stdout: '', stderr: '' }; } });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ engine: 'codex-cli', inconclusive: true });
    expect(result.errors[0]).toMatch(/^refused: /);
  });

  it('an unreadable engine version is inconclusive', () => {
    const env = { ...process.env }; for (const k of ['INSTAR_TELEGRAM_TOPIC', 'INSTAR_SLACK_CHANNEL', 'INSTAR_TOPIC_ID', 'INSTAR_SESSION_ID', 'INSTAR_TMUX_SESSION']) delete env[k];
    const { result } = runCodexAdapterSuite({ workDir: path.join(dir, 'w3'), machine: 'm', codexHome: path.join(dir, 'codex-home'), env, run: () => ({ status: 127, stdout: '', stderr: 'not found' }) });
    expect(result).toMatchObject({ inconclusive: true, version: 'unknown' });
  });

  it('removes only the throwaway directory\'s trust table from config.toml', () => {
    const home = path.join(dir, 'codex-home');
    const body = ['model = "x"', '', '[projects."/keep"]', 'trust_level = "trusted"', '', '[projects."/tmp/instar-adapter-suite-AB/project"]', 'trust_level = "trusted"', '', '[hooks.state]', ''].join('\n');
    fs.writeFileSync(path.join(home, 'config.toml'), body);
    expect(removeThrowawayProjectTrust(home, '/tmp/instar-adapter-suite-AB/project')).toBe(true);
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8')).toBe(['model = "x"', '', '[projects."/keep"]', 'trust_level = "trusted"', '', '[hooks.state]', ''].join('\n'));
    expect(removeThrowawayProjectTrust(home, '/tmp/instar-adapter-suite-AB/project')).toBe(false);
  });
});
