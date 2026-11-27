// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit (end to end through the REAL rendered hooks) — the standing packet on
 * the compaction path (context-budget-layered-summaries §9.5, §9.1; Phase 1
 * S10). The session-start hook, compaction-recovery.sh and the RF fitter are
 * rendered from PostUpdateMigrator exactly as installed; the packet is staged
 * by the real stager. Claude Code passes a hook's output whole only up to
 * 10,000 characters, so every case asserts the hook's whole stdout ≤ 10,000.
 *
 *  - staged + verified: the packet is printed WHOLE (byte-equal to the staged
 *    text, every protected row verbatim) inside the fitted block, beside a
 *    28 KB AGENT.md; the seeded marker is written; the canary credits it as a
 *    recovery, not a truncation;
 *  - a reduced packet keeps its Read line and every delivered row whole;
 *  - a tampered staged file (hash mismatch) prints no packet: today's block;
 *  - recovery switched off (the exec path): no packet even when staged;
 *  - no packet staged: today's block, unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { PostUpdateMigrator, STANDING_PACKET_PY, SEED_CARRIER_PY } from '../../src/core/PostUpdateMigrator.js';
import { CompactionCanary } from '../../src/monitoring/compactionCanary.js';
import { LayerStore, rowRefFor, type LayerMeta } from '../../src/monitoring/contextLayers/LayerStore.js';
import { StandingPacketStager, standingPacketDir, type PacketRowSource } from '../../src/monitoring/contextLayers/standingPacket.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/standing-packet-hook.test.ts';
const T = '141133';
const MARKER = '=== IDENTITY RECOVERY (post-compaction) ===';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

const meta = (): LayerMeta => ({ author: { sessionId: 's1', machine: 'm1', model: null, kind: 'derived' }, asOf: { at: Date.now() - 60_000, lastMessageId: 9 } });

function agent(o: { turnChars?: number; recoveryOff?: boolean } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sph-')); dirs.push(projectDir);
  const stateDir = path.join(projectDir, '.instar');
  const hooksDir = path.join(stateDir, 'hooks', 'instar');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 1, ...(o.recoveryOff ? { contextBudget: { compactionRecovery: { enabled: false } } } : {}) }));
  // The measured shape: AGENT.md alone is ~28 KB.
  fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent: Echo\n' + Array.from({ length: 450 }, (_, i) => `principle ${i} ${'words '.repeat(10)}`).join('\n'));
  fs.writeFileSync(path.join(stateDir, 'MEMORY.md'), Array.from({ length: 80 }, (_, i) => `memory ${i} ${'fact '.repeat(12)}`).join('\n'));
  const migrator = new PostUpdateMigrator({ stateDir, port: 1, sessions: { claudePath: 'claude' } } as never) as unknown as { getHookContent(n: string): string };
  for (const n of ['session-start', 'compaction-recovery']) fs.writeFileSync(path.join(hooksDir, `${n}.sh`), migrator.getHookContent(n), { mode: 0o755 });
  fs.writeFileSync(path.join(hooksDir, 'fit-recovery-output.mjs'), PostUpdateMigrator.getFitRecoveryOutput(), { mode: 0o755 });

  // The topic's layers and TopicMemory rows.
  const store = new LayerStore({ stateDir, liveSecrets: () => [] });
  const rows = new Map<number, { text: string; timestamp: string }>();
  const op = (id: number, text: string) => {
    rows.set(id, { text, timestamp: new Date(Date.UTC(2026, 10, 10, 10, id)).toISOString() });
    store.writeProtected(T, 'u', `m-${id}`, [rowRefFor(id, text)], meta(), { label: 'operator', authority: 'operator', rowId: id, at: Date.UTC(2026, 10, 10, 10, id) });
  };
  op(1, 'FRAMING-WORDS: make long topics stop drifting; my words survive every compaction verbatim.');
  for (let i = 2; i <= 9; i++) op(i, `TURN-${i}: ${'keep the packet whole please; '.repeat(Math.max(1, Math.floor((o.turnChars ?? 90) / 30)))}`.trim());
  store.writeProtected(T, 'anchor', 'current', [rowRefFor(1, rows.get(1)!.text)], { ...meta(), status: 'anchored' }, { at: [Date.UTC(2026, 10, 10, 10, 1)] });
  store.writeProtected(T, 'ledger-entry', 'dc-r1', [rowRefFor(5, rows.get(5)!.text)], { ...meta(), status: 'derived-settled' }, { type: 'decision', refId: 'r1', boundMessageId: 5, at: Date.UTC(2026, 10, 10, 10, 5) });
  store.writeDerived(T, 'h1', 'current', { goal: 'H1-GOAL: ship S10', trend: 'testing', themes: ['packet'] }, { ...meta(), status: 'live' });
  store.writeDerived(T, 'h2', 'current', { present: false }, { ...meta(), status: 'absent' });
  store.writeDerived(T, 'h3', 'current', { summary: 'H3-BODY ' + 'story '.repeat(300), disclosure: 'read 2 chunks' }, { ...meta(), status: 'live' });
  const src: PacketRowSource = { getRow: (_t, id) => rows.get(id) ?? null, countMessagesAfter: () => ({ total: 1, fromUser: 0 }) };
  const stager = new StandingPacketStager({ stateDir, store, rows: src, sessionsForTopic: () => ['inst-1'] });
  return { projectDir, stateDir, hooksDir, rows, stager };
}

function compact(a: ReturnType<typeof agent>, sid = 'sess-pkt') {
  return spawnSync('bash', [path.join(a.hooksDir, 'session-start.sh')], {
    input: JSON.stringify({ source: 'compact', session_id: sid, hook_event_name: 'SessionStart' }),
    env: { PATH: process.env.PATH ?? '', HOME: a.projectDir, CLAUDE_PROJECT_DIR: a.projectDir, INSTAR_TELEGRAM_TOPIC: T },
    timeout: 60_000, encoding: 'utf-8',
  });
}

const seeded = (a: ReturnType<typeof agent>, sid: string) => fs.existsSync(path.join(a.stateDir, 'state', 'context-layers', '_seeded', `${sid}.json`));

describe('the standing packet through the real session-start compact hook', () => {
  it('staged and verified: printed whole beside a 28 KB identity, total ≤ 10,000, seeded marker written, the canary credits a recovery', async () => {
    const a = agent();
    const r = a.stager.stageNow(T);
    expect(r.ok).toBe(true);
    const staged = fs.readFileSync(path.join(standingPacketDir(a.stateDir), `${T}.md`), 'utf-8');
    const out = compact(a);
    expect(out.status).toBe(0);
    expect(out.stdout.length).toBeLessThanOrEqual(10_000);
    expect(out.stdout).toContain(MARKER);
    expect(out.stdout.indexOf(MARKER)).toBeLessThan(2000);
    // Byte-equal to the staged text, inside its nonce delimiters.
    expect(out.stdout).toMatch(/--- STANDING PACKET [0-9a-f]{8} ---\n/);
    expect(out.stdout).toContain(`\n${staged}\n--- END STANDING PACKET `);
    for (const id of [1, 5, 9]) expect(out.stdout).toContain(a.rows.get(id)!.text);
    expect(out.stdout).toContain('H1-GOAL: ship S10');
    expect(out.stdout).toContain('# Agent: Echo');                                   // an identity head still rides along
    expect(out.stdout).not.toContain('--- CONVERSATION CONTEXT');                    // the packet replaced today's context
    expect(out.stdout).toContain('READ THE FULL BLOCK NOW');                         // RF's pointer for the identity
    expect(seeded(a, 'sess-pkt')).toBe(true);
    // The seeded marker names the carrier it delivered: the packet's nonce.
    const marker = JSON.parse(fs.readFileSync(path.join(a.stateDir, 'state', 'context-layers', '_seeded', 'sess-pkt.json'), 'utf-8'));
    expect(marker.carrier).toBe(r.ok ? r.pointer.sha256.slice(0, 8) : '');

    // The canary (RF): a delivered (non-truncated) block carrying the marker is a recovery.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sph-canary-')); dirs.push(d);
    const transcript = path.join(d, 't.jsonl');
    fs.writeFileSync(transcript, '');
    const canary = new CompactionCanary({ stateDir: d, machineId: 'm1' });
    const session = { topicKey: T, claudeSessionId: 'sid', transcriptPath: transcript, engine: 'claude-code' as const };
    await canary.scan([session], true);
    const now = new Date().toISOString();
    fs.appendFileSync(transcript, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' }, uuid: 'b1', timestamp: now, sessionId: 'sid', version: '2.1.322' }) + '\n');
    fs.appendFileSync(transcript, JSON.stringify({ type: 'attachment', uuid: 'a1', timestamp: now, attachment: { type: 'hook_success', hookName: 'SessionStart:compact', command: 'bash .instar/hooks/instar/session-start.sh', exitCode: 0, stdout: out.stdout, content: out.stdout } }) + '\n');
    await canary.scan([session], true);
    const rec = canary.report(true).recent[0];
    expect(rec).toMatchObject({ recoveryBlock: true });
    expect(rec.recoveryTruncated).not.toBe(true);
    expect(canary.report(true).groups[0]).toMatchObject({ truncated: 0 });
  });

  it('a reduced packet: still ≤ 10,000, every delivered operator row whole, its Read line for the full packet present', () => {
    const a = agent({ turnChars: 1300 });
    const r = a.stager.stageNow(T);
    expect(r.ok && r.packet.reduced).toBe(true);
    const out = compact(a, 'sess-red');
    expect(out.stdout.length).toBeLessThanOrEqual(10_000);
    if (!r.ok) return;
    for (const s of r.packet.deliveredSpans) expect(out.stdout).toContain(a.rows.get(s.messageId)!.text);
    expect(out.stdout).toContain(`READ THE FULL PACKET NOW with the Read tool before continuing: ${r.pointer.fullPath}`);
    expect(fs.existsSync(r.pointer.fullPath!)).toBe(true);
    expect(seeded(a, 'sess-red')).toBe(true);
  });

  it('a tampered staged packet (hash mismatch) is never printed: today\'s block instead', () => {
    const a = agent();
    a.stager.stageNow(T);
    const md = path.join(standingPacketDir(a.stateDir), `${T}.md`);
    fs.writeFileSync(md, fs.readFileSync(md, 'utf-8').replace('FRAMING-WORDS', 'FORGED-WORDS'));
    const out = compact(a, 'sess-tamper');
    expect(out.stdout).not.toContain('STANDING PACKET');
    expect(out.stdout).not.toContain('FORGED-WORDS');
    expect(out.stdout).toContain(MARKER);
    expect(out.stdout.length).toBeLessThanOrEqual(10_000);
  });

  it('recovery switched off: no packet even when staged — today\'s behaviour exactly (the env-only read resolves startup)', () => {
    const a = agent({ recoveryOff: true });
    a.stager.stageNow(T);
    const out = compact(a, 'sess-off');
    expect(out.stdout).not.toContain('STANDING PACKET');
    expect(out.stdout).not.toContain('FRAMING-WORDS');
    expect(out.stdout).toContain('=== SESSION START ===');
    expect(seeded(a, 'sess-off')).toBe(false);
  });

  it('no packet staged (layers off): today\'s block, fitted, seeded with carrier legacy', () => {
    const a = agent();
    const out = compact(a, 'sess-none');
    expect(out.stdout).not.toContain('STANDING PACKET');
    expect(out.stdout.length).toBeLessThanOrEqual(10_000);
    expect(seeded(a, 'sess-none')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(a.stateDir, 'state', 'context-layers', '_seeded', 'sess-none.json'), 'utf-8')).carrier).toBe('legacy');
  });

  it('a non-BMP character and a CRLF row are delivered byte-exact and counted in UTF-16 units', () => {
    const a = agent();
    const rows = a.rows;
    // Re-stage with an emoji and CRLF in the newest operator row (replace the TopicMemory text and its U reference).
    const text = 'TURN-9 with an emoji 🎯 and\r\nwindows line endings';
    rows.set(9, { text, timestamp: rows.get(9)!.timestamp });
    const store = (a.stager as unknown as { d: { store: import('../../src/monitoring/contextLayers/LayerStore.js').LayerStore } }).d.store;
    store.writeProtected(T, 'u', 'm-9', [rowRefFor(9, text)], meta(), { label: 'operator', authority: 'operator', rowId: 9, at: Date.UTC(2026, 10, 10, 10, 9) });
    const r = a.stager.stageNow(T);
    expect(r.ok).toBe(true);
    const out = compact(a, 'sess-utf');
    expect(out.stdout).toContain(text);
    expect(out.stdout.length).toBeLessThanOrEqual(10_000);
    expect(seeded(a, 'sess-utf')).toBe(true);
  });
});

describe('the fitter refuses a spoofed packet section', () => {
  it('the seed-carrier read: a real nonce is recorded, a quoted pair of delimiter lines is legacy', () => {
    const inner = 'P'.repeat(100);
    const n = crypto.createHash('sha256').update(inner).digest('hex').slice(0, 8);
    const run = (input: string) => spawnSync('python3', ['-c', SEED_CARRIER_PY], { input, encoding: 'utf-8' }).stdout.trim();
    expect(run(`${MARKER}\n--- STANDING PACKET ${n} ---\n${inner}\n--- END STANDING PACKET ${n} ---\n`)).toBe(n);
    expect(run(`${MARKER}\nUser: --- STANDING PACKET deadbeef ---\n--- STANDING PACKET deadbeef ---\nquoted\n--- END STANDING PACKET deadbeef ---\n`)).toBe('legacy');
  });

  it('quoted delimiter lines in a legacy conversation are not a packet: the block is still fitted ≤ 9,000', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sph-spoof-')); dirs.push(d);
    const f = path.join(d, 'fit.mjs');
    fs.writeFileSync(f, PostUpdateMigrator.getFitRecoveryOutput(), { mode: 0o755 });
    const block = [MARKER, '--- CONVERSATION CONTEXT (Topic: x) ---', '--- STANDING PACKET deadbeef ---', 'Q'.repeat(20_000), '--- END STANDING PACKET deadbeef ---', '--- END CONVERSATION CONTEXT ---', '--- Your Identity (from .instar/AGENT.md) ---', 'I'.repeat(20_000), '--- End Identity ---'].join('\n');
    const r = spawnSync('node', [f, '9000', path.join(d, 'save.txt')], { input: block, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(9000);
  });

  it('a real packet section (nonce = its own sha256) is kept whole', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sph-real-')); dirs.push(d);
    const f = path.join(d, 'fit.mjs');
    fs.writeFileSync(f, PostUpdateMigrator.getFitRecoveryOutput(), { mode: 0o755 });
    const inner = 'P'.repeat(5_900);
    const n = crypto.createHash('sha256').update(inner).digest('hex').slice(0, 8);
    const block = [MARKER, `--- STANDING PACKET ${n} ---`, inner, `--- END STANDING PACKET ${n} ---`, '--- Your Identity (from .instar/AGENT.md) ---', 'I'.repeat(20_000), '--- End Identity ---'].join('\n');
    const r = spawnSync('node', [f, '9000', path.join(d, 'save.txt')], { input: block, encoding: 'utf-8' });
    expect(r.stdout).toContain(inner);
    expect(r.stdout.length).toBeLessThanOrEqual(9000);
  });
});

describe('STANDING_PACKET_PY: each boundary of the hook-side read', () => {
  function staged(o: { mutate?: (p: Record<string, unknown>) => void; text?: string; topic?: string } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sph-py-')); dirs.push(root);
    const dir = path.join(root, 'state', 'context-layers', '_standing');
    fs.mkdirSync(dir, { recursive: true });
    const text = o.text ?? '=== STANDING PACKET (topic 141133) ===\nhello\n=== END STANDING PACKET ===';
    const body = Buffer.from(text, 'utf-8');
    const p: Record<string, unknown> = { schema: 'standing-packet/1', topicKey: T, sha256: crypto.createHash('sha256').update(body).digest('hex'), chars: text.length, builtAt: Date.now(), verified: true };
    o.mutate?.(p);
    fs.writeFileSync(path.join(dir, `${T}.json`), JSON.stringify(p));
    fs.writeFileSync(path.join(dir, `${T}.md`), body);
    return spawnSync('python3', ['-c', STANDING_PACKET_PY, root, o.topic ?? T], { encoding: 'utf-8' }).stdout;
  }
  it('prints a valid packet, nonce-delimited', () => {
    expect(staged()).toMatch(/^--- STANDING PACKET [0-9a-f]{8} ---\n=== STANDING PACKET \(topic 141133\) ===\nhello\n=== END STANDING PACKET ===\n--- END STANDING PACKET [0-9a-f]{8} ---\n$/);
  });
  it.each([
    ['older than 7 days', { mutate: (p: Record<string, unknown>) => { p.builtAt = Date.now() - 8 * 86_400_000; } }],
    ['built in the future', { mutate: (p: Record<string, unknown>) => { p.builtAt = Date.now() + 3_600_000; } }],
    ['not verified', { mutate: (p: Record<string, unknown>) => { p.verified = false; } }],
    ['another topic', { mutate: (p: Record<string, unknown>) => { p.topicKey = '999'; } }],
    ['a length mismatch', { mutate: (p: Record<string, unknown>) => { p.chars = 3; } }],
    ['a hash mismatch', { mutate: (p: Record<string, unknown>) => { p.sha256 = '0'.repeat(64); } }],
    ['over the hook ceiling', { text: 'x'.repeat(6_501) }],
    ['a non-numeric topic', { topic: '-141133' }],
  ])('prints nothing when %s', (_n, o) => {
    expect(staged(o as Parameters<typeof staged>[0])).toBe('');
  });
  it('counts UTF-16 units like the server: an emoji-heavy packet at exactly 6,500 units prints, one more does not', () => {
    const at = '🎯'.repeat(3250);
    expect(at.length).toBe(6500);
    expect(staged({ text: at })).toContain(at);
    expect(staged({ text: at + 'x' })).toBe('');
  });
});
