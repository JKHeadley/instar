// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * The fold-marker tool policy (context-budget-layered-summaries §10), run
 * exactly as Claude Code runs it: the INSTALLED hook (written by the real
 * PostUpdateMigrator), JSON on stdin, identity in env. Markers are written by
 * the real writer (writeFoldMarker), never a hand-written fixture path.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { writeFoldMarker, foldMarkersDir, foldMarkerCarrier, TORN_MARKER_KEY } from '../../src/monitoring/foldMarker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/fold-marker-guard-hook.test.ts';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IID = 'inst_probe1';
const L = 'http://localhost:4040';

let hookPath: string;
let hookDir: string;
let agentHome: string;
let stateDir: string;

function runHook(input: object, env: Record<string, string>, hook = hookPath): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile('node', [hook], {
      env: { PATH: process.env.PATH ?? '', INSTAR_AGENT_HOME: agentHome, CLAUDE_PROJECT_DIR: '/nonexistent-checkout', ...env },
      encoding: 'utf-8', timeout: 15_000,
    }, (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? -1) : 0, stdout: stdout ?? '' }));
    child.stdin?.end(JSON.stringify(input));
  });
}
const denied = (r: { stdout: string }) => {
  if (!r.stdout.trim()) return false;
  return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny';
};
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const mark = (over: Partial<{ expiresAt: number; foldId: string; topicKey: string }> = {}) =>
  expect(writeFoldMarker(stateDir, { instarSessionId: IID, foldId: 'fold1', topicKey: '141133', expiresAt: Date.now() + 600_000, ...over })).not.toBeNull();
const writeRecord = (state: string) => {
  const dir = path.join(stateDir, 'state', 'context-layers', '141133', 'fold-records');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fold1.json'), JSON.stringify({ state }));
};

beforeAll(() => {
  hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-marker-hook-'));
  // Install through the real migrator path (always-overwrite built-in hooks).
  const content = new PostUpdateMigrator({ projectDir: hookDir, stateDir: path.join(hookDir, '.instar'), port: 4040, hasTelegram: false, projectName: 't' } as never)
    .getHookContent('fold-marker-guard');
  hookPath = path.join(hookDir, 'fold-marker-guard.js');
  fs.writeFileSync(hookPath, content, { mode: 0o755 });
});

describe('fold-marker-guard hook', () => {
  beforeEach(() => {
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-marker-home-'));
    stateDir = path.join(agentHome, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4040 }));
  });
  afterEach(() => SafeFsExecutor.safeRmSync(agentHome, { recursive: true, force: true, operation: OP }));

  it('the String.raw body survives intact (regex backslashes kept, parses as a script)', () => {
    const body = fs.readFileSync(hookPath, 'utf-8');
    expect(body).toContain('\\$(?:AUTH|INSTAR_AUTH_TOKEN)');
    expect(body.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('no INSTAR_SESSION_ID ⇒ allow, nothing printed', async () => {
    mark();
    const r = await runHook({ tool_name: 'Write' }, {});
    expect(r.code).toBe(0);
    expect(denied(r)).toBe(false);
  });

  it('no marker for this session ⇒ allow (every other session untouched)', async () => {
    const r = await runHook({ tool_name: 'Write' }, { INSTAR_SESSION_ID: IID });
    expect(denied(r)).toBe(false);
    mark();
    expect(denied(await runHook({ tool_name: 'Write' }, { INSTAR_SESSION_ID: 'inst_other' }))).toBe(false);
  });

  it('live marker: file reads, writes, sub-agents, web fetch and MCP tools are all denied', async () => {
    mark();
    for (const tool of ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Task', 'WebFetch', 'mcp__threadline__threadline_send', 'SomeFutureTool']) {
      expect(denied(await runHook({ tool_name: tool }, { INSTAR_SESSION_ID: IID })), tool).toBe(true);
    }
  });

  it('live marker: only an exact localhost lookup GET is allowed; sends and shell tricks are denied', async () => {
    mark();
    const env = { INSTAR_SESSION_ID: IID };
    expect(denied(await runHook(bash(`curl -s "${L}/topic/search?topic=141133&q=deadline"`), env))).toBe(false);
    expect(denied(await runHook(bash(`curl -sS -H "Authorization: Bearer $AUTH" "${L}/memory/search?q=x"`), env))).toBe(false);
    for (const cmd of [
      `curl -s "${L}/telegram/reply/141133"`,
      `curl -s ${L}/topic/search; cat secrets`,
      `curl -X POST "${L}/topic/search"`,
      `curl -s -o out "${L}/topic/search"`,
      `curl -s "http://localhost:$PORT/topic/search"`,
      `curl -s "${L}/topic/search/../../telegram/reply"`,
      `bash -c "curl -s ${L}/topic/search"`,
      `node -e "1"`,
      `cat .instar/state/context-layers/141133/checkpoint.jsonl`,
      // second-pass review: unquoted / half-quoted URLs must not let '&' start a command
      `curl ${L}/topic/search?q=a&env`,
      `curl -s ${L}/topic/search?q=a&&printenv`,
      `curl ${L}/topic/search?q=a&ls`,
      `curl ${L}/memory/search?&PATH=x&claude`,
      `curl "${L}/topic/search?q=a&env`,
      `curl -s "http://localhost:9999/topic/search?q=x"`, // another server's port
      `curl -s "${L}/topic/./search?q=x"`,
      `curl -s "${L}/topic/search?q=%2e%2e"`,
    ]) {
      expect(denied(await runHook(bash(cmd), env)), cmd).toBe(true);
    }
  });

  it('malformed marker ⇒ deny', async () => {
    fs.mkdirSync(foldMarkersDir(stateDir), { recursive: true });
    fs.writeFileSync(path.join(foldMarkersDir(stateDir), `${IID}.json`), '{torn');
    expect(denied(await runHook(bash(`curl -s "${L}/topic/search?q=x"`), { INSTAR_SESSION_ID: IID }))).toBe(true);
  });

  it('stale marker ⇒ deny while the fold record is open or missing, allow once it is terminal', async () => {
    mark({ expiresAt: Date.now() - 1000 });
    const env = { INSTAR_SESSION_ID: IID };
    expect(denied(await runHook({ tool_name: 'Write' }, env))).toBe(true); // no record: treated as open
    writeRecord('probing');
    expect(denied(await runHook({ tool_name: 'Write' }, env))).toBe(true);
    writeRecord('rolled-back');
    expect(denied(await runHook({ tool_name: 'Write' }, env))).toBe(false);
  });

  it('reads the marker from the AGENT HOME, not the (worktree) project dir', async () => {
    mark();
    const r = await runHook({ tool_name: 'Write' }, { INSTAR_SESSION_ID: IID, CLAUDE_PROJECT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')) });
    expect(denied(r)).toBe(true);
  });

  it('every decision under a marker is counted in the fold decisions log', async () => {
    mark();
    const env = { INSTAR_SESSION_ID: IID };
    await runHook({ tool_name: 'Write' }, env);
    await runHook(bash(`curl -s "${L}/topic/search?q=x"`), env);
    const lines = fs.readFileSync(path.join(foldMarkersDir(stateDir), 'fold1.decisions.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.decision)).toEqual(['deny', 'allow']);
    expect(fs.statSync(path.join(foldMarkersDir(stateDir), 'fold1.decisions.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('runs under an ESM host (package.json "type": "module")', async () => {
    const esmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-host-'));
    fs.writeFileSync(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }));
    const esmHook = path.join(esmDir, 'fold-marker-guard.js');
    fs.copyFileSync(hookPath, esmHook);
    mark();
    const env = { INSTAR_SESSION_ID: IID };
    expect(denied(await runHook({ tool_name: 'Write' }, env, esmHook))).toBe(true);
    expect(denied(await runHook(bash(`curl -s "${L}/topic/search?q=x"`), env, esmHook))).toBe(false);
    SafeFsExecutor.safeRmSync(esmDir, { recursive: true, force: true, operation: OP });
  });

  it('a quoted URL with & inside its query is one literal argument and is allowed', async () => {
    mark();
    expect(denied(await runHook(bash(`curl -s "${L}/topic/search?topic=141133&q=a"`), { INSTAR_SESSION_ID: IID }))).toBe(false);
  });

  it('the lookup port is the agent configured port, not any port', async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4321 }));
    mark();
    const env = { INSTAR_SESSION_ID: IID };
    expect(denied(await runHook(bash(`curl -s "http://localhost:4321/topic/search?q=x"`), env))).toBe(false);
    expect(denied(await runHook(bash(`curl -s "${L}/topic/search?q=x"`), env))).toBe(true);
  });

  it('with no readable agent config (port unknown) no lookup is allowed', async () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{torn');
    mark();
    expect(denied(await runHook(bash(`curl -s "${L}/topic/search?q=x"`), { INSTAR_SESSION_ID: IID }))).toBe(true);
  });

  it('a marker that cannot be READ is kept (not classed as torn and deleted)', () => {
    mark();
    const f = path.join(foldMarkersDir(stateDir), `${IID}.json`);
    fs.chmodSync(f, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root reads anyway: the branch cannot be exercised here
      const c = foldMarkerCarrier(stateDir);
      expect(c.list().some((x) => x.topicKey === TORN_MARKER_KEY)).toBe(false);
      c.release(TORN_MARKER_KEY, TORN_MARKER_KEY);
      expect(fs.existsSync(f)).toBe(true);
    } finally { fs.chmodSync(f, 0o600); }
  });

  it('an unreadable markers directory (existence unknown) never denies', async () => {
    mark();
    fs.chmodSync(foldMarkersDir(stateDir), 0o000);
    try {
      expect(denied(await runHook({ tool_name: 'Write' }, { INSTAR_SESSION_ID: IID }))).toBe(false);
    } finally {
      fs.chmodSync(foldMarkersDir(stateDir), 0o700);
    }
  });

  it('a torn or mismatched marker is offered to the boot sweep and released by the carrier', () => {
    fs.mkdirSync(foldMarkersDir(stateDir), { recursive: true });
    fs.writeFileSync(path.join(foldMarkersDir(stateDir), 'inst_torn.json'), '{torn');
    fs.writeFileSync(path.join(foldMarkersDir(stateDir), 'inst_mismatch.json'), JSON.stringify({ schema: 'fold-marker/1', instarSessionId: 'inst_other', foldId: 'f1', topicKey: '1', writtenAt: 1, expiresAt: 2 }));
    mark();
    const c = foldMarkerCarrier(stateDir);
    expect(c.list()).toEqual(expect.arrayContaining([{ topicKey: TORN_MARKER_KEY, foldId: TORN_MARKER_KEY }, { topicKey: '141133', foldId: 'fold1' }]));
    c.release(TORN_MARKER_KEY, TORN_MARKER_KEY);
    expect(fs.readdirSync(foldMarkersDir(stateDir)).filter((f) => f.endsWith('.json')).sort()).toEqual([`${IID}.json`]);
  });

  it('writer refuses unsafe ids; marker file is 0600', () => {
    expect(writeFoldMarker(stateDir, { instarSessionId: '../x', foldId: 'f', topicKey: 't', expiresAt: 1 })).toBeNull();
    expect(writeFoldMarker(stateDir, { instarSessionId: IID, foldId: 'bad id', topicKey: 't', expiresAt: 1 })).toBeNull();
    mark();
    expect(fs.statSync(path.join(foldMarkersDir(stateDir), `${IID}.json`)).mode & 0o777).toBe(0o600);
  });
});
