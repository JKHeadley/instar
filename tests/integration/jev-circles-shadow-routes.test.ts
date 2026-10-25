/**
 * jev-circles-shadow — integration tier. Spec: docs/specs/jev-circles-shadow.md.
 *
 * The full HTTP pipeline through the real createRoutes: PostToolUse events
 * POSTed to /hooks/events (as hook-event-reporter.js sends them, with the
 * session's transcript_path) drive the installed shadow, which reads a real
 * transcript file from disk; GET /jev-circles/summary reports the checks. The
 * hook response is never delayed or changed by the shadow.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { JevCirclesShadow, installJevCirclesShadow, getJevCirclesShadow } from '../../src/core/JevCirclesShadow.js';

const SID = '2c1f7a9e-0b1d-4c55-9a55-0f7e2d3b8c11';

function writeLoopTranscript(root: string): string {
  const dir = path.join(root, '.claude', 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SID}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = `toolu_e${i}`, b = `toolu_b${i}`;
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: a, name: 'Edit', input: { file_path: '/p/x.ts', old_string: 'a', new_string: 'b' } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: a, content: 'updated' }] } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: b, name: 'Bash', input: { command: 'npm test' } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: b, content: 'Exit code 1\nFAIL x.test.ts', is_error: true }] } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function app(stateDir: string) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes({
    config: { authToken: 'test', stateDir, port: 0, projectName: 'it' },
    hookEventReceiver: new HookEventReceiver({ stateDir }),
  } as never));
  return a;
}

afterEach(() => installJevCirclesShadow(null));

describe('jev-circles-shadow — HTTP pipeline', () => {
  it('summary is 503 when the shadow is not constructed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-circles-it-'));
    installJevCirclesShadow(null);
    const res = await request(app(path.join(root, '.instar'))).get('/jev-circles/summary');
    expect(res.status).toBe(503);
  });

  it('five PostToolUse events run one check against the real transcript; the summary reports it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-circles-it-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const transcript = writeLoopTranscript(root);
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.state).toContain('Bash: npm test => ERROR');
      const p = { circling: 0.93, converging: 0.07, polling: 0, normal: 0, cannot_tell: 0 };
      return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { state: { choice: 'circling', probabilities: p }, state_rev: { choice: 'circling', probabilities: p } } }) } as unknown as Response;
    });
    installJevCirclesShadow(new JevCirclesShadow({
      getConfig: () => ({ enabled: true }),
      readKey: () => 'k',
      logPath: path.join(root, 'logs', 'jev-circles-shadow.jsonl'),
      fetchImpl: fetchImpl as never,
    }));
    const server = app(stateDir);
    for (let i = 0; i < 5; i++) {
      const res = await request(server).post('/hooks/events').send({ event: 'PostToolUse', session_id: SID, tool_name: 'Bash', cwd: root, file_path: '', transcript_path: transcript });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, event: 'PostToolUse' });
    }
    await getJevCirclesShadow()!.lastCheck;
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const res = await request(server).get('/jev-circles/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, checks: 1, wouldNudges: 1, labels: { circling: 1 } });
    expect(res.body.perSession[SID]).toMatchObject({ checks: 1, wouldNudges: 1 });
  });

  it('non-tool events and events without a session never reach the shadow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-circles-it-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const fetchImpl = vi.fn();
    installJevCirclesShadow(new JevCirclesShadow({
      getConfig: () => ({ enabled: true }), readKey: () => 'k',
      logPath: path.join(root, 'logs', 'x.jsonl'), fetchImpl: fetchImpl as never,
    }));
    const server = app(stateDir);
    for (let i = 0; i < 10; i++) await request(server).post('/hooks/events').send({ event: 'Stop', session_id: SID });
    for (let i = 0; i < 10; i++) await request(server).post('/hooks/events').send({ event: 'PostToolUse', tool_name: 'Bash' });
    await getJevCirclesShadow()!.lastCheck;
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
