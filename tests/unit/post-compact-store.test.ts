/**
 * context-budget-layered-summaries §9.1/§9.5/§9.7 — Claude's compact_summary is
 * stored, scrubbed, under the topic's layer store; the PostCompact hook forwards
 * it and prints nothing.
 *
 * Both sides of each boundary:
 *   - a summary is stored 0600 under a 0700 tree, with trigger and size
 *   - a credential-shaped string is scrubbed; an exact live secret value is
 *     replaced even when no shape pattern would catch it
 *   - an oversize summary is stored as a size pointer, never partially
 *   - unsafe topic / session ids are refused, never written
 *   - records are capped per topic, oldest pruned
 *   - the rendered hook forwards stdin with the Instar session id, prints
 *     nothing, and is a silent no-op without a token, a session id, or on
 *     another engine
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { isNeverServed } from '../../src/server/fileRoutes.js';
import {
  recordPostCompact,
  listPostCompactRecords,
  postCompactDir,
  redactLiveValues,
  MAX_RECORDS_PER_TOPIC,
  MAX_SUMMARY_CHARS,
} from '../../src/monitoring/PostCompactStore.js';

const OP = 'tests/unit/post-compact-store.test.ts';
const CS = 'c1a2b3c4-0000-4000-8000-000000000001';
let stateDir: string;

beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-compact-')); });
afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

const base = (over: Partial<Parameters<typeof recordPostCompact>[1]> = {}) => ({
  topicKey: '141133', instarSessionId: 'inst-1', claudeSessionId: CS, trigger: 'auto', summary: 'We were building the fold ladder.', receivedAt: 1_000, ...over,
});

describe('recordPostCompact', () => {
  it('stores the summary 0600 under a 0700 tree with trigger and size', () => {
    const r = recordPostCompact(stateDir, base());
    expect(r.recorded).toBe(true);
    if (!r.recorded) return;
    expect(r.record).toMatchObject({ schema: 'post-compact/1', topicKey: '141133', trigger: 'auto', summary: 'We were building the fold ladder.', summaryChars: 33, oversize: false, redactionKinds: [] });
    expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(postCompactDir(stateDir, '141133')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(stateDir, 'state', 'context-layers')).mode & 0o777).toBe(0o700);
    expect(listPostCompactRecords(stateDir, '141133')).toHaveLength(1);
  });

  it('normalises an unknown trigger', () => {
    const r = recordPostCompact(stateDir, base({ trigger: 'weird' }));
    expect(r.recorded && r.record.trigger).toBe('unknown');
  });

  it('scrubs a credential shape and replaces an exact live secret value', () => {
    const token = 'zq81Lm-not-a-shape-but-live-9921';
    const r = recordPostCompact(stateDir, base({ summary: `key sk-ant-api03-${'A'.repeat(40)} and AUTH=${token}` }), [token, 'short']);
    expect(r.recorded).toBe(true);
    if (!r.recorded) return;
    expect(r.record.summary).not.toContain(token);
    expect(r.record.summary).not.toContain('A'.repeat(40));
    expect(r.record.summary).toContain('[REDACTED:live-secret]');
    expect(r.record.redactionKinds).toContain('live-secret');
    expect(fs.readFileSync(r.file, 'utf-8')).not.toContain(token);
  });

  it('stores an oversize summary as a size pointer only', () => {
    const r = recordPostCompact(stateDir, base({ summary: 'x'.repeat(MAX_SUMMARY_CHARS + 1) }));
    expect(r.recorded && r.record.oversize).toBe(true);
    if (!r.recorded) return;
    expect(r.record.summary).toMatch(/^\[REDACTED:oversize\] \(\d+ chars withheld\)$/);
    expect(r.record.summaryChars).toBe(MAX_SUMMARY_CHARS + 1);
  });

  it('refuses unsafe ids and writes nothing', () => {
    expect(recordPostCompact(stateDir, base({ topicKey: '../x' }))).toEqual({ recorded: false, reason: 'unsafe-id' });
    expect(recordPostCompact(stateDir, base({ claudeSessionId: 'a/b' }))).toEqual({ recorded: false, reason: 'unsafe-id' });
    expect(recordPostCompact(stateDir, base({ instarSessionId: '' }))).toEqual({ recorded: false, reason: 'unsafe-id' });
    expect(fs.existsSync(path.join(stateDir, 'state'))).toBe(false);
  });

  it('caps records per topic, pruning the oldest', () => {
    for (let i = 0; i < MAX_RECORDS_PER_TOPIC + 5; i++) recordPostCompact(stateDir, base({ receivedAt: 1_000 + i }));
    const recs = listPostCompactRecords(stateDir, '141133');
    expect(recs).toHaveLength(MAX_RECORDS_PER_TOPIC);
    expect(recs[0].receivedAt).toBe(1_000 + MAX_RECORDS_PER_TOPIC + 4);
    expect(recs.at(-1)!.receivedAt).toBe(1_005);
  });

  it('the layer and archive roots are never served by the file viewer (spec 9.7)', () => {
    for (const p of ['.instar/state/context-layers/141133/post-compact/1-x.json', 'state/context-layers/141133/post-compact/1-x.json', '.instar/state/context-archive/141133/a.zst', '.instar/state/context-layers']) {
      expect(isNeverServed(p)).toBe(true);
    }
    expect(isNeverServed('.instar/state/context-layers-unrelated.json')).toBe(false);
  });

  it('redactLiveValues ignores values too short to be secrets', () => {
    expect(redactLiveValues('pin 123456 here', ['123456'])).toEqual({ text: 'pin 123456 here', hit: false });
  });
});

describe('post-compact.sh (rendered hook)', () => {
  let projectDir: string;
  let hookPath: string;
  let server: http.Server;
  let port: number;
  let received: Array<{ headers: http.IncomingHttpHeaders; body: string; url?: string }>;

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-compact-hook-'));
    const hooksDir = path.join(projectDir, '.instar', 'hooks', 'instar');
    fs.mkdirSync(hooksDir, { recursive: true });
    const m = new PostUpdateMigrator({ stateDir: path.join(projectDir, '.instar'), port: 1, sessions: { claudePath: 'claude' } } as never);
    hookPath = path.join(hooksDir, 'post-compact.sh');
    fs.writeFileSync(hookPath, (m as unknown as { getHookContent(n: string): string }).getHookContent('post-compact'), { mode: 0o755 });
    received = [];
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => { received.push({ headers: req.headers, body: b, url: req.url }); res.writeHead(200).end('{}'); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP });
  });

  const run = (input: string, env: Record<string, string>) => new Promise<{ out: string; code: number | null }>((resolve) => {
    const child = spawn('bash', [hookPath], { env: { PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir, INSTAR_PORT: String(port), ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
    // A no-op hook exits without reading stdin; that is its contract, not a failure.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

  const payload = JSON.stringify({ hook_event_name: 'PostCompact', session_id: CS, trigger: 'manual', compact_summary: 'summary text' });

  it('forwards stdin with the Instar session id and prints nothing', async () => {
    const r = await run(payload, { INSTAR_AUTH_TOKEN: 'tok', INSTAR_SESSION_ID: 'inst-9' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/hooks/post-compact');
    expect(received[0].headers['x-instar-session-id']).toBe('inst-9');
    expect(received[0].headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(received[0].body)).toMatchObject({ compact_summary: 'summary text', trigger: 'manual' });
  });

  it('is a silent no-op without a token, without a session id, or on another engine', async () => {
    await run(payload, { INSTAR_SESSION_ID: 'inst-9' });
    await run(payload, { INSTAR_AUTH_TOKEN: 'tok' });
    await run(payload, { INSTAR_AUTH_TOKEN: 'tok', INSTAR_SESSION_ID: 'inst-9', INSTAR_FRAMEWORK: 'codex-cli' });
    expect(received).toHaveLength(0);
  });
});
